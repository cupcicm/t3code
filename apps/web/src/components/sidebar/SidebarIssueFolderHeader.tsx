import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, InboxIcon, SquarePenIcon } from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useLinkedIssueDetail } from "../../state/issues";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { IssueGlyph, issueStatePresentation } from "../issue/issuePresentation";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarIssuePullRequestsPopover } from "./SidebarIssuePullRequestsPopover";
import {
  SIDEBAR_UNLINKED_ISSUE_KEY,
  collectThreadPullRequestsForIssue,
  sidebarIssueFolderRowId,
  type SidebarIssueGroup,
} from "./sidebarIssues.logic";

const FOLDER_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const FOLDER_DOT_LABEL = {
  attention: msg(", needs you", { $context: "issue folder status, read after its name" }),
  failed: msg(", failed", { $context: "issue folder status, read after its name" }),
  unread: msg(", done", { $context: "issue folder status, read after its name" }),
  working: msg(", working", { $context: "issue folder status, read after its name" }),
} as const;

export const SidebarIssueFolderHeader = memo(function SidebarIssueFolderHeader(props: {
  group: SidebarIssueGroup<EnvironmentThreadShell>;
  collapsed: boolean;
  hiddenThreads: readonly EnvironmentThreadShell[];
  routeThreadRef: ScopedThreadRef | null;
  prPopoverOpenRequestSeq: number | null;
  onToggle: (issueKey: string) => void;
  onNewThread: (group: SidebarIssueGroup<EnvironmentThreadShell>) => void;
  onContextMenu: (
    group: SidebarIssueGroup<EnvironmentThreadShell>,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { group, collapsed, hiddenThreads } = props;
  const rowId = sidebarIssueFolderRowId(group.issueKey);
  const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const detail = useLinkedIssueDetail(group.environmentId, group.link, "sidebar");
  const statePresentation = detail === null ? null : issueStatePresentation(detail.state);
  const IssueIcon = statePresentation?.Icon ?? IssueGlyph.issue;
  const title = detail?.title ?? group.link.title;
  const threadPullRequests = collectThreadPullRequestsForIssue(group.allLinkedThreads);
  const [prPopoverOpen, setPrPopoverOpen] = useState(false);
  const [handledRequestSeq, setHandledRequestSeq] = useState<number | null>(null);
  if (
    props.prPopoverOpenRequestSeq !== null &&
    props.prPopoverOpenRequestSeq !== handledRequestSeq
  ) {
    setHandledRequestSeq(props.prPopoverOpenRequestSeq);
    setPrPopoverOpen(true);
  }
  const dot = collapsed
    ? resolveSidebarFolderDot(
        hiddenThreads.map((thread) => ({
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(
            thread.lastVisitedAt,
            localLastVisitedAtById[
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
            ],
          ),
        })),
      )
    : null;

  return (
    <li
      data-testid="sidebar-issue-folder"
      className="group/issue-folder relative mt-2 list-none first:mt-0"
    >
      <div className="flex h-8 w-full items-center rounded-(--control-radius) hover:bg-sidebar-row-hover">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                data-sidebar-row={rowId}
                aria-expanded={!collapsed}
                onClick={() => props.onToggle(group.issueKey)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  props.onContextMenu(
                    group,
                    { x: event.clientX, y: event.clientY },
                    contextMenuSourceOf(event),
                  );
                }}
                className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-(--control-radius) ps-(--sidebar-row-content-inset) pe-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <IssueIcon
              aria-hidden
              className={cn(
                "size-4 shrink-0",
                statePresentation?.toneClassName ?? "text-sidebar-muted-foreground",
              )}
            />
            <span className="shrink-0 font-mono text-xs tabular-nums text-sidebar-muted-foreground">
              {group.link.displayKey}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90">
              {title}
            </span>
            {dot ? (
              <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
                <span className="sr-only">{m(FOLDER_DOT_LABEL[dot])}</span>
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="right" align="start">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">
                {group.link.displayKey} · {title}
              </span>
              {statePresentation ? (
                <span className="text-muted-foreground">{statePresentation.label}</span>
              ) : null}
            </div>
          </TooltipPopup>
        </Tooltip>
        <div className="flex shrink-0 items-center gap-0.5 pe-(--sidebar-row-content-inset)">
          <span
            className={cn(
              "inline-flex items-center gap-0.5",
              threadPullRequests.length === 0 &&
                !prPopoverOpen &&
                "opacity-0 focus-within:opacity-100 group-hover/issue-folder:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            <SidebarIssuePullRequestsPopover
              group={group}
              rowId={rowId}
              routeThreadRef={props.routeThreadRef}
              open={prPopoverOpen}
              onOpenChange={setPrPopoverOpen}
              linkedPullRequestCount={threadPullRequests.length}
            />
          </span>
          <span className="inline-flex items-center opacity-0 focus-within:opacity-100 group-hover/issue-folder:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    data-sidebar-action-for={rowId}
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={gt("New thread in {issue}", { issue: group.link.displayKey })}
                    onClick={() => props.onNewThread(group)}
                  />
                }
              >
                <SquarePenIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>
                <T>
                  New thread in <Var>{group.link.displayKey}</Var>
                </T>
              </TooltipPopup>
            </Tooltip>
          </span>
          {collapsed && hiddenThreads.length > 0 ? (
            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
              {hiddenThreads.length}
            </span>
          ) : null}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={() => props.onToggle(group.issueKey)}
            className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center text-sidebar-muted-foreground"
          >
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
            />
          </button>
        </div>
      </div>
    </li>
  );
});

export const SidebarUnlinkedIssueFolderHeader = memo(
  function SidebarUnlinkedIssueFolderHeader(props: {
    collapsed: boolean;
    hiddenThreads: readonly EnvironmentThreadShell[];
    onToggle: (issueKey: string) => void;
  }) {
    const m = useMessages();
    const { collapsed, hiddenThreads } = props;
    const rowId = sidebarIssueFolderRowId(SIDEBAR_UNLINKED_ISSUE_KEY);
    const localLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
    const dot = collapsed
      ? resolveSidebarFolderDot(
          hiddenThreads.map((thread) => ({
            ...thread,
            lastVisitedAt: resolveThreadLastVisitedAt(
              thread.lastVisitedAt,
              localLastVisitedAtById[
                scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
              ],
            ),
          })),
        )
      : null;

    return (
      <li
        data-testid="sidebar-unlinked-issue-folder"
        className="group/issue-folder relative mt-2 list-none first:mt-0"
      >
        <button
          type="button"
          data-sidebar-row={rowId}
          aria-expanded={!collapsed}
          onClick={() => props.onToggle(SIDEBAR_UNLINKED_ISSUE_KEY)}
          className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <InboxIcon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-muted-foreground">
            <T>No issue</T>
          </span>
          {dot ? (
            <span className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}>
              <span className="sr-only">{m(FOLDER_DOT_LABEL[dot])}</span>
            </span>
          ) : null}
          {collapsed && hiddenThreads.length > 0 ? (
            <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
              {hiddenThreads.length}
            </span>
          ) : null}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
              collapsed && "-rotate-90",
            )}
          />
        </button>
      </li>
    );
  },
);
