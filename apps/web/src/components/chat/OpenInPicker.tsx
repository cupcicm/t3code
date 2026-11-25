import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import { memo, use, useRef } from "react";
import { BackgroundThreadContext } from "./backgroundThread";
import { shortcutLabelForCommand } from "../../keybindings";
import { OPEN_FAVORITE_EDITOR_ATTRIBUTE } from "./OpenInPickerShortcut";
import { usePreferredEditor } from "../../editorPreferences";
import { editorLabelForPlatform } from "../../editorLabels";
import { type EditorWorktreeSyncTarget, useEditorWorktreeActions } from "../../editorWorktreeSync";
import type { MessageResolver } from "../../i18n/messages";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
} from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import {
  ArrowDownToLineIcon,
  ChevronDownIcon,
  FolderClosedIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";

import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AntigravityIcon,
  CursorIcon,
  FileExplorerIcon,
  FinderIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { announce } from "~/lib/announce";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useComposerMenuState } from "./useComposerMenuState";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
  resolve: MessageResolver,
) => {
  const baseOptions: ReadonlyArray<Omit<OpenInOption, "label">> = [
    {
      Icon: CursorIcon,
      value: "cursor",
      kind: "brand",
    },
    {
      Icon: TraeIcon,
      value: "trae",
      kind: "brand",
    },
    {
      Icon: KiroIcon,
      value: "kiro",
      kind: "brand",
    },
    {
      Icon: VisualStudioCode,
      value: "vscode",
      kind: "brand",
    },
    {
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
      kind: "brand",
    },
    {
      Icon: VSCodium,
      value: "vscodium",
      kind: "brand",
    },
    {
      Icon: Zed,
      value: "zed",
      kind: "brand",
    },
    {
      Icon: AntigravityIcon,
      value: "antigravity",
      kind: "brand",
    },
    {
      Icon: IntelliJIdeaIcon,
      value: "idea",
      kind: "brand",
    },
    {
      Icon: AquaIcon,
      value: "aqua",
      kind: "brand",
    },
    {
      Icon: CLionIcon,
      value: "clion",
      kind: "brand",
    },
    {
      Icon: DataGripIcon,
      value: "datagrip",
      kind: "brand",
    },
    {
      Icon: DataSpellIcon,
      value: "dataspell",
      kind: "brand",
    },
    {
      Icon: GoLandIcon,
      value: "goland",
      kind: "brand",
    },
    {
      Icon: PhpStormIcon,
      value: "phpstorm",
      kind: "brand",
    },
    {
      Icon: PyCharmIcon,
      value: "pycharm",
      kind: "brand",
    },
    {
      Icon: RiderIcon,
      value: "rider",
      kind: "brand",
    },
    {
      Icon: RubyMineIcon,
      value: "rubymine",
      kind: "brand",
    },
    {
      Icon: RustRoverIcon,
      value: "rustrover",
      kind: "brand",
    },
    {
      Icon: WebStormIcon,
      value: "webstorm",
      kind: "brand",
    },
    {
      Icon: isMacPlatform(platform)
        ? FinderIcon
        : isWindowsPlatform(platform)
          ? FileExplorerIcon
          : FolderClosedIcon,
      value: "file-manager",
      kind: isMacPlatform(platform) || isWindowsPlatform(platform) ? "brand" : "generic",
    },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({
      ...option,
      label: editorLabelForPlatform(option.value, platform, resolve),
    }));
};

