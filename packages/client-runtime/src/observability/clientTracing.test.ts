import { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import { BearerConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import {
  __resetClientTracingForTests,
  ClientTracingLive,
  configureClientTracing,
  installClientTracing,
} from "./clientTracing.ts";

const MOBILE_TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-mobile"),
  label: "Phone environment",
  connectionId: "connection-1",
});

const MOBILE_CONNECTION: PreparedConnection = {
  environmentId: MOBILE_TARGET.environmentId,
  label: MOBILE_TARGET.label,
  httpBaseUrl: "https://phone.example.test",
  socketUrl: "wss://phone.example.test/ws?wsTicket=test",
  httpAuthorization: { _tag: "Bearer", token: "mobile-access-token" },
  target: MOBILE_TARGET,
};

// `Tracer.Tracer` is read off the current fiber, so the layer's tracer is built out of its
// context and installed with `Effect.withTracer` rather than provided as a service.
const installedTracer = Effect.map(Layer.build(ClientTracingLive), (context) =>
  Context.get(context, Tracer.Tracer),
);

const exportedRequests = (fetchFn: ReturnType<typeof mobileFetch>) =>
  fetchFn.mock.calls.map(([url, init]) => ({
    url: String(url),
    headers: new Headers(init?.headers),
    body: new TextDecoder().decode(init?.body as Uint8Array),
  }));

const mobileFetch = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

it.effect("exports a mobile connection span to the environment the socket opened against", () => {
  const fetchFn = mobileFetch();
  installClientTracing({
    resource: {
      serviceName: "t3-mobile",
      attributes: {
        "service.runtime": "t3-mobile",
        "service.mode": "ios",
        "service.version": "1.2.3",
      },
    },
    fetch: fetchFn,
    exportIntervalMs: 10,
  });

  return Effect.gen(function* () {
    yield* Effect.promise(() =>
      configureClientTracing({ connection: MOBILE_CONNECTION, signer: Option.none() }),
    );
    const tracer = yield* installedTracer;

    yield* Effect.void.pipe(
      Effect.withSpan("clientRuntime.connection.rpcSession.socket", {
        attributes: { "connection.environment.id": MOBILE_CONNECTION.environmentId },
      }),
      Effect.withTracer(tracer),
    );

    // Disposing the exporter flushes whatever it has batched, so the assertion does not
    // have to race the export interval.
    yield* Effect.promise(() => __resetClientTracingForTests());

    const requests = exportedRequests(fetchFn);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://phone.example.test/api/observability/v1/traces");
    expect(request.headers.get("authorization")).toBe("Bearer mobile-access-token");
    expect(request.body).toContain("clientRuntime.connection.rpcSession.socket");
    expect(request.body).toContain("t3-mobile");
  }).pipe(Effect.scoped);
});

it.effect("keeps spans local when no surface has installed a tracing binding", () =>
  Effect.gen(function* () {
    const fetchFn = mobileFetch();
    yield* Effect.promise(() => __resetClientTracingForTests());

    yield* Effect.promise(() =>
      configureClientTracing({ connection: MOBILE_CONNECTION, signer: Option.none() }),
    );
    const tracer = yield* installedTracer;
    const span = tracer.span({
      name: "clientRuntime.connection.rpcSession.socket",
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      startTime: 0n,
      kind: "internal",
      root: true,
      sampled: true,
    });

    expect(span).toBeInstanceOf(Tracer.NativeSpan);
    expect(fetchFn).not.toHaveBeenCalled();
  }).pipe(Effect.scoped),
);
