// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import { CheckpointRef, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterAll, describe, expect } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefsPrefixForThread } from "../../checkpointing/Utils.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  logCleanupCauseUnlessInterrupted,
  sweepThreadCheckpointRefs,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("sweepThreadCheckpointRefs", () => {
  const threadId = ThreadId.make("thread-checkpoint-sweep");
  const refPrefix = checkpointRefsPrefixForThread(threadId);
  const capturedRef = CheckpointRef.make(`${refPrefix}/turn/1`);

  const tempDirs: Array<string> = [];

  afterAll(() => {
    for (const dir of tempDirs) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  const makeWorkspaceRoot = (options: { readonly git: boolean }) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "thread-deletion-reactor-"));
    tempDirs.push(dir);
    if (options.git) {
      NodeFS.mkdirSync(NodePath.join(dir, ".git"));
    }
    return dir;
  };

  const makeProjectionLayer = (workspaceRoot: Option.Option<string>) =>
    Layer.succeed(ProjectionSnapshotQuery, {
      getCommandReadModel: () => Effect.die("unused"),
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () => Effect.die("unused"),
      getArchivedShellSnapshot: () => Effect.die("unused"),
      searchThreads: () => Effect.die("unused"),
      getSnapshotSequence: () => Effect.die("unused"),
      getCounts: () => Effect.die("unused"),
      getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
      getProjectShellById: () => Effect.die("unused"),
      getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
      getThreadCheckpointContext: () => Effect.die("unused"),
      getThreadWorkspaceRoot: () => Effect.succeed(workspaceRoot),
      getFullThreadDiffContext: () => Effect.die("unused"),
      getThreadShellById: () => Effect.die("unused"),
      getThreadDetailById: () => Effect.die("unused"),
      getThreadDetailSnapshot: () => Effect.die("unused"),
    });

  const makeCheckpointStoreLayer = (
    listed: ReadonlyArray<CheckpointRef>,
    calls: {
      readonly listed: Array<CheckpointStore.ListCheckpointRefsInput>;
      readonly deleted: Array<CheckpointStore.DeleteCheckpointRefsInput>;
    },
  ) =>
    Layer.succeed(CheckpointStore.CheckpointStore, {
      isGitRepository: () => Effect.die("unused"),
      captureCheckpoint: () => Effect.die("unused"),
      hasCheckpointRef: () => Effect.die("unused"),
      restoreCheckpoint: () => Effect.die("unused"),
      diffCheckpoints: () => Effect.die("unused"),
      listCheckpointRefs: (input) =>
        Effect.sync(() => {
          calls.listed.push(input);
          return listed;
        }),
      deleteCheckpointRefs: (input) =>
        Effect.sync(() => {
          calls.deleted.push(input);
        }),
    });

  const runSweep = (input: {
    readonly workspaceRoot: Option.Option<string>;
    readonly listed?: ReadonlyArray<CheckpointRef>;
  }) =>
    Effect.gen(function* () {
      const calls = {
        listed: [] as Array<CheckpointStore.ListCheckpointRefsInput>,
        deleted: [] as Array<CheckpointStore.DeleteCheckpointRefsInput>,
      };
      yield* sweepThreadCheckpointRefs(threadId).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeProjectionLayer(input.workspaceRoot),
            makeCheckpointStoreLayer(input.listed ?? [], calls),
          ),
        ),
      );
      return calls;
    });

  it.effect("deletes every ref the thread captured, from the project workspace root", () =>
    Effect.gen(function* () {
      const workspaceRoot = makeWorkspaceRoot({ git: true });

      const calls = yield* runSweep({
        workspaceRoot: Option.some(workspaceRoot),
        listed: [capturedRef],
      });

      expect(calls.listed).toEqual([{ cwd: workspaceRoot, refPrefix }]);
      expect(calls.deleted).toEqual([{ cwd: workspaceRoot, checkpointRefs: [capturedRef] }]);
    }),
  );

  it.effect("skips the delete when the thread captured no checkpoints", () =>
    Effect.gen(function* () {
      const calls = yield* runSweep({
        workspaceRoot: Option.some(makeWorkspaceRoot({ git: true })),
        listed: [],
      });

      expect(calls.listed).toHaveLength(1);
      expect(calls.deleted).toEqual([]);
    }),
  );

  it.effect("skips workspaces that are not git repositories", () =>
    Effect.gen(function* () {
      const calls = yield* runSweep({
        workspaceRoot: Option.some(makeWorkspaceRoot({ git: false })),
        listed: [capturedRef],
      });

      expect(calls.listed).toEqual([]);
      expect(calls.deleted).toEqual([]);
    }),
  );

  it.effect("skips threads whose project can no longer be resolved", () =>
    Effect.gen(function* () {
      const calls = yield* runSweep({ workspaceRoot: Option.none(), listed: [capturedRef] });

      expect(calls.listed).toEqual([]);
      expect(calls.deleted).toEqual([]);
    }),
  );
});
