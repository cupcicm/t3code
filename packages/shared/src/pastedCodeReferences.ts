import {
  COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS,
  type ComposerContextId,
  type ReviewCommentContextRecord,
} from "@t3tools/contracts";

import {
  collectComposerContextReferences,
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "./composerContextReferences.ts";
import { parseFileUrlHref, splitFilePathPosition } from "./fileLinks.ts";
import {
  fileBasename,
  isAbsolutePath,
  isNetworkPath,
  isWindowsDrivePath,
  stripSlashPrefixedWindowsDrive,
} from "./path.ts";

export const CODE_REFERENCE_SECTION_PREFIX = "code-reference:";
export const CODE_REFERENCE_SECTION_TITLE = "Code reference";

export function isCodeReferenceContext(comment: { readonly sectionId: string }): boolean {
  return comment.sectionId.startsWith(CODE_REFERENCE_SECTION_PREFIX);
}

export interface ParsedPastedCodeReference {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly code: string;
  readonly fenceLanguage: string;
}

const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const EDITOR_FILE_URI_REGEX = /^(?:cursor|vscode|vscode-insiders|windsurf):\/\/file(\/.*)$/i;
const CURSOR_FENCE_INFO_REGEX = /^(\d+)(?::(\d+))?:(.+)$/;
const SIMPLE_FENCE_LANG_REGEX = /^[A-Za-z0-9_+#.-]{1,32}$/;
const FILE_EXTENSION_REGEX = /\.[A-Za-z][A-Za-z0-9_+-]{0,15}$/;
const IPV4_LIKE_REGEX = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const KNOWN_EXTENSIONLESS_FILES = new Set([
  "Dockerfile",
  "Makefile",
  "Procfile",
  "Gemfile",
  "Rakefile",
  "Justfile",
  "Vagrantfile",
  "Brewfile",
  "Containerfile",
  "LICENSE",
  "README",
  "CHANGELOG",
]);

const TRUNCATION_MARKER = "\n… truncated …";

function clampCode(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max - TRUNCATION_MARKER.length);
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}${TRUNCATION_MARKER}`;
}

function inferFenceLanguageFromPath(filePath: string): string {
  const normalizedPath = filePath.replaceAll("\\", "/");
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1).toLowerCase();
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex > 0 && extensionIndex < fileName.length - 1) {
    return fileName.slice(extensionIndex + 1);
  }
  if (fileName.startsWith(".") && fileName.length > 1) {
    return fileName.slice(1);
  }
  return "text";
}

function safeDecodeUriPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPlausibleCodeFilePath(path: string): boolean {
  if (!path || path.length > 2_048) return false;
  if (/[\r\n\0]/.test(path)) return false;
  if (path.endsWith("/") || path.endsWith("\\")) return false;
  if (isNetworkPath(path)) return false;
  if (URI_SCHEME_REGEX.test(path) && !isWindowsDrivePath(path)) return false;
  if (IPV4_LIKE_REGEX.test(path)) return false;
  if (path.includes("/") || path.includes("\\")) return true;
  if (FILE_EXTENSION_REGEX.test(path)) return true;
  return KNOWN_EXTENSIONLESS_FILES.has(path);
}

/**
 * Normalizes a pasted file path against the active thread's workspace `cwd` when possible,
 * turning absolute paths inside the workspace into clean workspace-relative POSIX paths.
 */
export function normalizeCodeReferencePath(rawPath: string, cwd?: string): string {
  let path = rawPath.trim();
  if (!path) return "";

  if (cwd) {
    const cleanCwd = cwd.trim().replace(/[\\/]+$/, "");
    if (cleanCwd) {
      const normalizedCwd = cleanCwd.replaceAll("\\", "/");
      const normalizedPath = path.replaceAll("\\", "/");
      const caseInsensitive = isWindowsDrivePath(cleanCwd) || isWindowsDrivePath(path);
      const cwdPrefix = `${normalizedCwd}/`;
      const matchesCwd = caseInsensitive
        ? normalizedPath.toLowerCase().startsWith(cwdPrefix.toLowerCase())
        : normalizedPath.startsWith(cwdPrefix);
      if (matchesCwd) {
        path = normalizedPath.slice(cwdPrefix.length);
      }
    }
  }

  if (!isAbsolutePath(path)) {
    path = path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  }
  return path;
}

function parseSingleCodeReference(
  rawToken: string,
  cwd?: string,
): Omit<ParsedPastedCodeReference, "code" | "fenceLanguage"> | null {
  let token = rawToken.trim();
  if (!token) return null;

  // Strip surrounding backticks (e.g. `src/foo.ts:10-25`) or markdown bold.
  if (token.length >= 2 && token.startsWith("`") && token.endsWith("`")) {
    token = token.slice(1, -1).trim();
  }

  // Strip leading @ mention prefix.
  if (token.startsWith("@")) {
    token = token.slice(1);
  }

  // Unwrap quoted paths with spaces: @"src/my file.ts":10-25 or @"src/my file.ts#L10-25"
  if (token.startsWith('"')) {
    const closeQuote = token.indexOf('"', 1);
    if (closeQuote === -1) return null;
    const inner = token.slice(1, closeQuote).replace(/\\(.)/g, "$1");
    const trailing = token.slice(closeQuote + 1);
    token = `${inner}${trailing}`;
  }

  // Editor URIs: cursor://file/abs/path:10:5, vscode://file/abs/path:10, file:///abs/path#L10-25
  let hash = "";
  const editorUriMatch = token.match(EDITOR_FILE_URI_REGEX);
  if (editorUriMatch?.[1]) {
    let rawUriRest = editorUriMatch[1];
    const hashIndex = rawUriRest.indexOf("#");
    if (hashIndex !== -1) {
      hash = rawUriRest.slice(hashIndex);
      rawUriRest = rawUriRest.slice(0, hashIndex);
    }
    token = stripSlashPrefixedWindowsDrive(safeDecodeUriPath(rawUriRest));
  } else if (/^file:\/\//i.test(token)) {
    const parsed = parseFileUrlHref(token);
    if (!parsed) return null;
    token = safeDecodeUriPath(parsed.path);
    hash = parsed.hash;
  }

  const position = splitFilePathPosition(token, hash);
  if (position.line === undefined || position.line < 1) return null;

  const filePath = normalizeCodeReferencePath(position.path, cwd);
  if (!isPlausibleCodeFilePath(filePath)) return null;

  const startLine = position.line;
  const endLine =
    position.endLine !== undefined && position.endLine >= startLine ? position.endLine : startLine;

  return { filePath, startLine, endLine };
}

function buildCodeReferenceRecord(ref: ParsedPastedCodeReference): ReviewCommentContextRecord {
  const startLine = Math.max(1, Math.min(ref.startLine, ref.endLine));
  const endLine = Math.max(startLine, Math.max(ref.startLine, ref.endLine));
  const rangeLabel = startLine === endLine ? `L${startLine}` : `L${startLine} to L${endLine}`;
  const label = sanitizeComposerContextLabel(
    `${fileBasename(ref.filePath)} ${rangeLabel}`,
    "review-comment",
  );
  const diff = clampCode(ref.code, COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS);
  const contextId = toKindScopedComposerContextId(
    "review-comment",
    `code-ref:${ref.filePath}:${startLine}:${endLine}:${diff}`,
  );
  return {
    version: 1,
    contextId,
    kind: "review-comment",
    label,
    sectionId: `${CODE_REFERENCE_SECTION_PREFIX}${ref.filePath}`,
    sectionTitle: CODE_REFERENCE_SECTION_TITLE,
    filePath: ref.filePath,
    startIndex: startLine - 1,
    endIndex: endLine - 1,
    rangeLabel,
    text: "",
    diff,
    fenceLanguage: ref.fenceLanguage || inferFenceLanguageFromPath(ref.filePath),
  };
}

function parseOpeningFence(line: string): { readonly ticks: number; readonly info: string } | null {
  const match = line.match(/^\s*(`{3,})([^\n]*)$/);
  if (!match?.[1]) return null;
  const info = (match[2] ?? "").trim();
  if (info.includes("`")) return null;
  return { ticks: match[1].length, info };
}

