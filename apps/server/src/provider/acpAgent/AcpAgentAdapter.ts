/**
 * The provider adapter for an external agent that speaks the Agent Client
 * Protocol.
 *
 * It stays close to what ACP itself guarantees, because an agent configured
 * from settings is an agent nobody here has met. It sends text and receives
 * text: no permission prompts, no tool calls, no plan updates, no MCP, no image
 * blocks. Anything richer would be this adapter guessing on the agent's behalf,
 * and a wrong guess is worse than an honest refusal.
 *
 * Two properties of the protocol shape everything below.
 *
 * **Turns are strictly sequential.** ACP answers one `session/prompt` at a
 * time per session, so a `sendTurn` arriving while another turn is live opens a
 * *new* turn that queues, rather than steering the live one the way the Grok
 * adapter does for an agent it knows accepts that.
 *
 * **Cancel is the agent's job, not ours.** `AcpSessionRuntime.cancel` sends the
 * notification but also interrupts the local prompt fiber and synthesises
 * `{stopReason: "cancelled"}` before the agent has answered. Here the real
 * `session/cancel` line goes out on its own and the prompt request stays open,
 * so the turn is settled by the agent's own answer. A bounded grace period
 * falls back to the local cancel, because a wedged agent must not leave a
 * spinner running forever.
 *
 * @module provider/acpAgent/AcpAgentAdapter
 */
import {
  ACP_AGENT_DRIVER_KIND,
  type AcpAgentSettings,
  EventId,
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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
import type { AcpPeerSession } from "../acp/AcpPeerSessions.ts";
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
  currentAcpAgentModelIdFromSessionSetup,
  type AcpAgentExit,
  makeAcpAgentRuntime,
  resolveAcpAgentModelId,
} from "./AcpAgentSupport.ts";
import {
  type AcpAgentWorkerEndReason,
  type AcpAgentWorkerObservation,
  acpAgentWorkerMessageIdFor,
  reconcileAcpAgentWorkers,
} from "./AcpAgentWorkerSessions.ts";

/** AcpAgentAdapterShape - per-instance external ACP agent adapter contract. */
export interface AcpAgentAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  /**
   * The peer sessions this instance's agents are hosting, and the text they
   * produce.
   *
   * `AcpAgentWorkerThreadReactor` is the only consumer; it turns these into
   * read-only threads. The subscription is acquired in the caller's own fiber
   * so an observation published while the consumer is still being scheduled
   * cannot fall into a gap - build a stream over it with
   * `Stream.fromSubscription`, never `Stream.fromPubSub`.
   */
  readonly subscribeWorkerObservations: Effect.Effect<
    PubSub.Subscription<AcpAgentWorkerObservation>,
    never,
    Scope.Scope
  >;
}

/** Narrows a registry adapter to the configurable ACP agent one. */
export function isAcpAgentAdapter(
  adapter: ProviderAdapterShape<ProviderAdapterError>,
): adapter is AcpAgentAdapterShape {
  return adapter.provider === PROVIDER && "subscribeWorkerObservations" in adapter;
}

const PROVIDER = ACP_AGENT_DRIVER_KIND;
const ACP_AGENT_RESUME_VERSION = 1 as const;

/**
 * How long the agent gets to answer a cancelled prompt itself before the local
 * cancel path takes over. Generous enough that the honest answer wins on any
 * healthy agent, short enough that a wedged one does not lie to the user.
 */
const ACP_AGENT_CANCEL_GRACE = Duration.seconds(10);

export interface AcpAgentAdapterLiveOptions {
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

interface AcpAgentSessionContext {
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
   * Set for the span of a live turn so an agent that dies mid-prompt can settle
   * it. Idempotent: the same guard that stops a late answer resurrecting
   * a cancelled turn also stops this double-settling one.
   */
  settleActiveTurn: AcpAgentTurnSettler | undefined;
  /**
   * Fires once this session is over, whether it was stopped or the agent died.
   * A prompt request outliving its agent is never answered and is never failed
   * by the ACP client either, so without this the `sendTurn` caller waits
   * forever on a process that no longer exists.
   */
  readonly sessionEnded: Deferred.Deferred<void>;
}

/** Settles the turn a `sendTurn` call owns; safe to call more than once. */
type AcpAgentTurnSettler = (outcome: {
  readonly state: "completed" | "cancelled" | "failed";
  readonly stopReason?: EffectAcpSchema.StopReason | null;
  readonly errorMessage?: string;
}) => Effect.Effect<void, ProviderAdapterRequestError>;

interface AcpAgentResumeCursor {
  readonly schemaVersion: typeof ACP_AGENT_RESUME_VERSION;
  readonly sessionId: string;
}

/**
 * The first line of a failure, short enough to read in a thread.
 *
 * A worker whose transcript could not be loaded says so in its own thread, and
 * a stack trace is not what the person reading it needs.
 */
function firstCauseLine(cause: Cause.Cause<unknown>): string {
  const first = Cause.pretty(cause).split("\n")[0]?.trim();
  return first ? first : "session/load failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The session id an earlier connection was given, if this thread has one.
 *
 * Persisting it is what lets a Desktop restart reattach to a session the agent
 * still holds, through `session/load`, instead of starting a second one beside
 * it. The version tag is there so a cursor written by an older build is ignored
 * rather than misread.
 */
export function parseAcpAgentResume(raw: unknown): AcpAgentResumeCursor | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== ACP_AGENT_RESUME_VERSION) return undefined;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
  if (!sessionId) return undefined;
  return { schemaVersion: ACP_AGENT_RESUME_VERSION, sessionId };
}

