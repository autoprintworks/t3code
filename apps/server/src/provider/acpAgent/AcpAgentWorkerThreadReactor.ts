/**
 * Projects an ACP agent's peer sessions as read-only threads.
 *
 * Some agents delegate: they run workers, each one a live ACP session on the
 * same connection, and `session/list` is how a client learns about them.
 * Without a thread for each there is no way to see what a worker is doing or
 * what it finished. This reactor is what makes them visible: it listens to the
 * worker observations `AcpAgentAdapter` publishes and turns them into ordinary
 * orchestration commands.
 *
 * **Threads are projected in process, not through `/api/orchestration/dispatch`.**
 * That endpoint only accepts `ClientOrchestrationCommand`, and the two commands
 * that carry a worker's text - `thread.message.assistant.delta` and `.complete`
 * - are deliberately internal. It also needs a bearer token and collapses every
 * failure into one opaque code, neither of which a server-side reactor should
 * be arranging for itself.
 *
 * **Worker threads are read-only.** Nothing here ever starts a turn or a
 * provider session for one. `readOnly` on the thread is what tells a client to
 * render no composer, and `requireThreadPromptable` in the decider is what
 * makes the refusal true for a client that never got the message. A human
 * steers a worker through its supervisor, which is the one place that can
 * actually do it.
 *
 * **Every attempt is counted and every attempt ends.** A worker thread that
 * cannot be created is retried a small fixed number of times and then recorded
 * as unavailable for good. Nothing on this path runs `git` or touches the
 * filesystem: creating a thread is one indexed project lookup and one
 * dispatch, and adopting an existing one is a second indexed lookup.
 *
 * **Text is buffered before it is written.** The event store is SQLite on the
 * event loop thread, so one write per ACP chunk is one synchronous write per
 * chunk. Chunks are coalesced per message and flushed on a short timer, on a
 * size cap, and on completion - the same shape `ProviderRuntimeIngestion` uses
 * for every other provider.
 *
 * @module provider/acpAgent/AcpAgentWorkerThreadReactor
 */
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { type AcpAgentAdapterShape, isAcpAgentAdapter } from "./AcpAgentAdapter.ts";
import { AcpAgentWorkerThreadQuery } from "./AcpAgentWorkerThreadQuery.ts";
import {
  type AcpAgentWorkerObservation,
  acpAgentWorkerThreadId,
  acpAgentWorkerThreadIdPrefix,
  acpAgentWorkerThreadTitle,
} from "./AcpAgentWorkerSessions.ts";

/**
 * What we settled about one worker thread.
 *
 * `unavailable` with `attempts` at the ceiling is the whole point of recording
 * anything: it is the final answer for a worker whose thread could not be
 * created, and it is what stops the next poll asking again two seconds later,
 * forever. Below the ceiling it means "not yet" - a transient SQL error is a
 * different thing from a worker that can never have a thread, and the count is
 * how the two are told apart.
 */
interface AcpAgentWorkerThreadRecord {
  readonly status: "live" | "unavailable";
  readonly attempts: number;
  /**
   * The assistant messages this thread already had when we adopted it.
   *
   * `session/load` replays a worker's whole history, and after a restart most
   * of that history is already written. The ids are deterministic, so the
   * replay lands on the same ids - and a delta command *appends*, so writing
   * them again would double every message. Empty for a thread this process
   * created, which has nothing to collide with.
   */
  readonly replayed: ReadonlySet<string>;
}

/** How many times one worker thread may fail to be created before we stop. */
const MAX_WORKER_THREAD_ATTEMPTS = 3;
/** How long buffered worker text may wait before it is written. */
const WORKER_TEXT_FLUSH_INTERVAL = Duration.millis(120);
/**
 * The safety valve: a worker emitting text faster than the timer flushes must
 * not grow one command without bound.
 */
