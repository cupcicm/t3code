import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { visibleThreadPullRequests } from "@t3tools/client-runtime/thread-pull-requests";
import {
  threadIssueKeyOf,
  type EnvironmentId,
  type IssueLinkedPullRequest,
  type ProjectId,
  type PullRequestActor,
  type PullRequestChecksState,
  type PullRequestListEntry,
  type PullRequestReviewDecision,
  type PullRequestState,
  type ThreadId,
  type ThreadIssueLink,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";

export const SIDEBAR_UNLINKED_ISSUE_KEY = "__unlinked__";

const ISSUE_ROW_PREFIX = "issue-row:";
const ISSUE_ROW_SEPARATOR = "\u0001";
const BRACKETED_ISSUE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export function sidebarIssueFolderRowId(issueKey: string): string {
  return `issue-folder:${issueKey}`;
}

export function sidebarIssueExpansionKey(issueKey: string): string {
  return `issue:${issueKey}`;
}

export function sidebarIssueThreadRowId(issueKey: string, threadKey: string): string {
  return `${ISSUE_ROW_PREFIX}${issueKey}${ISSUE_ROW_SEPARATOR}${threadKey}`;
}

export function extractThreadKeyFromSidebarSortableId(sortableId: string): string {
  if (!sortableId.startsWith(ISSUE_ROW_PREFIX)) return sortableId;
  const separatorIndex = sortableId.indexOf(ISSUE_ROW_SEPARATOR, ISSUE_ROW_PREFIX.length);
  return separatorIndex === -1 ? sortableId : sortableId.slice(separatorIndex + 1);
}

export function issuePullRequestSearchQuery(issue: Pick<ThreadIssueLink, "displayKey">): string {
  const trimmed = issue.displayKey.trim();
  return BRACKETED_ISSUE_KEY_PATTERN.test(trimmed) ? `[${trimmed}]` : trimmed;
}

export interface SidebarIssueGroup<TThread> {
  readonly issueKey: string;
  readonly link: ThreadIssueLink;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectIdsByEnvironment: ReadonlyMap<EnvironmentId, readonly ProjectId[]>;
  readonly threads: readonly TThread[];
  readonly allLinkedThreads: readonly TThread[];
}

type IssueGroupingThread = Pick<
  SidebarThreadSummary,
  | "environmentId"
  | "id"
  | "projectId"
  | "issues"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "latestRun"
>;

function threadActivityMs(thread: IssueGroupingThread): number {
  const timestamp = resolveThreadActivityTimestamp(thread);
  if (timestamp === null) return 0;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function groupSidebarThreadsByIssue<TThread extends IssueGroupingThread>(input: {
  readonly activeThreads: readonly TThread[];
  readonly allVisibleThreads: readonly TThread[];
}): {
  readonly issueGroups: readonly SidebarIssueGroup<TThread>[];
  readonly unlinkedThreads: readonly TThread[];
} {
  const unlinkedThreads: TThread[] = [];
  const groupsByKey = new Map<
    string,
    {
      issueKey: string;
      link: ThreadIssueLink;
      environmentId: EnvironmentId;
      projectId: ProjectId;
      projectIdsByEnvironment: Map<EnvironmentId, Set<ProjectId>>;
      threads: TThread[];
      allLinkedThreads: TThread[];
      allLinkedThreadKeys: Set<string>;
      latestActivityMs: number;
    }
  >();

  const addProjectId = (
    map: Map<EnvironmentId, Set<ProjectId>>,
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => {
    let set = map.get(environmentId);
    if (set === undefined) {
      set = new Set();
      map.set(environmentId, set);
    }
    set.add(projectId);
  };

  for (const thread of input.activeThreads) {
    const links = thread.issues ?? [];
    if (links.length === 0) {
      unlinkedThreads.push(thread);
      continue;
    }
    const seenOnThread = new Set<string>();
    const activityMs = threadActivityMs(thread);
    for (const link of links) {
      const issueKey = threadIssueKeyOf(link);
      if (seenOnThread.has(issueKey)) continue;
      seenOnThread.add(issueKey);
      let group = groupsByKey.get(issueKey);
      if (group === undefined) {
        const projectIdsByEnvironment = new Map<EnvironmentId, Set<ProjectId>>();
        addProjectId(projectIdsByEnvironment, thread.environmentId, link.projectId);
        addProjectId(projectIdsByEnvironment, thread.environmentId, thread.projectId);
        group = {
          issueKey,
          link,
          environmentId: thread.environmentId,
          projectId: link.projectId,
          projectIdsByEnvironment,
          threads: [thread],
          allLinkedThreads: [],
          allLinkedThreadKeys: new Set(),
          latestActivityMs: activityMs,
        };
        groupsByKey.set(issueKey, group);
      } else {
        group.threads.push(thread);
        addProjectId(group.projectIdsByEnvironment, thread.environmentId, link.projectId);
        addProjectId(group.projectIdsByEnvironment, thread.environmentId, thread.projectId);
        if (activityMs > group.latestActivityMs) {
          group.latestActivityMs = activityMs;
          group.link = link;
          group.environmentId = thread.environmentId;
          group.projectId = link.projectId;
        }
      }
    }
  }

  for (const thread of input.allVisibleThreads) {
    const links = thread.issues ?? [];
    if (links.length === 0) continue;
    const threadKey = `${thread.environmentId}:${thread.id}`;
    for (const link of links) {
      const group = groupsByKey.get(threadIssueKeyOf(link));
      if (group === undefined) continue;
      addProjectId(group.projectIdsByEnvironment, thread.environmentId, link.projectId);
      addProjectId(group.projectIdsByEnvironment, thread.environmentId, thread.projectId);
      if (!group.allLinkedThreadKeys.has(threadKey)) {
        group.allLinkedThreadKeys.add(threadKey);
        group.allLinkedThreads.push(thread);
      }
    }
  }

  const issueGroups = [...groupsByKey.values()]
    .toSorted(
      (left, right) =>
        right.latestActivityMs - left.latestActivityMs ||
        left.link.displayKey.localeCompare(right.link.displayKey) ||
        left.issueKey.localeCompare(right.issueKey),
    )
    .map((group): SidebarIssueGroup<TThread> => ({
      issueKey: group.issueKey,
      link: group.link,
      environmentId: group.environmentId,
      projectId: group.projectId,
      projectIdsByEnvironment: new Map(
        [...group.projectIdsByEnvironment].map(
          ([environmentId, projectIds]) => [environmentId, [...projectIds]] as const,
        ),
      ),
      threads: group.threads,
      allLinkedThreads: group.allLinkedThreads,
    }));

  return { issueGroups, unlinkedThreads };
}

export type IssuePullRequestSource = "thread" | "tracker" | "search";

export interface IssuePullRequestItem {
  readonly key: string;
  readonly host: string | null;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly updatedAt: string | null;
  readonly checksState: PullRequestChecksState | null;
  readonly reviewDecision: PullRequestReviewDecision | null;
  readonly headBranch: string | null;
  readonly baseBranch: string | null;
  readonly author: PullRequestActor | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly sources: readonly IssuePullRequestSource[];
}

function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function pullRequestKey(host: string | null, repository: string, number: number): string {
  return `${(host ?? "").trim().toLowerCase()}/${repository.trim().toLowerCase()}#${number}`;
}

function pullRequestStateRank(item: Pick<IssuePullRequestItem, "state" | "isDraft">): number {
  if (item.state === "open") return item.isDraft ? 1 : 0;
  if (item.state === "merged") return 2;
  return 3;
}

function parseTimestampMs(value: string | null): number {
  if (value === null) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function comparePullRequests(left: IssuePullRequestItem, right: IssuePullRequestItem): number {
  const rankDiff = pullRequestStateRank(left) - pullRequestStateRank(right);
  if (rankDiff !== 0) return rankDiff;
  const timeDiff = parseTimestampMs(right.updatedAt) - parseTimestampMs(left.updatedAt);
  if (timeDiff !== 0) return timeDiff;
  return right.number - left.number || left.repository.localeCompare(right.repository);
}

function mergeSources(
  left: readonly IssuePullRequestSource[],
  right: readonly IssuePullRequestSource[],
): readonly IssuePullRequestSource[] {
  const merged = [...left];
  for (const source of right) {
    if (!merged.includes(source)) merged.push(source);
  }
  return merged;
}

function isNewerPullRequest(
  existing: IssuePullRequestItem,
  incoming: IssuePullRequestItem,
): boolean {
  const existingMs = parseTimestampMs(existing.updatedAt);
  const incomingMs = parseTimestampMs(incoming.updatedAt);
  if (incomingMs !== existingMs) return incomingMs > existingMs;
  if (incoming.sources.includes("search") && !existing.sources.includes("search")) return true;
  if (
    existing.title === `${existing.repository}#${existing.number}` &&
    incoming.title !== existing.title
  ) {
    return true;
  }
  return false;
}

function combinePullRequestItems(
  existing: IssuePullRequestItem,
  incoming: IssuePullRequestItem,
): IssuePullRequestItem {
  const preferIncoming = isNewerPullRequest(existing, incoming);
  const primary = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;
  return {
    key: primary.key,
    host: primary.host ?? secondary.host,
    repository: primary.repository,
    number: primary.number,
    title: primary.title || secondary.title,
    url: primary.url || secondary.url,
    state: primary.state,
    isDraft: primary.isDraft,
    updatedAt: primary.updatedAt ?? secondary.updatedAt,
    checksState: primary.checksState ?? secondary.checksState,
    reviewDecision: primary.reviewDecision ?? secondary.reviewDecision,
    headBranch: primary.headBranch ?? secondary.headBranch,
    baseBranch: primary.baseBranch ?? secondary.baseBranch,
    author: primary.author ?? secondary.author,
    environmentId: primary.environmentId,
    projectId: primary.projectId,
    sources: mergeSources(existing.sources, incoming.sources),
  };
}

type PullRequestThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "projectId" | "pullRequests" | "linkedPullRequest" | "branchPullRequest"
> & { readonly id?: ThreadId };

function fromThreadPullRequestLink(
  link: ThreadPullRequestLink,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): IssuePullRequestItem {
  const host = link.host.trim().toLowerCase() || hostFromUrl(link.url);
  return {
    key: pullRequestKey(host, link.repository, link.number),
    host,
    repository: link.repository,
    number: link.number,
    title: link.snapshot?.title ?? `${link.repository}#${link.number}`,
    url: link.url,
    state: link.snapshot?.state ?? "open",
    isDraft: link.snapshot?.isDraft ?? false,
    updatedAt: link.snapshot?.updatedAt ?? link.linkedAt,
    checksState: link.snapshot?.checksState ?? null,
    reviewDecision: link.snapshot?.reviewDecision ?? null,
    headBranch: link.snapshot?.headBranch ?? null,
    baseBranch: link.snapshot?.baseBranch ?? null,
    author: link.snapshot?.author ?? null,
    environmentId,
    projectId,
    sources: ["thread"],
  };
}

export function collectThreadPullRequestsForIssue(
  threads: readonly PullRequestThread[],
): readonly IssuePullRequestItem[] {
  const byKey = new Map<string, IssuePullRequestItem>();
  const add = (item: IssuePullRequestItem) => {
    const existing = byKey.get(item.key);
    byKey.set(item.key, existing === undefined ? item : combinePullRequestItems(existing, item));
  };

  for (const thread of threads) {
    for (const link of visibleThreadPullRequests(thread.pullRequests)) {
      add(fromThreadPullRequestLink(link, thread.environmentId, thread.projectId));
    }
    for (const fallbackPr of [thread.linkedPullRequest, thread.branchPullRequest]) {
      if (!fallbackPr) continue;
      const host = hostFromUrl(fallbackPr.url);
      add({
        key: pullRequestKey(host, fallbackPr.repository, fallbackPr.number),
        host,
        repository: fallbackPr.repository,
        number: fallbackPr.number,
        title: `${fallbackPr.repository}#${fallbackPr.number}`,
        url: fallbackPr.url,
        state: "open",
        isDraft: false,
        updatedAt: null,
        checksState: null,
        reviewDecision: null,
        headBranch: null,
        baseBranch: null,
        author: null,
        environmentId: thread.environmentId,
        projectId: fallbackPr.projectId,
        sources: ["thread"],
      });
    }
  }

  return [...byKey.values()].toSorted(comparePullRequests);
}

export function mergeIssuePullRequests(input: {
  readonly threadPullRequests: readonly IssuePullRequestItem[];
  readonly trackerPullRequests: readonly IssueLinkedPullRequest[];
  readonly searchedPullRequests: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly entry: PullRequestListEntry;
  }>;
  readonly fallbackEnvironmentId: EnvironmentId;
  readonly fallbackProjectId: ProjectId;
}): readonly IssuePullRequestItem[] {
  const byKey = new Map<string, IssuePullRequestItem>();
  const add = (item: IssuePullRequestItem) => {
    const existing = byKey.get(item.key);
    byKey.set(item.key, existing === undefined ? item : combinePullRequestItems(existing, item));
  };

  for (const item of input.threadPullRequests) {
    add(item);
  }

  for (const link of input.trackerPullRequests) {
    const host = hostFromUrl(link.url);
    add({
      key: pullRequestKey(host, link.repository, link.number),
      host,
      repository: link.repository,
      number: link.number,
      title: link.title,
      url: link.url,
      state: link.state,
      isDraft: link.isDraft,
      updatedAt: null,
      checksState: null,
      reviewDecision: null,
      headBranch: null,
      baseBranch: null,
      author: null,
      environmentId: input.fallbackEnvironmentId,
      projectId: input.fallbackProjectId,
      sources: ["tracker"],
    });
  }

  for (const { environmentId, entry } of input.searchedPullRequests) {
    const host = entry.host.trim().toLowerCase() || hostFromUrl(entry.url);
    add({
      key: pullRequestKey(host, entry.repository, entry.number),
      host,
      repository: entry.repository,
      number: entry.number,
      title: entry.title,
      url: entry.url,
      state: entry.state,
      isDraft: entry.isDraft,
      updatedAt: entry.updatedAt,
      checksState: entry.checksState ?? null,
      reviewDecision: entry.reviewDecision ?? null,
      headBranch: entry.headBranch,
      baseBranch: entry.baseBranch,
      author: entry.author ?? null,
      environmentId,
      projectId: entry.projectId,
      sources: ["search"],
    });
  }

  return [...byKey.values()].toSorted(comparePullRequests);
}
