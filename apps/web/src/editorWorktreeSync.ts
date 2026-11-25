import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  buildRemoteOpenUrl,
  type EditorId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type VcsEditorWorktreeStatusResult,
} from "@t3tools/contracts";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { safeDecodeURIComponent } from "@t3tools/shared/markdownLinks";
import { Atom } from "effect/reactivity";
import { msg } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";

import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { editorLabelForPlatform } from "./editorLabels";
import {
  type EditorWorktreeSyncTarget,
  extractEditorWorktreeConflict,
  type ForegroundEditorSyncSnapshot,
  remapPathToEditorWorktree,
  runPullFromEditorWorktreeWithConfirm,
  runPushToEditorWorktreeWithConfirm,
} from "./editorWorktreeSync.logic";
import { m, type MessageResolver } from "./i18n/messages";
import { subscribeDocumentReturn } from "./lib/documentActivity";
import { openRemoteEditorUrl, type RemoteOpenState } from "./remoteOpen";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { useEnvironmentQuery } from "./state/query";
import { revisionedQuery } from "./state/revisionedQuery";
import { readEnvironmentScope, useEnvironmentScope } from "./state/session";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { editorWorktreeRevisionAtom, vcsEnvironment } from "./state/vcs";

export type {
  EditorWorktreeAutoSyncState,
  EditorWorktreeSyncTarget,
  ForegroundEditorSyncSnapshot,
} from "./editorWorktreeSync.logic";
export {
  planEditorWorktreeAutoSync,
  runPushToEditorWorktreeWithConfirm,
} from "./editorWorktreeSync.logic";

export const EDITOR_WORKTREE_AUTO_SYNC_DEBOUNCE_MS = 200;

export const activeForegroundEditorSyncTargetAtom = Atom.make<ForegroundEditorSyncSnapshot | null>(
  null,
).pipe(Atom.keepAlive, Atom.withLabel("editor-worktree:foreground-target"));

export function usePublishForegroundEditorSyncTarget(
  input: ForegroundEditorSyncSnapshot & { readonly enabled: boolean },
): void {
  const {
    enabled,
    routeKey,
    environmentId,
    threadId,
    projectId,
    worktreePath,
    isWorking,
    mutationKey,
    canWriteSourceControl,
  } = input;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the foreground ChatView thread state to the app-level editor worktree auto-sync coordinator
  useEffect(() => {
    if (!enabled) return;
    const entry: ForegroundEditorSyncSnapshot = {
      routeKey,
      environmentId,
      threadId,
      projectId,
      worktreePath,
      isWorking,
      mutationKey,
      canWriteSourceControl,
    };
    appAtomRegistry.set(activeForegroundEditorSyncTargetAtom, entry);
    return () => {
      const current = appAtomRegistry.get(activeForegroundEditorSyncTargetAtom);
      if (current?.routeKey === routeKey) {
        appAtomRegistry.set(activeForegroundEditorSyncTargetAtom, null);
      }
    };
  }, [
    canWriteSourceControl,
    enabled,
    environmentId,
    isWorking,
    mutationKey,
    projectId,
    routeKey,
    threadId,
    worktreePath,
  ]);
}

function refreshThreadGitViews(environmentId: EnvironmentId, cwd: string): void {
  void runAtomCommand(appAtomRegistry, vcsEnvironment.refreshStatus, {
    environmentId,
    input: { cwd },
  });
  void runAtomCommand(appAtomRegistry, vcsEnvironment.refreshBranch, {
    environmentId,
    input: { cwd },
  });
}

export async function ensureProjectEditorWorktreeImperative(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectId: ProjectId;
}): Promise<boolean> {
  const result = await runAtomCommand(appAtomRegistry, vcsEnvironment.ensureEditorWorktree, {
    environmentId: input.environmentId,
    input: {
      cwd: input.cwd,
      projectId: input.projectId,
    },
  });
  return result._tag === "Success";
}

export async function autoPullEditorWorktreeImperative(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly onConflict?: (conflictKey: string) => void;
}): Promise<boolean> {
  const result = await runAtomCommand(appAtomRegistry, vcsEnvironment.pullFromEditorWorktree, {
    environmentId: input.environmentId,
    input: {
      cwd: input.cwd,
      threadId: input.threadId,
    },
  });
  if (result._tag === "Success") {
    if (result.value.noop !== true) {
      refreshThreadGitViews(input.environmentId, input.cwd);
    }
    return true;
  }
  if (!isAtomCommandInterrupted(result)) {
    const conflict = extractEditorWorktreeConflict(squashAtomCommandFailure(result));
    if (conflict?.reason === "thread_changed_since_push") {
      input.onConflict?.(`${input.environmentId}:${input.threadId}:${conflict.reason}`);
    }
  }
  return false;
}

