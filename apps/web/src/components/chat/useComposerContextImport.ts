import { msg } from "gt-react";
import { m } from "~/i18n/messages";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { RefObject } from "react";
import type { ChatComposerProps } from "./ChatComposer";
import {
  AuthFilesystemReadScope,
  COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS,
  type ComposerContextClipboardFragment,
  type ComposerContextRecord,
  type EnvironmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "@t3tools/contracts";
import { isCodeReferenceContext } from "@t3tools/shared/pastedCodeReferences";
import { isAbsolutePath } from "@t3tools/shared/path";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftId,
  composerFileMatchesReattachMarker,
  composerFileNeedsReattach,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { type PendingUserInput } from "../../session-logic";
import {
  asKnownContextRecord,
  composerContextImportLookupIds,
  isSameComposerContextPayload,
  previewAnnotationContextId,
  previewAnnotationContextRecord,
  previewAnnotationFromRecord,
  reviewCommentContextId,
  reviewCommentContextRecord,
  reviewCommentFromRecord,
  terminalContextDraftFromRecord,
  terminalContextRecord,
  terminalContextReference,
} from "~/lib/composerContextRecords";
import { assetEnvironment } from "~/state/assets";
import { copiedComposerAttachmentFile } from "~/lib/copiedComposerAttachments";
import { countQuestionAttachments, questionAttachmentDraftId } from "../../questionAttachments";
import { collectInlineContextIds } from "../../lib/composerContextReferences";
import { elementContextToPreviewAnnotation } from "../../lib/elementContext";
import { orchestrationEnvironment } from "~/state/orchestration";
import { pendingDraftWork } from "./pendingDraftWork";
import { readComposerImageBytes } from "./composerAttachmentFiles";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { readEnvironmentScope, readPreparedConnection } from "~/state/session";
import { resolveAssetUrl } from "~/assets/assetUrls";
import { toKindScopedComposerContextId } from "@t3tools/shared/composerContextReferences";
import { getProjectFileContents } from "../files/projectFilesQueryState";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { toastManager } from "../ui/toast";
import {
  type ComposerDraftContextRecords,
  uploadedContextRecordFromDraft,
} from "../composerContextPresentation";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useStableCallback } from "../../hooks/useStableCallback";
import { countPreparingComposerImages } from "./preparingComposerImages";

const isUnreachable = Schema.is(
  Schema.Union([ConnectionTransientError, ConnectionBlockedError, EnvironmentRpcUnavailableError]),
);

async function downloadAttachmentBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

const CODE_REF_TRUNCATION_MARKER = "\n… truncated …";

