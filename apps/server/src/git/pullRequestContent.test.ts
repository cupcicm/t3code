import { IssueTrackerKind, ProjectId, type ThreadIssueLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  enrichPullRequestWithLinkedIssues,
  selectLongestCommitMessage,
} from "./pullRequestContent.ts";

function makeIssue(overrides: Partial<ThreadIssueLink> = {}): ThreadIssueLink {
  return {
    tracker: IssueTrackerKind.make("linear"),
    host: "linear.app",
    scope: "ENG",
    key: "ENG-123",
    projectId: ProjectId.make("project-1"),
    url: "https://linear.app/acme/issue/ENG-123/fix-auth-race",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    displayKey: "ENG-123",
    title: "Fix auth race",
    ...overrides,
  };
}

describe("selectLongestCommitMessage", () => {
  it("returns null when there are no non-empty commit messages", () => {
    expect(selectLongestCommitMessage([])).toBeNull();
    expect(selectLongestCommitMessage(["   ", "\n\t\n"])).toBeNull();
  });

  it("splits subject and body from the longest commit message", () => {
    expect(
      selectLongestCommitMessage([
        "fix: typo",
        "Refine retry backoff\r\n\r\nAvoid tight loops when the upstream resets connections.\r\n\r\nTested against staging.",
        "chore: format",
      ]),
    ).toEqual({
      title: "Refine retry backoff",
      body: "Avoid tight loops when the upstream resets connections.\n\nTested against staging.",
    });
  });

  it("handles a single-line longest commit message", () => {
    expect(selectLongestCommitMessage(["short", "Add deterministic retry jitter"])).toEqual({
      title: "Add deterministic retry jitter",
      body: "",
    });
  });
});

describe("enrichPullRequestWithLinkedIssues", () => {
  it("prefixes the title with the Linear tag and prepends the link to the body", () => {
    expect(
      enrichPullRequestWithLinkedIssues(
        { title: "Fix auth race", body: "Serialize token refresh." },
        [makeIssue()],
      ),
    ).toEqual({
      title: "[ENG-123] Fix auth race",
      body: "- Linear [ENG-123](https://linear.app/acme/issue/ENG-123/fix-auth-race)\n\nSerialize token refresh.",
    });
  });

  it("populates an empty body with the Linear link", () => {
    expect(
      enrichPullRequestWithLinkedIssues({ title: "Fix auth race", body: "" }, [makeIssue()]),
    ).toEqual({
      title: "[ENG-123] Fix auth race",
      body: "- Linear [ENG-123](https://linear.app/acme/issue/ENG-123/fix-auth-race)",
    });
  });

  it("does not duplicate an existing tag or URL and ignores non-Linear issues", () => {
    expect(
      enrichPullRequestWithLinkedIssues(
        {
          title: "[eng-123] Fix auth race",
          body: "Fixes https://linear.app/acme/issue/ENG-123/fix-auth-race",
        },
        [
          makeIssue(),
          makeIssue({
            tracker: IssueTrackerKind.make("github"),
            host: "github.com",
            scope: "acme/app",
            key: "42",
            displayKey: "#42",
            url: "https://github.com/acme/app/issues/42",
          }),
        ],
      ),
    ).toEqual({
      title: "[eng-123] Fix auth race",
      body: "Fixes https://linear.app/acme/issue/ENG-123/fix-auth-race",
    });
  });

  it("includes multiple distinct Linear issues in order", () => {
    expect(
      enrichPullRequestWithLinkedIssues({ title: "Batch fixes", body: "Details." }, [
        makeIssue({
          key: "ENG-1",
          displayKey: "ENG-1",
          url: "https://linear.app/acme/issue/ENG-1",
        }),
        makeIssue({
          key: "ENG-2",
          displayKey: "ENG-2",
          url: "https://linear.app/acme/issue/ENG-2",
        }),
        makeIssue({
          key: "ENG-1",
          displayKey: "ENG-1",
          url: "https://linear.app/acme/issue/ENG-1",
        }),
      ]),
    ).toEqual({
      title: "[ENG-1] [ENG-2] Batch fixes",
      body: "- Linear [ENG-1](https://linear.app/acme/issue/ENG-1)\n- Linear [ENG-2](https://linear.app/acme/issue/ENG-2)\n\nDetails.",
    });
  });
});
