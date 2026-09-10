import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { checkpointRefsPrefixForThread } from "../../checkpointing/Utils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

/**
 * Drop every checkpoint ref a thread ever captured.
 *
 * Sweeps against the project's workspace root rather than the thread's
 * worktree: `refs/t3/checkpoints/…` is not one of git's per-worktree ref
 * namespaces, so the refs land in the primary checkout's ref store and outlive
 * `git worktree remove`. Enumerating the namespace rather than reading the
 * read model's checkpoint list also catches refs from captures that never made
 * it into the projection.
 */
export const sweepThreadCheckpointRefs = Effect.fn("sweepThreadCheckpointRefs")(function* (
  threadId: ThreadId,
) {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;

  const workspaceRoot = yield* projectionSnapshotQuery.getThreadWorkspaceRoot(threadId);
  if (Option.isNone(workspaceRoot)) {
    return;
  }
  if (!(yield* checkpointStore.isGitRepository(workspaceRoot.value))) {
    return;
  }

  const checkpointRefs = yield* checkpointStore.listCheckpointRefs({
    cwd: workspaceRoot.value,
    refPrefix: checkpointRefsPrefixForThread(threadId),
  });
  if (checkpointRefs.length === 0) {
    return;
  }

  yield* checkpointStore.deleteCheckpointRefs({
    cwd: workspaceRoot.value,
    checkpointRefs,
  });
});

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const deleteCheckpointRefs = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: sweepThreadCheckpointRefs(threadId),
      message: "thread deletion cleanup skipped checkpoint ref sweep",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* deleteCheckpointRefs(threadId);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  // Highest event sequence the subscriber has handed to the worker. Waiting
  // through a successful thread.created sequence covers every deletion that
  // was ahead of that create in the engine queue; the worker drain then covers
  // the in-flight cleanup.
  const seenSequence = yield* SubscriptionRef.make(0);
  const noteSeen = (sequence: number) =>
    SubscriptionRef.update(seenSequence, (seen) => Math.max(seen, sequence));

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(
        orchestrationEngine.streamDomainEvents.pipe(
          // Events that landed before the subscription are not replayed, so
          // start the watermark at the current head instead of zero.
          Stream.onStart(orchestrationEngine.latestSequence.pipe(Effect.flatMap(noteSeen))),
        ),
        (event) =>
          (event.type === "thread.deleted" ? worker.enqueue(event) : Effect.void).pipe(
            Effect.andThen(noteSeen(event.sequence)),
          ),
      ),
    );
  });

  const drainThrough: ThreadDeletionReactorShape["drainThrough"] = Effect.fn(
    "ThreadDeletionReactor.drainThrough",
  )(function* (target) {
    yield* SubscriptionRef.changes(seenSequence).pipe(
      Stream.filter((seen) => seen >= target),
      Stream.runHead,
    );
    yield* worker.drain;
  });

  return {
    start,
    drainThrough,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