function isClosingFence(line: string, minTicks: number): boolean {
  const match = line.match(/^\s*(`{3,})\s*$/);
  return Boolean(match?.[1] && match[1].length >= minTicks);
}

function parseCursorFenceHeader(
  info: string,
  cwd?: string,
): Omit<ParsedPastedCodeReference, "code" | "fenceLanguage"> | null {
  const match = info.match(CURSOR_FENCE_INFO_REGEX);
  if (!match?.[1] || !match[3]) return null;
  const startLine = Number.parseInt(match[1], 10);
  const endLine = match[2] !== undefined ? Number.parseInt(match[2], 10) : startLine;
  if (startLine < 1 || endLine < startLine) return null;
  const filePath = normalizeCodeReferencePath(match[3], cwd);
  if (!isPlausibleCodeFilePath(filePath)) return null;
  return { filePath, startLine, endLine };
}

function extractStandaloneLineHeaderRef(
  line: string,
  cwd?: string,
): Omit<ParsedPastedCodeReference, "code" | "fenceLanguage"> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Also accept a markdown link header like `[src/foo.ts:10-25](file:///...)`
  const mdLink = trimmed.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
  if (mdLink?.[1] && mdLink[2]) {
    return parseSingleCodeReference(mdLink[2], cwd) ?? parseSingleCodeReference(mdLink[1], cwd);
  }
  return parseSingleCodeReference(trimmed, cwd);
}

// Inline intentional references: @-prefixed tokens or cursor:// / vscode:// / file:// URIs.
const INLINE_INTENTIONAL_REF_REGEX =
  /(^|[\s([{"'])(@(?:"(?:\\.|[^"\\])*"(?:[:#][^\s,;)}"']*)?|[^\s@"'<>()[\]{}]+)|(?:cursor|vscode|vscode-insiders|windsurf):\/\/file\/[^\s"'<>()[\]{}]+|file:\/\/[^\s"'<>()[\]{}]+)/gi;

function trimTrailingSentencePunctuation(token: string): {
  readonly candidate: string;
  readonly suffix: string;
} {
  let end = token.length;
  while (end > 0 && /[.,;!?)\]}]/.test(token[end - 1]!)) {
    end -= 1;
  }
  return { candidate: token.slice(0, end), suffix: token.slice(end) };
}

function rewriteInlineIntentionalReferences(
  segment: string,
  cwd: string | undefined,
  register: (ref: ParsedPastedCodeReference) => string,
): string {
  const existingLinks = collectComposerContextReferences(segment);
  const insideExistingLink = (start: number, end: number) =>
    existingLinks.some((link) => start < link.end && end > link.start);

  let result = "";
  let cursor = 0;
  for (const match of segment.matchAll(INLINE_INTENTIONAL_REF_REGEX)) {
    const prefix = match[1] ?? "";
    const rawToken = match[2] ?? "";
    const tokenStart = (match.index ?? 0) + prefix.length;
    const tokenEnd = tokenStart + rawToken.length;
    if (tokenStart < cursor || insideExistingLink(tokenStart, tokenEnd)) continue;

    const { candidate, suffix } = trimTrailingSentencePunctuation(rawToken);
    const parsed = parseSingleCodeReference(candidate, cwd);
    if (!parsed) continue;

    const replacement = register({
      ...parsed,
      code: "",
      fenceLanguage: inferFenceLanguageFromPath(parsed.filePath),
    });
    result += segment.slice(cursor, tokenStart) + replacement + suffix;
    cursor = tokenEnd;
  }
  return cursor === 0 ? segment : result + segment.slice(cursor);
}

/**
 * When the entire paste consists solely of bare file+line references (e.g. `src/foo.ts:10-25`
 * straight from a Copy Reference / Better Copy Path with Lines extension), convert every one.
 * Prose and stack traces are left untouched so we never mangle pasted logs.
 */
function tryRewriteWholePasteBareReferences(
  text: string,
  cwd: string | undefined,
  register: (ref: ParsedPastedCodeReference) => string,
): string | null {
  const lines = text.split("\n");
  type LineEntry =
    | { readonly kind: "raw"; readonly value: string }
    | {
        readonly kind: "whole";
        readonly leading: string;
        readonly trailing: string;
        readonly parsed: Omit<ParsedPastedCodeReference, "code" | "fenceLanguage">;
      }
    | {
        readonly kind: "parts";
        readonly parts: ReadonlyArray<
          | { readonly kind: "raw"; readonly value: string }
          | {
              readonly kind: "ref";
              readonly parsed: Omit<ParsedPastedCodeReference, "code" | "fenceLanguage">;
            }
        >;
      };

  const entries: LineEntry[] = [];
  let matchedCount = 0;

  for (const line of lines) {
    if (!line.trim()) {
      entries.push({ kind: "raw", value: line });
      continue;
    }

    // First try the whole line as a single reference (preserves paths containing spaces).
    const leading = line.match(/^\s*/)?.[0] ?? "";
    const trailing = line.match(/\s*$/)?.[0] ?? "";
    const wholeParsed = parseSingleCodeReference(line.trim(), cwd);
    if (wholeParsed) {
      matchedCount += 1;
      entries.push({ kind: "whole", leading, trailing, parsed: wholeParsed });
      continue;
    }

    // Otherwise check whitespace-separated tokens on the line; every token must be a reference.
    const rawParts = line.split(/(\s+)/);
    const lineParts: Array<
      | { readonly kind: "raw"; readonly value: string }
      | {
          readonly kind: "ref";
          readonly parsed: Omit<ParsedPastedCodeReference, "code" | "fenceLanguage">;
        }
    > = [];
    for (const part of rawParts) {
      if (!part || /^\s+$/.test(part)) {
        lineParts.push({ kind: "raw", value: part });
        continue;
      }
      const parsed = parseSingleCodeReference(part, cwd);
      if (!parsed) return null;
      matchedCount += 1;
      lineParts.push({ kind: "ref", parsed });
    }
    entries.push({ kind: "parts", parts: lineParts });
  }

  if (matchedCount === 0) return null;

  return entries
    .map((entry) => {
      if (entry.kind === "raw") return entry.value;
      if (entry.kind === "whole") {
        return `${entry.leading}${register({
          ...entry.parsed,
          code: "",
          fenceLanguage: inferFenceLanguageFromPath(entry.parsed.filePath),
        })}${entry.trailing}`;
      }
      return entry.parts
        .map((part) =>
          part.kind === "raw"
            ? part.value
            : register({
                ...part.parsed,
                code: "",
                fenceLanguage: inferFenceLanguageFromPath(part.parsed.filePath),
              }),
        )
        .join("");
    })
    .join("\n");
}

/**
 * Parses pasted Cursor / VS Code code references (fenced code blocks with file+line headers,
 * `@path:line` / `@path#Lstart-Lend` mentions, `cursor://file/...` URIs, and standalone
 * `path:start-end` clipboard strings) into structured `ReviewCommentContextRecord` entries.
 */
export function extractPastedCodeReferences(
  rawText: string,
  options?: { readonly cwd?: string | undefined },
): {
  readonly text: string;
  readonly records: ReadonlyArray<ReviewCommentContextRecord>;
} {
  if (!rawText) return { text: rawText, records: [] };
  const text = rawText.replace(/\r\n?/g, "\n");
  const cwd = options?.cwd;
  const recordsById = new Map<ComposerContextId, ReviewCommentContextRecord>();
  const register = (ref: ParsedPastedCodeReference): string => {
    const record = buildCodeReferenceRecord(ref);
    recordsById.set(record.contextId, record);
    return formatComposerContextReference({
      kind: record.kind,
      contextId: record.contextId,
      label: record.label,
    });
  };

  // Fast path: whole clipboard is one or more bare file+line references (no fenced blocks).
  if (!text.includes("```")) {
    const whole = tryRewriteWholePasteBareReferences(text, cwd, register);
    if (whole !== null) {
      return { text: whole, records: [...recordsById.values()] };
    }
    const inlineOnly = rewriteInlineIntentionalReferences(text, cwd, register);
    return { text: inlineOnly, records: [...recordsById.values()] };
  }

  // Block-aware scan: handle Cursor fenced blocks and `<ref>\n```lang...``` ` pairs while
  // leaving ordinary fenced code blocks untouched.
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    // Case 1: Cursor-style fenced block: ```12:34:src/foo.ts
    const openingFence = parseOpeningFence(line);
    if (openingFence) {
      const closeIndex = findClosingFence(lines, index + 1, openingFence.ticks);
      if (closeIndex !== -1) {
        const cursorHeader = parseCursorFenceHeader(openingFence.info, cwd);
        if (cursorHeader) {
          const code = lines.slice(index + 1, closeIndex).join("\n");
          output.push(
            register({
              ...cursorHeader,
              code,
              fenceLanguage: inferFenceLanguageFromPath(cursorHeader.filePath),
            }),
          );
          index = closeIndex + 1;
          continue;
        }
        // Ordinary fenced block: keep verbatim so code inside fences is never rewritten.
        for (let cursor = index; cursor <= closeIndex; cursor += 1) {
          output.push(lines[cursor]!);
        }
        index = closeIndex + 1;
        continue;
      }
    }

    // Case 2: Reference header line immediately followed (optionally across 1 blank line) by a fenced block.
    const headerRef = extractStandaloneLineHeaderRef(line, cwd);
    if (headerRef) {
      const fenceLineIndex =
        index + 1 < lines.length && lines[index + 1]!.trim() === "" ? index + 2 : index + 1;
      const nextFence =
        fenceLineIndex < lines.length ? parseOpeningFence(lines[fenceLineIndex]!) : null;
      if (nextFence) {
        const closeIndex = findClosingFence(lines, fenceLineIndex + 1, nextFence.ticks);
        if (closeIndex !== -1) {
          const code = lines.slice(fenceLineIndex + 1, closeIndex).join("\n");
          const fenceLanguage = SIMPLE_FENCE_LANG_REGEX.test(nextFence.info)
            ? nextFence.info
            : inferFenceLanguageFromPath(headerRef.filePath);
          output.push(register({ ...headerRef, code, fenceLanguage }));
          index = closeIndex + 1;
          continue;
        }
      }
    }

    output.push(rewriteInlineIntentionalReferences(line, cwd, register));
    index += 1;
  }

  return { text: output.join("\n"), records: [...recordsById.values()] };
}

function findClosingFence(
  lines: ReadonlyArray<string>,
  startIndex: number,
  minTicks: number,
): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (isClosingFence(lines[index]!, minTicks)) return index;
  }
  return -1;
}
