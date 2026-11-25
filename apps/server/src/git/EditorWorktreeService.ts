import {
  EDITOR_WORKTREE_DIRECTORY_NAME,
  GitCommandError,
  ProjectId,
  ThreadId,
  type VcsAutoPulledThread,
  VcsEditorWorktreeConflictError,
  type VcsEditorWorktreeStatusInput,
  type VcsEditorWorktreeStatusResult,
  type VcsEnsureEditorWorktreeInput,
  type VcsEnsureEditorWorktreeResult,
  type VcsPullFromEditorWorktreeInput,
  type VcsPullFromEditorWorktreeResult,
  type VcsPushToEditorWorktreeInput,
  type VcsPushToEditorWorktreeResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  isFilesystemRoot,
  managedWorktreesDirectories,
  resolveWorktreesDirectory,
} from "../worktreesDirectory.ts";

const EDITOR_WORKTREE_METADATA_FILENAME = "t3-editor-sync.json" as const;

const EditorWorktreeSyncMetadata = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.NullOr(ThreadId),
  threadCwd: Schema.NullOr(Schema.String),
  requestedThreadCwd: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pushedHeadSha: Schema.String,
  pushedIndexTreeSha: Schema.String,
  pushedWorktreeTreeSha: Schema.String,
  pushedAt: Schema.String,
});
type EditorWorktreeSyncMetadata = typeof EditorWorktreeSyncMetadata.Type;

const decodeMetadataJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EditorWorktreeSyncMetadata),
);
const encodeMetadataJson = Schema.encodeEffect(Schema.fromJsonString(EditorWorktreeSyncMetadata));

interface WorkspaceTreeSnapshot {
  readonly headSha: string;
  readonly indexTreeSha: string;
  readonly worktreeTreeSha: string;
  readonly hasConflicts: boolean;
}

function snapshotsMatch(
  snapshot: WorkspaceTreeSnapshot,
  metadata: Pick<
    EditorWorktreeSyncMetadata,
    "pushedHeadSha" | "pushedIndexTreeSha" | "pushedWorktreeTreeSha"
  >,
): boolean {
  return (
    !snapshot.hasConflicts &&
    snapshot.headSha === metadata.pushedHeadSha &&
    snapshot.indexTreeSha === metadata.pushedIndexTreeSha &&
    snapshot.worktreeTreeSha === metadata.pushedWorktreeTreeSha
  );
}

export class EditorWorktreeService extends Context.Service<
  EditorWorktreeService,
  {
    readonly ensure: (
      input: VcsEnsureEditorWorktreeInput,
    ) => Effect.Effect<VcsEnsureEditorWorktreeResult, GitCommandError>;
    readonly status: (
      input: VcsEditorWorktreeStatusInput,
    ) => Effect.Effect<VcsEditorWorktreeStatusResult, GitCommandError>;
    readonly push: (
      input: VcsPushToEditorWorktreeInput,
    ) => Effect.Effect<
      VcsPushToEditorWorktreeResult,
      GitCommandError | VcsEditorWorktreeConflictError
    >;
    readonly pull: (
      input: VcsPullFromEditorWorktreeInput,
    ) => Effect.Effect<
      VcsPullFromEditorWorktreeResult,
      GitCommandError | VcsEditorWorktreeConflictError
    >;
  }