export async function autoSyncEditorWorktreeImperative(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  readonly onConflict?: (conflictKey: string) => void;
}): Promise<boolean> {
  const result = await runAtomCommand(appAtomRegistry, vcsEnvironment.pushToEditorWorktree, {
    environmentId: input.environmentId,
    input: {
      cwd: input.cwd,
      threadId: input.threadId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      autoPullPrevious: true,
    },
  });
  if (result._tag === "Success") {
    const autoPulled = result.value.autoPulledThread;
    if (autoPulled) {
      refreshThreadGitViews(input.environmentId, autoPulled.cwd);
    }
    return true;
  }
  if (!isAtomCommandInterrupted(result)) {
    const conflict = extractEditorWorktreeConflict(squashAtomCommandFailure(result));
    if (conflict?.reason === "unpulled_editor_changes") {
      input.onConflict?.(
        `${input.environmentId}:${conflict.ownerThreadId ?? input.threadId}:${conflict.reason}`,
      );
    }
  }
  return false;
}

function showErrorToast(title: string, description: string): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description,
    }),
  );
}

export async function pushThreadWorktreeToEditorImperative(input: {
  readonly environmentId: EnvironmentId;
  readonly target: EditorWorktreeSyncTarget;
  readonly editor: EditorId;
  readonly resolve?: MessageResolver;
}): Promise<boolean> {
  const worktreePath = input.target.worktreePath;
  if (!worktreePath) return false;
  const resolve = input.resolve ?? m;
  const editorLabel = editorLabelForPlatform(input.editor, navigator.platform, resolve);
  const pushed = await runPushToEditorWorktreeWithConfirm({
    environmentId: input.environmentId,
    cwd: worktreePath,
    threadId: input.target.threadId,
    projectId: input.target.projectId,
    editorLabel,
    pushCommand: (args) =>
      runAtomCommand(appAtomRegistry, vcsEnvironment.pushToEditorWorktree, args),
    onError: showErrorToast,
    resolve,
  });
  if (!pushed) return false;
  if (pushed.autoPulledThread) {
    refreshThreadGitViews(input.environmentId, pushed.autoPulledThread.cwd);
  }
  if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) return false;
  const opened = await runAtomCommand(appAtomRegistry, shellEnvironment.openInEditor, {
    environmentId: input.environmentId,
    input: {
      cwd: pushed.editorWorktreePath,
      editor: input.editor,
    },
  });
  return opened._tag === "Success";
}

export async function pullThreadWorktreeFromEditorImperative(input: {
  readonly environmentId: EnvironmentId;
  readonly target: EditorWorktreeSyncTarget;
  readonly editor: EditorId | null;
  readonly resolve?: MessageResolver;
}): Promise<boolean> {
  const worktreePath = input.target.worktreePath;
  if (!worktreePath) return false;
  const resolve = input.resolve ?? m;
  const editorLabel = input.editor
    ? editorLabelForPlatform(input.editor, navigator.platform, resolve)
    : resolve(msg("editor"));
  const pulled = await runPullFromEditorWorktreeWithConfirm({
    environmentId: input.environmentId,
    cwd: worktreePath,
    threadId: input.target.threadId,
    editorLabel,
    pullCommand: (args) =>
      runAtomCommand(appAtomRegistry, vcsEnvironment.pullFromEditorWorktree, args),
    onError: showErrorToast,
    resolve,
  });
  if (!pulled) return false;
  void runAtomCommand(appAtomRegistry, vcsEnvironment.refreshStatus, {
    environmentId: input.environmentId,
    input: { cwd: worktreePath },
  });
  void runAtomCommand(appAtomRegistry, vcsEnvironment.refreshBranch, {
    environmentId: input.environmentId,
    input: { cwd: worktreePath },
  });
  toastManager.add(
    stackedThreadToast({
      type: "success",
      title: resolve(msg("Pulled changes from {editor}", { editor: editorLabel })),
    }),
  );
  return true;
}