/**
 * The turn an agent notification belongs to, or `undefined` when it belongs to
 * nothing the user is still watching.
 *
 * Two cases have no wire barrier a test can wait on, which is why this is a
 * function rather than an inline guard: `session/load` replay chunks arrive
 * with no turn open, and a cancelled turn can still be handed chunks the agent
 * had already queued. Both must be dropped, and the certification suite
 * asserts that here.
 */
export function acpAgentLiveTurnForNotification(input: {
  readonly activeTurnId: TurnId | undefined;
  readonly cancelRequestedTurnIds: ReadonlySet<TurnId>;
}): TurnId | undefined {
  const { activeTurnId } = input;
  if (activeTurnId === undefined) {
    return undefined;
  }
  return input.cancelRequestedTurnIds.has(activeTurnId) ? undefined : activeTurnId;
}

export function makeAcpAgentAdapter(
  agentSettings: AcpAgentSettings,
  options?: AcpAgentAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("acpAgent");
    // Agent watchers are forked here rather than into the session scope,
    // because the watcher's own job is to close that scope; forking into it
    // would have the watcher interrupt itself half way through the teardown.
    const adapterScope = yield* Effect.scope;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;
    const cancelGrace: Duration.Input = options?.cancelGrace ?? ACP_AGENT_CANCEL_GRACE;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, AcpAgentSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const workerObservationPubSub = yield* PubSub.unbounded<AcpAgentWorkerObservation>();
    // Two locks, always taken in this order: `turnGate` for the whole span of a
    // turn (so a queued `sendTurn` waits exactly like the agent's own request
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
            detail: "Failed to generate an ACP agent runtime identifier.",
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

    const publishWorkerObservation = (observation: AcpAgentWorkerObservation) =>
      PubSub.publish(workerObservationPubSub, observation).pipe(Effect.asVoid);

    /**
     * Turns one agent's peer sessions into worker observations for the
     * reactor.
     *
     * Two pumps run for the life of the session: one over the poll rosters,
     * which decides what a worker thread is; one over the peer event queue,
     * which decides what is written into it. Neither ever prompts - a peer
     * session is steered by whoever opened it, never through this adapter.
     *
     * Nothing here waits on the agent. The one request this feature makes,
     * `session/load` for a newly seen worker, is forked into the session scope
     * rather than awaited, so an agent that accepts the load and never answers
     * costs one sleeping fiber and delays nothing: not the next poll, not the
     * other workers, and not the supervisor's own conversation.
     */
    const watchWorkerSessions = (input: {
      readonly supervisorThreadId: ThreadId;
      readonly homeSessionId: string;
      readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
      readonly peerSessions: PubSub.Subscription<ReadonlyArray<AcpPeerSession>>;
      readonly scope: Scope.Scope;
    }) =>
      Effect.gen(function* () {
        // Reconciled against the whole roster on every poll, so a dropped item
        // costs one poll of latency rather than a worker nobody hears about.
        const known = new Set<string>();
        // A `Ref` rather than a bare `Map` because both pumps touch it and they
        // run as two fibers: the event pump reads-then-writes per chunk, and
        // the roster pump drops a session's entry when the worker ends. An
        // unsynchronised read-modify-write across those two can resurrect an
        // entry for a worker that is already gone.
        const messageStateRef = yield* SynchronizedRef.make(
          new Map<string, { currentMessageId: string | undefined; fallbackCount: number }>(),
        );

        const publishFor = (
          fields:
            | {
                readonly _tag: "WorkerAppeared";
                readonly workerSessionId: string;
                readonly title: string | undefined;
                readonly cwd: string;
              }
            | {
                readonly _tag: "WorkerDisappeared";
                readonly workerSessionId: string;
                readonly reason: AcpAgentWorkerEndReason;
              }
            | { readonly _tag: "WorkerRoster"; readonly workerSessionIds: ReadonlyArray<string> }
            | {
                readonly _tag: "WorkerLoadFailed";
                readonly workerSessionId: string;
                readonly detail: string;
              }
            | {
                readonly _tag: "WorkerText";
                readonly workerSessionId: string;
                readonly messageId: string;
                readonly text: string;
              }
            | {
                readonly _tag: "WorkerTextCompleted";
                readonly workerSessionId: string;
                readonly messageId: string;
              },
        ) =>
          publishWorkerObservation({
            ...fields,
            supervisorThreadId: input.supervisorThreadId,
            homeSessionId: input.homeSessionId,
          });

        const loadWorkerTranscript = (session: AcpPeerSession) =>
          // Loading on appearance rather than on open is deliberate: a worker
          // that starts and finishes before anyone looks must still leave a
          // readable thread behind, and an archived thread has no later moment
          // at which to fetch its own history.
          //
          // One attempt. A load that fails is a worker whose transcript cannot
          // be read, which is a terminal answer the thread says out loud - not
          // a reason to ask the same agent again.
          //
          // Forked, not awaited: this is the only request the feature makes,
          // and the roster pump must not be behind it.
          input.acp.loadPeerSession(session.sessionId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("acp.worker.session-load-failed", {
                cause,
                threadId: input.supervisorThreadId,
                workerSessionId: session.sessionId,
              }).pipe(
                Effect.andThen(
                  publishFor({
                    _tag: "WorkerLoadFailed",
                    workerSessionId: session.sessionId,
                    detail: firstCauseLine(cause),
                  }),
                ),
              ),
            ),
            Effect.forkIn(input.scope),
            Effect.asVoid,
          );

        const rosterPump = Stream.runForEach(
          Stream.fromSubscription(input.peerSessions),
          (present) =>
            Effect.gen(function* () {
              const changed = reconcileAcpAgentWorkers({ known, present });
              for (const session of changed.appeared) {
                known.add(session.sessionId);
                yield* publishFor({
                  _tag: "WorkerAppeared",
                  workerSessionId: session.sessionId,
                  title: session.title,
                  cwd: session.cwd,
                });
                yield* loadWorkerTranscript(session);
              }
              for (const workerSessionId of changed.disappeared) {
                known.delete(workerSessionId);
                yield* SynchronizedRef.update(messageStateRef, (current) => {
                  if (!current.has(workerSessionId)) return current;
                  const next = new Map(current);
                  next.delete(workerSessionId);
                  return next;
                });
                yield* publishFor({
                  _tag: "WorkerDisappeared",
                  workerSessionId,
                  // The agent answered, and did not list it: it is over.
                  reason: "finished",
                });
              }
              // Published after the diff so the reactor applies the two in the
              // order they happened, and on every poll that says anything at
              // all so that a restart with no change still tells the reactor
              // what is real.
              yield* publishFor({
                _tag: "WorkerRoster",
                workerSessionIds: present.map((session) => session.sessionId),
              });
            }),
        );

        const eventPump = Stream.runForEach(input.acp.getPeerSessionEvents(), (item) =>
          Effect.gen(function* () {
            if (item._tag === "EventStreamBarrier") {
              yield* Deferred.succeed(item.acknowledge, undefined);
              return;
            }
            const workerSessionId = item.sessionId;
            switch (item.event._tag) {
              case "AssistantItemStarted": {
                const itemId = item.event.itemId;
                yield* SynchronizedRef.update(messageStateRef, (current) => {
                  const next = new Map(current);
                  next.set(workerSessionId, {
                    currentMessageId: itemId,
                    fallbackCount: current.get(workerSessionId)?.fallbackCount ?? 0,
                  });
                  return next;
                });
                return;
              }
              case "AssistantItemCompleted": {
                const itemId = item.event.itemId;
                yield* SynchronizedRef.update(messageStateRef, (current) => {
                  const state = current.get(workerSessionId);
                  const next = new Map(current);
                  next.set(workerSessionId, {
                    currentMessageId:
                      state?.currentMessageId === itemId ? undefined : state?.currentMessageId,
                    fallbackCount: state?.fallbackCount ?? 0,
                  });
                  return next;
                });
                yield* publishFor({
                  _tag: "WorkerTextCompleted",
                  workerSessionId,
                  messageId: itemId,
                });
                return;
              }
              case "ContentDelta": {
                const itemId = item.event.itemId;
                const text = item.event.text;
                const messageId = yield* SynchronizedRef.modify(messageStateRef, (current) => {
                  const state = current.get(workerSessionId) ?? {
                    currentMessageId: undefined,
                    fallbackCount: 0,
                  };
                  const resolved = acpAgentWorkerMessageIdFor({
                    workerSessionId,
                    itemId,
                    currentMessageId: state.currentMessageId,
                    fallbackCount: state.fallbackCount,
                  });
                  const synthesised = !itemId?.trim() && state.currentMessageId === undefined;
                  const next = new Map(current);
                  next.set(workerSessionId, {
                    currentMessageId: resolved,
                    fallbackCount: synthesised ? state.fallbackCount + 1 : state.fallbackCount,
                  });
                  return [resolved, next] as const;
                });
                yield* publishFor({
                  _tag: "WorkerText",
                  workerSessionId,
                  messageId,
                  text,
                });
                return;
              }
              // A peer session's modes, plans and tool calls belong to a
              // richer client than this one; ignoring them here is a statement
              // about what a worker thread shows, not an oversight.
              default:
                return;
            }
          }),
        );

        yield* Effect.all([rosterPump, eventPump], { concurrency: 2, discard: true }).pipe(
          // However the watch ends - scope closed, agent exited, editor
          // shutting down - every worker it was watching stops being watched.
          // Saying so is what stops a thread streaming forever on the strength
          // of a connection that is gone. `unknown`, not `finished`: an agent
          // may outlive the editor, so these workers may still be running.
          Effect.ensuring(
            Effect.forEach(
              [...known],
              (workerSessionId) =>
                publishFor({
                  _tag: "WorkerDisappeared",
                  workerSessionId,
                  reason: "unknown",
                }),
              { discard: true },
            ),
          ),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to watch the agent's peer sessions.", {
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
          Effect.logWarning("Failed to write a native ACP agent notification log.", {
            cause,
            threadId,
            method,
          }),
        ),
      );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AcpAgentSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    /** Moves the session out of `running` without emitting a turn event. */
    const markSessionReady = (ctx: AcpAgentSessionContext) =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.activeTurnId = undefined;
        ctx.session = { ...readySession, status: "ready", updatedAt };
      });

    /**
     * Settles whatever turn is still live, then releases the prompt fiber
     * waiting on the agent. Order matters twice: `settleTurn` recognises its
     * turn by looking the session up in `sessions`, so it has to run before
     * the session is removed; and it has to win the race against the prompt's
     * own failure, so the user is told why the turn ended rather than which
     * transport error happened to surface.
     */
    const settleActiveTurnOnEnd = (
      ctx: AcpAgentSessionContext,
      outcome: Parameters<AcpAgentTurnSettler>[0],
    ) =>
      Effect.gen(function* () {
        if (ctx.settleActiveTurn) {
          yield* Effect.ignore(ctx.settleActiveTurn(outcome));
        }
        yield* Deferred.succeed(ctx.sessionEnded, undefined);
      });

    const stopSessionInternal = (ctx: AcpAgentSessionContext) =>
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
     * The agent died without anyone asking it to. Both events go out before the
     * scope is torn down, and the live turn is settled while the session is
     * still in `sessions`, because that map is how `settleTurn` recognises the
     * turn it owns.
     */
    const handleUnexpectedAgentExit = (ctx: AcpAgentSessionContext, exit: AcpAgentExit) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        const reason =
          exit.code === null
            ? "The ACP agent exited unexpectedly."
            : `The ACP agent exited unexpectedly with code ${exit.code}.`;
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

    const startSession: AcpAgentAdapterShape["startSession"] = (input) =>
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

          const resumeSessionId = parseAcpAgentResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const runtime = yield* makeAcpAgentRuntime({
            agentSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            // Opting in is what starts the `session/list` poll, and only if
            // the agent also advertises the capability. Without this the
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
          // poll. A subscription taken afterwards could miss the first roster,
          // and a roster that says nothing changed is never republished.
          const peerSessions = yield* acp.subscribePeerSessions.pipe(
            Effect.provideService(Scope.Scope, sessionScope),
          );

          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          // Forked after `start` because the agent's own session id is what a
          // worker thread is named after, and that id is what `start` returns.
          // Nothing is lost by waiting: the subscription above is already
          // holding whatever the first poll published.
          yield* watchWorkerSessions({
            supervisorThreadId: input.threadId,
            homeSessionId: started.sessionId,
            acp,
            peerSessions,
            scope: sessionScope,
          }).pipe(Effect.forkIn(sessionScope));

          // Session start is the one moment a model choice is honoured, which
          // is what `requiresNewThreadForModelChange` on the snapshot says. An
          // agent is still free to refuse the request, and its refusal is
          // surfaced verbatim rather than swallowed: a silently ignored model
          // choice is the worst of the available answers.
          const requestedModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const currentModelId = currentAcpAgentModelIdFromSessionSetup(started.sessionSetupResult);
          const requestedModelId = resolveAcpAgentModelId(requestedModelSelection?.model);
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
              schemaVersion: ACP_AGENT_RESUME_VERSION,
              sessionId: started.sessionId,
            } satisfies AcpAgentResumeCursor,
            createdAt: now,
            updatedAt: now,
          };

          const ctx: AcpAgentSessionContext = {
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
                // The agent emits only assistant text. Mode changes, plans and
                // tool calls belong to richer agents; ignoring them here is a
                // statement about the agent, not an oversight.
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
                const turnId = acpAgentLiveTurnForNotification(ctx);
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
              Effect.logError("Failed to process a ACP agent runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // Nothing else notices a agent that dies on its own: the ACP event
          // queue is never shut down on process death, so without this the
          // session would sit `ready` forever and a live turn would spin.
          yield* runtime.awaitAgentExit.pipe(
            Effect.flatMap((exit) => handleUnexpectedAgentExit(ctx, exit)),
            Effect.catchCause((cause) =>
              Effect.logError("Failed to report a ACP agent exit.", {
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
            payload: { state: "ready", reason: "ACP session ready" },
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

    const sendTurn: AcpAgentAdapterShape["sendTurn"] = (input) =>
      // Held for the whole turn. The agent answers one prompt at a time, so a
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
                    "An agent turn requires non-empty text. This adapter sends no attachments.",
                });
              }
              if (input.attachments && input.attachments.length > 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "The ACP agent declares no image or embedded-context prompt capability, so attachments cannot be sent.",
                });
              }

              const turnId = TurnId.make(yield* randomUUIDv4);
              const displayModel = resolveAcpAgentModelId(ctx.currentModelId);
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
          const settleTurnUnlocked: AcpAgentTurnSettler = (outcome) =>
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
                        errorMessage: outcome.errorMessage ?? "The agent prompt failed.",
                      }
                    : {
                        state: outcome.state,
                        stopReason: outcome.stopReason ?? null,
                      },
              });
            });
          const settleTurn: AcpAgentTurnSettler = (outcome) =>
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
                        detail: "The ACP session ended while this prompt was still running.",
                      }),
                    ),
                  ),
                ),
              ),
            );
            // Every notification the agent queued for this turn must reach the
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

    const interruptTurn: AcpAgentAdapterShape["interruptTurn"] = (threadId, turnId) =>
      withStateLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) return;
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (activeTurnId === undefined) {
            // No prompt is in flight. Sending `session/cancel` anyway would
            // leave a cancel sitting in the agent's queue, where an agent that
            // does not discard it stops the *next* prompt instead.
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
          // request stays open so the agent's own `{stopReason: "cancelled"}`
          // is what settles the turn.
          yield* ctx.acp.notify("session/cancel", { sessionId: ctx.acpSessionId }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
            Effect.ignore,
          );

          // Grace fallback. If the agent has not answered by now it is wedged,
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
              "The ACP agent did not answer a cancelled prompt in time; forcing the local cancel path.",
              { threadId, turnId: activeTurnId },
            );
            yield* Effect.ignore(liveCtx.acp.cancel);
          }).pipe(Effect.forkIn(ctx.scope));
        }),
      );

    const respondToRequest: AcpAgentAdapterShape["respondToRequest"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/request_permission",
          detail:
            "This adapter grants the agent no filesystem or terminal capability, so there is no permission request to answer.",
        });
      });

    const respondToUserInput: AcpAgentAdapterShape["respondToUserInput"] = (threadId) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/elicitation",
          detail:
            "This adapter asks the agent for text only, so there is no structured question to answer.",
        });
      });

    const readThread: AcpAgentAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: AcpAgentAdapterShape["rollbackThread"] = (threadId, numTurns) =>
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
            "An ACP session is the agent's own history, and ACP has no way to rewind it from the client.",
        });
      });

    const stopSession: AcpAgentAdapterShape["stopSession"] = (threadId) =>
      withStateLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: AcpAgentAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: AcpAgentAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: AcpAgentAdapterShape["stopAll"] = () =>
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
      // A model change starts a fresh session rather than steering the live
      // one, because ACP does not promise that any given agent will accept a
      // mid-session `session/set_model`. The snapshot says the same thing to
      // the user as `requiresNewThreadForModelChange`.
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
    } satisfies AcpAgentAdapterShape;
  });
}
