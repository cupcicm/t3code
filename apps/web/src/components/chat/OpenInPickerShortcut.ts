import {
  AuthSourceControlWriteScope,
  buildRemoteOpenUrl,
  type EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { useEffect } from "react";

import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import {
  type EditorWorktreeSyncTarget,
  runPushToEditorWorktreeWithConfirm,
} from "../../editorWorktreeSync";
import { isOpenFavoriteEditorShortcut } from "../../keybindings";
import { m } from "../../i18n/messages";
import { announce } from "../../lib/announce";
import { openRemoteEditorUrl, useRemoteCapableEditors, useRemoteOpenState } from "../../remoteOpen";
import { registerCommands } from "../../shortcuts/dispatcher";
import { readEnvironmentScope } from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";

/** Marks an OpenInPicker's primary button as the target of `editor.openFavorite`. */
export const OPEN_FAVORITE_EDITOR_ATTRIBUTE = "data-open-favorite-editor";

/**
 * `editor.openFavorite` presses the marked OpenInPicker primary button, so the shortcut opens
 * exactly what the button on screen would. A missing or disabled button leaves the chord to the
 * bubble-phase fallback below. Capture phase, so a focused terminal does not swallow the chord.
 */
export function registerOpenFavoriteEditorCommand(): () => void {
  return registerCommands(
    {
      "editor.openFavorite": (event) => {
        if (event.repeat) return false;
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>(`[${OPEN_FAVORITE_EDITOR_ATTRIBUTE}]`),
        ].at(-1);
        if (button === undefined || button.disabled) return false;
        event.preventDefault();
        button.click();
      },
    },
    { capture: true },
  );
}

export function useOpenFavoriteEditorShortcut({
  enabled,
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  worktreeSync,
}: {
  enabled: boolean;
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  worktreeSync?: EditorWorktreeSyncTarget | undefined;
}) {
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const pushToEditorWorktree = useAtomCommand(vcsEnvironment.pushToEditorWorktree, {
    reportFailure: false,
  });
  const remote = useRemoteOpenState(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();
  // Matches the picker: remote editors run on the viewing machine.
  const [preferredEditor] = usePreferredEditor(
    remote.mode === "local-exec" ? availableEditors : remoteCapableEditors,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a window keydown listener for the open-in-editor shortcut while enabled
  useEffect(() => {
    if (!enabled || remote.mode === "remote-unavailable") return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        event.repeat ||
        event.defaultPrevented ||
        !isOpenFavoriteEditorShortcut(event, keybindings)
      )
        return;
      if (!openInCwd || !preferredEditor) return;

      event.preventDefault();
      const label = editorLabelForPlatform(preferredEditor, navigator.platform);
      const launchAtPath = (targetPath: string, pushed: boolean) => {
        const announced = pushed
          ? m(msg("Pushed to {editor}", { editor: label }))
          : m(msg("Opened in {editor}", { editor: label }));
        if (remote.mode === "remote-links") {
          const url = buildRemoteOpenUrl({
            editor: preferredEditor,
            ...remote.host,
            absolutePath: targetPath,
          });
          if (url === undefined) return;
          void openRemoteEditorUrl(url).then((opened) => {
            if (opened) announce(announced);
          });
          return;
        }
        void openInEditorMutation({
          environmentId,
          input: {
            cwd: targetPath,
            editor: preferredEditor,
          },
        }).then((result) => {
          if (result._tag === "Success") announce(announced);
        });
      };

      if (
        worktreeSync?.worktreePath &&
        preferredEditor !== "file-manager" &&
        readEnvironmentScope(environmentId, AuthSourceControlWriteScope)
      ) {
        void runPushToEditorWorktreeWithConfirm({
          environmentId,
          cwd: worktreeSync.worktreePath,
          threadId: worktreeSync.threadId,
          projectId: worktreeSync.projectId,
          editorLabel: label,
          pushCommand: pushToEditorWorktree,
        }).then((pushed) => {
          if (pushed) launchAtPath(pushed.editorWorktreePath, true);
        });
        return;
      }

      launchAtPath(openInCwd, false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    enabled,
    environmentId,
    keybindings,
    openInCwd,
    openInEditorMutation,
    preferredEditor,
    pushToEditorWorktree,
    remote,
    worktreeSync,
  ]);
}
