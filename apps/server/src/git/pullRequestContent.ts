import type { ThreadIssueLink } from "@t3tools/contracts";

export interface PullRequestTextContent {
  readonly title: string;
  readonly body: string;
}

export function selectLongestCommitMessage(
  messages: ReadonlyArray<string>,
): PullRequestTextContent | null {
  let longest = "";
  for (const raw of messages) {
    const normalized = raw.replaceAll("\r\n", "\n").trim();
    if (normalized.length > longest.length) {
      longest = normalized;
    }
  }
  if (longest.length === 0) {
    return null;
  }
  const newlineIndex = longest.indexOf("\n");
  if (newlineIndex === -1) {
    return { title: longest, body: "" };
  }
  return {
    title: longest.slice(0, newlineIndex).trim(),
    body: longest.slice(newlineIndex + 1).trim(),
  };
}

export function enrichPullRequestWithLinkedIssues(
  content: PullRequestTextContent,
  issues: ReadonlyArray<ThreadIssueLink>,
): PullRequestTextContent {
  const linearIssues: Array<ThreadIssueLink> = [];
  const seenKeys = new Set<string>();
  for (const issue of issues) {
    if (issue.tracker !== "linear") continue;
    const key = issue.displayKey.trim();
    const url = issue.url.trim();
    if (key.length === 0 || url.length === 0) continue;
    const normalizedKey = key.toLowerCase();
    if (seenKeys.has(normalizedKey)) continue;
    seenKeys.add(normalizedKey);
    linearIssues.push(issue);
  }
  if (linearIssues.length === 0) {
    return content;
  }

  let title = content.title.trim();
  const titleLower = title.toLowerCase();
  const missingTags: Array<string> = [];
  for (const issue of linearIssues) {
    const tag = `[${issue.displayKey.trim()}]`;
    if (!titleLower.includes(tag.toLowerCase())) {
      missingTags.push(tag);
    }
  }
  if (missingTags.length > 0) {
    title = `${missingTags.join(" ")} ${title}`.trim();
  }

  let body = content.body.trim();
  const bodyLower = body.toLowerCase();
  const missingLinks: Array<string> = [];
  for (const issue of linearIssues) {
    const url = issue.url.trim();
    if (!bodyLower.includes(url.toLowerCase())) {
      missingLinks.push(`- Linear [${issue.displayKey.trim()}](${url})`);
    }
  }
  if (missingLinks.length > 0) {
    const header = missingLinks.join("\n");
    body = body.length === 0 ? header : `${header}\n\n${body}`;
  }

  return { title, body };
}
