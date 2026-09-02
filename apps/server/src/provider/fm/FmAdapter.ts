/**
 * FORK DELTA (fm provider) - the provider adapter that drives the First Mate
 * ACP door.
 *
 * The door is deliberately small, and so is this adapter. It has no
 * permission prompts, no tool calls, no plan updates, no MCP, and no image
 * blocks: the supervisor conversation is text in, text out. Two properties of
 * the door shape everything below.
 *
 * **Turns are strictly sequential.** The door reads its stdin on one thread
 * and answers requests one at a time off a channel, so a second
 * `session/prompt` waits for the first. Modelling that honestly means a
 * `sendTurn` arriving while another turn is live opens a *new* turn that
 * queues, rather than steering the live one the way the Grok adapter does.
 *
 * **Cancel is the door's job, not ours.** `AcpSessionRuntime.cancel` sends the
 * notification but also interrupts the local prompt fiber and synthesises
 * `{stopReason: "cancelled"}` before the agent has answered. Here the real
 * `session/cancel` line goes out on its own and the prompt request stays open,
 * so the turn is settled by the door's own answer. A bounded grace period
 * falls back to the local cancel, because a wedged door must not leave a
 * spinner running forever.
 *
 * @module provider/fm/FmAdapter
 */
import {
  EventId,
  type FmSettings,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import type { AcpPeerSessionDiff } from "../acp/AcpPeerSessions.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import { makeEventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import {
  currentFmModelIdFromSessionSetup,
  type FmDoorExit,
  makeFmAcpRuntime,
  resolveFmModelId,
} from "./FmAcpSupport.ts";
import {
  type FmWorkerObservation,
  fmWorkerMessageIdFor,
  reconcileFmWorkers,
} from "./FmWorkerSessions.ts";

/** FmAdapterShape - per-instance First Mate adapter contract. */
export interface FmAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  /**
   * The workers this instance's doors are hosting, and the text they produce.
   *
   * `FmWorkerThreadReactor` is the only consumer; it turns these into
   * read-only threads. The subscription is acquired in the caller's own fiber
   * so an observation published while the consumer is still being scheduled
   * cannot fall into a gap - build a stream over it with
   * `Stream.fromSubscription`, never `Stream.fromPubSub`.
   */
  readonly subscribeWorkerObservations: Effect.Effect<
    PubSub.Subscription<FmWorkerObservation>,
    never,
    Scope.Scope
  >;
}

/** Narrows a registry adapter to the First Mate one. */
export function isFmAdapter(
  adapter: ProviderAdapterShape<ProviderAdapterError>,
): adapter is FmAdapterShape {
  return adapter.provider === PROVIDER && "subscribeWorkerObservations" in adapter;
}

const PROVIDER = ProviderDriverKind.make("fm");
const FM_RESUME_VERSION = 1 as const;

/**
 * How long the door gets to answer a cancelled prompt itself before the local
 * cancel path takes over. Generous enough that the honest answer wins on any
 * healthy door, short enough that a wedged one does not lie to the user.
 */
const FM_CANCEL_GRACE = Duration.seconds(10);

export interface FmAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Overrides the cancel grace period; the certification suite shortens it. */
  readonly cancelGrace?: Duration.Input;
  /**
   * Overrides how often `session/list` is polled for workers. The worker suite
   * shortens it so a test does not wait out the shipping interval.
   */
  readonly peerSessionPollInterval?: Duration.Input;
}

interface FmSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  /** Turns a cancel has been requested for; a late answer must not resurrect them. */
  readonly cancelRequestedTurnIds: Set<TurnId>;
  currentModelId: string | undefined;
  stopped: boolean;
  /**
   * Set for the span of a live turn so a door that dies mid-prompt can settle
   * it. Idempotent: the same guard that stops a late door answer resurrecting
   * a cancelled turn also stops this double-settling one.
   */
  settleActiveTurn: FmTurnSettler | undefined;
  /**
   * Fires once this session is over, whether it was stopped or the door died.
   * A prompt request outliving its door is never answered and is never failed
   * by the ACP client either, so without this the `sendTurn` caller waits
   * forever on a process that no longer exists.
   */
  readonly sessionEnded: Deferred.Deferred<void>;
}

