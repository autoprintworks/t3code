import { type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import { formatTraceParent, TRACEPARENT_QUERY_PARAM } from "@t3tools/shared/traceContext";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import type * as Tracer from "effect/Tracer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";

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
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
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

function mapSessionRpcError(error: InitialConfigError | ProbeError): ConnectionAttemptError {
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
        detail: error.message,
      });
  }
}

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const clock = yield* Clock.Clock;

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();

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
            detail: wasConnected
              ? `${connection.label} disconnected.`
              : `${connection.label} could not establish a WebSocket connection.`,
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
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfig = yield* Effect.cached(
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapSessionRpcError),
        Effect.withSpan("environment.initialSync"),
      ),
    );
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? client[WS_METHODS.serverProbe]({})
          : client[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapSessionRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client,
      initialConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
