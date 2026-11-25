import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  VcsEditorWorktreeConflictError,
  type VcsPullFromEditorWorktreeResult,
  type VcsPushToEditorWorktreeResult,
} from "@t3tools/contracts";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { safeDecodeURIComponent } from "@t3tools/shared/markdownLinks";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { requestConfirmDialog } from "./confirmDialog";
import { m, type MessageResolver } from "./i18n/messages";

const isEditorWorktreeConflictError = Schema.is(VcsEditorWorktreeConflictError);

export function extractEditorWorktreeConflict(
  error: unknown,
): VcsEditorWorktreeConflictError | null {
  return isEditorWorktreeConflictError(error) ? error : null;
}

export interface ForegroundEditorSyncSnapshot {
  readonly routeKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  readonly worktreePath: string | null;
  readonly isWorking: boolean;
  readonly mutationKey: string | null;
  readonly canWriteSourceControl: boolean;
}

export interface PreviousEditorWorktreeTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | undefined;
  readonly worktreePath: string;
  readonly canWriteSourceControl: boolean;
}

export interface EditorWorktreeAutoSyncState {
  readonly previousWorktree: PreviousEditorWorktreeTarget | null;
  readonly lastSyncedStateKey: string | null;
}

export interface EditorWorktreeAutoSyncPlan {
  readonly nextState: EditorWorktreeAutoSyncState;
  readonly autoPullTarget: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly threadId: ThreadId;
  } | null;
  readonly autoSyncTarget: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId | undefined;
    readonly stateKey: string;
  } | null;
}

export function planEditorWorktreeAutoSync(
  state: EditorWorktreeAutoSyncState,
  current: ForegroundEditorSyncSnapshot | null,
  reason: "state" | "focus",
): EditorWorktreeAutoSyncPlan {
  const prev = state.previousWorktree;
  const switchedAwayFromPrev =
    prev !== null &&
    (current === null ||
      current.environmentId !== prev.environmentId ||
      current.threadId !== prev.threadId);

  const coveredByAtomicPush =
    switchedAwayFromPrev &&
    current !== null &&
    current.worktreePath !== null &&
    !current.isWorking &&
    current.canWriteSourceControl &&
    current.environmentId === prev.environmentId &&
    current.projectId !== undefined &&
    current.projectId === prev.projectId;

  const autoPullTarget =
    switchedAwayFromPrev && !coveredByAtomicPush && prev.canWriteSourceControl
      ? {
          environmentId: prev.environmentId,
          cwd: prev.worktreePath,
          threadId: prev.threadId,
        }
      : null;

  if (
    current === null ||
    current.worktreePath === null ||
    current.isWorking ||
    !current.canWriteSourceControl
  ) {
    const nextPreviousWorktree: PreviousEditorWorktreeTarget | null =
      current !== null && current.worktreePath !== null
        ? {
            environmentId: current.environmentId,
            threadId: current.threadId,
            projectId: current.projectId,
            worktreePath: current.worktreePath,
            canWriteSourceControl: current.canWriteSourceControl,
          }
        : switchedAwayFromPrev
          ? null
          : prev;

    return {
      nextState: {
        previousWorktree: nextPreviousWorktree,
        lastSyncedStateKey: switchedAwayFromPrev ? null : state.lastSyncedStateKey,
      },
      autoPullTarget,
      autoSyncTarget: null,
    };
  }

  const stateKey = `${current.environmentId}:${current.threadId}:${current.worktreePath}:${current.mutationKey ?? ""}`;
  const nextPreviousWorktree: PreviousEditorWorktreeTarget = {
    environmentId: current.environmentId,
    threadId: current.threadId,
    projectId: current.projectId,
    worktreePath: current.worktreePath,
    canWriteSourceControl: current.canWriteSourceControl,
  };

  if (reason !== "focus" && state.lastSyncedStateKey === stateKey) {
    return {
      nextState: {
        previousWorktree: nextPreviousWorktree,
        lastSyncedStateKey: state.lastSyncedStateKey,
      },
      autoPullTarget,
      autoSyncTarget: null,
    };
  }

  return {
    nextState: {
      previousWorktree: nextPreviousWorktree,
      lastSyncedStateKey: stateKey,
    },
    autoPullTarget,
    autoSyncTarget: {
      environmentId: current.environmentId,
      cwd: current.worktreePath,
      threadId: current.threadId,
      projectId: current.projectId,
      stateKey,
    },
  };
}

export interface EditorWorktreeSyncTarget {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId | undefined;
  readonly worktreePath: string | null | undefined;
  readonly isWorking?: boolean | undefined;
}

function stripTrailingSeparators(filePath: string): string {
  if (filePath === "/") return filePath;
  if (/^[A-Za-z]:[\\/]$/u.test(filePath)) return filePath;
  return filePath.replace(/[\\/]+$/u, "");
}

/**
 * Maps a file or directory target inside `threadWorktreePath` onto the corresponding path inside
 * `editorWorktreePath`, preserving any `:line:column` suffix or `file://...#Lline` fragment.
 * Returns null when `targetPath` does not belong to `threadWorktreePath`.
 */