/** Settles the turn a `sendTurn` call owns; safe to call more than once. */
type FmTurnSettler = (outcome: {
  readonly state: "completed" | "cancelled" | "failed";
  readonly stopReason?: EffectAcpSchema.StopReason | null;
  readonly errorMessage?: string;
}) => Effect.Effect<void, ProviderAdapterRequestError>;

interface FmResumeCursor {
  readonly schemaVersion: typeof FM_RESUME_VERSION;
  readonly sessionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The door derives its session id from the home path, so the same home always
 * answers with the same id. Persisting it is what lets a Desktop restart
 * reattach to the running first mate through `session/load` instead of
 * starting a second one.
 */
export function parseFmResume(raw: unknown): FmResumeCursor | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== FM_RESUME_VERSION) return undefined;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
  if (!sessionId) return undefined;
  return { schemaVersion: FM_RESUME_VERSION, sessionId };
}

/**
 * The turn a door notification belongs to, or `undefined` when it belongs to
 * nothing the user is still watching.
 *
 * Two cases have no wire barrier a test can wait on, which is why this is a
 * function rather than an inline guard: `session/load` replay chunks arrive
 * with no turn open, and a cancelled turn can still be handed chunks the door
 * had already queued. Both must be dropped, and the certification suite
 * asserts that here.
 */
export function fmLiveTurnForNotification(input: {
  readonly activeTurnId: TurnId | undefined;
  readonly cancelRequestedTurnIds: ReadonlySet<TurnId>;
}): TurnId | undefined {
  const { activeTurnId } = input;
  if (activeTurnId === undefined) {
    return undefined;
  }
  return input.cancelRequestedTurnIds.has(activeTurnId) ? undefined : activeTurnId;
}

