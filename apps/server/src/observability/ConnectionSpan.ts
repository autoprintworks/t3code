import { parseTraceParent, TRACEPARENT_QUERY_PARAM } from "@t3tools/shared/traceContext";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as Socket from "effect/unstable/socket/Socket";

/**
 * One span per client websocket, so every close is explained in the trace file: which code and
 * reason ended it, who ended it, and how the keepalive was behaving just before.
 */
export const CLIENT_SOCKET_SPAN_NAME = "server.connection.clientSocket";

// The RPC keepalive is client-driven: the client sends `Ping` every 5 seconds and the server
// answers `Pong`. Under `RpcSerialization.layerJson` each is a whole JSON frame, so recognising
// them costs a string compare that a real message fails on its first character. If the wire format
// ever changes these stop matching and the span simply carries no keepalive numbers.
const PING_FRAME = JSON.stringify(RpcMessage.constPing);
const PONG_FRAME = JSON.stringify(RpcMessage.constPong);

/**
 * Four keepalive intervals of silence. A client that stopped pinging for this long before its
 * socket died had already given up on our Pongs, which is what a client-side ping timeout looks
 * like from this end. Diagnostic only: nothing here closes or retries a connection.
 */
export const PING_STARVATION_MS = 20_000;

// Codes a websocket may close with without anything having gone wrong.
const CLEAN_CLOSE_CODES: ReadonlySet<number> = new Set([1000, 1001]);

export interface ClientSocketSpanOptions {
  readonly attributes?: Record<string, unknown> | undefined;
  readonly parent?: Tracer.AnySpan | undefined;
  readonly starvationMs?: number | undefined;
}

function socketCloseOf(exit: Exit.Exit<unknown, unknown>): Socket.SocketCloseError | undefined {
  if (!Exit.isFailure(exit)) {
    return undefined;
  }
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error) || !Socket.SocketError.is(error.value)) {
    return undefined;
  }
  const reason = error.value.reason;
  return reason._tag === "SocketCloseError" ? reason : undefined;
}

/**
 * Wraps a client websocket so its whole life is one span. The returned socket is a pass-through
 * the RPC server consumes unchanged; only the reading and writing are observed.
 *
 * Keepalive traffic is summarised rather than evented, because these sockets stay open for hours
 * and a span event per 5-second tick would dominate the trace file.
 */