const MAX_BUFFERED_WORKER_CHARS = 8_000;
/**
 * A ceiling on the startup sweep. A home with more live worker threads than
 * this has something else wrong with it, and reading them all would be the
 * unbounded read this feature exists to avoid.
 */
const MAX_SWEPT_WORKER_THREADS = 500;
/** A ceiling on the replay-dedupe read, for the same reason. */
const MAX_REPLAYED_MESSAGE_IDS = 2_000;

const makeAcpAgentWorkerThreadReactor = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const workerQuery = yield* AcpAgentWorkerThreadQuery;
  const crypto = yield* Crypto.Crypto;
  const reactorScope = yield* Effect.scope;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextCommandId = Effect.map(crypto.randomUUIDv4, CommandId.make);
  const nextEventId = Effect.map(crypto.randomUUIDv4, EventId.make);

  const workerThreads = new Map<ThreadId, AcpAgentWorkerThreadRecord>();
  /** Homes whose pre-existing worker threads have already been reconciled. */
  const sweptHomes = new Set<string>();

  /**
   * Buffered assistant text, and the timer fiber that will write it.
   *
   * Both are guarded by `writeGate`, because the timer fiber and the
   * observation fiber both read-modify-write them and both suspend on a
   * dispatch in the middle of doing so.
   */
  const buffers = new Map<ThreadId, { readonly messageId: string; readonly text: string }>();
  const flushFibers = new Map<ThreadId, Fiber.Fiber<void>>();
  const openMessages = new Map<ThreadId, string>();
  const writeGate = yield* Semaphore.make(1);

  /**
   * Which project a worker thread belongs to.
   *
   * The worker's own working directory when a project already covers it,
   * otherwise the supervisor's project. Never a new project: creating one
   * wakes the repository identity work, which is exactly the per-project
   * `git` fan-out this path must stay clear of.
   */
  const resolveWorkerProjectId = (input: {
    readonly cwd: string;
    readonly supervisor: OrchestrationThreadShell;
  }) =>
    Effect.gen(function* () {
      const cwd = input.cwd.trim();
      if (cwd === "") return input.supervisor.projectId;
      const project = yield* projection.getActiveProjectByWorkspaceRoot(cwd);
      return Option.match(project, {
        onNone: () => input.supervisor.projectId,
        onSome: (found) => found.id,
      });
    }).pipe(Effect.catchCause(() => Effect.succeed(input.supervisor.projectId)));

  const createWorkerThread = (input: {
    readonly workerThreadId: ThreadId;
    readonly supervisor: OrchestrationThreadShell;
    readonly title: string;
    readonly cwd: string;
  }) =>
    Effect.gen(function* () {
      const projectId = yield* resolveWorkerProjectId({
        cwd: input.cwd,
        supervisor: input.supervisor,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: yield* nextCommandId,
        threadId: input.workerThreadId,
        projectId,
        title: TrimmedNonEmptyString.make(input.title),
        // The worker runs on the supervisor's own provider instance. It is
        // recorded so the thread renders a provider like any other, not so
        // anything can be sent to it.
        modelSelection: input.supervisor.modelSelection,
        runtimeMode: input.supervisor.runtimeMode,
        interactionMode: input.supervisor.interactionMode,
        branch: null,
        worktreePath: null,
        readOnly: true,
        createdAt: yield* nowIso,
      });
    });

  /**
   * The assistant messages an already-existing worker thread holds.
   *
   * Read once, when the thread is adopted rather than created. A failure here
   * is not a reason to refuse the thread: the worst case of an empty answer is
   * a doubled transcript, and the worst case of refusing is no thread at all.
   */
  const readReplayedMessageIds = (workerThreadId: ThreadId) =>
    workerQuery
      .listThreadAssistantMessageIds({
        threadId: workerThreadId,
        limit: MAX_REPLAYED_MESSAGE_IDS,
      })
      .pipe(
        Effect.map((ids) => new Set(ids)),
        Effect.catchCause((cause) =>
          Effect.logWarning("acp.worker.thread.replay-ids-unavailable", {
            cause,
            workerThreadId,
          }).pipe(Effect.as(new Set<string>())),
        ),
      );

  /**
   * Makes sure the thread for a worker exists.
   *
   * A live thread is reused, an archived one is brought back (a worker id that
   * returns is the same worker returning), and a thread that could not be
   * created is tried at most `MAX_WORKER_THREAD_ATTEMPTS` times before the
   * answer becomes final.
   */
  const ensureWorkerThread = (input: {
    readonly workerThreadId: ThreadId;
    readonly supervisorThreadId: ThreadId;
    readonly workerSessionId: string;
    readonly title: string;
    readonly cwd: string;
  }) =>
    Effect.gen(function* () {
      const workerThreadId = input.workerThreadId;
      const record = workerThreads.get(workerThreadId);
      if (record?.status === "live") return;
      const attempts = record?.attempts ?? 0;
      if (attempts >= MAX_WORKER_THREAD_ATTEMPTS) return;
      // Claimed before the first await, so two observations for one worker
      // cannot both decide to create it. Counted, so a claim that fails is
      // "not yet" until the count runs out and then "never".
      workerThreads.set(workerThreadId, {
        status: "unavailable",
        attempts: attempts + 1,
        replayed: new Set(),
      });

      const lifecycle = yield* projection.getThreadLifecycleById(workerThreadId);
      if (Option.isSome(lifecycle)) {
        if (lifecycle.value.archived) {
          yield* engine.dispatch({
            type: "thread.unarchive",
            commandId: yield* nextCommandId,
            threadId: workerThreadId,
          });
        }
        workerThreads.set(workerThreadId, {
          status: "live",
          attempts: attempts + 1,
          replayed: yield* readReplayedMessageIds(workerThreadId),
        });
        return;
      }

      const supervisor = yield* projection.getThreadShellById(input.supervisorThreadId);
      if (Option.isNone(supervisor)) {
        // Terminal on purpose: a supervisor thread that is not in the
        // projection is not one that is about to appear.
        workerThreads.set(workerThreadId, {
          status: "unavailable",
          attempts: MAX_WORKER_THREAD_ATTEMPTS,
          replayed: new Set(),
        });
        yield* Effect.logWarning("acp.worker.thread.no-supervisor", {
          threadId: input.supervisorThreadId,
          workerSessionId: input.workerSessionId,
        });
        return;
      }

      yield* createWorkerThread({
        workerThreadId,
        supervisor: supervisor.value,
        title: input.title,
        cwd: input.cwd,
      });
      workerThreads.set(workerThreadId, {
        status: "live",
        attempts: attempts + 1,
        // Nothing to collide with: this process just made the thread.
        replayed: new Set(),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("acp.worker.thread.ensure-failed", {
          cause,
          threadId: input.supervisorThreadId,
          workerSessionId: input.workerSessionId,
          attempts: workerThreads.get(input.workerThreadId)?.attempts,
        }),
      ),
    );

  /** The worker thread to write into, or nothing when there is no live one. */
  const liveWorkerThread = (input: {
    readonly homeSessionId: string;
    readonly workerSessionId: string;
  }): { readonly threadId: ThreadId; readonly record: AcpAgentWorkerThreadRecord } | undefined => {
    const threadId = acpAgentWorkerThreadId(input);
    const record = workerThreads.get(threadId);
    return record?.status === "live" ? { threadId, record } : undefined;
  };

  /** Writes whatever is buffered for a thread. Caller holds `writeGate`. */
  const flushBufferedText = (workerThreadId: ThreadId) =>
    Effect.gen(function* () {
      const buffered = buffers.get(workerThreadId);
      if (buffered === undefined || buffered.text === "") return;
      buffers.delete(workerThreadId);
      yield* engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: yield* nextCommandId,
        threadId: workerThreadId,
        messageId: MessageId.make(buffered.messageId),
        delta: buffered.text,
        createdAt: yield* nowIso,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("acp.worker.text.flush-failed", { cause, workerThreadId }),
      ),
    );

  /** Cancels any pending timer for a thread. Caller holds `writeGate`. */
  const cancelFlushTimer = (workerThreadId: ThreadId) =>
    Effect.suspend(() => {
      const fiber = flushFibers.get(workerThreadId);
      if (fiber === undefined) return Effect.void;
      flushFibers.delete(workerThreadId);
      return Fiber.interrupt(fiber).pipe(Effect.ignore);
    });

  /**
   * Arms the timer that will write what is buffered.
   *
   * One fiber per thread at a time, forked into the reactor's own scope so it
   * cannot outlive the reactor. It takes `writeGate` before it writes, so it
   * can never interleave with the observation fiber mid-append.
   */
  const scheduleFlush = (workerThreadId: ThreadId) =>
    Effect.suspend(() => {
      if (flushFibers.has(workerThreadId)) return Effect.void;
      return Effect.sleep(WORKER_TEXT_FLUSH_INTERVAL).pipe(
        Effect.andThen(
          writeGate.withPermits(1)(
            Effect.suspend(() => {
              flushFibers.delete(workerThreadId);
              return flushBufferedText(workerThreadId);
            }),
          ),
        ),
        Effect.forkIn(reactorScope),
        Effect.flatMap((fiber) =>
          Effect.sync(() => {
            flushFibers.set(workerThreadId, fiber);
          }),
        ),
      );
    });

  /** Buffers a chunk, writing early when the message changes or the cap is hit. */
  const appendWorkerText = (input: {
    readonly workerThreadId: ThreadId;
    readonly messageId: string;
    readonly text: string;
  }) =>
    Effect.gen(function* () {
      const buffered = buffers.get(input.workerThreadId);
      if (buffered !== undefined && buffered.messageId !== input.messageId) {
        yield* flushBufferedText(input.workerThreadId);
      }
      const carried = buffers.get(input.workerThreadId)?.text ?? "";
      const text = carried + input.text;
      buffers.set(input.workerThreadId, { messageId: input.messageId, text });
      openMessages.set(input.workerThreadId, input.messageId);
      if (text.length >= MAX_BUFFERED_WORKER_CHARS) {
        yield* cancelFlushTimer(input.workerThreadId);
        yield* flushBufferedText(input.workerThreadId);
        return;
      }
      yield* scheduleFlush(input.workerThreadId);
    });

  /**
   * Ends the message a thread has open, if it has one.
   *
   * The decider marks a message streaming on every delta and only `.complete`
   * clears it, so a worker thread whose message is never completed spins in
   * every client forever. Completion is therefore issued on a message ending,
   * on the worker ending, and on the watch ending - "the agent said so" and
   * "the connection went away" are different things, but neither of them is a
   * reason to leave a spinner running.
   */
  const completeOpenMessage = (workerThreadId: ThreadId) =>
    Effect.gen(function* () {
      yield* cancelFlushTimer(workerThreadId);
      yield* flushBufferedText(workerThreadId);
      const messageId = openMessages.get(workerThreadId);
      if (messageId === undefined) return;
      openMessages.delete(workerThreadId);
      yield* engine
        .dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* nextCommandId,
          threadId: workerThreadId,
          messageId: MessageId.make(messageId),
          createdAt: yield* nowIso,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("acp.worker.text.complete-skipped", { cause, workerThreadId }),
          ),
        );
    });

  const archiveWorkerThread = (workerThreadId: ThreadId) =>
    nextCommandId.pipe(
      Effect.flatMap((commandId) =>
        engine.dispatch({ type: "thread.archive", commandId, threadId: workerThreadId }),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("acp.worker.thread.archive-skipped", { cause, workerThreadId }),
      ),
    );

  /**
   * The worker threads this home left behind, archived.
   *
   * Run once per home per process, on the first roster the adapter publishes.
   * What is in memory and what is on disk only disagree after a restart: the
   * threads survive, the map that says which of them are live does not. One
   * prefix range read settles it, so the cost is this home's worker threads
   * rather than every thread in the database.
   */
  const sweepStaleWorkerThreads = (input: {
    readonly homeSessionId: string;
    readonly present: ReadonlySet<ThreadId>;
  }) =>
    Effect.gen(function* () {
      const existing = yield* workerQuery.listActiveThreadIdsByPrefix({
        prefix: acpAgentWorkerThreadIdPrefix(input.homeSessionId),
        limit: MAX_SWEPT_WORKER_THREADS,
      });
      for (const workerThreadId of existing) {
        if (input.present.has(workerThreadId)) continue;
        if (workerThreads.get(workerThreadId)?.status === "live") continue;
        // Not listed by an agent that is answering, and not one this process is
        // watching: the worker ended while the editor was not running.
        yield* archiveWorkerThread(workerThreadId);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("acp.worker.sweep-failed", { cause, homeSessionId: input.homeSessionId }),
      ),
    );

  const handleObservation = (observation: AcpAgentWorkerObservation) =>
    Effect.gen(function* () {
      switch (observation._tag) {
        case "WorkerAppeared": {
          yield* ensureWorkerThread({
            workerThreadId: acpAgentWorkerThreadId(observation),
            supervisorThreadId: observation.supervisorThreadId,
            workerSessionId: observation.workerSessionId,
            title: acpAgentWorkerThreadTitle(observation),
            cwd: observation.cwd,
          });
          return;
        }
        case "WorkerRoster": {
          if (sweptHomes.has(observation.homeSessionId)) return;
          sweptHomes.add(observation.homeSessionId);
          yield* sweepStaleWorkerThreads({
            homeSessionId: observation.homeSessionId,
            present: new Set(
              observation.workerSessionIds.map((workerSessionId) =>
                acpAgentWorkerThreadId({
                  homeSessionId: observation.homeSessionId,
                  workerSessionId,
                }),
              ),
            ),
          });
          return;
        }
        case "WorkerDisappeared": {
          const live = liveWorkerThread(observation);
          if (live === undefined) return;
          yield* completeOpenMessage(live.threadId);
          // Forgotten rather than marked, so the same worker id coming back is
          // free to bring its thread back with it.
          workerThreads.delete(live.threadId);
          if (observation.reason === "unknown") {
            // The watch ended, not the worker. The agent process outlives the
            // editor, so archiving here would file away work still running.
            return;
          }
          // Archived, never deleted: the transcript of finished work is the
          // reason the thread existed at all.
          yield* archiveWorkerThread(live.threadId);
          return;
        }
        case "WorkerLoadFailed": {
          const live = liveWorkerThread(observation);
          if (live === undefined) return;
          // Said in the thread, not only in the log. An empty thread with no
          // explanation is the symptom the user cannot tell apart from a
          // thread that is still loading.
          yield* engine
            .dispatch({
              type: "thread.activity.append",
              commandId: yield* nextCommandId,
              threadId: live.threadId,
              activity: {
                id: yield* nextEventId,
                tone: "error",
                kind: "acp.worker.transcript-unavailable",
                summary: "This worker's transcript could not be read",
                payload: { detail: observation.detail },
                turnId: null,
                createdAt: yield* nowIso,
              },
              createdAt: yield* nowIso,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logDebug("acp.worker.load-failed-note-skipped", {
                  cause,
                  workerThreadId: live.threadId,
                }),
              ),
            );
          return;
        }
        case "WorkerText": {
          const live = liveWorkerThread(observation);
          if (live === undefined) return;
          // A message this thread already holds. `session/load` replays the
          // whole history under the same deterministic ids, and a delta
          // appends, so writing it again would double the message.
          if (live.record.replayed.has(observation.messageId)) return;
          yield* appendWorkerText({
            workerThreadId: live.threadId,
            messageId: observation.messageId,
            text: observation.text,
          });
          return;
        }
        case "WorkerTextCompleted": {
          const live = liveWorkerThread(observation);
          if (live === undefined) return;
          if (live.record.replayed.has(observation.messageId)) return;
          if (openMessages.get(live.threadId) !== observation.messageId) {
            // Completion for a message we never wrote a delta for; there is
            // nothing to stop streaming.
            yield* cancelFlushTimer(live.threadId);
            yield* flushBufferedText(live.threadId);
            return;
          }
          yield* completeOpenMessage(live.threadId);
          return;
        }
      }
    }).pipe(
      // Every write path is serialised against the flush timer, which is the
      // only other fiber that touches the buffers.
      writeGate.withPermits(1),
      Effect.catchCause((cause) =>
        Effect.logWarning("acp.worker.observation-failed", { cause, tag: observation._tag }),
      ),
    );

  /**
   * Watches one adapter until its own scope is closed.
   *
   * The subscription is taken here, in the caller's fiber, before the consumer
   * is forked - the same reason `ProviderService` does it that way. The scope
   * returned is the watcher's, not the adapter's: closing it is what actually
   * ends the fiber, which is what `reconcile` does when the instance is
   * rebuilt or goes away.
   */
  const watchAdapter = (adapter: AcpAgentAdapterShape) =>
    Effect.gen(function* () {
      const watcherScope = yield* Scope.make("sequential");
      const observations = yield* adapter.subscribeWorkerObservations.pipe(
        Effect.provideService(Scope.Scope, watcherScope),
      );
      yield* Stream.runForEach(Stream.fromSubscription(observations), handleObservation).pipe(
        Effect.forkIn(watcherScope),
      );
      return watcherScope;
    });

  interface WatchedAcpAgentAdapter {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly scope: Scope.Scope;
  }

  const watchedRef = yield* Ref.make(new Map<ProviderInstanceId, WatchedAcpAgentAdapter>());

  const reconcile = Effect.gen(function* () {
    const previous = yield* Ref.get(watchedRef);
    const instanceIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, WatchedAcpAgentAdapter>();
    for (const instanceId of instanceIds) {
      const adapter = yield* registry.getByInstance(instanceId).pipe(Effect.option);
      if (Option.isNone(adapter) || !isAcpAgentAdapter(adapter.value)) continue;
      const watched = previous.get(instanceId);
      // Identity, not presence: a rebuilt instance is a new adapter with a new
      // channel, and the watcher for the old one has to be ended by hand -
      // nothing else closes it.
      if (watched !== undefined && watched.adapter === adapter.value) {
        next.set(instanceId, watched);
        continue;
      }
      if (watched !== undefined) {
        yield* Scope.close(watched.scope, Exit.void);
      }
      next.set(instanceId, {
        adapter: adapter.value,
        scope: yield* watchAdapter(adapter.value),
      });
    }
    // An instance that is gone takes its watcher with it, so neither the fiber
    // nor the subscription outlives the adapter it was reading.
    for (const [instanceId, watched] of previous) {
      if (!next.has(instanceId)) {
        yield* Scope.close(watched.scope, Exit.void);
      }
    }
    yield* Ref.set(watchedRef, next);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("acp.worker.reactor.reconcile-failed", { cause }),
    ),
  );

  // Subscribed before the first reconcile so an instance that appears during
  // it is still seen, and the reconcile is idempotent when both notice it.
  const changes = yield* registry.subscribeChanges;
  yield* reconcile;
  yield* forkParked(Stream.runForEach(Stream.fromSubscription(changes), () => reconcile));
});

/**
 * Runs for the life of the layer scope. There is no service tag because
 * nothing calls into this: it is a pure consumer of the adapter's worker
 * channel and a producer of orchestration commands.
 */
export const AcpAgentWorkerThreadReactorLive = Layer.effectDiscard(makeAcpAgentWorkerThreadReactor);
