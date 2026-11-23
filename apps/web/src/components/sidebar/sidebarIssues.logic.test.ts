import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type IssueLinkedPullRequest,
  type PullRequestListEntry,
  type ThreadIssueLink,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectThreadPullRequestsForIssue,
  extractThreadKeyFromSidebarSortableId,
  groupSidebarThreadsByIssue,
  issuePullRequestSearchQuery,
  mergeIssuePullRequests,
  sidebarIssueThreadRowId,
} from "./sidebarIssues.logic";

const ENV_ID = EnvironmentId.make("env-1");
const PROJECT_A = ProjectId.make("proj-a");
const PROJECT_B = ProjectId.make("proj-b");

function makeIssueLink(overrides: Partial<ThreadIssueLink> = {}): ThreadIssueLink {
  return {
    tracker: IssueTrackerKind.make("linear"),
    host: "linear.app",
    scope: "WARP",
    key: "WARP-6069",
    projectId: PROJECT_A,
    url: "https://linear.app/warpstream/issue/WARP-6069",
    source: "manual",
    linkedAt: "2026-11-20T10:00:00.000Z",
    displayKey: "WARP-6069",
    title: "Fixes two bugs in DescribeProducers",
    ...overrides,
  };
}

function makeThread(
  id: string,
  overrides: Partial<{
    projectId: ProjectId;
    issues: readonly ThreadIssueLink[];
    pullRequests: readonly ThreadPullRequestLink[];
    createdAt: string;
    updatedAt: string;
    latestUserMessageAt: string | null;
  }> = {},
) {
  return {
    environmentId: ENV_ID,
    id: ThreadId.make(id),
    projectId: overrides.projectId ?? PROJECT_A,
    issues: overrides.issues ?? [],
    pullRequests: overrides.pullRequests ?? [],
    linkedPullRequest: null,
    branchPullRequest: null,
    createdAt: overrides.createdAt ?? "2026-11-20T09:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-11-20T09:00:00.000Z",
    latestUserMessageAt: overrides.latestUserMessageAt ?? "2026-11-20T09:00:00.000Z",
    latestRun: null,
  };
}

function makePrLink(
  number: number,
  overrides: Partial<ThreadPullRequestLink> = {},
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "warpstreamlabs/warpstream",
    number,
    url: `https://github.com/warpstreamlabs/warpstream/pull/${number}`,
    source: "created",
    linkedAt: "2026-11-20T10:00:00.000Z",
    snapshot: {
      state: "open",
      title: `[WARP-6069] PR ${number}`,
      headBranch: `cupcicm/pr/${number}`,
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-11-20T11:00:00.000Z",
      syncedAt: "2026-11-20T11:05:00.000Z",
    },
    stack: null,
    ...overrides,
  };
}

