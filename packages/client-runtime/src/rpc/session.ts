import {
  type ServerConfig,
  type ServerConfigStreamEvent,
  WsSubscribeServerConfigRpc,
  WS_METHODS,
} from "@t3tools/contracts";
import { formatTraceParent, TRACEPARENT_QUERY_PARAM } from "@t3tools/shared/traceContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import { prepareClientTracing } from "../observability/clientTracing.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withoutEnvironmentThemes,
} from "../state/serverConfigProjection.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

// Diagnosing intermittent client disconnects (banner: "<label> disconnected.") needs to
// distinguish "who closed this socket, with what code" from "was the Pong late", rather than
// inferring both from the generic transport error. `clientRuntime.connection.rpcSession.socket`
// covers one connect() call end to end: it opens when connect() starts, gains a Ping/Pong event
// per keepalive tick, and ends with the native WebSocket close code/reason once the socket dies.
// Cheap by construction — the pinger only ticks every 5s (RpcClient.js), so a socket open for the
// median 46s observed in the field produces well under a dozen span events.
const SOCKET_SPAN_NAME = "clientRuntime.connection.rpcSession.socket";

interface WebSocketCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

// Wraps the platform WebSocketConstructor so we observe the native 'close' event (code + reason)
// directly from the browser/Electron/RN WebSocket object. Effect's RpcClient protocol layer
// consumes the same WebSocket instance unmodified; we only attach an extra listener.
function instrumentWebSocketConstructor(
  base: (url: string, protocols?: string | Array<string>) => globalThis.WebSocket,
  onClose: (info: WebSocketCloseInfo) => void,
): (url: string, protocols?: string | Array<string>) => globalThis.WebSocket {
  return (url, protocols) => {
    const ws = base(url, protocols);
    ws.addEventListener("close", (event) => {
      onClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    });
    return ws;
  };
}

// The environment has to be able to line its own view of a dropped socket up against this one.
// Carrying the socket span's traceparent on the connect URL gives the server a parent to hang its
// connection span on, so both ends share a trace id in the server trace file, and gives both ends
// the same `connection.id` to filter on. A URL we cannot parse (never seen in practice) just
// connects without the parameter rather than failing the attempt.
function withTraceParent(socketUrl: string, span: Tracer.Span): string {
  try {
    const url = new URL(socketUrl);
    url.searchParams.set(
      TRACEPARENT_QUERY_PARAM,
      formatTraceParent({ traceId: span.traceId, spanId: span.spanId, sampled: span.sampled }),
    );
    return url.toString();
  } catch {
    return socketUrl;
  }
}

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly subscribeServerConfig: (
    input: ServerConfigSubscriptionInput,
  ) => ServerConfigSubscription;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
}

export interface RpcSessionOptions {
  readonly environmentThemes?: boolean;
  readonly usageLimitSources?: boolean;
  /** This client answers /usage-limits itself, so the server may advertise it. */
  readonly usageLimitsCommand?: boolean;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;
type ServerConfigSubscriptionError =
  | Rpc.ErrorExit<typeof WsSubscribeServerConfigRpc>
  | RpcClientError.RpcClientError;
type ServerConfigSubscription = Stream.Stream<
  ServerConfigStreamEvent,
  ServerConfigSubscriptionError
>;
type ServerConfigSubscriptionInput = Parameters<
  WsRpcProtocolClient[typeof WS_METHODS.subscribeServerConfig]
>[0];
type EnvironmentThemesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "environmentThemesUpdated" }
>;
type UsageLimitSourcesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "usageLimitSourcesUpdated" }
>;

interface ServerConfigReplayState {
  readonly projection: ServerConfigProjection;
  readonly revision: number;
  readonly themesEvent: EnvironmentThemesUpdatedEvent | undefined;
  readonly sourcesEvent: UsageLimitSourcesUpdatedEvent | undefined;
}

interface BufferedServerConfigEvent {
  readonly event: ServerConfigStreamEvent;
  readonly replay: ServerConfigReplayState;
  readonly revision: number;
}

function serverConfigReplayEvents(
  state: ServerConfigReplayState,
): ReadonlyArray<ServerConfigStreamEvent> {
  const snapshot = {
    version: 1 as const,
    type: "snapshot" as const,
    config: withoutEnvironmentThemes(state.projection.config),
  };
  return [
    snapshot,
    ...(state.themesEvent === undefined ? [] : [state.themesEvent]),
    ...(state.sourcesEvent === undefined ? [] : [state.sourcesEvent]),
  ];
}

