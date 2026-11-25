import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VcsEditorWorktreeConflictError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  resetConfirmDialogForTests,
  respondToConfirmDialog,
  subscribeConfirmDialogHost,
} from "./confirmDialog";
import {
  type EditorWorktreeAutoSyncState,
  type ForegroundEditorSyncSnapshot,
  planEditorWorktreeAutoSync,
  remapPathToEditorWorktree,
  runPushToEditorWorktreeWithConfirm,
} from "./editorWorktreeSync.logic";

describe("remapPathToEditorWorktree", () => {
  it("remaps worktree roots, nested files, line/column suffixes, and file:// URIs", () => {
    const threadWorktreePath = "/Users/dev/.t3/worktrees/myrepo/t3-abc123";
    const editorWorktreePath = "/Users/dev/.t3/worktrees/myrepo/cursor";

    expect(
      remapPathToEditorWorktree({
        targetPath: threadWorktreePath,
        threadWorktreePath,
        editorWorktreePath,
      }),
    ).toBe(editorWorktreePath);

    expect(
      remapPathToEditorWorktree({
        targetPath: `${threadWorktreePath}/internal/server/http.go:42:7`,
        threadWorktreePath,
        editorWorktreePath,
      }),
    ).toBe(`${editorWorktreePath}/internal/server/http.go:42:7`);

    expect(
      remapPathToEditorWorktree({
        targetPath: `file://${threadWorktreePath}/cmd/main.go#L19`,
        threadWorktreePath,
        editorWorktreePath,
      }),
    ).toBe(`file://${editorWorktreePath}/cmd/main.go#L19`);
  });

  it("returns null for paths outside the thread worktree", () => {
    expect(
      remapPathToEditorWorktree({
        targetPath: "/Users/dev/other-repo/main.go:10",
        threadWorktreePath: "/Users/dev/.t3/worktrees/myrepo/t3-abc123",
        editorWorktreePath: "/Users/dev/.t3/worktrees/myrepo/cursor",
      }),
    ).toBeNull();

    expect(
      remapPathToEditorWorktree({
        targetPath: "/Users/dev/.t3/worktrees/myrepo/t3-abc123-other/main.go",
        threadWorktreePath: "/Users/dev/.t3/worktrees/myrepo/t3-abc123",
        editorWorktreePath: "/Users/dev/.t3/worktrees/myrepo/cursor",
      }),
    ).toBeNull();
  });
});

describe("runPushToEditorWorktreeWithConfirm", () => {
  it("prompts and retries with force=true when the editor worktree has unpulled changes", async () => {
    resetConfirmDialogForTests();
    const unsubscribe = subscribeConfirmDialogHost(() => {
      queueMicrotask(() => respondToConfirmDialog(true));
    });

    try {
      const pushCommand = vi
        .fn()
        .mockResolvedValueOnce(
          AsyncResult.failure(
            Cause.fail(
              new VcsEditorWorktreeConflictError({
                reason: "unpulled_editor_changes",
                ownerThreadId: ThreadId.make("other-thread"),
                editorWorktreePath: "/wt/myrepo/cursor",
                detail: "Unpulled changes",
              }),
            ),
          ),
        )
        .mockResolvedValueOnce(
          AsyncResult.success({
            editorWorktreePath: "/wt/myrepo/cursor",
            created: false,
            headSha: "abc123",
          }),
        );

      const result = await runPushToEditorWorktreeWithConfirm({
        environmentId: EnvironmentId.make("env-1"),
        cwd: "/wt/myrepo/t3-1",
        threadId: ThreadId.make("thread-1"),
        editorLabel: "Cursor",
        pushCommand,
      });

      expect(result).toEqual({
        editorWorktreePath: "/wt/myrepo/cursor",
        created: false,
        headSha: "abc123",
      });
      expect(pushCommand).toHaveBeenCalledTimes(2);
      expect(pushCommand).toHaveBeenNthCalledWith(1, {
        environmentId: "env-1",
        input: { cwd: "/wt/myrepo/t3-1", threadId: "thread-1", autoPullPrevious: true },
      });
      expect(pushCommand).toHaveBeenNthCalledWith(2, {
        environmentId: "env-1",
        input: { cwd: "/wt/myrepo/t3-1", threadId: "thread-1", force: true },
      });
    } finally {
      unsubscribe();
      resetConfirmDialogForTests();
    }
  });
});