describe("sidebarIssues.logic", () => {
  it("groups active threads by issue, places multi-issue threads in every linked issue, and collects unlinked threads", () => {
    const issueA = makeIssueLink({ key: "WARP-6069", displayKey: "WARP-6069", title: "Issue A" });
    const issueB = makeIssueLink({
      key: "WARP-6029",
      displayKey: "WARP-6029",
      title: "Issue B",
      url: "https://linear.app/warpstream/issue/WARP-6029",
    });

    const threadShared = makeThread("t-shared", {
      issues: [issueA, issueB, issueA],
      latestUserMessageAt: "2026-11-20T12:00:00.000Z",
    });
    const threadB = makeThread("t-b", {
      issues: [issueB],
      projectId: PROJECT_B,
      latestUserMessageAt: "2026-11-20T13:00:00.000Z",
    });
    const threadSettled = makeThread("t-settled", {
      issues: [issueA],
      latestUserMessageAt: "2026-11-19T10:00:00.000Z",
    });
    const threadUnlinked = makeThread("t-unlinked", {
      issues: [],
      latestUserMessageAt: "2026-11-20T14:00:00.000Z",
    });

    const result = groupSidebarThreadsByIssue({
      activeThreads: [threadShared, threadB, threadUnlinked],
      allVisibleThreads: [threadShared, threadB, threadSettled, threadUnlinked],
    });

    expect(result.issueGroups.map((group) => group.link.displayKey)).toEqual([
      "WARP-6029",
      "WARP-6069",
    ]);
    expect(result.issueGroups[0]!.threads.map((thread) => thread.id)).toEqual(["t-shared", "t-b"]);
    expect(result.issueGroups[0]!.projectIdsByEnvironment.get(ENV_ID)).toEqual([
      PROJECT_A,
      PROJECT_B,
    ]);
    expect(result.issueGroups[1]!.threads.map((thread) => thread.id)).toEqual(["t-shared"]);
    expect(result.issueGroups[1]!.allLinkedThreads.map((thread) => thread.id)).toEqual([
      "t-shared",
      "t-settled",
    ]);
    expect(result.unlinkedThreads.map((thread) => thread.id)).toEqual(["t-unlinked"]);
  });

  it("formats search queries with brackets for tracker keys and preserves hash keys", () => {
    expect(issuePullRequestSearchQuery({ displayKey: "WARP-6069" })).toBe("[WARP-6069]");
    expect(issuePullRequestSearchQuery({ displayKey: "ENG-42" })).toBe("[ENG-42]");
    expect(issuePullRequestSearchQuery({ displayKey: "#123" })).toBe("#123");
  });

  it("merges, deduplicates, and sorts thread-linked, tracker-linked, and searched PRs", () => {
    const threadPr = makePrLink(30208, {
      snapshot: {
        state: "open",
        title: "[WARP-6069] Fixes two bugs",
        headBranch: "cupcicm/pr/30208",
        baseBranch: "main",
        isDraft: false,
        updatedAt: "2026-11-20T10:00:00.000Z",
        syncedAt: "2026-11-20T10:05:00.000Z",
      },
    });
    const thread = makeThread("t-1", { pullRequests: [threadPr] });
    const threadPullRequests = collectThreadPullRequestsForIssue([thread]);

    const trackerPullRequests: IssueLinkedPullRequest[] = [
      {
        repository: "warpstreamlabs/warpstream",
        number: 30185,
        title: "[WARP-6069] Enable dry run",
        url: "https://github.com/warpstreamlabs/warpstream/pull/30185",
        state: "merged",
        isDraft: false,
        closesIssue: false,
      },
    ];

    const searchedEntry: PullRequestListEntry = {
      provider: SourceControlProviderKind.make("github"),
      host: "github.com",
      projectId: PROJECT_A,
      projectTitle: "warpstream",
      repository: "warpstreamlabs/warpstream",
      number: 30208,
      title: "[WARP-6069] Fixes two bugs in DescribeProducers",
      url: "https://github.com/warpstreamlabs/warpstream/pull/30208",
      state: "open",
      isDraft: false,
      author: { login: "cupcicm", name: null, avatarUrl: null },
      headBranch: "cupcicm/pr/30208",
      baseBranch: "main",
      createdAt: "2026-11-20T08:00:00.000Z",
      updatedAt: "2026-11-20T12:00:00.000Z",
      labels: [],
      reviewDecision: "approved",
      checksState: "passing",
      mergeability: "mergeable",
      additions: 12,
      deletions: 4,
      viewerReviewRequested: false,
    };

    const searchedExtra: PullRequestListEntry = {
      ...searchedEntry,
      number: 30209,
      title: "[WARP-6069] Follow-up draft",
      url: "https://github.com/warpstreamlabs/warpstream/pull/30209",
      isDraft: true,
      updatedAt: "2026-11-20T13:00:00.000Z",
    };

    const merged = mergeIssuePullRequests({
      threadPullRequests,
      trackerPullRequests,
      searchedPullRequests: [
        { environmentId: ENV_ID, entry: searchedEntry },
        { environmentId: ENV_ID, entry: searchedExtra },
      ],
      fallbackEnvironmentId: ENV_ID,
      fallbackProjectId: PROJECT_A,
    });

    expect(merged.map((item) => item.number)).toEqual([30208, 30209, 30185]);
    expect(merged[0]!.title).toBe("[WARP-6069] Fixes two bugs in DescribeProducers");
    expect(merged[0]!.checksState).toBe("passing");
    expect(merged[0]!.reviewDecision).toBe("approved");
    expect(merged[0]!.sources).toEqual(["thread", "search"]);
    expect(merged[1]!.sources).toEqual(["search"]);
    expect(merged[2]!.sources).toEqual(["tracker"]);
  });

  it("round-trips thread keys through issue-row sortable ids", () => {
    const threadKey = "env-1:thread-1";
    const rowId = sidebarIssueThreadRowId(
      "linear\u0000linear.app\u0000warp\u0000WARP-6069",
      threadKey,
    );
    expect(extractThreadKeyFromSidebarSortableId(rowId)).toBe(threadKey);
    expect(extractThreadKeyFromSidebarSortableId(threadKey)).toBe(threadKey);
  });
});