>()("t3/git/EditorWorktreeService") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const hostPlatform = yield* HostProcess.Platform;
  const longPaths = hostPlatform === "win32" ? ["-c", "core.longpaths=true"] : [];

  const realOrResolved = (target: string): Effect.Effect<string> =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  const withSortedWorkspaceLeases = <A, E, R>(
    targets: ReadonlyArray<string>,
    effect: (leasedPaths: ReadonlySet<string>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.forEach(targets, realOrResolved).pipe(
      Effect.flatMap((resolved) => {
        const uniqueSorted = [...new Set(resolved)].toSorted();
        const leasedSet = new Set(uniqueSorted);
        return uniqueSorted.reduceRight(
          (acc, key) => withWorkspaceLease(key, acc),
          effect(leasedSet),
        );
      }),
    );

  const runGit = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    options?: {
      readonly env?: NodeJS.ProcessEnv;
      readonly allowNonZeroExit?: boolean;
      readonly timeoutMs?: number | null;
    },
  ) =>
    git.execute({
      operation,
      cwd,
      args: [...longPaths, ...args],
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.allowNonZeroExit !== undefined
        ? { allowNonZeroExit: options.allowNonZeroExit }
        : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

  const parseMainWorktreePath = (porcelainZ: string): string | null => {
    for (const token of porcelainZ.split("\0")) {
      if (token.startsWith("worktree ")) {
        const mainPath = token.slice("worktree ".length);
        return mainPath.length > 0 ? mainPath : null;
      }
    }
    return null;
  };

  const inspectCheckout = Effect.fn("EditorWorktreeService.inspectCheckout")(function* (
    operation: string,
    rawCwd: string,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const cwd = path.resolve(expandHomePath(rawCwd, home));
    if (!(yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => false)))) {
      return null;
    }
    const probe = yield* runGit(
      operation,
      cwd,
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { allowNonZeroExit: true },
    );
    if (probe.exitCode !== 0) return null;
    const lines = probe.stdout.replace(/\r?\n$/u, "").split(/\r?\n/u);
    const topLevelRaw = lines[0]?.trim();
    const commonDirRaw = lines[1]?.trim();
    if (!topLevelRaw || !commonDirRaw) return null;

    const [topLevel, gitCommonDir, realCwd] = yield* Effect.all([
      realOrResolved(topLevelRaw),
      realOrResolved(commonDirRaw),
      realOrResolved(cwd),
    ]);

    const worktreeList = yield* runGit(
      operation,
      topLevel,
      ["worktree", "list", "--porcelain", "-z"],
      {
        allowNonZeroExit: true,
      },
    );
    const parsedMain =
      worktreeList.exitCode === 0 ? parseMainWorktreePath(worktreeList.stdout) : null;
    const mainWorktreePath = parsedMain ? yield* realOrResolved(parsedMain) : topLevel;

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => ({
        worktreesDirectory: "",
        previousWorktreesDirectories: [] as readonly string[],
      })),
    );
    const configuredParent = resolveWorktreesDirectory(
      settings.worktreesDirectory,
      serverConfig.worktreesDir,
      path,
      home,
    );
    if (configuredParent === null) {
      return yield* new GitCommandError({
        operation,
        command: "git worktree",
        cwd,
        detail: `The worktree location "${settings.worktreesDirectory}" must be an absolute folder on this machine, not a drive root.`,
      });
    }

    const managedRoots = yield* Effect.forEach(
      managedWorktreesDirectories(settings, serverConfig.worktreesDir, path, home),
      realOrResolved,
    );
    const matchingManagedBucket = managedRoots
      .map((root) => {
        if (isFilesystemRoot(root, path)) return null;
        const relative = path.relative(root, topLevel);
        const segments = relative.split(path.sep);
        if (
          path.isAbsolute(relative) ||
          segments.length !== 2 ||
          segments.some((segment) => segment === "" || segment === "..")
        ) {
          return null;
        }
        return path.join(root, segments[0]!);
      })
      .find((bucket): bucket is string => bucket !== null);

    const repoBucketDir =
      matchingManagedBucket ??
      path.join(yield* realOrResolved(configuredParent), path.basename(mainWorktreePath));
    const editorTopLevel = path.join(repoBucketDir, EDITOR_WORKTREE_DIRECTORY_NAME);

    const isLinkedWorktree = path.resolve(topLevel) !== path.resolve(editorTopLevel);

    const relativeSubpath = path.relative(topLevel, realCwd);
    const hasNestedSubpath =
      relativeSubpath !== "" &&
      !relativeSubpath.startsWith("..") &&
      !path.isAbsolute(relativeSubpath);
    const editorWorktreePath = hasNestedSubpath
      ? path.join(editorTopLevel, relativeSubpath)
      : editorTopLevel;

    return {
      cwd,
      topLevel,
      gitCommonDir,
      mainWorktreePath,
      editorTopLevel,
      editorWorktreePath,
      isLinkedWorktree,
    };
  });

  const inspectExistingEditorWorktree = Effect.fn(
    "EditorWorktreeService.inspectExistingEditorWorktree",
  )(function* (operation: string, editorTopLevel: string, expectedGitCommonDir: string) {
    const existsOnDisk = yield* fileSystem
      .exists(editorTopLevel)
      .pipe(Effect.orElseSucceed(() => false));
    if (!existsOnDisk) {
      return { kind: "missing" as const };
    }
    const probe = yield* runGit(
      operation,
      editorTopLevel,
      [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
        "--git-path",
        EDITOR_WORKTREE_METADATA_FILENAME,
      ],
      { allowNonZeroExit: true },
    );
    if (probe.exitCode !== 0) {
      return { kind: "invalid" as const, reason: "Path exists on disk and is not a Git worktree." };
    }
    const lines = probe.stdout.replace(/\r?\n$/u, "").split(/\r?\n/u);
    const [topRaw = "", commonRaw = "", metadataPath = ""] = lines;
    if (!topRaw || !commonRaw || !metadataPath) {
      return { kind: "invalid" as const, reason: "Could not inspect the Git worktree metadata." };
    }
    const [resolvedTop, resolvedCommon, expectedTop] = yield* Effect.all([
      realOrResolved(topRaw.trim()),
      realOrResolved(commonRaw.trim()),
      realOrResolved(editorTopLevel),
    ]);
    if (resolvedTop !== expectedTop || resolvedCommon !== expectedGitCommonDir) {
      return {
        kind: "invalid" as const,
        reason: "The 'cursor' worktree belongs to a different repository.",
      };
    }
    return {
      kind: "valid" as const,
      topLevel: resolvedTop,
      metadataPath: metadataPath.trim(),
    };
  });

  const readSyncMetadata = (
    metadataPath: string,
  ): Effect.Effect<EditorWorktreeSyncMetadata | null> =>
    fileSystem.readFileString(metadataPath).pipe(
      Effect.flatMap(decodeMetadataJson),
      Effect.orElseSucceed(() => null),
    );

  const writeSyncMetadata = (
    operation: string,
    cwd: string,
    metadataPath: string,
    metadata: EditorWorktreeSyncMetadata,
  ): Effect.Effect<void, GitCommandError> =>
    encodeMetadataJson(metadata).pipe(
      Effect.flatMap((json) => fileSystem.writeFileString(metadataPath, `${json}\n`)),
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation,
            command: "write-sync-metadata",
            cwd,
            detail: `Failed to record editor worktree state: ${String(cause)}`,
            cause,
          }),
      ),
    );

  const captureWorkspaceTrees = Effect.fn("EditorWorktreeService.captureWorkspaceTrees")(function* (
    operation: string,
    topLevel: string,
    gitCommonDir: string,
  ) {
    const headResult = yield* runGit(
      operation,
      topLevel,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { allowNonZeroExit: true },
    );
    const headSha = headResult.exitCode === 0 ? headResult.stdout.trim() : "";
    if (!headSha) {
      return yield* new GitCommandError({
        operation,
        command: "git rev-parse HEAD",
        cwd: topLevel,
        detail: "Create an initial commit before syncing with the editor worktree.",
      });
    }

    const unmerged = yield* runGit(operation, topLevel, ["ls-files", "-u", "-z"]);
    const hasConflicts = unmerged.stdout.length > 0;

    const indexPathResult = yield* runGit(operation, topLevel, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]);
    const userIndexPath = indexPathResult.stdout.trim();
    const indexId = yield* random.uuidV4();
    const tempIndexPath = path.join(gitCommonDir, `t3-editor-sync-index-${indexId}`);
    const indexEnv: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndexPath };
    const indexConfig = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.splitIndex=false",
      "-c",
      "splitIndex.sharedIndexExpire=never",
      "-c",
      "core.safecrlf=false",
    ];

    const cleanupTempIndex = Effect.forEach(
      [tempIndexPath, `${tempIndexPath}.lock`],
      (file) => fileSystem.remove(file, { force: true }).pipe(Effect.ignore),
      { discard: true },
    );

    return yield* Effect.gen(function* () {
      const hasUserIndex = yield* fileSystem
        .exists(userIndexPath)
        .pipe(Effect.orElseSucceed(() => false));
      if (hasUserIndex && !hasConflicts) {
        yield* fileSystem.copyFile(userIndexPath, tempIndexPath).pipe(
          Effect.catch(() =>
            runGit(operation, topLevel, [...indexConfig, "read-tree", "HEAD"], {
              env: indexEnv,
            }).pipe(Effect.asVoid),
          ),
        );
      } else {
        yield* runGit(operation, topLevel, [...indexConfig, "read-tree", "HEAD"], {
          env: indexEnv,
        });
      }

      const indexTree = yield* runGit(operation, topLevel, [...indexConfig, "write-tree"], {
        env: indexEnv,
      });
      const indexTreeSha = indexTree.stdout.trim();

      yield* runGit(operation, topLevel, [...indexConfig, "add", "-A", "--", "."], {
        env: indexEnv,
      });
      const worktreeTree = yield* runGit(operation, topLevel, [...indexConfig, "write-tree"], {
        env: indexEnv,
      });
      const worktreeTreeSha = worktreeTree.stdout.trim();

      return {
        headSha,
        indexTreeSha,
        worktreeTreeSha,
        hasConflicts,
      } satisfies WorkspaceTreeSnapshot;
    }).pipe(Effect.ensuring(cleanupTempIndex));
  });

  const applyWorkspaceTrees = Effect.fn("EditorWorktreeService.applyWorkspaceTrees")(function* (
    operation: string,
    targetTopLevel: string,
    snapshot: WorkspaceTreeSnapshot,
    mode: "detach" | "update-current-ref",
  ) {
    const indexConfig = ["-c", "core.fsmonitor=false", "-c", "core.safecrlf=false"];

    if (mode === "detach") {
      // Detach first if a branch was checked out inside the editor worktree, so updating HEAD
      // never moves that branch ref or holds a worktree lock on it.
      const symbolic = yield* runGit(
        operation,
        targetTopLevel,
        ["symbolic-ref", "--quiet", "HEAD"],
        { allowNonZeroExit: true },
      );
      if (symbolic.exitCode === 0) {
        const currentHead = yield* runGit(operation, targetTopLevel, ["rev-parse", "HEAD"]);
        yield* runGit(operation, targetTopLevel, [
          "update-ref",
          "--no-deref",
          "HEAD",
          currentHead.stdout.trim(),
        ]);
      }
    }

    // Stage current disk contents so `read-tree --reset -u` removes stale untracked files while
    // leaving unchanged tracked files' mtimes untouched (keeping gopls / LSP caches warm) and
    // leaving gitignored files (.env, build caches) untouched.
    yield* runGit(operation, targetTopLevel, ["reset", "--quiet"], { allowNonZeroExit: true });
    yield* runGit(operation, targetTopLevel, [...indexConfig, "add", "-A", "--", "."]);
    yield* runGit(operation, targetTopLevel, [
      ...indexConfig,
      "read-tree",
      "--reset",
      "-u",
      snapshot.worktreeTreeSha,
    ]);
    yield* runGit(operation, targetTopLevel, ["clean", "-fd", "--", "."]);

    let updatedBranch: string | null = null;
    if (mode === "detach") {
      yield* runGit(operation, targetTopLevel, [
        "update-ref",
        "--no-deref",
        "-m",
        "t3: push to editor worktree",
        "HEAD",
        snapshot.headSha,
      ]);
    } else {
      const symbolic = yield* runGit(
        operation,
        targetTopLevel,
        ["symbolic-ref", "--quiet", "HEAD"],
        { allowNonZeroExit: true },
      );
      const symbolicRef = symbolic.exitCode === 0 ? symbolic.stdout.trim() : "";
      if (symbolicRef.startsWith("refs/heads/")) {
        updatedBranch = symbolicRef.slice("refs/heads/".length);
        yield* runGit(operation, targetTopLevel, [
          "update-ref",
          "-m",
          "t3: pull from editor worktree",
          symbolicRef,
          snapshot.headSha,
        ]);
      } else {
        yield* runGit(operation, targetTopLevel, [
          "update-ref",
          "--no-deref",
          "-m",
          "t3: pull from editor worktree",
          "HEAD",
          snapshot.headSha,
        ]);
      }
    }

    yield* runGit(operation, targetTopLevel, [...indexConfig, "read-tree", snapshot.indexTreeSha]);
    yield* runGit(operation, targetTopLevel, ["update-index", "-q", "--refresh"], {
      allowNonZeroExit: true,
    });

    return updatedBranch;
  });

  const detachSymbolicHead = Effect.fn("EditorWorktreeService.detachSymbolicHead")(function* (
    operation: string,
    targetTopLevel: string,
    headSha: string,
  ) {
    const symbolic = yield* runGit(operation, targetTopLevel, ["symbolic-ref", "--quiet", "HEAD"], {
      allowNonZeroExit: true,
    });
    if (symbolic.exitCode === 0) {
      yield* runGit(operation, targetTopLevel, ["update-ref", "--no-deref", "HEAD", headSha]);
    }
  });

  const ensure: EditorWorktreeService["Service"]["ensure"] = Effect.fn(
    "EditorWorktreeService.ensure",
  )(function* (input) {
    const operation = "EditorWorktreeService.ensure";
    const info = yield* inspectCheckout(operation, input.cwd);
    if (!info) {
      return {
        editorWorktreePath: null,
        created: false,
      };
    }

    const existingOutside = yield* inspectExistingEditorWorktree(
      operation,
      info.editorTopLevel,
      info.gitCommonDir,
    );
    if (existingOutside.kind === "valid") {
      return {
        editorWorktreePath: existingOutside.topLevel,
        created: false,
      };
    }
    if (existingOutside.kind === "invalid") {
      return {
        editorWorktreePath: null,
        created: false,
      };
    }

    const headProbe = yield* runGit(
      operation,
      info.topLevel,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { allowNonZeroExit: true },
    );
    const headSha = headProbe.exitCode === 0 ? headProbe.stdout.trim() : "";
    if (!headSha) {
      return {
        editorWorktreePath: null,
        created: false,
      };
    }

    return yield* withSortedWorkspaceLeases([info.mainWorktreePath, info.editorTopLevel], () =>
      Effect.gen(function* () {
        const existing = yield* inspectExistingEditorWorktree(
          operation,
          info.editorTopLevel,
          info.gitCommonDir,
        );
        if (existing.kind === "valid") {
          return {
            editorWorktreePath: existing.topLevel,
            created: false,
          };
        }
        if (existing.kind === "invalid") {
          return {
            editorWorktreePath: null,
            created: false,
          };
        }

        yield* fileSystem
          .makeDirectory(path.dirname(info.editorTopLevel), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new GitCommandError({
                  operation,
                  command: "mkdir",
                  cwd: info.topLevel,
                  detail: `Could not create editor worktree parent directory: ${cause.message}`,
                  cause,
                }),
            ),
          );
        yield* runGit(operation, info.topLevel, ["worktree", "prune"], {
          allowNonZeroExit: true,
        });
        yield* runGit(
          operation,
          info.topLevel,
          [
            "-c",
            "checkout.workers=0",
            "worktree",
            "add",
            "--detach",
            "--",
            info.editorTopLevel,
            headSha,
          ],
          { timeoutMs: null },
        );
        const editorRealTopLevel = yield* realOrResolved(info.editorTopLevel);
        const metaResult = yield* runGit(operation, editorRealTopLevel, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          EDITOR_WORKTREE_METADATA_FILENAME,
        ]);
        const metadataPath = metaResult.stdout.trim();
        const initialSnapshot = yield* captureWorkspaceTrees(
          operation,
          editorRealTopLevel,
          info.gitCommonDir,
        );
        const now = yield* DateTime.now;
        yield* writeSyncMetadata(operation, editorRealTopLevel, metadataPath, {
          version: 1,
          threadId: null,
          threadCwd: null,
          requestedThreadCwd: null,
          pushedHeadSha: initialSnapshot.headSha,
          pushedIndexTreeSha: initialSnapshot.indexTreeSha,
          pushedWorktreeTreeSha: initialSnapshot.worktreeTreeSha,
          pushedAt: DateTime.formatIso(now),
        });

        yield* setupScriptRunner
          .runForThread({
            threadId: `editor-worktree:${input.projectId ?? info.mainWorktreePath}`,
            ...(input.projectId ? { projectId: ProjectId.make(input.projectId) } : {}),
            projectCwd: info.mainWorktreePath,
            worktreePath: editorRealTopLevel,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Editor worktree setup script failed to start", { cause }),
            ),
          );

        return {
          editorWorktreePath: editorRealTopLevel,
          created: true,
        };
      }),
    );
  });

  const status: EditorWorktreeService["Service"]["status"] = Effect.fn(
    "EditorWorktreeService.status",
  )(function* (input) {
    const operation = "EditorWorktreeService.status";
    const info = yield* inspectCheckout(operation, input.cwd);
    if (!info || !info.isLinkedWorktree) {
      return {
        isLinkedWorktree: false,
        editorWorktreePath: null,
        exists: false,
        ownerThreadId: null,
        hasUnpulledEditorChanges: false,
      };
    }

    const existing = yield* inspectExistingEditorWorktree(
      operation,
      info.editorTopLevel,
      info.gitCommonDir,
    );
    if (existing.kind !== "valid") {
      return {
        isLinkedWorktree: true,
        editorWorktreePath: info.editorWorktreePath,
        exists: false,
        ownerThreadId: null,
        hasUnpulledEditorChanges: false,
      };
    }

    const metadata = yield* readSyncMetadata(existing.metadataPath);
    if (!metadata) {
      const dirty = yield* runGit(
        operation,
        existing.topLevel,
        ["status", "--porcelain", "--untracked-files=normal"],
        { allowNonZeroExit: true },
      );
      return {
        isLinkedWorktree: true,
        editorWorktreePath: info.editorWorktreePath,
        exists: true,
        ownerThreadId: null,
        hasUnpulledEditorChanges: dirty.exitCode === 0 && dirty.stdout.trim().length > 0,
      };
    }

    const currentSnapshot = yield* captureWorkspaceTrees(
      operation,
      existing.topLevel,
      info.gitCommonDir,
    ).pipe(Effect.orElseSucceed(() => null));

    return {
      isLinkedWorktree: true,
      editorWorktreePath: info.editorWorktreePath,
      exists: true,
      ownerThreadId: metadata.threadId,
      hasUnpulledEditorChanges:
        currentSnapshot === null ? false : !snapshotsMatch(currentSnapshot, metadata),
    };
  });

  const push: EditorWorktreeService["Service"]["push"] = Effect.fn("EditorWorktreeService.push")(
    function* (input) {
      const operation = "EditorWorktreeService.push";
      const info = yield* inspectCheckout(operation, input.cwd);
      if (!info) {
        return yield* new GitCommandError({
          operation,
          command: "git rev-parse",
          cwd: input.cwd,
          detail: "The workspace is not a Git repository.",
        });
      }
      if (!info.isLinkedWorktree) {
        return yield* new VcsEditorWorktreeConflictError({
          reason: "invalid_target_worktree",
          ownerThreadId: null,
          editorWorktreePath: info.editorWorktreePath,
          detail: "The dedicated editor worktree cannot push to itself.",
        });
      }

      const peekedExisting =
        input.autoPullPrevious === true
          ? yield* inspectExistingEditorWorktree(operation, info.editorTopLevel, info.gitCommonDir)
          : null;
      const peekedMetadata =
        peekedExisting?.kind === "valid"
          ? yield* readSyncMetadata(peekedExisting.metadataPath)
          : null;

      type PushAttemptOutcome =
        | { readonly _tag: "Done"; readonly result: VcsPushToEditorWorktreeResult }
        | { readonly _tag: "RetryWithExtraLease"; readonly extraPath: string };

      const runPushAttempt = (
        extraLeasePaths: ReadonlyArray<string>,
        allowLeaseRetry: boolean,
      ): Effect.Effect<PushAttemptOutcome, GitCommandError | VcsEditorWorktreeConflictError> =>
        withSortedWorkspaceLeases(
          [info.mainWorktreePath, info.topLevel, info.editorTopLevel, ...extraLeasePaths],
          (leasedPaths) =>
            Effect.gen(function* () {
              const threadSnapshot = yield* captureWorkspaceTrees(
                operation,
                info.topLevel,
                info.gitCommonDir,
              );
              if (threadSnapshot.hasConflicts) {
                return yield* new VcsEditorWorktreeConflictError({
                  reason: "unresolved_conflicts",
                  ownerThreadId: null,
                  editorWorktreePath: info.editorWorktreePath,
                  detail: "Resolve merge conflicts in this thread before pushing to the editor.",
                });
              }

              const existing = yield* inspectExistingEditorWorktree(
                operation,
                info.editorTopLevel,
                info.gitCommonDir,
              );
              if (existing.kind === "invalid") {
                return yield* new VcsEditorWorktreeConflictError({
                  reason: "invalid_target_worktree",
                  ownerThreadId: null,
                  editorWorktreePath: info.editorWorktreePath,
                  detail: existing.reason,
                });
              }

              let created = false;
              let metadataPath: string;
              let editorRealTopLevel: string;
              let autoPulledThread: VcsAutoPulledThread | null = null;
              let editorSnapshotIfValid: WorkspaceTreeSnapshot | null = null;

              if (existing.kind === "valid") {
                metadataPath = existing.metadataPath;
                editorRealTopLevel = existing.topLevel;
                const mappedExistingEditorPath =
                  info.editorWorktreePath === info.editorTopLevel
                    ? editorRealTopLevel
                    : path.join(
                        editorRealTopLevel,
                        path.relative(info.editorTopLevel, info.editorWorktreePath),
                      );
                const metadata = yield* readSyncMetadata(metadataPath);
                if (metadata) {
                  const editorSnapshot = yield* captureWorkspaceTrees(
                    operation,
                    editorRealTopLevel,
                    info.gitCommonDir,
                  );
                  editorSnapshotIfValid = editorSnapshot;

                  if (
                    input.force !== true &&
                    metadata.threadId === input.threadId &&
                    snapshotsMatch(threadSnapshot, metadata) &&
                    snapshotsMatch(editorSnapshot, metadata)
                  ) {
                    return {
                      _tag: "Done" as const,
                      result: {
                        editorWorktreePath: mappedExistingEditorPath,
                        created: false,
                        headSha: threadSnapshot.headSha,
                        autoPulledThread: null,
                        noop: true,
                      },
                    };
                  }

                  if (!snapshotsMatch(editorSnapshot, metadata)) {
                    if (
                      input.autoPullPrevious === true &&
                      metadata.threadId !== null &&
                      metadata.threadCwd !== null
                    ) {
                      const resolvedPrevOwnerTop = yield* realOrResolved(metadata.threadCwd);
                      if (!leasedPaths.has(resolvedPrevOwnerTop) && allowLeaseRetry) {
                        return {
                          _tag: "RetryWithExtraLease" as const,
                          extraPath: resolvedPrevOwnerTop,
                        };
                      }
                      if (editorSnapshot.hasConflicts && input.force !== true) {
                        return yield* new VcsEditorWorktreeConflictError({
                          reason: "unresolved_conflicts",
                          ownerThreadId: metadata.threadId,
                          editorWorktreePath: info.editorWorktreePath,
                          detail: "Resolve merge conflicts in the editor worktree before syncing.",
                        });
                      }

                      if (resolvedPrevOwnerTop === info.topLevel) {
                        if (snapshotsMatch(threadSnapshot, metadata)) {
                          yield* detachSymbolicHead(
                            operation,
                            editorRealTopLevel,
                            editorSnapshot.headSha,
                          );
                          const pulledBranch = yield* applyWorkspaceTrees(
                            operation,
                            info.topLevel,
                            editorSnapshot,
                            "update-current-ref",
                          );
                          const now = yield* DateTime.now;
                          yield* writeSyncMetadata(operation, editorRealTopLevel, metadataPath, {
                            version: 1,
                            threadId: input.threadId,
                            threadCwd: info.topLevel,
                            requestedThreadCwd: input.cwd,
                            pushedHeadSha: editorSnapshot.headSha,
                            pushedIndexTreeSha: editorSnapshot.indexTreeSha,
                            pushedWorktreeTreeSha: editorSnapshot.worktreeTreeSha,
                            pushedAt: DateTime.formatIso(now),
                          });
                          return {
                            _tag: "Done" as const,
                            result: {
                              editorWorktreePath: mappedExistingEditorPath,
                              created: false,
                              headSha: editorSnapshot.headSha,
                              autoPulledThread: {
                                threadId: metadata.threadId,
                                cwd: metadata.requestedThreadCwd ?? input.cwd,
                                headSha: editorSnapshot.headSha,
                                branch: pulledBranch,
                              },
                              noop: false,
                            },
                          };
                        }
                        if (input.force !== true) {
                          return yield* new VcsEditorWorktreeConflictError({
                            reason: "unpulled_editor_changes",
                            ownerThreadId: metadata.threadId,
                            editorWorktreePath: info.editorWorktreePath,
                            detail:
                              "Both this thread and the editor worktree have unsynced changes.",
                          });
                        }
                      } else if (leasedPaths.has(resolvedPrevOwnerTop)) {
                        const prevOwnerInfo = yield* inspectCheckout(operation, metadata.threadCwd);
                        const prevOwnerSnapshot =
                          prevOwnerInfo !== null &&
                          prevOwnerInfo.isLinkedWorktree &&
                          prevOwnerInfo.gitCommonDir === info.gitCommonDir
                            ? yield* captureWorkspaceTrees(
                                operation,
                                prevOwnerInfo.topLevel,
                                info.gitCommonDir,
                              ).pipe(Effect.orElseSucceed(() => null))
                            : null;
                        const canAutoPullPrevOwner =
                          prevOwnerInfo !== null &&
                          prevOwnerSnapshot !== null &&
                          !editorSnapshot.hasConflicts &&
                          !prevOwnerSnapshot.hasConflicts &&
                          (snapshotsMatch(prevOwnerSnapshot, metadata) ||
                            snapshotsMatch(prevOwnerSnapshot, {
                              pushedHeadSha: editorSnapshot.headSha,
                              pushedIndexTreeSha: editorSnapshot.indexTreeSha,
                              pushedWorktreeTreeSha: editorSnapshot.worktreeTreeSha,
                            }));

                        if (canAutoPullPrevOwner) {
                          yield* detachSymbolicHead(
                            operation,
                            editorRealTopLevel,
                            editorSnapshot.headSha,
                          );
                          const pulledBranch = yield* applyWorkspaceTrees(
                            operation,
                            prevOwnerInfo.topLevel,
                            editorSnapshot,
                            "update-current-ref",
                          );
                          autoPulledThread = {
                            threadId: metadata.threadId,
                            cwd: metadata.requestedThreadCwd ?? metadata.threadCwd,
                            headSha: editorSnapshot.headSha,
                            branch: pulledBranch,
                          };
                        } else if (input.force !== true) {
                          return yield* new VcsEditorWorktreeConflictError({
                            reason: "unpulled_editor_changes",
                            ownerThreadId: metadata.threadId,
                            editorWorktreePath: info.editorWorktreePath,
                            detail:
                              "The editor worktree has unpulled changes that could not be merged into the previous thread automatically.",
                          });
                        }
                      } else if (input.force !== true) {
                        return yield* new VcsEditorWorktreeConflictError({
                          reason: "unpulled_editor_changes",
                          ownerThreadId: metadata.threadId,
                          editorWorktreePath: info.editorWorktreePath,
                          detail: "The editor worktree has unpulled changes.",
                        });
                      }
                    } else if (input.force !== true) {
                      return yield* new VcsEditorWorktreeConflictError({
                        reason: "unpulled_editor_changes",
                        ownerThreadId: metadata.threadId,
                        editorWorktreePath: info.editorWorktreePath,
                        detail: "The editor worktree has unpulled changes.",
                      });
                    }
                  }
                } else if (input.force !== true) {
                  const dirty = yield* runGit(operation, editorRealTopLevel, [
                    "status",
                    "--porcelain",
                    "--untracked-files=normal",
                  ]);
                  if (dirty.stdout.trim().length > 0) {
                    return yield* new VcsEditorWorktreeConflictError({
                      reason: "unpulled_editor_changes",
                      ownerThreadId: null,
                      editorWorktreePath: info.editorWorktreePath,
                      detail: "The editor worktree has uncommitted changes.",
                    });
                  }
                }
              } else {
                yield* fileSystem
                  .makeDirectory(path.dirname(info.editorTopLevel), { recursive: true })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new GitCommandError({
                          operation,
                          command: "mkdir",
                          cwd: info.topLevel,
                          detail: `Could not create editor worktree parent directory: ${cause.message}`,
                          cause,
                        }),
                    ),
                  );
                yield* runGit(operation, info.topLevel, ["worktree", "prune"], {
                  allowNonZeroExit: true,
                });
                yield* runGit(
                  operation,
                  info.topLevel,
                  [
                    "-c",
                    "checkout.workers=0",
                    "worktree",
                    "add",
                    "--detach",
                    "--",
                    info.editorTopLevel,
                    threadSnapshot.headSha,
                  ],
                  { timeoutMs: null },
                );
                created = true;
                editorRealTopLevel = yield* realOrResolved(info.editorTopLevel);
                const metaResult = yield* runGit(operation, editorRealTopLevel, [
                  "rev-parse",
                  "--path-format=absolute",
                  "--git-path",
                  EDITOR_WORKTREE_METADATA_FILENAME,
                ]);
                metadataPath = metaResult.stdout.trim();
              }

              const editorAlreadyMatchesTarget =
                editorSnapshotIfValid !== null &&
                snapshotsMatch(editorSnapshotIfValid, {
                  pushedHeadSha: threadSnapshot.headSha,
                  pushedIndexTreeSha: threadSnapshot.indexTreeSha,
                  pushedWorktreeTreeSha: threadSnapshot.worktreeTreeSha,
                });

              if (editorAlreadyMatchesTarget) {
                yield* detachSymbolicHead(operation, editorRealTopLevel, threadSnapshot.headSha);
              } else {
                yield* applyWorkspaceTrees(operation, editorRealTopLevel, threadSnapshot, "detach");
              }

              const now = yield* DateTime.now;
              yield* writeSyncMetadata(operation, editorRealTopLevel, metadataPath, {
                version: 1,
                threadId: input.threadId,
                threadCwd: info.topLevel,
                requestedThreadCwd: input.cwd,
                pushedHeadSha: threadSnapshot.headSha,
                pushedIndexTreeSha: threadSnapshot.indexTreeSha,
                pushedWorktreeTreeSha: threadSnapshot.worktreeTreeSha,
                pushedAt: DateTime.formatIso(now),
              });

              if (created) {
                yield* setupScriptRunner
                  .runForThread({
                    threadId: input.threadId,
                    ...(input.projectId ? { projectId: ProjectId.make(input.projectId) } : {}),
                    projectCwd: info.mainWorktreePath,
                    worktreePath: editorRealTopLevel,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Editor worktree setup script failed to start", { cause }),
                    ),
                  );
              }

              const mappedEditorPath =
                info.editorWorktreePath === info.editorTopLevel
                  ? editorRealTopLevel
                  : path.join(
                      editorRealTopLevel,
                      path.relative(info.editorTopLevel, info.editorWorktreePath),
                    );

              return {
                _tag: "Done" as const,
                result: {
                  editorWorktreePath: mappedEditorPath,
                  created,
                  headSha: threadSnapshot.headSha,
                  autoPulledThread,
                  noop: false,
                },
              };
            }),
        );

      const initialExtra = peekedMetadata?.threadCwd ? [peekedMetadata.threadCwd] : [];
      const firstOutcome = yield* runPushAttempt(initialExtra, true);
      if (firstOutcome._tag === "Done") {
        return firstOutcome.result;
      }
      const retriedOutcome = yield* runPushAttempt(
        [...initialExtra, firstOutcome.extraPath],
        false,
      );
      if (retriedOutcome._tag === "Done") {
        return retriedOutcome.result;
      }
      return yield* new VcsEditorWorktreeConflictError({
        reason: "unpulled_editor_changes",
        ownerThreadId: null,
        editorWorktreePath: info.editorWorktreePath,
        detail: "The editor worktree changed concurrently during sync.",
      });
    },
  );

  const pull: EditorWorktreeService["Service"]["pull"] = Effect.fn("EditorWorktreeService.pull")(
    function* (input) {
      const operation = "EditorWorktreeService.pull";
      const info = yield* inspectCheckout(operation, input.cwd);
      if (!info) {
        return yield* new GitCommandError({
          operation,
          command: "git rev-parse",
          cwd: input.cwd,
          detail: "The workspace is not a Git repository.",
        });
      }
      if (!info.isLinkedWorktree) {
        return yield* new VcsEditorWorktreeConflictError({
          reason: "invalid_target_worktree",
          ownerThreadId: null,
          editorWorktreePath: info.editorWorktreePath,
          detail: "The dedicated editor worktree cannot pull into itself.",
        });
      }

      return yield* withSortedWorkspaceLeases([info.topLevel, info.editorTopLevel], () =>
        Effect.gen(function* () {
          const existing = yield* inspectExistingEditorWorktree(
            operation,
            info.editorTopLevel,
            info.gitCommonDir,
          );
          if (existing.kind !== "valid") {
            return yield* new VcsEditorWorktreeConflictError({
              reason: "editor_worktree_missing",
              ownerThreadId: null,
              editorWorktreePath: info.editorWorktreePath,
              detail: "Push this thread to the editor worktree first.",
            });
          }

          const metadata = yield* readSyncMetadata(existing.metadataPath);
          if (!metadata || metadata.threadId !== input.threadId) {
            return yield* new VcsEditorWorktreeConflictError({
              reason: "wrong_owner_thread",
              ownerThreadId: metadata?.threadId ?? null,
              editorWorktreePath: info.editorWorktreePath,
              detail:
                metadata === null || metadata.threadId === null
                  ? "No thread has pushed to the editor worktree yet."
                  : "Another thread pushed to the editor worktree most recently.",
            });
          }

          const editorSnapshot = yield* captureWorkspaceTrees(
            operation,
            existing.topLevel,
            info.gitCommonDir,
          );
          if (editorSnapshot.hasConflicts) {
            return yield* new VcsEditorWorktreeConflictError({
              reason: "unresolved_conflicts",
              ownerThreadId: metadata.threadId,
              editorWorktreePath: info.editorWorktreePath,
              detail: "Resolve merge conflicts in the editor worktree before pulling.",
            });
          }

          const threadSnapshot = yield* captureWorkspaceTrees(
            operation,
            info.topLevel,
            info.gitCommonDir,
          );
          if (threadSnapshot.hasConflicts && input.force !== true) {
            return yield* new VcsEditorWorktreeConflictError({
              reason: "thread_changed_since_push",
              ownerThreadId: metadata.threadId,
              editorWorktreePath: info.editorWorktreePath,
              detail: "This thread has unresolved conflicts since the last push.",
            });
          }

          const mappedEditorPath =
            info.editorWorktreePath === info.editorTopLevel
              ? existing.topLevel
              : path.join(
                  existing.topLevel,
                  path.relative(info.editorTopLevel, info.editorWorktreePath),
                );

          if (input.force !== true && snapshotsMatch(editorSnapshot, metadata)) {
            const symbolic = yield* runGit(
              operation,
              info.topLevel,
              ["symbolic-ref", "--quiet", "HEAD"],
              { allowNonZeroExit: true },
            );
            const symbolicRef = symbolic.exitCode === 0 ? symbolic.stdout.trim() : "";
            const currentBranch = symbolicRef.startsWith("refs/heads/")
              ? symbolicRef.slice("refs/heads/".length)
              : null;
            return {
              editorWorktreePath: mappedEditorPath,
              headSha: editorSnapshot.headSha,
              branch: currentBranch,
              noop: true,
            };
          }

          if (
            input.force !== true &&
            !snapshotsMatch(threadSnapshot, metadata) &&
            !snapshotsMatch(threadSnapshot, {
              pushedHeadSha: editorSnapshot.headSha,
              pushedIndexTreeSha: editorSnapshot.indexTreeSha,
              pushedWorktreeTreeSha: editorSnapshot.worktreeTreeSha,
            })
          ) {
            return yield* new VcsEditorWorktreeConflictError({
              reason: "thread_changed_since_push",
              ownerThreadId: metadata.threadId,
              editorWorktreePath: info.editorWorktreePath,
              detail:
                "This thread's workspace also changed since you pushed to the editor. Pulling will replace it with the editor's current state.",
            });
          }

          // Ensure the editor worktree stays detached at its current commit so it never holds a
          // branch lock if the user checked out a branch inside the editor.
          yield* detachSymbolicHead(operation, existing.topLevel, editorSnapshot.headSha);

          const branch = yield* applyWorkspaceTrees(
            operation,
            info.topLevel,
            editorSnapshot,
            "update-current-ref",
          );

          const now = yield* DateTime.now;
          yield* writeSyncMetadata(operation, existing.topLevel, existing.metadataPath, {
            version: 1,
            threadId: input.threadId,
            threadCwd: info.topLevel,
            requestedThreadCwd: input.cwd,
            pushedHeadSha: editorSnapshot.headSha,
            pushedIndexTreeSha: editorSnapshot.indexTreeSha,
            pushedWorktreeTreeSha: editorSnapshot.worktreeTreeSha,
            pushedAt: DateTime.formatIso(now),
          });

          return {
            editorWorktreePath: mappedEditorPath,
            headSha: editorSnapshot.headSha,
            branch,
            noop: false,
          };
        }),
      );
    },
  );

  return EditorWorktreeService.of({
    ensure,
    status,
    push,
    pull,
  });
});

export const layer = Layer.effect(EditorWorktreeService, make);
