import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type GitCommandError, ThreadId, VcsEditorWorktreeConflictError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as EditorWorktreeService from "./EditorWorktreeService.ts";

const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const isConflictError = Schema.is(VcsEditorWorktreeConflictError);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("EditorWorktreeService", (it) => {
  const withHarness = <A, E>(
    body: (ctx: {
      readonly mainRepo: string;
      readonly worktreeA: string;
      readonly worktreeB: string;
      readonly worktreesDir: string;
      readonly setupRuns: Array<string>;
      readonly service: EditorWorktreeService.EditorWorktreeService["Service"];
      readonly git: (
        cwd: string,
        args: ReadonlyArray<string>,
      ) => Effect.Effect<string, GitCommandError>;
    }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-editor-wt-" });
      const mainRepo = path.join(root, "myrepo");
      yield* fs.makeDirectory(mainRepo, { recursive: true });

      const setupRuns: Array<string> = [];
      const testServerConfigLayer = ServerConfig.layerTest(mainRepo, {
        prefix: "t3-editor-wt-home-",
      }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

      const fullLayer = EditorWorktreeService.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            runForThread: (input) =>
              Effect.sync(() => {
                setupRuns.push(input.worktreePath);
                return { status: "no-script" as const };
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              worktreesDirectory: "",
              previousWorktreesDirectories: [],
            } as never),
          }),
        ),
        Layer.provideMerge(GitVcsDriver.layer),
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(testServerConfigLayer),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      return yield* Effect.gen(function* () {
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const config = yield* ServerConfig.ServerConfig;
        const service = yield* EditorWorktreeService.EditorWorktreeService;

        const git = (cwd: string, args: ReadonlyArray<string>) =>
          driver
            .execute({
              operation: "EditorWorktreeService.test",
              cwd,
              args: ["-c", "user.email=test@t3.codes", "-c", "user.name=Test", ...args],
            })
            .pipe(Effect.map((res) => res.stdout.trim()));

        yield* git(mainRepo, ["init", "-b", "main"]);
        yield* fs.writeFileString(path.join(mainRepo, ".gitignore"), "*.env\n");
        yield* fs.writeFileString(path.join(mainRepo, "unchanged.go"), "package main\n");
        yield* fs.writeFileString(path.join(mainRepo, "handler.go"), "package v1\n");
        yield* git(mainRepo, ["add", "-A"]);
        yield* git(mainRepo, ["commit", "-m", "initial"]);

        const bucketDir = path.join(config.worktreesDir, "myrepo");
        yield* fs.makeDirectory(bucketDir, { recursive: true });
        const worktreeA = path.join(bucketDir, "t3-branch-a");
        const worktreeB = path.join(bucketDir, "t3-branch-b");
        yield* git(mainRepo, ["worktree", "add", "-b", "t3/branch-a", worktreeA, "main"]);
        yield* git(mainRepo, ["worktree", "add", "-b", "t3/branch-b", worktreeB, "main"]);

        return yield* body({
          mainRepo,
          worktreeA,
          worktreeB,
          worktreesDir: config.worktreesDir,
          setupRuns,
          service,
          git,
        });
      }).pipe(Effect.provide(fullLayer));
    }).pipe(Effect.scoped);

  it.effect(
    "creates the 'cursor' sibling worktree on push and pulls committed + staged + unstaged + untracked changes back onto the thread branch",
    () =>
      withHarness(({ mainRepo, worktreeA, worktreesDir, setupRuns, service, git }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const mainStatus = yield* service.status({ cwd: mainRepo });
          assert.strictEqual(mainStatus.isLinkedWorktree, false);

          const beforePush = yield* service.status({ cwd: worktreeA });
          assert.strictEqual(beforePush.isLinkedWorktree, true);
          assert.strictEqual(beforePush.exists, false);
          assert.strictEqual(beforePush.ownerThreadId, null);

          yield* fs.writeFileString(path.join(worktreeA, "handler.go"), "package staged\n");
          yield* git(worktreeA, ["add", "handler.go"]);
          yield* fs.writeFileString(path.join(worktreeA, "handler.go"), "package unstaged\n");
          yield* fs.writeFileString(path.join(worktreeA, "new_helper.go"), "package helper\n");
          yield* fs.writeFileString(path.join(worktreeA, "local.env"), "THREAD_SECRET=1\n");

          const pushed = yield* service.push({ cwd: worktreeA, threadId: THREAD_A });
          const expectedCursorPath = yield* fs.realPath(
            path.join(worktreesDir, "myrepo", "cursor"),
          );
          assert.strictEqual(pushed.created, true);
          assert.strictEqual(pushed.editorWorktreePath, expectedCursorPath);
          assert.strictEqual(setupRuns.length, 1);

          assert.strictEqual(
            yield* fs.readFileString(path.join(expectedCursorPath, "handler.go")),
            "package unstaged\n",
          );
          assert.strictEqual(
            yield* fs.readFileString(path.join(expectedCursorPath, "new_helper.go")),
            "package helper\n",
          );
          const cursorPorcelain = yield* git(expectedCursorPath, ["status", "--short"]);
          assert.include(cursorPorcelain, "MM handler.go");
          assert.include(cursorPorcelain, "?? new_helper.go");

          yield* fs.writeFileString(
            path.join(expectedCursorPath, "cursor.env"),
            "CURSOR_CACHE=1\n",
          );

          const cleanStatus = yield* service.status({ cwd: worktreeA });
          assert.strictEqual(cleanStatus.exists, true);
          assert.strictEqual(cleanStatus.ownerThreadId, THREAD_A);
          assert.strictEqual(cleanStatus.hasUnpulledEditorChanges, false);

          yield* git(expectedCursorPath, ["add", "handler.go", "new_helper.go"]);
          yield* git(expectedCursorPath, ["commit", "-m", "feat: commit inside cursor"]);
          const cursorCommitSha = yield* git(expectedCursorPath, ["rev-parse", "HEAD"]);

          yield* fs.writeFileString(
            path.join(expectedCursorPath, "handler.go"),
            "package v3_staged\n",
          );
          yield* git(expectedCursorPath, ["add", "handler.go"]);
          yield* fs.writeFileString(
            path.join(expectedCursorPath, "handler.go"),
            "package v4_unstaged\n",
          );
          yield* fs.writeFileString(
            path.join(expectedCursorPath, "cursor_untracked.go"),
            "package extra\n",
          );

          const dirtyStatus = yield* service.status({ cwd: worktreeA });
          assert.strictEqual(dirtyStatus.hasUnpulledEditorChanges, true);

          const pulled = yield* service.pull({ cwd: worktreeA, threadId: THREAD_A });
          assert.strictEqual(pulled.branch, "t3/branch-a");
          assert.strictEqual(pulled.headSha, cursorCommitSha);

          assert.strictEqual(yield* git(worktreeA, ["rev-parse", "t3/branch-a"]), cursorCommitSha);
          assert.strictEqual(
            yield* fs.readFileString(path.join(worktreeA, "handler.go")),
            "package v4_unstaged\n",
          );
          assert.strictEqual(
            yield* fs.readFileString(path.join(worktreeA, "cursor_untracked.go")),
            "package extra\n",
          );
          assert.strictEqual(
            yield* fs.readFileString(path.join(worktreeA, "local.env")),
            "THREAD_SECRET=1\n",
          );
          const threadPorcelain = yield* git(worktreeA, ["status", "--short"]);
          assert.include(threadPorcelain, "MM handler.go");
          assert.include(threadPorcelain, "?? cursor_untracked.go");

          const syncedAgain = yield* service.status({ cwd: worktreeA });
          assert.strictEqual(syncedAgain.hasUnpulledEditorChanges, false);
        }),
      ),
  );

  it.effect(
    "enforces thread ownership on pull, guards unpulled changes on push, and preserves unchanged file mtimes",
    () =>
      withHarness(({ worktreeA, worktreeB, setupRuns, service }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          const firstPush = yield* service.push({ cwd: worktreeA, threadId: THREAD_A });
          const cursorDir = firstPush.editorWorktreePath;

          const wrongPull = yield* Effect.flip(
            service.pull({ cwd: worktreeB, threadId: THREAD_B }),
          );
          assert.isTrue(isConflictError(wrongPull));
          if (isConflictError(wrongPull)) {
            assert.strictEqual(wrongPull.reason, "wrong_owner_thread");
            assert.strictEqual(wrongPull.ownerThreadId, THREAD_A);
          }

          const unchangedPath = path.join(cursorDir, "unchanged.go");
          const oldEpochSec = 1_700_000_000;
          yield* fs.utimes(unchangedPath, oldEpochSec, oldEpochSec);
          const mtimeBefore = Option.getOrThrow((yield* fs.stat(unchangedPath)).mtime).getTime();

          yield* fs.writeFileString(path.join(worktreeB, "handler.go"), "package from_b\n");
          const secondPush = yield* service.push({ cwd: worktreeB, threadId: THREAD_B });
          assert.strictEqual(secondPush.created, false);
          assert.strictEqual(setupRuns.length, 1);

          const mtimeAfter = Option.getOrThrow((yield* fs.stat(unchangedPath)).mtime).getTime();
          assert.strictEqual(mtimeAfter, mtimeBefore);

          yield* fs.writeFileString(path.join(cursorDir, "handler.go"), "package unpulled_edit\n");
          const blockedPush = yield* Effect.flip(
            service.push({ cwd: worktreeA, threadId: THREAD_A }),
          );
          assert.isTrue(isConflictError(blockedPush));
          if (isConflictError(blockedPush)) {
            assert.strictEqual(blockedPush.reason, "unpulled_editor_changes");
            assert.strictEqual(blockedPush.ownerThreadId, THREAD_B);
          }

          yield* service.push({ cwd: worktreeA, threadId: THREAD_A, force: true });
          const afterForce = yield* service.status({ cwd: worktreeA });
          assert.strictEqual(afterForce.ownerThreadId, THREAD_A);
          assert.strictEqual(afterForce.hasUnpulledEditorChanges, false);

          yield* fs.writeFileString(path.join(cursorDir, "handler.go"), "package cursor_side\n");
          yield* fs.writeFileString(path.join(worktreeA, "handler.go"), "package agent_side\n");
          const divergedPull = yield* Effect.flip(
            service.pull({ cwd: worktreeA, threadId: THREAD_A }),
          );
          assert.isTrue(isConflictError(divergedPull));
          if (isConflictError(divergedPull)) {
            assert.strictEqual(divergedPull.reason, "thread_changed_since_push");
          }

          yield* service.pull({ cwd: worktreeA, threadId: THREAD_A, force: true });
          assert.strictEqual(
            yield* fs.readFileString(path.join(worktreeA, "handler.go")),
            "package cursor_side\n",
          );
        }),
      ),
  );

  it.effect(
    "eagerly ensures the 'cursor' worktree from the project root and atomically auto-pulls on thread switch and same-thread return",
    () =>
      withHarness(({ mainRepo, worktreeA, worktreeB, worktreesDir, setupRuns, service, git }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          // Unborn / non-git directories return cleanly without throwing.
          const nonGitDir = path.join(path.dirname(mainRepo), "not-a-repo");
          yield* fs.makeDirectory(nonGitDir, { recursive: true });
          const nonGitResult = yield* service.ensure({ cwd: nonGitDir });
          assert.strictEqual(nonGitResult.created, false);
          assert.strictEqual(nonGitResult.editorWorktreePath, null);

          const unbornRepo = path.join(path.dirname(mainRepo), "unborn-repo");
          yield* fs.makeDirectory(unbornRepo, { recursive: true });
          yield* git(unbornRepo, ["init", "-b", "main"]);
          const unbornResult = yield* service.ensure({ cwd: unbornRepo });
          assert.strictEqual(unbornResult.created, false);
          assert.strictEqual(unbornResult.editorWorktreePath, null);

          // Eagerly ensuring from mainRepo creates <worktreesDir>/myrepo/cursor once.
          const ensuredFirst = yield* service.ensure({ cwd: mainRepo });
          const expectedCursorPath = yield* fs.realPath(
            path.join(worktreesDir, "myrepo", "cursor"),
          );
          assert.strictEqual(ensuredFirst.created, true);
          assert.strictEqual(ensuredFirst.editorWorktreePath, expectedCursorPath);
          assert.strictEqual(setupRuns.length, 1);

          const ensuredSecond = yield* service.ensure({ cwd: mainRepo });
          assert.strictEqual(ensuredSecond.created, false);
          assert.strictEqual(ensuredSecond.editorWorktreePath, expectedCursorPath);
          assert.strictEqual(setupRuns.length, 1);

          const initialStatus = yield* service.status({ cwd: worktreeA });
          assert.strictEqual(initialStatus.exists, true);
          assert.strictEqual(initialStatus.ownerThreadId, null);
          assert.strictEqual(initialStatus.hasUnpulledEditorChanges, false);

          // Selecting Thread A pushes Thread A cleanly onto the pre-created cursor worktree.
          const pushA = yield* service.push({
            cwd: worktreeA,
            threadId: THREAD_A,
            autoPullPrevious: true,
          });
          assert.strictEqual(pushA.created, false);
          assert.strictEqual(pushA.noop, false);

          // Repeat push with no changes hits the fast no-op path.
          const noopPushA = yield* service.push({
            cwd: worktreeA,
            threadId: THREAD_A,
            autoPullPrevious: true,
          });
          assert.strictEqual(noopPushA.noop, true);
          const noopPullA = yield* service.pull({ cwd: worktreeA, threadId: THREAD_A });
          assert.strictEqual(noopPullA.noop, true);

          // User commits + leaves uncommitted edits inside cursor while on Thread A.
          yield* fs.writeFileString(
            path.join(expectedCursorPath, "handler.go"),
            "package committed_in_cursor\n",
          );
          yield* git(expectedCursorPath, ["add", "handler.go"]);
          yield* git(expectedCursorPath, ["commit", "-m", "feat: cursor commit on A"]);
          const commitOnASha = yield* git(expectedCursorPath, ["rev-parse", "HEAD"]);
          yield* fs.writeFileString(
            path.join(expectedCursorPath, "handler.go"),
            "package dirty_in_cursor\n",
          );
          yield* fs.writeFileString(
            path.join(expectedCursorPath, "draft_a.go"),
            "package draft_a\n",
          );

          // User switches from Thread A -> Thread B (`autoPullPrevious: true`).
          yield* fs.writeFileString(path.join(worktreeB, "handler.go"), "package thread_b_state\n");
          const switchToB = yield* service.push({
            cwd: worktreeB,
            threadId: THREAD_B,
            autoPullPrevious: true,
          });

          // Thread A automatically received both the commit and uncommitted files from cursor!
          assert.isNotNull(switchToB.autoPulledThread ?? null);
          assert.strictEqual(switchToB.autoPulledThread?.threadId, THREAD_A);
          assert.strictEqual(switchToB.autoPulledThread?.cwd, worktreeA);
          assert.strictEqual(switchToB.autoPulledThread?.branch, "t3/branch-a");
          assert.strictEqual(yield* git(worktreeA, ["rev-parse", "t3/branch-a"]), commitOnASha);
          assert.strictEqual(
            yield* fs.readFileString(path.join(worktreeA, "handler.go")),
            "package dirty_in_cursor\n",
          );
          assert.strictEqual(
            yield* fs.readFileString(path.join(worktreeA, "draft_a.go")),
            "package draft_a\n",
          );

          // And cursor now holds Thread B's state!
          assert.strictEqual(
            yield* fs.readFileString(path.join(expectedCursorPath, "handler.go")),
            "package thread_b_state\n",
          );
          assert.isFalse(yield* fs.exists(path.join(expectedCursorPath, "draft_a.go")));

          // Same-thread return: editing in cursor while staying on Thread B pulls into Thread B.
          yield* fs.writeFileString(
            path.join(expectedCursorPath, "handler.go"),
            "package edited_b_in_cursor\n",
          );
          const sameThreadSync = yield* service.push({
            cwd: worktreeB,
            threadId: THREAD_B,
            autoPullPrevious: true,
          });
          assert.strictEqual(sameThreadSync.autoPulledThread?.threadId, THREAD_B);
          assert.strictEqual(
            yield* fs.readFileString(path.join(worktreeB, "handler.go")),
            "package edited_b_in_cursor\n",
          );

          // Split-brain guard: if both Thread B and cursor diverge independently, auto-sync refuses to clobber.
          yield* fs.writeFileString(
            path.join(expectedCursorPath, "handler.go"),
            "package cursor_diverged\n",
          );
          yield* fs.writeFileString(path.join(worktreeB, "handler.go"), "package agent_diverged\n");
          const splitBrain = yield* Effect.flip(
            service.push({
              cwd: worktreeA,
              threadId: THREAD_A,
              autoPullPrevious: true,
            }),
          );
          assert.isTrue(isConflictError(splitBrain));
          if (isConflictError(splitBrain)) {
            assert.strictEqual(splitBrain.reason, "unpulled_editor_changes");
            assert.strictEqual(splitBrain.ownerThreadId, THREAD_B);
          }
        }),
      ),
  );
});
