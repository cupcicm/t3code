import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const EDITOR_WORKTREE_DIRECTORY_NAME = "cursor" as const;

export const VcsEditorWorktreeStatusInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type VcsEditorWorktreeStatusInput = typeof VcsEditorWorktreeStatusInput.Type;

export const VcsEnsureEditorWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  projectId: Schema.optional(ProjectId),
});
export type VcsEnsureEditorWorktreeInput = typeof VcsEnsureEditorWorktreeInput.Type;

export const VcsEnsureEditorWorktreeResult = Schema.Struct({
  editorWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  created: Schema.Boolean,
});
export type VcsEnsureEditorWorktreeResult = typeof VcsEnsureEditorWorktreeResult.Type;

export const VcsEditorWorktreeStatusResult = Schema.Struct({
  isLinkedWorktree: Schema.Boolean,
  editorWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  exists: Schema.Boolean,
  ownerThreadId: Schema.NullOr(ThreadId),
  hasUnpulledEditorChanges: Schema.Boolean,
});
export type VcsEditorWorktreeStatusResult = typeof VcsEditorWorktreeStatusResult.Type;

export const VcsPushToEditorWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  threadId: ThreadId,
  projectId: Schema.optional(ProjectId),
  force: Schema.optional(Schema.Boolean),
  autoPullPrevious: Schema.optional(Schema.Boolean),
});
export type VcsPushToEditorWorktreeInput = typeof VcsPushToEditorWorktreeInput.Type;

export const VcsAutoPulledThread = Schema.Struct({
  threadId: ThreadId,
  cwd: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
});
export type VcsAutoPulledThread = typeof VcsAutoPulledThread.Type;

export const VcsPushToEditorWorktreeResult = Schema.Struct({
  editorWorktreePath: TrimmedNonEmptyString,
  created: Schema.Boolean,
  headSha: TrimmedNonEmptyString,
  autoPulledThread: Schema.optionalKey(Schema.NullOr(VcsAutoPulledThread)),
  noop: Schema.optionalKey(Schema.Boolean),
});
export type VcsPushToEditorWorktreeResult = typeof VcsPushToEditorWorktreeResult.Type;

export const VcsPullFromEditorWorktreeInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  threadId: ThreadId,
  force: Schema.optional(Schema.Boolean),
});
export type VcsPullFromEditorWorktreeInput = typeof VcsPullFromEditorWorktreeInput.Type;

export const VcsPullFromEditorWorktreeResult = Schema.Struct({
  editorWorktreePath: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  noop: Schema.optionalKey(Schema.Boolean),
});
export type VcsPullFromEditorWorktreeResult = typeof VcsPullFromEditorWorktreeResult.Type;

export const VcsEditorWorktreeConflictReason = Schema.Literals([
  "unpulled_editor_changes",
  "wrong_owner_thread",
  "editor_worktree_missing",
  "thread_changed_since_push",
  "invalid_target_worktree",
  "unresolved_conflicts",
]);
export type VcsEditorWorktreeConflictReason = typeof VcsEditorWorktreeConflictReason.Type;

export class VcsEditorWorktreeConflictError extends Schema.TaggedError<VcsEditorWorktreeConflictError>()(
  "VcsEditorWorktreeConflictError",
  {
    reason: VcsEditorWorktreeConflictReason,
    ownerThreadId: Schema.NullOr(ThreadId),
    editorWorktreePath: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