export function remapPathToEditorWorktree(input: {
  readonly targetPath: string;
  readonly threadWorktreePath: string;
  readonly editorWorktreePath: string;
}): string | null {
  const threadRoot = stripTrailingSeparators(input.threadWorktreePath);
  const editorRoot = stripTrailingSeparators(input.editorWorktreePath);
  if (!threadRoot || !editorRoot) return null;

  const isUri = /^file:\/\//iu.test(input.targetPath);
  const parsedUri = isUri ? parseFileUrlHref(input.targetPath) : null;
  const rawPath = parsedUri ? safeDecodeURIComponent(parsedUri.path) : input.targetPath;
  const split = parsedUri
    ? { path: rawPath, line: undefined, column: undefined }
    : splitFilePathPosition(rawPath);
  const candidatePath = split.path;

  const windows = isWindowsAbsolutePath(threadRoot) || isWindowsAbsolutePath(candidatePath);
  const normalize = (value: string) =>
    windows ? value.replaceAll("/", "\\").toLowerCase() : value;

  const normalizedRoot = normalize(threadRoot);
  const normalizedCandidate = normalize(candidatePath);
  const separator = windows ? "\\" : "/";

  let suffix = "";
  if (normalizedCandidate === normalizedRoot) {
    suffix = "";
  } else if (normalizedCandidate.startsWith(`${normalizedRoot}${separator}`)) {
    suffix = candidatePath.slice(threadRoot.length);
  } else {
    return null;
  }

  const mappedFilePath = `${editorRoot}${suffix}`;
  if (parsedUri) {
    const posixMapped = mappedFilePath.replaceAll("\\", "/");
    const encodedPath = (posixMapped.startsWith("/") ? posixMapped : `/${posixMapped}`)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return `file://${encodedPath}${parsedUri.hash}`;
  }

  if (split.line !== undefined) {
    return split.column !== undefined
      ? `${mappedFilePath}:${split.line}:${split.column}`
      : `${mappedFilePath}:${split.line}`;
  }
  return mappedFilePath;
}

async function confirmDestructiveAction(message: string): Promise<boolean> {
  const hostResult = requestConfirmDialog(message, { variant: "destructive" });
  if (hostResult !== undefined) {
    return hostResult;
  }
  return typeof window !== "undefined" ? window.confirm(message) : false;
}

export async function runPushToEditorWorktreeWithConfirm(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId | undefined;
  readonly editorLabel: string;
  readonly pushCommand: (args: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly cwd: string;
      readonly threadId: ThreadId;
      readonly projectId?: ProjectId;
      readonly force?: boolean;
    };
  }) => Promise<AtomCommandResult<VcsPushToEditorWorktreeResult, unknown>>;
  readonly onError?: (title: string, description: string) => void;
  readonly resolve?: MessageResolver;
}): Promise<VcsPushToEditorWorktreeResult | null> {
  const resolve = input.resolve ?? m;
  const basePayload = {
    cwd: input.cwd,
    threadId: input.threadId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };

  let result = await input.pushCommand({
    environmentId: input.environmentId,
    input: basePayload,
  });

  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) return null;
    const failure = squashAtomCommandFailure(result);
    if (isEditorWorktreeConflictError(failure) && failure.reason === "unpulled_editor_changes") {
      const promptMessage =
        failure.ownerThreadId === input.threadId
          ? resolve(
              msg(
                "The {editor} worktree has unpulled changes from earlier edits on this thread. Overwrite them with this thread's current state?",
                { editor: input.editorLabel },
              ),
            )
          : failure.ownerThreadId !== null
            ? resolve(
                msg(
                  "The {editor} worktree has unpulled changes from another thread. Overwrite them with this thread's state?",
                  { editor: input.editorLabel },
                ),
              )
            : resolve(
                msg(
                  "The {editor} worktree has uncommitted changes. Overwrite them with this thread's state?",
                  { editor: input.editorLabel },
                ),
              );
      const confirmed = await confirmDestructiveAction(promptMessage);
      if (!confirmed) return null;
      result = await input.pushCommand({
        environmentId: input.environmentId,
        input: { ...basePayload, force: true },
      });
    }
  }

  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      input.onError?.(
        resolve(msg("Could not push to {editor}", { editor: input.editorLabel })),
        thrownErrorMessage(failure, resolve) ?? resolve(msg("An unexpected error occurred.")),
      );
    }
    return null;
  }

  return result.value;
}

export async function runPullFromEditorWorktreeWithConfirm(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly editorLabel: string;
  readonly pullCommand: (args: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly cwd: string;
      readonly threadId: ThreadId;
      readonly force?: boolean;
    };
  }) => Promise<AtomCommandResult<VcsPullFromEditorWorktreeResult, unknown>>;
  readonly onError?: (title: string, description: string) => void;
  readonly resolve?: MessageResolver;
}): Promise<VcsPullFromEditorWorktreeResult | null> {
  const resolve = input.resolve ?? m;
  let result = await input.pullCommand({
    environmentId: input.environmentId,
    input: {
      cwd: input.cwd,
      threadId: input.threadId,
    },
  });

  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) return null;
    const failure = squashAtomCommandFailure(result);
    if (isEditorWorktreeConflictError(failure) && failure.reason === "thread_changed_since_push") {
      const confirmed = await confirmDestructiveAction(
        resolve(
          msg(
            "This thread also changed since you pushed to {editor}. Replace this thread's workspace with {editor}'s current state?",
            { editor: input.editorLabel },
          ),
        ),
      );
      if (!confirmed) return null;
      result = await input.pullCommand({
        environmentId: input.environmentId,
        input: {
          cwd: input.cwd,
          threadId: input.threadId,
          force: true,
        },
      });
    }
  }

  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      input.onError?.(
        resolve(msg("Could not pull from {editor}", { editor: input.editorLabel })),
        thrownErrorMessage(failure, resolve) ?? resolve(msg("An unexpected error occurred.")),
      );
    }
    return null;
  }

  return result.value;
}
