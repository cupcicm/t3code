import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EDITORS,
  EditorId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { parseFileUrlHref, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { safeDecodeURIComponent } from "@t3tools/shared/markdownLinks";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import {
  remapPathToEditorWorktree,
  runPushToEditorWorktreeWithConfirm,
} from "./editorWorktreeSync.logic";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { m } from "./i18n/messages";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { readEnvironmentScope } from "./state/session";

const LAST_EDITOR_KEY = "t3code:last-editor";

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedError<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return m(
      msg("Cannot open {targetPath} because no environment is selected.", {
        targetPath: this.targetPath,
      }),
    );
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedError<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    environmentId: EnvironmentId,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(EditorId),
  },
) {
  override get message(): string {
    return m(
      msg("No available editor can open {targetPath} in environment {environmentId}.", {
        targetPath: this.targetPath,
        environmentId: this.environmentId,
      }),
    );
  }
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor =
    lastEditor && availableEditors.includes(lastEditor)
      ? lastEditor
      : (EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null);

  return [effectiveEditor, setLastEditor] as const;
}

function resolveAndPersistPreferredEditor(availableEditors: readonly EditorId[]): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  let stored: EditorId | null = null;
  try {
    stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  } catch (error) {
    console.warn("Could not read the preferred editor.", error);
  }
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) {
    try {
      setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
    } catch (error) {
      console.warn("Could not save the preferred editor.", error);
    }
  }
  return editor ?? null;
}

export interface OpenInPreferredEditorWorktreeSync {
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId | undefined;
  readonly worktreePath: string | null | undefined;
}

async function pushWorktreeBeforeFileOpen(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly projectId?: ProjectId | undefined;
  readonly editorLabel: string;
}): Promise<
  | { readonly status: "pushed"; readonly editorWorktreePath: string }
  | { readonly status: "cancelled" }
  | { readonly status: "fallback" }
> {
  const [
    { isAtomCommandInterrupted, runAtomCommand, squashAtomCommandFailure },
    { appAtomRegistry },
    { vcsEnvironment },
  ] = await Promise.all([
    import("@t3tools/client-runtime/state/runtime"),
    import("./rpc/atomRegistry"),
    import("./state/vcs"),
  ]);
  let fallback = false;
  const pushed = await runPushToEditorWorktreeWithConfirm({
    environmentId: input.environmentId,
    cwd: input.cwd,
    threadId: input.threadId,
    projectId: input.projectId,
    editorLabel: input.editorLabel,
    pushCommand: async (args) => {
      const result = await runAtomCommand(
        appAtomRegistry,
        vcsEnvironment.pushToEditorWorktree,
        args,
      );
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        if (
          typeof failure === "object" &&
          failure !== null &&
          "_tag" in failure &&
          failure._tag === "GitCommandError"
        ) {
          fallback = true;
        }
      }
      return result;
    },
  });
  if (pushed) return { status: "pushed", editorWorktreePath: pushed.editorWorktreePath };
  return fallback ? { status: "fallback" } : { status: "cancelled" };
}

export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
  projectRoot?: string,
  worktreeSync?:
    | OpenInPreferredEditorWorktreeSync
    | (() => OpenInPreferredEditorWorktreeSync | undefined),
) {
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>;

  return async (
    targetPath: string,
  ): Promise<
    AtomCommandResult<
      EditorId,
      | OpenInEditorError
      | PreferredEditorEnvironmentRequiredError
      | PreferredEditorUnavailableError
      | EnvironmentAuthorizationError
    >
  > => {
    if (environmentId === null) {
      return AsyncResult.failure(
        Cause.fail(
          new PreferredEditorEnvironmentRequiredError({
            targetPath,
          }),
        ),
      );
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return AsyncResult.failure(
        Cause.fail(
          new EnvironmentAuthorizationError({
            requiredScope: AuthOrchestrationOperateScope,
            message: m(msg("This connection cannot open an editor on this environment.")),
          }),
        ),
      );
    }
    const editor = resolveAndPersistPreferredEditor(availableEditors);
    if (!editor) {
      return AsyncResult.failure(
        Cause.fail(
          new PreferredEditorUnavailableError({
            environmentId,
            targetPath,
            availableEditorIds: availableEditors,
          }),
        ),
      );
    }

    let effectiveTargetPath = targetPath;
    let effectiveProjectRoot = projectRoot;
    const resolvedSync = typeof worktreeSync === "function" ? worktreeSync() : worktreeSync;
    const threadWorktreePath = resolvedSync?.worktreePath;
    if (
      resolvedSync &&
      threadWorktreePath &&
      editor !== "file-manager" &&
      readEnvironmentScope(environmentId, AuthSourceControlWriteScope) &&
      remapPathToEditorWorktree({
        targetPath,
        threadWorktreePath,
        editorWorktreePath: threadWorktreePath,
      }) !== null
    ) {
      const editorLabel = EDITORS.find((candidate) => candidate.id === editor)?.label ?? editor;
      const pushOutcome = await pushWorktreeBeforeFileOpen({
        environmentId,
        cwd: threadWorktreePath,
        threadId: resolvedSync.threadId,
        projectId: resolvedSync.projectId,
        editorLabel,
      });
      if (pushOutcome.status === "cancelled") {
        return AsyncResult.success(editor);
      }
      if (pushOutcome.status === "pushed") {
        effectiveTargetPath =
          remapPathToEditorWorktree({
            targetPath,
            threadWorktreePath,
            editorWorktreePath: pushOutcome.editorWorktreePath,
          }) ?? pushOutcome.editorWorktreePath;
        effectiveProjectRoot = pushOutcome.editorWorktreePath;
      }
    }

    const uri = /^file:\/\//iu.test(effectiveTargetPath)
      ? parseFileUrlHref(effectiveTargetPath)
      : null;
    const { line, column } = uri ? splitFilePathPosition("", uri.hash) : {};
    const result = await openInEditor({
      environmentId,
      input: {
        cwd: uri ? safeDecodeURIComponent(uri.path) : effectiveTargetPath,
        ...(uri ? { position: { line, column } } : {}),
        editor,
        ...(effectiveProjectRoot ? { projectRoot: effectiveProjectRoot } : {}),
      },
    });
    return mapAtomCommandResult(result, () => editor);
  };
}
