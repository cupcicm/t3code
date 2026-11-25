import {
  ComposerContextId,
  EnvironmentId,
  type ComposerContextClipboardFragment,
  type ComposerContextRecord,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
  decodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
  threadLinkContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { extractPastedCodeReferences } from "@t3tools/shared/pastedCodeReferences";

import { readThreadShell } from "~/state/entities";

const threadTitle = (ref: ScopedThreadRef) => readThreadShell(ref)?.title;

export interface ReadPastedComposerContextOptions {
  readonly cwd?: string | undefined;
  readonly environmentId?: EnvironmentId | undefined;
}

// Matches ProseMirror's default clipboard parser, which a custom handlePaste bypasses.
export function readPastedPlainText(clipboardData: Pick<DataTransfer, "getData">): string {
  return clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
}

function parsePastedComposerPayload(
  clipboardData: Pick<DataTransfer, "getData">,
  options?: ReadPastedComposerContextOptions,
) {
  const pastedText = readPastedPlainText(clipboardData);
  const decodedFragment =
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
    decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));
  const threads = threadLinkContextReferences(
    pastedText,
    decodedFragment?.records ?? [],
    threadTitle,
  );
  const codeReferences = extractPastedCodeReferences(threads.text, { cwd: options?.cwd });
  const source =
    decodedFragment?.source ??
    (threads.records[0]
      ? { environmentId: threads.records[0].environmentId }
      : codeReferences.records.length > 0
        ? { environmentId: options?.environmentId ?? EnvironmentId.make("local") }
        : null);
  if (source === null) {
    return { pastedText, fragment: null, threads, codeReferences };
  }
  const pastedIds = new Set<string>(
    collectComposerContextReferences(codeReferences.text).map((occurrence) => occurrence.contextId),
  );
  const records = new Map<string, ComposerContextRecord>();
  for (const record of [
    ...(decodedFragment?.records ?? []),
    ...threads.records,
    ...codeReferences.records,
  ]) {
    if (
      record.kind === "preview-annotation" &&
      !("payload" in record) &&
      pastedIds.has(record.contextId) &&
      record.screenshotContextId
    ) {
      pastedIds.add(record.screenshotContextId);
    }
    records.set(record.contextId, record);
  }
  const fragment: ComposerContextClipboardFragment = {
    version: 1,
    source,
    records: [...records.values()].filter((record) => pastedIds.has(record.contextId)),
  };
  return { pastedText, fragment, threads, codeReferences };
}

/** Pasted thread links and code references count as context too, so they become chips. */
export function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
  options?: ReadPastedComposerContextOptions,
): ComposerContextClipboardFragment | null {
  return parsePastedComposerPayload(clipboardData, options).fragment;
}

export function importPastedComposerText(
  clipboardData: Pick<DataTransfer, "getData">,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>,
  options?: ReadPastedComposerContextOptions,
): string {
  const { pastedText, fragment, codeReferences } = parsePastedComposerPayload(
    clipboardData,
    options,
  );
  const rewrittenIds =
    importContextFragment && fragment && fragment.records.length > 0
      ? importContextFragment(fragment)
      : null;
  if (!rewrittenIds || rewrittenIds.size === 0) return pastedText;
  const nextId = (contextId: string) => {
    const id = rewrittenIds.get(contextId);
    return id ? ComposerContextId.make(id) : undefined;
  };
  const acceptedCodeRefs = codeReferences.records.some(
    (record) => nextId(record.contextId) !== undefined,
  );
  const sourceText = acceptedCodeRefs
    ? extractPastedCodeReferences(
        threadLinkContextReferences(pastedText, fragment?.records ?? [], threadTitle, (record) =>
          nextId(record.contextId),
        ).text,
        { cwd: options?.cwd },
      ).text
    : threadLinkContextReferences(pastedText, fragment?.records ?? [], threadTitle, (record) =>
        nextId(record.contextId),
      ).text;
  return replaceComposerContextReferences(sourceText, (occurrence) => {
    const contextId = nextId(occurrence.contextId);
    return contextId
      ? formatComposerContextReference({
          ...occurrence,
          contextId,
          kind: occurrence.kind === "element" ? "preview-annotation" : occurrence.kind,
        })
      : occurrence.source;
  });
}