function useEditorWorktreeStatus(
  environmentId: EnvironmentId | null,
  worktreePath: string | null | undefined,
): {
  readonly status: VcsEditorWorktreeStatusResult | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
} {
  const revision = useAtomValue(editorWorktreeRevisionAtom((environmentId ?? "") as EnvironmentId));
  const queryAtom =
    environmentId !== null && worktreePath
      ? revisionedQuery(
          vcsEnvironment.editorWorktreeStatus({
            environmentId,
            input: { cwd: worktreePath },
          }),
          String(revision),
        )
      : null;
  const query = useEnvironmentQuery(queryAtom);
  const refreshQuery = useEffectEvent(() => {
    query.refresh();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- revalidates unpulled editor changes when returning focus from the external editor
  useEffect(() => {
    if (!environmentId || !worktreePath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeDocumentReturn(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        refreshQuery();
      }, 250);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [environmentId, worktreePath]);

  return {
    status: query.data ?? null,
    isPending: query.isPending,
    refresh: query.refresh,
  };
}

export function useEditorWorktreeActions(input: {
  readonly environmentId: EnvironmentId;
  readonly target: EditorWorktreeSyncTarget | undefined;
  readonly remote: RemoteOpenState;
  readonly markRemoteHintSeen?: () => void;
}) {
  const pushCommand = useAtomCommand(vcsEnvironment.pushToEditorWorktree, { reportFailure: false });
  const pullCommand = useAtomCommand(vcsEnvironment.pullFromEditorWorktree, {
    reportFailure: false,
  });
  const refreshStatusCommand = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const refreshBranchCommand = useAtomCommand(vcsEnvironment.refreshBranch, {
    reportFailure: false,
  });
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const canWriteSourceControl = useEnvironmentScope(
    input.environmentId,
    AuthSourceControlWriteScope,
  );
  const [isPushing, setIsPushing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);

  const worktreePath = input.target?.worktreePath ?? null;
  const statusQuery = useEditorWorktreeStatus(
    worktreePath ? input.environmentId : null,
    worktreePath,
  );

  const launchInEditor = async (
    editor: EditorId,
    editorWorktreeRoot: string,
    targetPath?: string | null,
    targetIsFile = false,
  ): Promise<boolean> => {
    const resolvedTarget =
      targetPath && worktreePath
        ? (remapPathToEditorWorktree({
            targetPath,
            threadWorktreePath: worktreePath,
            editorWorktreePath: editorWorktreeRoot,
          }) ?? editorWorktreeRoot)
        : editorWorktreeRoot;

    if (input.remote.mode === "remote-unavailable") return false;
    if (input.remote.mode === "remote-links") {
      const url = buildRemoteOpenUrl({
        editor,
        ...input.remote.host,
        absolutePath: resolvedTarget,
        isFile: targetIsFile,
      });
      if (url === undefined) return false;
      const opened = await openRemoteEditorUrl(url);
      if (opened) input.markRemoteHintSeen?.();
      return opened;
    }

    if (!readEnvironmentScope(input.environmentId, AuthOrchestrationOperateScope)) return false;
    const uri = /^file:\/\//iu.test(resolvedTarget) ? parseFileUrlHref(resolvedTarget) : null;
    const { line, column } = uri ? splitFilePathPosition("", uri.hash) : {};
    const result = await openInEditorMutation({
      environmentId: input.environmentId,
      input: {
        cwd: uri ? safeDecodeURIComponent(uri.path) : resolvedTarget,
        ...(uri ? { position: { line, column } } : {}),
        editor,
        ...(resolvedTarget !== editorWorktreeRoot ? { projectRoot: editorWorktreeRoot } : {}),
      },
    });
    return result._tag === "Success";
  };

  const pushToEditor = (options: {
    readonly editor: EditorId;
    readonly targetPath?: string | null;
    readonly targetIsFile?: boolean;
    readonly resolve?: MessageResolver;
  }): Promise<boolean> => {
    const target = input.target;
    if (!target || !worktreePath) return Promise.resolve(false);
    const editorLabel = editorLabelForPlatform(
      options.editor,
      navigator.platform,
      options.resolve ?? m,
    );
    setIsPushing(true);
    return runPushToEditorWorktreeWithConfirm({
      environmentId: input.environmentId,
      cwd: worktreePath,
      threadId: target.threadId,
      projectId: target.projectId,
      editorLabel,
      pushCommand,
      onError: showErrorToast,
      ...(options.resolve ? { resolve: options.resolve } : {}),
    })
      .then((pushed) => {
        if (!pushed) return false;
        if (pushed.autoPulledThread) {
          refreshThreadGitViews(input.environmentId, pushed.autoPulledThread.cwd);
        }
        return launchInEditor(
          options.editor,
          pushed.editorWorktreePath,
          options.targetPath,
          options.targetIsFile ?? false,
        );
      })
      .then(
        (opened) => {
          setIsPushing(false);
          return opened;
        },
        (error: unknown) => {
          setIsPushing(false);
          throw error;
        },
      );
  };

  const pullFromEditor = (options: {
    readonly editor: EditorId | null;
    readonly resolve?: MessageResolver;
  }): Promise<boolean> => {
    const target = input.target;
    if (!target || !worktreePath) return Promise.resolve(false);
    const resolve = options.resolve ?? m;
    const editorLabel = options.editor
      ? editorLabelForPlatform(options.editor, navigator.platform, resolve)
      : resolve(msg("editor"));

    setIsPulling(true);
    return runPullFromEditorWorktreeWithConfirm({
      environmentId: input.environmentId,
      cwd: worktreePath,
      threadId: target.threadId,
      editorLabel,
      pullCommand,
      onError: showErrorToast,
      resolve,
    }).then(
      (pulled) => {
        setIsPulling(false);
        if (!pulled) return false;
        void refreshStatusCommand({
          environmentId: input.environmentId,
          input: { cwd: worktreePath },
        });
        void refreshBranchCommand({
          environmentId: input.environmentId,
          input: { cwd: worktreePath },
        });
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: resolve(msg("Pulled changes from {editor}", { editor: editorLabel })),
          }),
        );
        return true;
      },
      (error: unknown) => {
        setIsPulling(false);
        throw error;
      },
    );
  };

  return {
    status: statusQuery.status,
    isStatusPending: statusQuery.isPending,
    canWriteSourceControl,
    isPushing,
    isPulling,
    pushToEditor,
    pullFromEditor,
  };
}
