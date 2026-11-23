import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";

import { cn } from "~/lib/utils";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { useServerConfigs } from "~/state/entities";
import { useLinkedIssueDetail } from "~/state/issues";
import { usePullRequestList } from "~/state/pullRequests";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import {
  PULL_REQUEST_ROW_CLASS,
  PULL_REQUEST_ROW_NUMBER_CLASS,
  PullRequestRowAuthor,
  PullRequestRowBranches,
  PullRequestRowGlyph,
  PullRequestRowLines,
} from "../pullRequest/PullRequestListRow";
import {
  PullRequestReviewDecisionGlyph,
  pullRequestChecksStatePresentation,
} from "../pullRequest/pullRequestPresentation";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { RefreshIcon } from "../ui/refresh-icon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  collectThreadPullRequestsForIssue,
  issuePullRequestSearchQuery,
  mergeIssuePullRequests,
  type IssuePullRequestItem,
  type SidebarIssueGroup,
} from "./sidebarIssues.logic";

function IssuePullRequestRow({
  item,
  routeThreadRef,
  onAfterOpen,
}: {
  item: IssuePullRequestItem;
  routeThreadRef: ScopedThreadRef | null;
  onAfterOpen: () => void;
}) {
  const resolve = useMessages();
  const openPrLink = useOpenPrLink(routeThreadRef ?? undefined);
  const open = item.state === "open";
  const checksPresentation =
    open && item.checksState ? pullRequestChecksStatePresentation(item.checksState, resolve) : null;
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        openPrLink(event, item.url, routeThreadRef ?? undefined);
        onAfterOpen();
      }}
      className={cn(
        PULL_REQUEST_ROW_CLASS,
        "px-2 hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      )}
    >
      <PullRequestRowGlyph state={item.state} isDraft={item.isDraft} />
      <PullRequestRowLines
        number={<span className={PULL_REQUEST_ROW_NUMBER_CLASS}>#{item.number}</span>}
        title={item.title}
        signals={
          open ? (
            <>
              {checksPresentation ? (
                <Tooltip>
                  <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
                    <checksPresentation.Icon
                      role="img"
                      aria-label={checksPresentation.label}
                      className={cn("size-3.5", checksPresentation.toneClassName)}
                    />
                  </TooltipTrigger>
                  <TooltipPopup>{checksPresentation.label}</TooltipPopup>
                </Tooltip>
              ) : null}
              {item.reviewDecision ? (
                <PullRequestReviewDecisionGlyph decision={item.reviewDecision} />
              ) : null}
            </>
          ) : null
        }
        meta={
          <>
            {item.author ? (
              <PullRequestRowAuthor
                actor={item.author}
                className="shrink-0"
                labelClassName="max-w-24"
              />
            ) : null}
            <span className="flex min-w-0 max-w-36 font-mono">
              <MiddleTruncate value={item.repository} showTitle={false} />
            </span>
            {item.headBranch && item.baseBranch ? (
              <PullRequestRowBranches head={item.headBranch} base={item.baseBranch} />
            ) : null}
          </>
        }
        updatedAt={item.updatedAt}
      />
    </a>
  );
}

function IssuePullRequestsPopoverBody({
  group,
  routeThreadRef,
  onClose,
}: {
  group: SidebarIssueGroup<EnvironmentThreadShell>;
  routeThreadRef: ScopedThreadRef | null;
  onClose: () => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const serverConfigs = useServerConfigs();
  const detail = useLinkedIssueDetail(group.environmentId, group.link, "sidebar-tooltip");
  const searchQuery = issuePullRequestSearchQuery(group.link);
  const searchTargets = [...group.projectIdsByEnvironment]
    .filter(([environmentId]) => serverConfigs.has(environmentId))
    .map(([environmentId, projectIds]) => ({
      environmentId,
      input: {
        state: "all" as const,
        involvement: "all" as const,
        projectIds: [...projectIds],
        query: searchQuery,
        limit: 50,
      },
    }));
  const searchList = usePullRequestList(searchTargets);
  const threadPullRequests = collectThreadPullRequestsForIssue(group.allLinkedThreads);
  const pullRequests = mergeIssuePullRequests({
    threadPullRequests,
    trackerPullRequests: detail?.linkedPullRequests ?? [],
    searchedPullRequests: (searchList.data?.entries ?? []).map((entry) => ({
      environmentId: entry.environmentId,
      entry,
    })),
    fallbackEnvironmentId: group.environmentId,
    fallbackProjectId: group.projectId,
  });

  const handleOpenInPullRequestsPage = () => {
    onClose();
    void navigate({
      to: "/pull-requests",
      search: {
        involvement: "all",
        state: "all",
        q: searchQuery,
      },
    });
  };

  return (
    <div className="flex max-h-[min(28rem,var(--available-height))] flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <PullRequestGlyph.pullRequest
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {gt("Pull requests for {issue}", { issue: group.link.displayKey })}
        </span>
        {pullRequests.length > 0 ? (
          <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
            {pullRequests.length}
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Refresh pull requests")}
                disabled={searchList.isPending}
                onClick={() => searchList.refresh()}
              />
            }
          >
            <RefreshIcon size="sm" refreshing={searchList.isPending} />
          </TooltipTrigger>
          <TooltipPopup>
            <T>Refresh pull requests</T>
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Open in Pull requests")}
                onClick={handleOpenInPullRequestsPage}
              />
            }
          >
            <ArrowUpRightIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>
            <T>Open in Pull requests</T>
          </TooltipPopup>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
        {pullRequests.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {pullRequests.map((item) => (
              <IssuePullRequestRow
                key={item.key}
                item={item}
                routeThreadRef={routeThreadRef}
                onAfterOpen={onClose}
              />
            ))}
          </div>
        ) : searchList.isPending ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            <T>
              Searching for <Var>{searchQuery}</Var>…
            </T>
          </p>
        ) : (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            <T>
              No pull requests found for <Var>{searchQuery}</Var>.
            </T>
          </p>
        )}
      </div>
      {searchList.isPending && pullRequests.length > 0 ? (
        <div className="border-t border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
          <T>
            Searching for <Var>{searchQuery}</Var>…
          </T>
        </div>
      ) : searchList.error !== null && !searchList.isPending ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
          <span className="min-w-0 truncate">{searchList.error.message}</span>
          <Button size="xs" variant="ghost" onClick={() => searchList.retry()}>
            <T>Retry</T>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function SidebarIssuePullRequestsPopover({
  group,
  rowId,
  routeThreadRef,
  open,
  onOpenChange,
  linkedPullRequestCount,
}: {
  group: SidebarIssueGroup<EnvironmentThreadShell>;
  rowId: string;
  routeThreadRef: ScopedThreadRef | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  linkedPullRequestCount: number;
}) {
  const gt = useGT();
  const label =
    linkedPullRequestCount > 0
      ? gt(
          "{count, plural, one {{count} pull request for {issue}} other {{count} pull requests for {issue}}}",
          { count: linkedPullRequestCount, issue: group.link.displayKey },
        )
      : gt("Pull requests for {issue}", { issue: group.link.displayKey });

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  data-sidebar-action-for={rowId}
                  data-testid="sidebar-issue-prs-trigger"
                  size={linkedPullRequestCount > 0 ? "xs" : "icon-xs"}
                  variant="ghost-muted"
                  aria-label={label}
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <PullRequestGlyph.pullRequest aria-hidden className="size-3 shrink-0" />
              {linkedPullRequestCount > 0 ? (
                <span className="text-2xs tabular-nums">{linkedPullRequestCount}</span>
              ) : null}
            </PopoverTrigger>
          }
        />
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      <PopoverPopup side="right" align="start" width="lg" padding="none">
        {open ? (
          <IssuePullRequestsPopoverBody
            group={group}
            routeThreadRef={routeThreadRef}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