export function makeFmAdapter(fmSettings: FmSettings, options?: FmAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("fm");
    // Door watchers are forked here rather than into the session scope,
    // because the watcher's own job is to close that scope; forking into it
    // would have the watcher interrupt itself half way through the teardown.
    const adapterScope = yield* Effect.scope;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const cancelGrace: Duration.Input = options?.cancelGrace ?? FM_CANCEL_GRACE;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, FmSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const workerObservationPubSub = yield* PubSub.unbounded<FmWorkerObservation>();
    // Two locks, always taken in this order: `turnGate` for the whole span of a
    // turn (so a queued `sendTurn` waits exactly like the door's own request
    // queue), `stateLock` for the short bookkeeping sections. `interruptTurn`
    // only ever takes `stateLock`, so a cancel is never stuck behind the very
    // prompt it is trying to stop.
    const turnGatesRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const stateLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate a First Mate runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getSemaphore = (
      ref: SynchronizedRef.SynchronizedRef<Map<string, Semaphore.Semaphore>>,
      key: string,
    ) =>
      SynchronizedRef.modifyEffect(ref, (current) => {
        const existing = current.get(key);
        if (existing) {
          return Effect.succeed([existing, current] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(key, semaphore);
            return [semaphore, next] as const;
          }),
        );
      });

    const withTurnGate = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getSemaphore(turnGatesRef, threadId), (semaphore) =>
        semaphore.withPermit(effect),
      );

    const withStateLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getSemaphore(stateLocksRef, threadId), (semaphore) =>
        semaphore.withPermit(effect),
      );

    const publishWorkerObservation = (observation: FmWorkerObservation) =>
      PubSub.publish(workerObservationPubSub, observation).pipe(Effect.asVoid);

    /**
     * Turns one door's peer sessions into worker observations for the reactor.
     *
     * Two pumps run for the life of the session: one over the poll diffs, which
     * decides what a worker thread is; one over the peer event queue, which
     * decides what is written into it. Neither ever prompts - a worker is
     * steered through First Mate itself, never through this adapter.
     */
    const watchWorkerSessions = (input: {
      readonly supervisorThreadId: ThreadId;
      readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
      readonly peerDiffs: PubSub.Subscription<AcpPeerSessionDiff>;
    }) =>
      Effect.gen(function* () {
        // Reconciled against `present` on every diff, so a dropped item costs
        // one poll of latency rather than a worker nobody ever hears about.
        const known = new Set<string>();
        const messageState = new Map<
          string,
          { currentMessageId: string | undefined; fallbackCount: number }
        >();

        const diffPump = Stream.runForEach(Stream.fromSubscription(input.peerDiffs), (diff) =>
          Effect.gen(function* () {
            const changed = reconcileFmWorkers({ known, present: diff.present });
            for (const session of changed.appeared) {
              known.add(session.sessionId);
              yield* publishWorkerObservation({
                _tag: "WorkerAppeared",
                supervisorThreadId: input.supervisorThreadId,
                workerSessionId: session.sessionId,
                title: session.title,
                cwd: session.cwd,
              });
              // Loading on appearance rather than on open is deliberate: a
              // worker that starts and finishes before anyone looks must still
              // leave a readable thread behind, and an archived thread has no
              // later moment at which to fetch its own history.
              yield* input.acp.loadPeerSession(session.sessionId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("fm.worker.session-load-failed", {
                    cause,
                    threadId: input.supervisorThreadId,
                    workerSessionId: session.sessionId,
                  }),
                ),
              );
            }
            for (const workerSessionId of changed.disappeared) {
              known.delete(workerSessionId);
              messageState.delete(workerSessionId);
              yield* publishWorkerObservation({
                _tag: "WorkerDisappeared",
                supervisorThreadId: input.supervisorThreadId,
                workerSessionId,
              });
            }
          }),
        );

        const eventPump = Stream.runForEach(input.acp.getPeerSessionEvents(), (item) =>
          Effect.gen(function* () {
            if (item._tag === "EventStreamBarrier") {
              yield* Deferred.succeed(item.acknowledge, undefined);
              return;
            }
            const workerSessionId = item.sessionId;
            const state = messageState.get(workerSessionId) ?? {
              currentMessageId: undefined,
              fallbackCount: 0,
            };
            switch (item.event._tag) {
              case "AssistantItemStarted": {
                messageState.set(workerSessionId, {
                  currentMessageId: item.event.itemId,
                  fallbackCount: state.fallbackCount,
                });
                return;
              }
              case "AssistantItemCompleted": {
                messageState.set(workerSessionId, {
                  currentMessageId:
                    state.currentMessageId === item.event.itemId
                      ? undefined
                      : state.currentMessageId,
                  fallbackCount: state.fallbackCount,
                });
                yield* publishWorkerObservation({
                  _tag: "WorkerTextCompleted",
                  supervisorThreadId: input.supervisorThreadId,
                  workerSessionId,
                  messageId: item.event.itemId,
                });
                return;
              }
              case "ContentDelta": {
                const itemId = item.event.itemId;
                const messageId = fmWorkerMessageIdFor({
                  workerSessionId,
                  itemId,
                  currentMessageId: state.currentMessageId,
                  fallbackCount: state.fallbackCount,
                });
                const synthesised = !itemId?.trim() && state.currentMessageId === undefined;
                messageState.set(workerSessionId, {
                  currentMessageId: messageId,
                  fallbackCount: synthesised ? state.fallbackCount + 1 : state.fallbackCount,
                });
                yield* publishWorkerObservation({
                  _tag: "WorkerText",
                  supervisorThreadId: input.supervisorThreadId,
                  workerSessionId,
                  messageId,
                  text: item.event.text,
                });
                return;
              }
              // A worker's modes, plans and tool calls belong to richer agents
              // than the door; ignoring them here is a statement about the
              // door, not an oversight.
              default:
                return;
            }
          }),
        );

        yield* Effect.all([diffPump, eventPump], { concurrency: 2, discard: true });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to watch First Mate worker sessions.", {
            cause,
            threadId: input.supervisorThreadId,
          }),
        ),
      );

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write a native First Mate notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<FmSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /** Moves the session out of `running` without emitting a turn event. */
    const markSessionReady = (ctx: FmSessionContext) =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.activeTurnId = undefined;
        ctx.session = { ...readySession, status: "ready", updatedAt };
      });

    /**
     * Settles whatever turn is still live, then releases the prompt fiber
     * waiting on the door. Order matters twice: `settleTurn` recognises its
     * turn by looking the session up in `sessions`, so it has to run before
     * the session is removed; and it has to win the race against the prompt's
     * own failure, so the user is told why the turn ended rather than which
     * transport error happened to surface.
     */
    const settleActiveTurnOnEnd = (ctx: FmSessionContext, outcome: Parameters<FmTurnSettler>[0]) =>
      Effect.gen(function* () {
        if (ctx.settleActiveTurn) {
          yield* Effect.ignore(ctx.settleActiveTurn(outcome));
        }
        yield* Deferred.succeed(ctx.sessionEnded, undefined);
      });

    const stopSessionInternal = (ctx: FmSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settleActiveTurnOnEnd(ctx, { state: "cancelled", stopReason: "cancelled" });
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    /**
     * The door died without anyone asking it to. Both events go out before the
     * scope is torn down, and the live turn is settled while the session is
     * still in `sessions`, because that map is how `settleTurn` recognises the
     * turn it owns.
     */
    const handleUnexpectedDoorExit = (ctx: FmSessionContext, exit: FmDoorExit) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        const reason =
          exit.code === null
            ? "The First Mate ACP door exited unexpectedly."
            : `The First Mate ACP door exited unexpectedly with code ${exit.code}.`;
        yield* Effect.logWarning(reason, { threadId: ctx.threadId });
        const turnId = ctx.activeTurnId;
        yield* settleActiveTurnOnEnd(ctx, { state: "failed", errorMessage: reason });
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "runtime.error",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          ...(turnId ? { turnId } : {}),
          payload: { message: reason, class: "transport_error" },
        });
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { reason, recoverable: false, exitKind: "error" },
        });
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
      });

    const startSession: FmAdapterShape["startSession"] = (input) =>
      withStateLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const cwd = input.cwd.trim();

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = parseFmResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const runtime = yield* makeFmAcpRuntime({
            fmSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            // Opting in is what starts the `session/list` poll, and only if
            // the door also advertises the capability. Without this the
            // runtime never asks, which is how every other ACP provider in
            // this build behaves.
            peerSessions:
              options?.peerSessionPollInterval === undefined
                ? {}
                : { pollInterval: options.peerSessionPollInterval },
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          const acp = runtime.acp;

          // Before `start`, because `start` is what forks the `session/list`
          // poll. A subscription taken afterwards could miss the first worker,
          // and nothing would ever republish it.
          const peerDiffs = yield* acp.subscribePeerSessions.pipe(
            Effect.provideService(Scope.Scope, sessionScope),
          );
          yield* watchWorkerSessions({
            supervisorThreadId: input.threadId,
            acp,
            peerDiffs,
          }).pipe(Effect.forkIn(sessionScope));

          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          // The door refuses `session/set_model` once the conversation is
          // live, which is why the snapshot advertises
          // `requiresNewThreadForModelChange`. Selecting at start is the only
          // moment a model choice can be honoured, and the refusal message the
          // door returns is surfaced verbatim rather than swallowed.
          const fmModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const currentModelId = currentFmModelIdFromSessionSetup(started.sessionSetupResult);
          const requestedModelId = resolveFmModelId(fmModelSelection?.model);
          let boundModelId = currentModelId;
          if (requestedModelId !== undefined && requestedModelId !== currentModelId) {
            yield* acp
              .setSessionModel(requestedModelId)
              .pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", error),
                ),
              );
            boundModelId = requestedModelId;
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            ...(boundModelId ? { model: boundModelId } : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: FM_RESUME_VERSION,
              sessionId: started.sessionId,
            } satisfies FmResumeCursor,
            createdAt: now,
            updatedAt: now,
          };

          const ctx: FmSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            turns: [],
            activeTurnId: undefined,
            cancelRequestedTurnIds: new Set(),
            currentModelId: boundModelId,
            stopped: false,
            settleActiveTurn: undefined,
            sessionEnded: yield* Deferred.make<void>(),
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                // The door emits only assistant text. Mode changes, plans and
                // tool calls belong to richer agents; ignoring them here is a
                // statement about the door, not an oversight.
                if (
                  event._tag === "ModeChanged" ||
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated"
                ) {
                  return;
                }
                // No active turn means these are `session/load` replay chunks.
                // The thread already holds that history in T3 Code's own event
                // store, so replaying it would double every message.
                const turnId = fmLiveTurnForNotification(ctx);
                if (turnId === undefined) {
                  return;
                }
                const stamp = yield* makeEventStamp();
                switch (event._tag) {
                  case "AssistantItemStarted":
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        itemId: event.itemId,
                        lifecycle:
                          event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process a First Mate runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // Nothing else notices a door that dies on its own: the ACP event
          // queue is never shut down on process death, so without this the
          // session would sit `ready` forever and a live turn would spin.
          yield* runtime.awaitDoorExit.pipe(
            Effect.flatMap((exit) => handleUnexpectedDoorExit(ctx, exit)),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to report a First Mate door exit.", {
                cause,
                threadId: ctx.threadId,
              }),
            ),
            Effect.forkIn(adapterScope),
          );

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "First Mate ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: FmAdapterShape["sendTurn"] = (input) =>
      // Held for the whole turn. The door answers one prompt at a time, so a
      // second `sendTurn` genuinely waits here rather than pretending to steer.
      withTurnGate(
        input.threadId,
        Effect.gen(function* () {
          const prepared = yield* withStateLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              const text = input.input?.trim();
              if (!text) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "A First Mate turn requires non-empty text. The door accepts no attachments.",
                });
              }
              if (input.attachments && input.attachments.length > 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "The First Mate door declares no image or embedded-context prompt capability, so attachments cannot be sent.",
                });
              }

              const turnId = TurnId.make(yield* randomUUIDv4);
              const displayModel = resolveFmModelId(ctx.currentModelId);
              ctx.activeTurnId = turnId;
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: displayModel ? { model: displayModel } : {},
              });
              return {
                ctx,
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts: [
                  { type: "text" as const, text },
                ] satisfies ReadonlyArray<EffectAcpSchema.ContentBlock>,
                turnId,
              };
            }),
          );

          const settled = yield* Deferred.make<void>();
          // Split in two on purpose. The session-end paths already hold the
          // state lock or run outside it deliberately, and this semaphore is
          // not re-entrant, so they settle through the unlocked body while the
          // ordinary turn path takes the lock exactly once.
          const settleTurnUnlocked: FmTurnSettler = (outcome) =>
            Effect.gen(function* () {
              if (yield* Deferred.isDone(settled)) return;
              yield* Deferred.succeed(settled, undefined);
              const ctx = sessions.get(input.threadId);
              if (!ctx || ctx.acpSessionId !== prepared.acpSessionId) {
                return;
              }
              if (ctx.activeTurnId === prepared.turnId) {
                yield* markSessionReady(ctx);
              }
              ctx.cancelRequestedTurnIds.delete(prepared.turnId);
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: prepared.turnId,
                payload:
                  outcome.state === "failed"
                    ? {
                        state: "failed",
                        errorMessage: outcome.errorMessage ?? "First Mate prompt failed.",
                      }
                    : {
                        state: outcome.state,
                        stopReason: outcome.stopReason ?? null,
                      },
              });
            });
          const settleTurn: FmTurnSettler = (outcome) =>
            withStateLock(input.threadId, settleTurnUnlocked(outcome));
          prepared.ctx.settleActiveTurn = settleTurnUnlocked;

          return yield* Effect.gen(function* () {
            const result = yield* prepared.acp.prompt({ prompt: prepared.promptParts }).pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
              Effect.raceFirst(
                Deferred.await(prepared.ctx.sessionEnded).pipe(
                  Effect.flatMap(() =>
                    Effect.fail(
                      new ProviderAdapterProcessError({
                        provider: PROVIDER,
                        threadId: input.threadId,
                        detail:
                          "The First Mate ACP session ended while this prompt was still running.",
                      }),
                    ),
                  ),
                ),
              ),
            );
            // Every notification the door queued for this turn must reach the
            // UI before the turn is reported complete; otherwise the last
            // chunk of the answer races the terminal event.
            yield* prepared.acp.drainEvents;
            yield* withStateLock(
              input.threadId,
              Effect.sync(() => {
                const ctx = sessions.get(input.threadId);
                if (ctx && ctx.acpSessionId === prepared.acpSessionId) {
                  ctx.turns = [
                    ...ctx.turns,
                    { id: prepared.turnId, items: [{ prompt: prepared.promptParts, result }] },
                  ];
                }
              }),
            );
            yield* settleTurn({
              state: result.stopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: result.stopReason,
            });
            const ctx = sessions.get(input.threadId);
            return {
              threadId: input.threadId,
              turnId: prepared.turnId,
              ...(ctx?.session.resumeCursor !== undefined
                ? { resumeCursor: ctx.session.resumeCursor }
                : {}),
            };
          }).pipe(
            Effect.tapError((error) =>
              settleTurn({ state: "failed", errorMessage: error.message }),
            ),
            // Also covers interruption, so a stopped session cannot strand a
            // turn in `running`.
            Effect.ensuring(
              settleTurn({
                state: "cancelled",
                stopReason: "cancelled",
              }).pipe(Effect.catchCause(() => Effect.void)),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (prepared.ctx.settleActiveTurn === settleTurnUnlocked) {
                  prepared.ctx.settleActiveTurn = undefined;
                }
              }),
            ),
          );
        }),
      );

    const interruptTurn: FmAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withStateLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) return;
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (activeTurnId === undefined) {
            // No prompt is in flight. Sending `session/cancel` anyway would
            // leave a cancel sitting in the door's queue, and the door's own
            // regression suite exists because such a cancel once stopped the
            // *next* prompt.
            if (ctx.session.status === "running" || ctx.session.status === "connecting") {
              yield* markSessionReady(ctx);
            }
            return;
          }
          if (turnId !== undefined && activeTurnId !== turnId) {
            return;
          }
          ctx.cancelRequestedTurnIds.add(activeTurnId);

          // The honest wire line: `session/cancel` and nothing else. The prompt
          // request stays open so the door's own `{stopReason: "cancelled"}`
          // is what settles the turn.
          yield* ctx.acp.notify("session/cancel", { sessionId: ctx.acpSessionId }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
            Effect.ignore,
          );

          // Grace fallback. If the door has not answered by now it is wedged,
          // and a spinner that never stops is worse than a locally forced
          // cancel.
          yield* Effect.gen(function* () {
            yield* Effect.sleep(cancelGrace);
            const liveCtx = sessions.get(threadId);
            if (
              !liveCtx ||
              liveCtx.stopped ||
              liveCtx.acpSessionId !== ctx.acpSessionId ||
              liveCtx.activeTurnId !== activeTurnId
            ) {
              return;
            }
            yield* Effect.logWarning(
              "The First Mate door did not answer a cancelled prompt in time; forcing the local cancel path.",
              { threadId, turnId: activeTurnId },
            );
            yield* Effect.ignore(liveCtx.acp.cancel);
          }).pipe(Effect.forkIn(ctx.scope));
        }),
      );

    const respondToRequest: FmAdapterShape["respondToRequest"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail: "The First Mate door never asks for permission, so there is nothing to answer.",
        });
      });

    const respondToUserInput: FmAdapterShape["respondToUserInput"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail:
            "The First Mate door asks no structured questions, so there is nothing to answer.",
        });
      });

    const readThread: FmAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: FmAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail:
            "A First Mate conversation is the supervisor's own history and cannot be rewound from the host.",
        });
      });

    const stopSession: FmAdapterShape["stopSession"] = (threadId) =>
      withStateLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: FmAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: FmAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: FmAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => PubSub.shutdown(workerObservationPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      // The door accepts `session/set_model` only before the conversation
      // starts, which the snapshot expresses as
      // `requiresNewThreadForModelChange`.
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
      get subscribeWorkerObservations() {
        return PubSub.subscribe(workerObservationPubSub);
      },
    } satisfies FmAdapterShape;
  });
}