function sliceCodeReferenceLines(contents: string, startIndex: number, endIndex: number): string {
  const lines = contents.replace(/\r\n?/g, "\n").split("\n");
  if (startIndex < 0 || startIndex >= lines.length) return "";
  const sliced = lines.slice(startIndex, Math.min(lines.length, endIndex + 1)).join("\n");
  if (sliced.length <= COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS) return sliced;
  let end = Math.max(0, COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS - CODE_REF_TRUNCATION_MARKER.length);
  const last = sliced.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${sliced.slice(0, end)}${CODE_REF_TRUNCATION_MARKER}`;
}

/**
 * Imports copied composer context (terminal output, review comments, annotations, threads,
 * images and files) into the open draft, and counts the attachment slots already spoken for.
 */
export function useComposerContextImport(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd?: string | undefined;
  readonly linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  readonly activeThread: ChatComposerProps["activeThread"];
  readonly activeThreadId: ChatComposerProps["activeThreadId"];
  readonly composerDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly attachmentDraftTarget: ChatComposerProps["composerDraftTarget"];
  readonly attachmentTargetKey: string;
  readonly attachmentTargetKeyRef: RefObject<string>;
  readonly questionAttachmentTarget: DraftId | null;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly composerContextRecords: ComposerDraftContextRecords;
  readonly composerImages: ReadonlyArray<ComposerImageAttachment>;
  readonly composerFilesRef: ChatComposerProps["composerFilesRef"];
  readonly promptRef: RefObject<string>;
  readonly pendingThreadImportsRef: RefObject<Map<string, number>>;
  readonly addComposerFilesToDraft: (files: ComposerFileAttachment[]) => string[];
}) {
  const {
    environmentId,
    cwd,
    linkedEnvironments,
    activeThread,
    activeThreadId,
    composerDraftTarget,
    attachmentDraftTarget,
    attachmentTargetKey,
    attachmentTargetKeyRef,
    questionAttachmentTarget,
    pendingUserInputs,
    composerContextRecords,
    composerImages,
    composerFilesRef,
    promptRef,
    pendingThreadImportsRef,
    addComposerFilesToDraft,
  } = input;
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const addComposerDraftReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const addComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.addPreviewAnnotation,
  );
  const addComposerDraftThreadContexts = useComposerDraftStore((store) => store.addThreadContexts);
  const addComposerDraftEnvironmentContexts = useComposerDraftStore(
    (store) => store.addEnvironmentContexts,
  );
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, { reportFailure: false });
  const loadThreadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const countReservedAttachments = () => {
    const questionRequest = pendingUserInputs[0];
    const otherQuestionKeys =
      questionAttachmentTarget && questionRequest && activeThreadId
        ? questionRequest.questions
            .map((question) =>
              questionAttachmentDraftId(
                environmentId,
                activeThreadId,
                questionRequest.requestId,
                question.id,
              ),
            )
            .filter((key) => key !== questionAttachmentTarget)
        : [];
    const draft = getComposerDraft(attachmentDraftTarget);
    return (
      (draft?.images.length ?? 0) +
      (draft?.files.length ?? 0) +
      countPreparingComposerImages(attachmentTargetKey) +
      (pendingThreadImportsRef.current.get(attachmentTargetKey) ?? 0) +
      countQuestionAttachments(otherQuestionKeys)
    );
  };
  const countReservedAttachmentsStable = useStableCallback(countReservedAttachments);
  const runAttachmentImport = async (
    record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
    localId: string,
    sourceEnvironmentId: EnvironmentId,
    importTargetKey: string,
  ) => {
    const fail = (reason: string) => {
      toastManager.add({
        type: "error",
        title: m(msg("Couldn't bring {name} into this message", { name: record.name })),
        description: m(msg("{reason} Remove the chip or attach the file again.", { reason })),
      });
    };
    let file = copiedComposerAttachmentFile(sourceEnvironmentId, record.attachmentId);
    if (!file) {
      const sourceConnection = readPreparedConnection(sourceEnvironmentId);
      if (!sourceConnection) {
        fail(m(msg("The environment it came from is not connected.")));
        return;
      }
      const result = await createAssetUrl({
        environmentId: sourceEnvironmentId,
        input: { resource: { _tag: "attachment", attachmentId: record.attachmentId } },
      });
      const url =
        result._tag === "Success"
          ? resolveAssetUrl(sourceConnection.httpBaseUrl, result.value.relativeUrl)
          : null;
      if (!url) {
        const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;
        fail(
          isUnreachable(cause)
            ? m(msg("The environment it came from is not reachable right now."))
            : m(msg("The original attachment is no longer available.")),
        );
        return;
      }
      const blob = await downloadAttachmentBlob(url);
      if (!blob) {
        fail(m(msg("Downloading it from the source failed.")));
        return;
      }
      file = new File([blob], record.name, { type: record.mimeType || blob.type });
      if (record.kind === "image") await readComposerImageBytes(file);
      // Question attachments have no inline reference; annotations can own their screenshots.
      const references = new Set(collectInlineContextIds(promptRef.current));
      if (
        !questionAttachmentTarget &&
        !references.has(toKindScopedComposerContextId(record.kind, localId)) &&
        !(
          record.kind === "image" &&
          references.has(previewAnnotationContextId(localId)) &&
          getComposerDraft(composerDraftTarget)?.previewAnnotations.some(
            (annotation) => annotation.id === localId,
          )
        )
      )
        return;
    }
    // The draft these bytes belong to may have been sent or switched away from while they
    // downloaded. Dropping them here keeps them out of whatever draft is open now.
    if (attachmentTargetKeyRef.current !== importTargetKey) return;
    const replacesFileMarker =
      record.kind === "file" &&
      composerFilesRef.current.some(
        (candidate) =>
          composerFileNeedsReattach(candidate) &&
          composerFileMatchesReattachMarker(candidate, {
            name: record.name,
            mimeType: file.type,
            sizeBytes: file.size,
          }),
      );
    if (
      !replacesFileMarker &&
      (pendingThreadImportsRef.current.get(importTargetKey) ?? 0) > 0 &&
      countReservedAttachments() >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS
    ) {
      fail(m(msg("The attachment limit has been reached.")));
      return;
    }
    if (record.kind === "image") {
      const accepted = addComposerDraftImages(
        attachmentDraftTarget,
        [
          {
            type: "image",
            id: localId,
            name: record.name,
            mimeType: file.type,
            sizeBytes: file.size,
            previewUrl: URL.createObjectURL(file),
            file,
            ...(record.source ? { source: record.source } : {}),
          },
        ],
        {
          allowDuplicates:
            getComposerDraft(composerDraftTarget)?.previewAnnotations.some(
              (annotation) => annotation.id === localId,
            ) ?? false,
        },
      );
      if (!accepted.includes(localId))
        fail(m(msg("The draft rejected this attachment (duplicate or attachment limit reached).")));
    } else {
      const accepted = addComposerFilesToDraft([
        {
          type: "file",
          id: localId,
          name: record.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
        },
      ]);
      if (!accepted.includes(localId))
        fail(m(msg("The draft rejected this attachment (duplicate or attachment limit reached).")));
    }
  };
  const importAttachmentRecord = async (
    record: Extract<ComposerContextRecord, { kind: "image" | "file" }>,
    localId: string,
    sourceEnvironmentId: EnvironmentId,
  ) => {
    // The chip lands in the draft immediately while these bytes are still downloading. Count
    // the transfer against its own draft so a send cannot snapshot a message whose chip has no
    // attachment behind it, and so bytes for an abandoned draft never enter the next one.
    const importTargetKey = attachmentTargetKey;
    pendingDraftWork.begin(importTargetKey);
    await runAttachmentImport(record, localId, sourceEnvironmentId, importTargetKey).finally(() =>
      pendingDraftWork.end(importTargetKey),
    );
  };
  const hydrateCodeReference = async (comment: ReviewCommentContext, importTargetKey: string) => {
    if (!cwd || isAbsolutePath(comment.filePath) || comment.filePath.startsWith("..")) return;
    if (!readEnvironmentScope(environmentId, AuthFilesystemReadScope)) return;
    pendingDraftWork.begin(importTargetKey);
    try {
      const result = await executeAtomQuery(
        appAtomRegistry,
        projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath: comment.filePath },
        }),
        { label: "Read referenced code lines", reportFailure: false },
      );
      if (result._tag !== "Success") return;
      if (attachmentTargetKeyRef.current !== importTargetKey) return;
      const current = getComposerDraft(composerDraftTarget)?.reviewComments.find(
        (candidate) => candidate.id === comment.id,
      );
      if (!current || current.diff.length > 0) return;
      const diff = sliceCodeReferenceLines(
        result.value.contents,
        current.startIndex,
        current.endIndex,
      );
      if (!diff) return;
      addComposerDraftReviewComment(
        composerDraftTarget,
        { ...current, diff },
        { appendReference: false },
      );
    } finally {
      pendingDraftWork.end(importTargetKey);
    }
  };

  const importContextRecords = (
    records: ReadonlyArray<ComposerContextRecord>,
    sourceEnvironmentId: EnvironmentId | null,
    threadDraftTarget = attachmentDraftTarget,
  ): ReadonlyMap<string, string> => {
    const rewritten = new Map<string, string>();
    const dependentAttachmentLocalIds = new Map<string, string>();
    const skippedDependentAttachmentIds = new Set<string>();
    // Resolve annotations before their dependent screenshot records even if a foreign
    // clipboard producer emitted the records in a different order.
    const orderedRecords = records.toSorted((left, right) =>
      left.kind === "preview-annotation" && right.kind !== "preview-annotation"
        ? -1
        : right.kind === "preview-annotation" && left.kind !== "preview-annotation"
          ? 1
          : 0,
    );
    for (const candidate of orderedRecords) {
      // Producer ids fold into context ids, so two different excerpts can collide. Only skip
      // when the draft already holds the same payload; a colliding but different record is
      // re-minted under a fresh id so both survive the paste. Threads resolve below.
      const record = asKnownContextRecord(candidate);
      if (!record) continue;
      // A reminted annotation needs its screenshot under the new annotation id.
      const existing = dependentAttachmentLocalIds.has(record.contextId)
        ? undefined
        : composerContextImportLookupIds(record).flatMap((contextId) => {
            const found = composerContextRecords.get(contextId);
            return found ? [found] : [];
          })[0];
      // Upload completion can change the server id since copy; the local bytes still match.
      if (
        sourceEnvironmentId !== null &&
        (record.kind === "image" || record.kind === "file") &&
        (existing?.kind === "image" || existing?.kind === "file") &&
        existing.record.file !== null &&
        existing.record.file ===
          copiedComposerAttachmentFile(sourceEnvironmentId, record.attachmentId)
      )
        continue;
      const existingRecord =
        existing?.kind === "terminal"
          ? terminalContextRecord(existing.record)
          : existing?.kind === "review-comment"
            ? reviewCommentContextRecord(existing.record)
            : existing?.kind === "preview-annotation"
              ? previewAnnotationContextRecord(existing.record, {
                  screenshotContextId: composerImages.some(
                    (image) => image.id === existing.record.id,
                  )
                    ? existing.record.id
                    : undefined,
                })
              : existing?.kind === "thread" || existing?.kind === "environment"
                ? existing.record
                : existing
                  ? (uploadedContextRecordFromDraft(existing) ?? undefined)
                  : undefined;
      const matchesHydratedCodeReference =
        existingRecord?.kind === "review-comment" &&
        record.kind === "review-comment" &&
        isCodeReferenceContext(record) &&
        record.diff === "" &&
        existingRecord.sectionId === record.sectionId &&
        existingRecord.startIndex === record.startIndex &&
        existingRecord.endIndex === record.endIndex;
      if (
        existingRecord &&
        (isSameComposerContextPayload(existingRecord, record) || matchesHydratedCodeReference) &&
        record.kind !== "thread"
      ) {
        if (record.kind === "preview-annotation" && record.screenshotContextId) {
          skippedDependentAttachmentIds.add(record.screenshotContextId);
        }
        rewritten.set(record.contextId, existingRecord.contextId);
        continue;
      }
      const conflicts = existing !== undefined;
      switch (record.kind) {
        case "terminal": {
          const threadId = activeThread?.id ?? activeThreadId;
          if (!threadId) break;
          const imported = terminalContextDraftFromRecord(record, threadId);
          const draft = conflicts ? { ...imported, id: randomUUID() } : imported;
          addComposerDraftTerminalContexts(composerDraftTarget, [draft], {
            appendReference: false,
          });
          rewritten.set(record.contextId, terminalContextReference(draft).contextId);
          break;
        }
        case "review-comment": {
          const imported = reviewCommentFromRecord(record);
          const cachedContents =
            isCodeReferenceContext(imported) &&
            imported.diff === "" &&
            cwd &&
            !isAbsolutePath(imported.filePath)
              ? getProjectFileContents(environmentId, cwd, imported.filePath)
              : undefined;
          const hydratedDiff =
            cachedContents !== undefined
              ? sliceCodeReferenceLines(cachedContents, imported.startIndex, imported.endIndex)
              : imported.diff;
          const comment = {
            ...(conflicts ? { ...imported, id: randomUUID() } : imported),
            diff: hydratedDiff,
          };
          addComposerDraftReviewComment(composerDraftTarget, comment, {
            appendReference: false,
          });
          rewritten.set(record.contextId, reviewCommentContextId(comment.id));
          if (isCodeReferenceContext(comment) && comment.diff === "") {
            void hydrateCodeReference(comment, attachmentTargetKey);
          }
          break;
        }
        case "element":
        case "preview-annotation": {
          const imported =
            record.kind === "element"
              ? elementContextToPreviewAnnotation(record, randomUUID(), new Date().toISOString())
              : previewAnnotationFromRecord(record);
          const annotation = conflicts ? { ...imported, id: randomUUID() } : imported;
          if (record.kind === "preview-annotation" && record.screenshotContextId) {
            dependentAttachmentLocalIds.set(record.screenshotContextId, annotation.id);
          }
          addComposerDraftPreviewAnnotation(composerDraftTarget, annotation, {
            appendReference: false,
          });
          rewritten.set(record.contextId, previewAnnotationContextId(annotation.id));
          break;
        }
        case "thread": {
          // The agent reads threads on its own server and the machines it links to; a pasted
          // thread from any other machine is dropped.
          if (
            record.environmentId !== environmentId &&
            !linkedEnvironments.has(record.environmentId)
          )
            break;
          // Threads reuse their destination record by identity, reminting only on an ID collision.
          const threads = getComposerDraft(threadDraftTarget)?.threadContexts ?? [];
          const attached = threads.find(
            (thread) =>
              thread.environmentId === record.environmentId && thread.threadId === record.threadId,
          );
          const imported =
            attached ??
            (threads.some((thread) => thread.contextId === record.contextId)
              ? { ...record, contextId: toKindScopedComposerContextId("thread", randomUUID()) }
              : record);
          addComposerDraftThreadContexts(threadDraftTarget, [imported], {
            appendReference: false,
          });
          rewritten.set(record.contextId, imported.contextId);
          break;
        }
        case "environment": {
          // A machine means the same machine from any thread, so a pasted one is kept,
          // but not in an answer to an agent's question, which carries no machines.
          if (questionAttachmentTarget !== null) break;
          addComposerDraftEnvironmentContexts(composerDraftTarget, [record], {
            appendReference: false,
          });
          rewritten.set(record.contextId, record.contextId);
          break;
        }
        case "image":
        case "file": {
          if (skippedDependentAttachmentIds.has(record.contextId)) break;
          if (sourceEnvironmentId === null && !conflicts) {
            rewritten.set(record.contextId, record.contextId);
            break;
          }
          if (sourceEnvironmentId === null) break;
          const localId = dependentAttachmentLocalIds.get(record.contextId) ?? randomUUID();
          rewritten.set(record.contextId, toKindScopedComposerContextId(record.kind, localId));
          void importAttachmentRecord(record, localId, sourceEnvironmentId);
          break;
        }
        default:
          break;
      }
    }
    return rewritten;
  };
  const importContextFragment = (
    fragment: ComposerContextClipboardFragment,
  ): ReadonlyMap<string, string> =>
    importContextRecords(fragment.records, fragment.source.environmentId);
  const importContextFragmentStable = useStableCallback(importContextFragment);

  return {
    loadThreadTranscript,
    countReservedAttachments,
    countReservedAttachmentsStable,
    importContextRecords,
    importContextFragment,
    importContextFragmentStable,
  };
}