const isSocketErrorReason = Schema.is(Socket.SocketErrorReason);

function mapSessionRpcError(
  error: InitialConfigError | ProbeError | ServerConfigSubscriptionError,
  networkHint: string,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: `${error.message}${isSocketErrorReason(error.reason) ? networkHint : ""}`,
      });
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("RpcSessionFactory.make")(function* (
  options: RpcSessionOptions = {},
) {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const clock = yield* Clock.Clock;
  const serverConfigInput: ServerConfigSubscriptionInput = {
    ...(options.environmentThemes === true ? { environmentThemes: true } : {}),
    ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
    ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
  };

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    const networkHint =
      connection.target._tag === "RelayConnectionTarget" ? ` ${NETWORK_BLOCKING_HINT}` : "";
    const mapRpcError = (error: Parameters<typeof mapSessionRpcError>[0]) =>
      mapSessionRpcError(error, networkHint);
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();

    // Point the client tracing exporter at the environment this socket opens against, before
    // the socket span exists. A span made while the exporter is still being built is handed to
    // the fallback tracer and never exported, so this is awaited rather than forked; it does no
    // network work and gives up rather than delaying a connect. A surface that installed no
    // binding (or a test) skips it and connects with the ambient tracer.
    yield* prepareClientTracing(connection);

    const socketSpan: Tracer.Span = yield* Effect.makeSpan(SOCKET_SPAN_NAME, {
      attributes: {
        "connection.environment.id": connection.environmentId,
        "connection.label": connection.label,
      },
    });
    socketSpan.attribute("connection.id", socketSpan.spanId);
    const socketUrl = withTraceParent(connection.socketUrl, socketSpan);

    let closeInfo: WebSocketCloseInfo | undefined;
    let lastPingSentAtMs: number | undefined;
    let lastPongAtMs: number | undefined;

    const instrumentedWebSocketConstructor = instrumentWebSocketConstructor(
      webSocketConstructor,
      (info) => {
        closeInfo = info;
        socketSpan.event("clientRuntime.connection.socket.closed", clock.currentTimeNanosUnsafe(), {
          "connection.close.code": info.code,
          "connection.close.reason": info.reason,
          "connection.close.wasClean": info.wasClean,
        });
      },
    );

    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onPing: Effect.sync(() => {
        lastPingSentAtMs = clock.currentTimeMillisUnsafe();
        socketSpan.event("clientRuntime.connection.socket.ping", clock.currentTimeNanosUnsafe());
      }),
      onPong: Effect.sync(() => {
        const now = clock.currentTimeMillisUnsafe();
        lastPongAtMs = now;
        socketSpan.event(
          "clientRuntime.connection.socket.pong",
          clock.currentTimeNanosUnsafe(),
          lastPingSentAtMs === undefined ? {} : { "connection.pong.rttMs": now - lastPingSentAtMs },
        );
      }),
      onPingTimeout: Effect.sync(() => {
        const now = clock.currentTimeMillisUnsafe();
        socketSpan.event(
          "clientRuntime.connection.socket.pingTimeout",
          clock.currentTimeNanosUnsafe(),
          lastPongAtMs === undefined
            ? {}
            : { "connection.pingTimeout.msSinceLastPong": now - lastPongAtMs },
        );
      }),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) => {
          const error = new ConnectionTransientErrorClass({
            reason: "transport",
            detail: `${
              wasConnected
                ? `${connection.label} disconnected.`
                : `${connection.label} could not establish a WebSocket connection.`
            }${networkHint}`,
          });
          return Effect.sync(() => {
            socketSpan.attribute("connection.wasConnected", wasConnected);
            if (closeInfo !== undefined) {
              socketSpan.attribute("connection.close.code", closeInfo.code);
              socketSpan.attribute("connection.close.reason", closeInfo.reason);
              socketSpan.attribute("connection.close.wasClean", closeInfo.wasClean);
            }
            socketSpan.end(clock.currentTimeNanosUnsafe(), Exit.fail(error));
          }).pipe(Effect.andThen(Deferred.fail(disconnected, error)));
        }),
        Effect.asVoid,
      ),
    });
    const socketLayer = Socket.layerWebSocket(socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(
      Layer.provide(Layer.succeed(Socket.WebSocketConstructor, instrumentedWebSocketConstructor)),
    );
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const protocolClient = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfigDeferred = yield* Deferred.make<ServerConfig>();
    const serverConfigExit = yield* Deferred.make<void, ServerConfigSubscriptionError>();
    const configSubscriptionClosed = yield* Deferred.make<never, ConnectionAttemptError>();
    const serverConfigState = yield* Ref.make(Option.none<ServerConfigReplayState>());
    const serverConfigUpdates = yield* PubSub.sliding<BufferedServerConfigEvent>(64);
    const configSubscriptionEndedError = new ConnectionTransientErrorClass({
      reason: "remote-unavailable",
      detail: `${connection.label} config subscription ended.`,
    });
    const serverConfigSource = protocolClient[WS_METHODS.subscribeServerConfig](
      serverConfigInput,
    ).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const buffered = yield* Ref.modify(serverConfigState, (current) => {
            const projection = applyServerConfigProjection(
              Option.map(current, (state) => state.projection),
              event,
            );
            if (Option.isNone(projection)) {
              return [Option.none<BufferedServerConfigEvent>(), current] as const;
            }
            const next = {
              projection: projection.value,
              revision: Option.match(current, {
                onNone: () => 1,
                onSome: (state) => state.revision + 1,
              }),
              themesEvent:
                event.type === "environmentThemesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.environmentThemes !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.themesEvent,
              sourcesEvent:
                event.type === "usageLimitSourcesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.usageLimitSources !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.sourcesEvent,
            } satisfies ServerConfigReplayState;
            return [
              Option.some({ event, replay: next, revision: next.revision }),
              Option.some(next),
            ] as const;
          });
          if (Option.isSome(buffered)) {
            yield* PubSub.publish(serverConfigUpdates, buffered.value);
          }
          if (event.type === "snapshot") {
            yield* Deferred.succeed(initialConfigDeferred, event.config);
          }
        }),
      ),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.all([
            Deferred.succeed(serverConfigExit, undefined),
            Deferred.fail(configSubscriptionClosed, configSubscriptionEndedError),
          ]).pipe(Effect.asVoid);
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.void;
        }
        return Effect.all([
          Deferred.failCause(serverConfigExit, exit.cause),
          Deferred.failCause(configSubscriptionClosed, Cause.map(exit.cause, mapRpcError)),
        ]).pipe(Effect.asVoid);
      }),
    );
    yield* serverConfigSource.pipe(Effect.forkScoped);
    const initialConfig = Effect.raceFirst(
      Deferred.await(initialConfigDeferred),
      Deferred.await(serverConfigExit).pipe(
        Effect.mapError(mapRpcError),
        Effect.flatMap(() => Effect.fail(configSubscriptionEndedError)),
      ),
    ).pipe(Effect.withSpan("environment.initialSync"));
    const serverConfigEvents = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(serverConfigUpdates);
        yield* Effect.raceFirst(
          Deferred.await(initialConfigDeferred).pipe(Effect.asVoid),
          Deferred.await(serverConfigExit),
        );
        const snapshot = yield* Ref.get(serverConfigState);
        if (Option.isNone(snapshot)) {
          return Stream.empty;
        }
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((buffered) => buffered.revision > snapshot.value.revision),
          Stream.mapAccum(
            () => snapshot.value.revision,
            (revision, buffered) => [
              buffered.revision,
              buffered.revision === revision + 1
                ? [buffered.event]
                : serverConfigReplayEvents(buffered.replay),
            ],
          ),
        );
        const terminal = Stream.fromEffect(Deferred.await(serverConfigExit)).pipe(Stream.drain);
        return Stream.concat(
          Stream.fromIterable(serverConfigReplayEvents(snapshot.value)),
          Stream.merge(updates, terminal, { haltStrategy: "either" }),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Stream.failCause(cause);
        }
        // The supervisor keeps the original cause. Shared durable consumers
        // need a transport-shaped failure so they wait for its replacement.
        return Stream.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
        );
      }),
    );
    const subscribeServerConfig = (input: ServerConfigSubscriptionInput) =>
      Equal.equals(input, serverConfigInput)
        ? serverConfigEvents
        : protocolClient[WS_METHODS.subscribeServerConfig](input);
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? protocolClient[WS_METHODS.serverProbe]({})
          : protocolClient[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client: protocolClient,
      initialConfig,
      subscribeServerConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Effect.raceFirst(
        Deferred.await(disconnected),
        Deferred.await(configSubscriptionClosed),
      ),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layerWithOptions = (options: RpcSessionOptions) =>
  Layer.effect(RpcSessionFactory, make(options));