function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  openInCwdIsFile = false,
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
  displayMode = "toolbar",
  revealFileManager = false,
  worktreeSync,
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  openInCwdIsFile?: boolean;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
  displayMode?: "toolbar" | "panel";
  revealFileManager?: boolean;
  worktreeSync?: EditorWorktreeSyncTarget | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const isHostEditorDenied = remote.mode === "local-exec" && !canOperateHost;
  const canOpenEditor = remote.mode !== "remote-unavailable" && !isHostEditorDenied;
  const [menuOpen, setMenuOpen] = useComposerMenuState(isHostEditorDenied);
  const remoteCapableEditors = useRemoteCapableEditors();
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  const environmentLabel = useEnvironment(environmentId)?.label ?? null;
  // Remote editors run on the viewing machine; only desktop can probe that PATH.
  const effectiveEditors = remote.mode === "local-exec" ? availableEditors : remoteCapableEditors;
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);

  const editorSync = useEditorWorktreeActions({
    environmentId,
    target: worktreeSync,
    remote,
    markRemoteHintSeen,
  });

  const isWorktreeSyncMode =
    Boolean(worktreeSync?.worktreePath) &&
    preferredEditor !== null &&
    preferredEditor !== "file-manager" &&
    editorSync.status?.isLinkedWorktree !== false;

  const openInEditorDirect = async (editorId: EditorId | null): Promise<boolean> => {
    if (!openInCwd) return false;
    const editor = editorId ?? preferredEditor;
    if (!editor) return false;
    if (remote.mode === "remote-unavailable") return false;
    if (remote.mode === "remote-links") {
      const url = buildRemoteOpenUrl({
        editor,
        ...remote.host,
        absolutePath: openInCwd,
        isFile: openInCwdIsFile,
      });
      if (url === undefined) return false;
      // Only record hint-seen/preferred when the shell actually accepted
      // the URL (an older desktop build can refuse the editor scheme).
      const opened = await openRemoteEditorUrl(url);
      if (!opened) return false;
      markRemoteHintSeen();
      setPreferredEditor(editor);
      return true;
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
    const result = openInEditorMutation({
      environmentId,
      input: {
        cwd: openInCwd,
        editor,
        ...(revealFileManager && editor === "file-manager" ? { reveal: true } : {}),
      },
    });
    setPreferredEditor(editor);
    return (await result)._tag === "Success";
  };

  const openOrPushEditor = async (editorId: EditorId | null): Promise<boolean> => {
    const editor = editorId ?? preferredEditor;
    if (!editor) return false;
    if (
      Boolean(worktreeSync?.worktreePath) &&
      editor !== "file-manager" &&
      editorSync.status?.isLinkedWorktree !== false &&
      editorSync.canWriteSourceControl
    ) {
      setPreferredEditor(editor);
      return editorSync.pushToEditor({
        editor,
        targetPath: openInCwd,
        targetIsFile: openInCwdIsFile,
        resolve: messages,
      });
    }
    return openInEditorDirect(editor);
  };

  const openFavoriteEditorShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "editor.openFavorite",
  );

  const backgroundThread = use(BackgroundThreadContext);
  const options = resolveOpenInOptions(navigator.platform, effectiveEditors, messages);
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  const primaryLabel = isWorktreeSyncMode
    ? isPanel
      ? primaryOption
        ? gt("Push to {editor}", { editor: primaryOption.label })
        : gt("Push to editor")
      : gt("Push", { $context: "verb, syncs worktree changes to the dedicated editor worktree" })
    : isPanel
      ? primaryOption
        ? gt("Open in {editor}", { editor: primaryOption.label })
        : gt("Open in editor")
      : gt("Open", { $context: "verb, opens the project in the preferred editor" });

  const unavailableReason =
    remote.mode === "remote-unavailable"
      ? environmentLabel !== null
        ? gt("No SSH route to {environment}", { environment: environmentLabel })
        : gt("No SSH route to this machine")
      : remote.mode === "remote-links" && options.length === 0
        ? environmentLabel !== null
          ? gt("Open from a computer to edit on {environment}", { environment: environmentLabel })
          : gt("Open from a computer to edit on this machine")
        : null;

  const editorItems = (
    <>
      {unavailableReason !== null ? (
        <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
          {unavailableReason}
        </MenuItem>
      ) : (
        <>
          {options.length === 0 && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              <T>No installed editors found</T>
            </MenuItem>
          )}
          {options.map(({ label, Icon, value, kind }) => (
            <MenuItem
              density={presentation === "menu" ? "touch" : "default"}
              disabled={!openInCwd || !canOpenEditor}
              key={value}
              onClick={() => {
                if (presentation === "menu") {
                  void openOrPushEditor(value);
                } else {
                  setPreferredEditor(value);
                }
              }}
            >
              <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
              <MenuItemLabel>{label}</MenuItemLabel>
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
          {isWorktreeSyncMode && primaryOption && openInCwd ? (
            <>
              <MenuSeparator />
              <MenuItem
                density={presentation === "menu" ? "touch" : "default"}
                disabled={!canOpenEditor}
                onClick={() => {
                  void openInEditorDirect(primaryOption.value);
                }}
              >
                <SquareArrowOutUpRightIcon aria-hidden="true" className="text-muted-foreground" />
                <MenuItemLabel>
                  {gt("Open worktree directly in {editor}", { editor: primaryOption.label })}
                </MenuItemLabel>
              </MenuItem>
            </>
          ) : null}
          {remote.mode === "remote-links" && !remoteHintSeen && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              {environmentLabel !== null
                ? gt("Opens over SSH. Needs your key on {environment}", {
                    environment: environmentLabel,
                  })
                : gt("Opens over SSH. Needs your key on this machine")}
            </MenuItem>
          )}
        </>
      )}
    </>
  );
  if (presentation === "menu") {
    return (
      <>
        {primaryOption && (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}
            disabled={!openInCwd || !canOpenEditor || editorSync.isPushing}
            onClick={() => openOrPushEditor(preferredEditor)}
          >
            <primaryOption.Icon className={cn("size-4", getOpenInIconClass(primaryOption.kind))} />
            <MenuItemLabel>
              {isWorktreeSyncMode ? (
                <T>
                  Push to <Var>{primaryOption.label}</Var>
                </T>
              ) : (
                <T>
                  Open in <Var>{primaryOption.label}</Var>
                </T>
              )}
            </MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub>
          <MenuSubTrigger density="touch" disabled={isHostEditorDenied}>
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>
              <T>Open in…</T>
            </MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
      </>
    );
  }

  const primaryDisabled = isWorktreeSyncMode
    ? !preferredEditor ||
      !openInCwd ||
      !canOpenEditor ||
      !editorSync.canWriteSourceControl ||
      editorSync.isPushing ||
      editorSync.isPulling
    : !preferredEditor || !openInCwd || !canOpenEditor;

  const primaryControlLabel = compact
    ? isWorktreeSyncMode && primaryOption
      ? gt("Push and open file in {editor}", { editor: primaryOption.label })
      : gt("Open file in preferred editor")
    : primaryLabel;

  const primaryControl = (
    <ThreadDetailsControl
      aria-label={primaryControlLabel}
      // Tooltip replaces the button data-slot, so toolbar theming needs a separate hook.
      data-toolbar-control=""
      size={isPanel ? "sm" : "xs"}
      variant={isPanel ? "ghost" : "outline"}
      part="primary"
      panel={isPanel}
      disabled={primaryDisabled}
      {...(enableShortcut && !backgroundThread ? { [OPEN_FAVORITE_EDITOR_ATTRIBUTE]: "" } : {})}
      onClick={() => {
        if (!preferredEditor) return;
        const label = editorLabelForPlatform(preferredEditor, navigator.platform);
        void openOrPushEditor(preferredEditor).then((opened) => {
          if (opened) {
            announce(
              isWorktreeSyncMode
                ? gt("Pushed to {editor}", { editor: label })
                : gt("Opened in {editor}", { editor: label }),
            );
          }
        });
      }}
    >
      {editorSync.isPushing ? (
        isPanel ? (
          <Spinner aria-hidden="true" className="size-4 shrink-0" />
        ) : (
          <Spinner aria-hidden="true" className="size-3.5" />
        )
      ) : primaryOption?.Icon ? (
        <primaryOption.Icon
          aria-hidden="true"
          className={cn(
            isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5",
            getOpenInIconClass(primaryOption.kind),
          )}
        />
      ) : isPanel ? (
        <SquareArrowOutUpRightIcon aria-hidden="true" className={THREAD_DETAILS_PANEL_ICON_CLASS} />
      ) : null}
      <span
        className={cn(
          compact
            ? "sr-only"
            : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
          isPanel && cn("not-sr-only ml-0 min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
        )}
      >
        {primaryLabel}
      </span>
    </ThreadDetailsControl>
  );

  const isOwnerThread =
    worktreeSync !== undefined && editorSync.status?.ownerThreadId === worktreeSync.threadId;
  const isThreadWorking = worktreeSync?.isWorking === true;
  const canPullFromEditor =
    isWorktreeSyncMode &&
    isOwnerThread &&
    !isThreadWorking &&
    editorSync.canWriteSourceControl &&
    !editorSync.isPushing &&
    !editorSync.isPulling;

  const pullEditorName =
    primaryOption?.label ??
    (preferredEditor
      ? editorLabelForPlatform(preferredEditor, navigator.platform, messages)
      : null);
  const pullLabel = pullEditorName
    ? gt("Pull from {editor}", { editor: pullEditorName })
    : gt("Pull from editor");

  const pullTooltip = !editorSync.canWriteSourceControl
    ? gt("This connection cannot modify source control on this environment.")
    : isThreadWorking
      ? pullEditorName
        ? gt("Wait for the current turn to finish before pulling from {editor}.", {
            editor: pullEditorName,
          })
        : gt("Wait for the current turn to finish before pulling.")
      : !editorSync.status?.exists || editorSync.status.ownerThreadId === null
        ? pullEditorName
          ? gt("Push this thread to {editor} first.", { editor: pullEditorName })
          : gt("Push this thread to the editor first.")
        : !isOwnerThread
          ? pullEditorName
            ? gt("Another thread pushed to {editor} most recently.", { editor: pullEditorName })
            : gt("Another thread pushed to the editor most recently.")
          : pullEditorName
            ? gt("Pull committed and uncommitted changes from {editor} into this thread", {
                editor: pullEditorName,
              })
            : gt("Pull committed and uncommitted changes from the editor into this thread");

  const splitRow = (
    <ActionGroup
      aria-label={gt("Open in editor")}
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : {})}
    >
      <Tooltip>
        <TooltipTrigger render={primaryControl} />
        <TooltipPopup side="top">{primaryControlLabel}</TooltipPopup>
      </Tooltip>
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : (
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      )}
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                disabled={isHostEditorDenied}
                render={
                  <ThreadDetailsControl
                    aria-label={gt("Choose editor")}
                    data-toolbar-control=""
                    size={isPanel ? "sm" : "icon-xs"}
                    variant={isPanel ? "ghost" : "outline"}
                    part="secondary"
                    panel={isPanel}
                  />
                }
              />
            }
          >
            <ChevronDownIcon
              aria-hidden="true"
              className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <T>Choose editor</T>
          </TooltipPopup>
        </Tooltip>
        <MenuPopup
          align="end"
          {...(isPanel ? { anchor: panelAnchorRef } : {})}
          className={isPanel ? "w-(--anchor-width)" : undefined}
        >
          {editorItems}
        </MenuPopup>
      </Menu>
    </ActionGroup>
  );

  if (!isPanel || !isWorktreeSyncMode) {
    return splitRow;
  }

  return (
    <>
      {splitRow}
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="flex w-full">
              <ThreadDetailsControl
                aria-label={pullLabel}
                size="sm"
                variant="ghost"
                part="row"
                panel
                disabled={!canPullFromEditor}
                onClick={() => {
                  void editorSync.pullFromEditor({
                    editor: preferredEditor,
                    resolve: messages,
                  });
                }}
              >
                {editorSync.isPulling ? (
                  <Spinner aria-hidden="true" className="size-4 shrink-0" />
                ) : (
                  <ArrowDownToLineIcon
                    aria-hidden="true"
                    className={THREAD_DETAILS_PANEL_ICON_CLASS}
                  />
                )}
                <span className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
                  {pullLabel}
                </span>
                {isOwnerThread && editorSync.status?.hasUnpulledEditorChanges ? (
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
                ) : null}
              </ThreadDetailsControl>
            </span>
          }
        />
        <TooltipPopup side="top">{pullTooltip}</TooltipPopup>
      </Tooltip>
    </>
  );
});