describe("planEditorWorktreeAutoSync", () => {
  const ENV = EnvironmentId.make("env-1");
  const PROJECT_1 = ProjectId.make("proj-1");
  const PROJECT_2 = ProjectId.make("proj-2");
  const THREAD_A = ThreadId.make("thread-a");
  const THREAD_B = ThreadId.make("thread-b");
  const THREAD_C = ThreadId.make("thread-c");

  const makeTarget = (
    overrides: Partial<ForegroundEditorSyncSnapshot> = {},
  ): ForegroundEditorSyncSnapshot => ({
    routeKey: `${ENV}:${THREAD_A}`,
    environmentId: ENV,
    threadId: THREAD_A,
    projectId: PROJECT_1,
    worktreePath: "/wt/repo1/t3-a",
    isWorking: false,
    mutationKey: "m1",
    canWriteSourceControl: true,
    ...overrides,
  });

  it("uses atomic push+autoPullPrevious across same-project worktree switches and pushes again when a turn settles", () => {
    const emptyState: EditorWorktreeAutoSyncState = {
      previousWorktree: null,
      lastSyncedStateKey: null,
    };

    // Initial selection of idle Thread A
    const step1 = planEditorWorktreeAutoSync(emptyState, makeTarget(), "state");
    expect(step1.autoPullTarget).toBeNull();
    expect(step1.autoSyncTarget).toMatchObject({
      cwd: "/wt/repo1/t3-a",
      threadId: THREAD_A,
    });

    // Duplicate state render does not re-trigger
    const dup = planEditorWorktreeAutoSync(step1.nextState, makeTarget(), "state");
    expect(dup.autoPullTarget).toBeNull();
    expect(dup.autoSyncTarget).toBeNull();

    // Focus return re-triggers sync on the idle active thread so external editor edits are pulled
    const focus = planEditorWorktreeAutoSync(dup.nextState, makeTarget(), "focus");
    expect(focus.autoSyncTarget?.threadId).toBe(THREAD_A);

    // Rapid switch A -> (debounced past B) -> idle Thread C in same project uses atomic autoSyncTarget (no separate pull RPC)
    const stepC = planEditorWorktreeAutoSync(
      step1.nextState,
      makeTarget({
        routeKey: `${ENV}:${THREAD_C}`,
        threadId: THREAD_C,
        worktreePath: "/wt/repo1/t3-c",
        mutationKey: "m1",
      }),
      "state",
    );
    expect(stepC.autoPullTarget).toBeNull();
    expect(stepC.autoSyncTarget).toMatchObject({
      cwd: "/wt/repo1/t3-c",
      threadId: THREAD_C,
    });

    // Turn starts on Thread C (isWorking=true): no push while running, preserves previousWorktree
    const runningC = planEditorWorktreeAutoSync(
      stepC.nextState,
      makeTarget({
        routeKey: `${ENV}:${THREAD_C}`,
        threadId: THREAD_C,
        worktreePath: "/wt/repo1/t3-c",
        isWorking: true,
        mutationKey: "m1",
      }),
      "state",
    );
    expect(runningC.autoPullTarget).toBeNull();
    expect(runningC.autoSyncTarget).toBeNull();
    expect(runningC.nextState.previousWorktree?.threadId).toBe(THREAD_C);

    // Turn settles on Thread C (isWorking=false, mutationKey="m2"): auto-pushes settled state!
    const settledC = planEditorWorktreeAutoSync(
      runningC.nextState,
      makeTarget({
        routeKey: `${ENV}:${THREAD_C}`,
        threadId: THREAD_C,
        worktreePath: "/wt/repo1/t3-c",
        isWorking: false,
        mutationKey: "m2",
      }),
      "state",
    );
    expect(settledC.autoSyncTarget).toMatchObject({
      cwd: "/wt/repo1/t3-c",
      threadId: THREAD_C,
    });
  });

  it("explicitly auto-pulls the previous worktree thread when switching to a non-worktree thread, running thread, or another project", () => {
    const afterA = planEditorWorktreeAutoSync(
      { previousWorktree: null, lastSyncedStateKey: null },
      makeTarget(),
      "state",
    );

    // Switch Thread A -> local non-worktree thread (worktreePath: null)
    const toLocal = planEditorWorktreeAutoSync(
      afterA.nextState,
      makeTarget({
        routeKey: `${ENV}:${THREAD_B}`,
        threadId: THREAD_B,
        worktreePath: null,
      }),
      "state",
    );
    expect(toLocal.autoPullTarget).toEqual({
      environmentId: ENV,
      cwd: "/wt/repo1/t3-a",
      threadId: THREAD_A,
    });
    expect(toLocal.autoSyncTarget).toBeNull();

    // Switch Thread A -> another project's worktree thread
    const toOtherProject = planEditorWorktreeAutoSync(
      afterA.nextState,
      makeTarget({
        routeKey: `${ENV}:${THREAD_B}`,
        threadId: THREAD_B,
        projectId: PROJECT_2,
        worktreePath: "/wt/repo2/t3-b",
      }),
      "state",
    );
    expect(toOtherProject.autoPullTarget).toEqual({
      environmentId: ENV,
      cwd: "/wt/repo1/t3-a",
      threadId: THREAD_A,
    });
    expect(toOtherProject.autoSyncTarget).toMatchObject({
      cwd: "/wt/repo2/t3-b",
      threadId: THREAD_B,
      projectId: PROJECT_2,
    });
  });
});
