// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CheckpointRef,
  CommandId,
  CorrelationId,
  EventId,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { afterAll, describe, expect, it } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefsPrefixForThread } from "../../checkpointing/Utils.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  sweepThreadCheckpointRefs,
  ThreadDeletionReactorLive,
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
      getThreadLifecycleById: () => Effect.die("unused"),
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

  effectIt.effect("deletes every ref the thread captured, from the project workspace root", () =>
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

  effectIt.effect("skips the delete when the thread captured no checkpoints", () =>
    Effect.gen(function* () {
      const calls = yield* runSweep({
        workspaceRoot: Option.some(makeWorkspaceRoot({ git: true })),
        listed: [],
      });

      expect(calls.listed).toHaveLength(1);
      expect(calls.deleted).toEqual([]);
    }),
  );

  effectIt.effect("skips workspaces that are not git repositories", () =>
    Effect.gen(function* () {
      const calls = yield* runSweep({
        workspaceRoot: Option.some(makeWorkspaceRoot({ git: false })),
        listed: [capturedRef],
      });

      expect(calls.listed).toEqual([]);
      expect(calls.deleted).toEqual([]);
    }),
  );

  effectIt.effect("skips threads whose project can no longer be resolved", () =>
    Effect.gen(function* () {
      const calls = yield* runSweep({ workspaceRoot: Option.none(), listed: [capturedRef] });

      expect(calls.listed).toEqual([]);
      expect(calls.deleted).toEqual([]);
    }),
  );
});

describe("ThreadDeletionReactor drain", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const threadId = ThreadId.make("thread-deletion-reactor-drain");
  const deletedEvent = (sequence: number): OrchestrationEvent => ({
    sequence,
    eventId: EventId.make(`evt-deleted-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.deleted",
    occurredAt: now,
    commandId: CommandId.make(`cmd-deleted-${sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-deleted-${sequence}`),
    metadata: {},
    payload: { threadId, deletedAt: now },
  });

  effectIt.effect("waits for a published deletion the subscriber has not consumed yet", () =>
    Effect.gen(function* () {
      const stops: Array<number> = [];
      const firstCleanupDone = yield* Deferred.make<void>();
      // The engine has already committed and published sequence 2, but the
      // subscriber has not received it yet: the stream releases it on demand.
      const releaseSecondEvent = yield* Deferred.make<void>();
      const latestSequence = yield* Ref.make(0);
      const engine = {
        latestSequence: Ref.get(latestSequence),
        streamDomainEvents: Stream.concat(
          Stream.make(deletedEvent(1)),
          Stream.fromEffect(Deferred.await(releaseSecondEvent)).pipe(
            Stream.map(() => deletedEvent(2)),
          ),
        ),
      } as unknown as OrchestrationEngineShape;
      const providerService = {
        stopSession: () =>
          Effect.gen(function* () {
            stops.push(stops.length + 1);
            if (stops.length === 1) {
              yield* Deferred.succeed(firstCleanupDone, undefined);
            }
          }),
      } as unknown as ProviderServiceShape;
      const terminalManager = {
        close: () => Effect.void,
      } as unknown as TerminalManager.TerminalManager["Service"];
      // The fork sweeps checkpoint refs on deletion (#24), so the reactor also
      // needs these two. A thread with no workspace root skips the sweep, which
      // keeps this test about drain ordering alone.
      const projection = {
        getThreadWorkspaceRoot: () => Effect.succeed(Option.none<string>()),
      } as unknown as ProjectionSnapshotQuery["Service"];
      const checkpointStore = {
        isGitRepository: () => Effect.die("unused"),
      } as unknown as CheckpointStore.CheckpointStore["Service"];
      const layer = ThreadDeletionReactorLive.pipe(
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(TerminalManager.TerminalManager, terminalManager)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provide(Layer.succeed(ProjectionSnapshotQuery, projection)),
        Layer.provide(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* ThreadDeletionReactor;
          yield* reactor.start();
          yield* Deferred.await(firstCleanupDone);

          // Sequence 1 is fully cleaned and the worker queue is idle. Sequence
          // 2 is committed and published but still in flight to the subscriber.
          yield* Ref.set(latestSequence, 2);
          const drained = yield* Effect.forkChild(reactor.drainThrough(2));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(stops).toEqual([1]);
          expect(drained.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(releaseSecondEvent, undefined);
          yield* Fiber.join(drained);
          expect(stops).toEqual([1, 2]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
