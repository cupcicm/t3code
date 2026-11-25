import { useAtomValue } from "@effect/atom-react";
import {
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { msg } from "gt-react";
import { useEffect, useEffectEvent, useRef } from "react";

import {
  activeForegroundEditorSyncTargetAtom,
  autoPullEditorWorktreeImperative,
  autoSyncEditorWorktreeImperative,
  EDITOR_WORKTREE_AUTO_SYNC_DEBOUNCE_MS,
  type EditorWorktreeAutoSyncState,
  ensureProjectEditorWorktreeImperative,
  planEditorWorktreeAutoSync,
} from "../editorWorktreeSync";
import { m } from "../i18n/messages";
import { subscribeDocumentReturn } from "../lib/documentActivity";
import { useProjects } from "../state/entities";
import { useEnvironment, useEnvironments } from "../state/environments";
import { useEnvironmentProjectClones } from "../state/projectClones";
import { useEnvironmentScope } from "../state/session";
import { stackedThreadToast, toastManager } from "./ui/toast";

export function EditorWorktreeCoordinator() {
  const { environments } = useEnvironments();
  return (
    <>
      <ForegroundEditorWorktreeAutoSync />
      {environments.map((environment) => (
        <EnvironmentEditorWorktreeBootstrapper
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}

function EnvironmentEditorWorktreeBootstrapper({
  environmentId,
}: {
  environmentId: EnvironmentId;
}) {
  const environment = useEnvironment(environmentId);
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const projects = useProjects();
  const clones = useEnvironmentProjectClones(environmentId);
  const ensuredKeysRef = useRef(new Set<string>());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- eagerly creates missing dedicated editor worktrees for connected non-scratch projects
  useEffect(() => {
    if (
      !environment ||
      environment.connection.phase !== "connected" ||
      !environment.serverConfig ||
      !canWriteSourceControl
    ) {
      return;
    }

    const scratchRoot = environment.serverConfig.scratchWorkspaceRoot;
    const runningCloneProjectIds = new Set<ProjectId>();
    for (const clone of clones) {
      if (clone.phase === "running") {
        runningCloneProjectIds.add(clone.projectId);
      }
    }

    for (const project of projects) {
      if (project.environmentId !== environmentId) continue;
      if (runningCloneProjectIds.has(project.id)) continue;
      if (isScratchProject(project, scratchRoot)) continue;

      const key = `${environmentId}:${project.workspaceRoot}`;
      if (ensuredKeysRef.current.has(key)) continue;
      ensuredKeysRef.current.add(key);

      void ensureProjectEditorWorktreeImperative({
        environmentId,
        cwd: project.workspaceRoot,
        projectId: project.id,
      }).then((ok) => {
        if (!ok) {
          ensuredKeysRef.current.delete(key);
        }
      });
    }
  }, [canWriteSourceControl, clones, environment, environmentId, projects]);

  return null;
}

function ForegroundEditorWorktreeAutoSync() {
  const target = useAtomValue(activeForegroundEditorSyncTargetAtom);
  const syncStateRef = useRef<EditorWorktreeAutoSyncState>({
    previousWorktree: null,
    lastSyncedStateKey: null,
  });
  const warnedConflictKeyRef = useRef<string | null>(null);

  const notifyAutoSyncConflict = (conflictKey: string) => {
    if (warnedConflictKeyRef.current === conflictKey) return;
    warnedConflictKeyRef.current = conflictKey;
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: m(msg("Editor auto-sync paused")),
        description: m(
          msg(
            "Both this thread and the editor worktree changed independently. Push or pull manually to resolve.",
          ),
        ),
      }),
    );
  };

  const runSettledSync = useEffectEvent((snapshot: typeof target, reason: "state" | "focus") => {
    const plan = planEditorWorktreeAutoSync(syncStateRef.current, snapshot, reason);
    syncStateRef.current = plan.nextState;

    if (plan.autoPullTarget !== null) {
      void autoPullEditorWorktreeImperative({
        ...plan.autoPullTarget,
        onConflict: notifyAutoSyncConflict,
      });
    }

    if (plan.autoSyncTarget !== null) {
      const { stateKey, ...syncArgs } = plan.autoSyncTarget;
      void autoSyncEditorWorktreeImperative({
        ...syncArgs,
        onConflict: notifyAutoSyncConflict,
      }).then((ok) => {
        if (ok) {
          warnedConflictKeyRef.current = null;
        } else if (syncStateRef.current.lastSyncedStateKey === stateKey) {
          syncStateRef.current = {
            ...syncStateRef.current,
            lastSyncedStateKey: null,
          };
        }
      });
    }
  });

  const runFocusSync = useEffectEvent(() => {
    runSettledSync(target, "focus");
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounces automatic editor worktree pull/push across thread switches and turn settlements
  useEffect(() => {
    const snapshot = target;
    const timer = setTimeout(() => {
      runSettledSync(snapshot, "state");
    }, EDITOR_WORKTREE_AUTO_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [target]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pulls external editor changes into the active idle worktree thread when returning focus to T3
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeDocumentReturn(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        runFocusSync();
      }, EDITOR_WORKTREE_AUTO_SYNC_DEBOUNCE_MS);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  return null;
}
