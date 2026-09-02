/**
 * FORK DELTA (fm provider) - projects First Mate workers as read-only threads.
 *
 * A First Mate runs crewmates. Each one is a live ACP session on the same
 * door, and without a thread for it there is no way to see what a crewmate is
 * doing or what it finished. This reactor is what makes them visible: it
 * listens to the worker observations `FmAdapter` publishes and turns them into
 * ordinary orchestration commands.
 *
 * **Threads are projected in process, not through `/api/orchestration/dispatch`.**
 * The old `bin/fm-t3` backend posted to that endpoint; this does not. The HTTP
 * door only accepts `ClientOrchestrationCommand`, and the two commands that
 * carry a worker's text - `thread.message.assistant.delta` and `.complete` -
 * are deliberately internal. It also needs a bearer token and collapses every
 * failure into one opaque code, neither of which a server-side reactor should
 * be arranging for itself.
 *
 * **Worker threads are read-only.** Nothing here ever starts a turn or a
 * provider session for one, and `readOnly` on the thread is what tells every
 * client to render no composer. A human steers a crewmate through First Mate,
 * which is the one place that can actually do it.
 *
 * **A missing or archived thread is not retried.** Each worker thread is
 * settled once and the answer remembered, so a thread that cannot be created
 * costs one attempt rather than a retry loop. Nothing on this path runs `git`
 * or touches the filesystem: creating a thread is one indexed project lookup
 * and one dispatch.
 *
 * @module provider/fm/FmWorkerThreadReactor
 */
import {
  CommandId,
  MessageId,
  type OrchestrationThreadShell,
  type ProviderInstanceId,
  type ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { type FmAdapterShape, isFmAdapter } from "./FmAdapter.ts";
import {
  type FmWorkerObservation,
  fmWorkerThreadId,
  fmWorkerThreadTitle,
} from "./FmWorkerSessions.ts";

/**
 * What we settled about one worker thread.
 *
 * `unavailable` is the whole point of recording anything: it is the answer for
 * a worker whose thread could not be created, and it is what stops the next
 * poll asking again two seconds later, forever.
 */
type FmWorkerThreadState = "live" | "unavailable";

const makeFmWorkerThreadReactor = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextCommandId = Effect.map(crypto.randomUUIDv4, CommandId.make);

  const workerThreads = new Map<ThreadId, FmWorkerThreadState>();

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
        // The worker runs on the supervisor's own First Mate instance. It is
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
   * Makes sure the thread for a worker exists, exactly once.
   *
   * The three answers a lookup can give are all terminal. A live thread is
   * reused, an archived one is brought back (a worker id that returns is the
   * same worker returning), and a thread that could not be created is recorded
   * as unavailable so no later poll asks again.
   */
  const ensureWorkerThread = (input: {
    readonly supervisorThreadId: ThreadId;
    readonly workerSessionId: string;
    readonly title: string;
    readonly cwd: string;
  }) =>
    Effect.gen(function* () {
      const workerThreadId = fmWorkerThreadId({
        supervisorThreadId: input.supervisorThreadId,
        workerSessionId: input.workerSessionId,
      });
      if (workerThreads.has(workerThreadId)) return;
      // Claimed before the first await, so two observations for one worker
      // cannot both decide to create it.
      workerThreads.set(workerThreadId, "unavailable");

      const lifecycle = yield* projection.getThreadLifecycleById(workerThreadId);
      if (Option.isSome(lifecycle)) {
        if (lifecycle.value.archived) {
          yield* engine.dispatch({
            type: "thread.unarchive",
            commandId: yield* nextCommandId,
            threadId: workerThreadId,
          });
        }
        workerThreads.set(workerThreadId, "live");
        return;
      }

      const supervisor = yield* projection.getThreadShellById(input.supervisorThreadId);
      if (Option.isNone(supervisor)) {
        yield* Effect.logWarning("fm.worker.thread.no-supervisor", {
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
      workerThreads.set(workerThreadId, "live");
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("fm.worker.thread.ensure-failed", {
          cause,
          threadId: input.supervisorThreadId,
          workerSessionId: input.workerSessionId,
        }),
      ),
    );

  /** The worker thread to write into, or nothing when there is no live one. */
  const liveWorkerThreadId = (input: {
    readonly supervisorThreadId: ThreadId;
    readonly workerSessionId: string;
  }): ThreadId | undefined => {
    const workerThreadId = fmWorkerThreadId(input);
    return workerThreads.get(workerThreadId) === "live" ? workerThreadId : undefined;
  };

  const handleObservation = (observation: FmWorkerObservation) =>
    Effect.gen(function* () {
      switch (observation._tag) {
        case "WorkerAppeared": {
          yield* ensureWorkerThread({
            supervisorThreadId: observation.supervisorThreadId,
            workerSessionId: observation.workerSessionId,
            title: fmWorkerThreadTitle(observation),
            cwd: observation.cwd,
          });
          return;
        }
        case "WorkerDisappeared": {
          const workerThreadId = liveWorkerThreadId(observation);
          if (workerThreadId === undefined) return;
          // Archived, never deleted: the transcript of finished work is the
          // reason the thread existed at all.
          yield* engine
            .dispatch({
              type: "thread.archive",
              commandId: yield* nextCommandId,
              threadId: workerThreadId,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logDebug("fm.worker.thread.archive-skipped", { cause, workerThreadId }),
              ),
            );
          // Forgotten rather than marked, so the same worker id coming back is
          // free to bring its thread back with it.
          workerThreads.delete(workerThreadId);
          return;
        }
        case "WorkerText": {
          const workerThreadId = liveWorkerThreadId(observation);
          if (workerThreadId === undefined) return;
          yield* engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* nextCommandId,
            threadId: workerThreadId,
            messageId: MessageId.make(observation.messageId),
            delta: observation.text,
            createdAt: yield* nowIso,
          });
          return;
        }
        case "WorkerTextCompleted": {
          const workerThreadId = liveWorkerThreadId(observation);
          if (workerThreadId === undefined) return;
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: yield* nextCommandId,
            threadId: workerThreadId,
            messageId: MessageId.make(observation.messageId),
            createdAt: yield* nowIso,
          });
          return;
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("fm.worker.observation-failed", { cause, tag: observation._tag }),
      ),
    );

  /**
   * Watches one adapter for the life of the enclosing scope.
   *
   * The subscription is taken here, in the caller's fiber, before the consumer
   * is forked - the same reason `ProviderService` does it that way.
   */
  const watchAdapter = (adapter: FmAdapterShape) =>
    Effect.gen(function* () {
      const observations = yield* adapter.subscribeWorkerObservations;
      yield* Stream.runForEach(Stream.fromSubscription(observations), handleObservation).pipe(
        Effect.forkScoped,
      );
    });

  const watchedRef = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const reconcile = Effect.gen(function* () {
    const previous = yield* Ref.get(watchedRef);
    const instanceIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const instanceId of instanceIds) {
      const adapter = yield* registry.getByInstance(instanceId).pipe(Effect.option);
      if (Option.isNone(adapter) || !isFmAdapter(adapter.value)) continue;
      next.set(instanceId, adapter.value);
      // Identity, not presence: a rebuilt instance is a new adapter with a new
      // channel, and the old watcher's subscription died with its scope.
      if (previous.get(instanceId) !== adapter.value) {
        yield* watchAdapter(adapter.value);
      }
    }
    yield* Ref.set(watchedRef, next);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("fm.worker.reactor.reconcile-failed", { cause }),
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
export const FmWorkerThreadReactorLive = Layer.effectDiscard(makeFmWorkerThreadReactor);