export const instrumentClientSocket = Effect.fnUntraced(function* (
  socket: Socket.Socket,
  options: ClientSocketSpanOptions = {},
) {
  const clock = yield* Clock.Clock;
  const starvationMs = options.starvationMs ?? PING_STARVATION_MS;
  const span = yield* Effect.makeSpan(CLIENT_SOCKET_SPAN_NAME, {
    kind: "server",
    ...(options.attributes ? { attributes: options.attributes } : {}),
    ...(options.parent ? { parent: options.parent } : {}),
  });

  const openedAtMs = clock.currentTimeMillisUnsafe();
  let pingCount = 0;
  let pongCount = 0;
  let lastPingAtMs: number | undefined;
  let lastPongAtMs: number | undefined;
  let maxPingGapMs = 0;
  let serverInitiatedClose = false;
  let ended = false;

  const observeIncoming = (data: string | Uint8Array) => {
    if (data !== PING_FRAME) {
      return;
    }
    const now = clock.currentTimeMillisUnsafe();
    const gapMs = now - (lastPingAtMs ?? openedAtMs);
    if (gapMs > maxPingGapMs) {
      maxPingGapMs = gapMs;
    }
    // Only the gaps worth reading about become events, so a long-lived socket stays cheap.
    if (gapMs > starvationMs) {
      span.event("server.connection.socket.keepaliveGap", clock.currentTimeNanosUnsafe(), {
        "connection.ping.gapMs": gapMs,
      });
    }
    pingCount += 1;
    lastPingAtMs = now;
  };

  const observeOutgoing = (chunk: Uint8Array | string | Socket.CloseEvent) => {
    if (Socket.isCloseEvent(chunk)) {
      serverInitiatedClose = true;
      return;
    }
    if (chunk === PONG_FRAME) {
      pongCount += 1;
      lastPongAtMs = clock.currentTimeMillisUnsafe();
    }
  };

  const endSpan = (exit: Exit.Exit<unknown, unknown>) => {
    if (ended) {
      return;
    }
    ended = true;
    const now = clock.currentTimeMillisUnsafe();
    const close = socketCloseOf(exit);

    span.attribute("connection.open.durationMs", now - openedAtMs);
    span.attribute("connection.close.initiator", serverInitiatedClose ? "server" : "client");
    if (close === undefined) {
      // The socket ended without a close frame: the environment tore the connection down itself,
      // or the run was interrupted at shutdown.
      span.attribute("connection.close.observed", false);
      span.attribute(
        "connection.close.clean",
        Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause),
      );
    } else {
      span.attribute("connection.close.observed", true);
      span.attribute("connection.close.code", close.code);
      span.attribute("connection.close.reason", close.closeReason ?? "");
      span.attribute("connection.close.clean", CLEAN_CLOSE_CODES.has(close.code));
    }

    span.attribute("connection.ping.count", pingCount);
    span.attribute("connection.pong.count", pongCount);
    span.attribute("connection.ping.maxGapMs", maxPingGapMs);
    span.attribute(
      "connection.ping.lastAgeMs",
      lastPingAtMs === undefined ? null : now - lastPingAtMs,
    );
    span.attribute(
      "connection.pong.lastAgeMs",
      lastPongAtMs === undefined ? null : now - lastPongAtMs,
    );
    span.attribute("connection.ping.starved", now - (lastPingAtMs ?? openedAtMs) > starvationMs);

    span.end(clock.currentTimeNanosUnsafe(), exit);
  };

  // The socket run ends the span, but a connection whose scope closes before the run starts must
  // not leave a span open, or it never reaches the trace file at all.
  yield* Effect.addFinalizer((exit) => Effect.sync(() => endSpan(exit)));

  return Socket.make({
    runRaw: (handler, runOptions) =>
      socket
        .runRaw((data) => {
          observeIncoming(data);
          return handler(data);
        }, runOptions)
        .pipe(Effect.onExit((exit) => Effect.sync(() => endSpan(exit)))),
    writer: Effect.map(socket.writer, (write) => (chunk) => {
      observeOutgoing(chunk);
      return write(chunk);
    }),
  });
});

/**
 * Reads the connection span the client put on its websocket URL. Returns the span to parent on
 * and the attributes that let a reader join the two ends of one connection.
 */
export function clientConnectionTrace(request: HttpServerRequest.HttpServerRequest): {
  readonly parent?: Tracer.AnySpan;
  readonly attributes: Record<string, unknown>;
} {
  const url = HttpServerRequest.toURL(request);
  const traceParent = Option.isSome(url)
    ? parseTraceParent(url.value.searchParams.get(TRACEPARENT_QUERY_PARAM))
    : undefined;
  if (traceParent === undefined) {
    return { attributes: {} };
  }
  return {
    parent: Tracer.externalSpan(traceParent),
    attributes: { "connection.id": traceParent.spanId },
  };
}

/**
 * Returns the request with an instrumented `upgrade`, so the RPC server's own websocket handling
 * is untouched but the socket it gets is the observed one. `upgrade` is a getter on the platform's
 * request class, so the override goes through a proxy that forwards every other member to the real
 * request with `this` still bound to it.
 */
export const instrumentUpgrade = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
  attributes: Record<string, unknown>,
) {
  const scope = yield* Effect.scope;
  const client = clientConnectionTrace(request);
  const upgrade = request.upgrade.pipe(
    Effect.flatMap((socket) =>
      instrumentClientSocket(socket, {
        attributes: { ...attributes, ...client.attributes },
        ...(client.parent ? { parent: client.parent } : {}),
      }),
    ),
    Scope.provide(scope),
  );

  return new Proxy(request, {
    get: (target, property) =>
      property === "upgrade" ? upgrade : Reflect.get(target, property, target),
  });
});
