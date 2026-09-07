import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { OtlpExporter, OtlpSerialization, OtlpTracer } from "effect/unstable/observability";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders } from "../state/environmentHttpAuth.ts";

/** Where an environment receives client OTLP span exports. */
export const OTLP_TRACES_PATH = "/api/observability/v1/traces";

const DEFAULT_EXPORT_INTERVAL_MS = 1_000;

// Building the exporter is local work (no network), but a wedged build must never hold up a
// connection attempt, so `prepareClientTracing` gives up after this and connects untraced.
const CONFIGURE_TIMEOUT = "2 seconds";

export interface ClientTracingResource {
  readonly serviceName: string;
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * What a surface has to supply to get its connection spans into the environment's
 * trace file: how it names itself, and the `fetch` its platform provides. Where the
 * spans go, and the credential the export carries, come from the connection itself,
 * so every client that opens the environment socket exports the same way.
 */
export interface ClientTracingBinding {
  readonly resource: ClientTracingResource;
  readonly fetch: typeof globalThis.fetch;
  readonly exportIntervalMs?: number;
}

type DpopSigner = Option.Option<ManagedRelayDpopSigner["Service"]>;

interface ConnectionCredential {
  readonly connection: PreparedConnection;
  readonly signer: DpopSigner;
}

let binding: ClientTracingBinding | null = null;
let activeCredential: ConnectionCredential | null = null;
let activeDelegate: Tracer.Tracer | null = null;
let activeRuntime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeScope: Scope.Closeable | null = null;
let activeConfigKey: string | null = null;
let configurationGeneration = 0;
let pendingConfiguration = Promise.resolve();

/**
 * Names this surface to the exporter. Call it once, at module load of the app's own
 * tracing module, before any connection runtime is built. Without a binding the tracer
 * stays a no-op, which is what tests and non-client processes want.
 */
export function installClientTracing(next: ClientTracingBinding): void {
  binding = next;
}

/**
 * Routes spans created inside the runtime it is merged into (RPC session connect/probe,
 * ping/pong, socket close) to the configured client tracing exporter. Not ambient: a
 * runtime that does not merge this layer keeps the no-op tracer and its spans never leave
 * the process. Spans made before the first `prepareClientTracing` fall back to a local
 * `NativeSpan`, which is why `connect()` primes the exporter before it opens its span.
 */
export const ClientTracingLive = Layer.succeed(
  Tracer.Tracer,
  Tracer.make({
    span(options) {
      return activeDelegate?.span(options) ?? new Tracer.NativeSpan(options);
    },
  }),
);

// The traces route authenticates like any other environment route, so an export has to carry
// the credential the socket was prepared with. DPoP proofs are bound to one method and URL,
// so they are signed per request rather than baked into a static header set. The credential is
// read from `activeCredential` at request time, so a reconnect that refreshes a token is picked
// up without rebuilding the exporter.
const tracingRuntimeLayer = (
  fetchFn: typeof globalThis.fetch,
  tracesUrl: string,
  authorizationAtBuild: PreparedConnection["httpAuthorization"],
) => {
  const authorizedHttpLayer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      HttpClient.mapRequestEffect(client, (request) => {
        const credential = activeCredential;
        if (credential === null) {
          return Effect.succeed(request);
        }
        return buildEnvironmentAuthHeaders(
          credential.connection.httpAuthorization,
          "POST",
          tracesUrl,
          credential.signer,
        ).pipe(
          Effect.map((headers) => {
            const record: Record<string, string> = {};
            if (headers.authorization !== undefined) {
              record.authorization = headers.authorization;
            }
            if (headers.dpop !== undefined) {
              record.dpop = headers.dpop;
            }
            return record;
          }),
          // An unauthorized export is rejected by the environment and logged by the export
          // loop; failing the request here would take the loop down with it.
          Effect.orElseSucceed((): Record<string, string> => ({})),
          Effect.map((record) => HttpClientRequest.setHeaders(request, record)),
        );
      }),
    ),
  ).pipe(Layer.provide(remoteHttpClientLayer(fetchFn)));

  return Layer.mergeAll(
    authorizedHttpLayer,
    // A connection with no credential authenticates by session cookie, which a cross-origin
    // fetch only sends in credentialed mode. Fixed when the exporter is built, because
    // `RequestInit` is a context value rather than a per-request one; an environment does not
    // change which of the two it uses inside a session.
    Layer.succeed(FetchHttpClient.RequestInit, {
      credentials: authorizationAtBuild === null ? "include" : "omit",
    }),
    OtlpExporter.layerFlusher,
    OtlpSerialization.layerJson,
    Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
  );
};

/**
 * Points the exporter at the environment this connection opens against, so its spans land in
 * that environment's trace file. A repeat call for the same environment only refreshes the
 * credential. Never rejects.
 */
export function configureClientTracing(credential: ConnectionCredential): Promise<void> {
  const current = binding;
  if (current === null) {
    return pendingConfiguration;
  }
  activeCredential = credential;
  pendingConfiguration = pendingConfiguration.finally(() =>
    applyClientTracingConfig(current, credential),
  );
  return pendingConfiguration;
}

/**
 * Readies the exporter for a connection before its spans exist. Awaited by `connect()` rather
 * than forked, because a span created before the delegate exists is never handed to the
 * exporter, and the socket span is the first thing `connect()` makes.
 */
export const prepareClientTracing = Effect.fnUntraced(function* (connection: PreparedConnection) {
  if (binding === null) {
    return;
  }
  // Only relay/DPoP connections need a signer, so this must not hard-require one.
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  yield* Effect.promise(() => configureClientTracing({ connection, signer })).pipe(
    Effect.timeout(CONFIGURE_TIMEOUT),
    Effect.ignore,
  );
});

async function applyClientTracingConfig(
  current: ClientTracingBinding,
  credential: ConnectionCredential,
): Promise<void> {
  let tracesUrl: string;
  try {
    tracesUrl = environmentEndpointUrl(credential.connection.httpBaseUrl, OTLP_TRACES_PATH);
  } catch {
    return;
  }
  const exportIntervalMs = Math.max(10, current.exportIntervalMs ?? DEFAULT_EXPORT_INTERVAL_MS);
  const nextConfigKey = `${tracesUrl}|${exportIntervalMs}`;

  if (activeConfigKey === nextConfigKey && activeDelegate !== null) {
    return;
  }

  activeConfigKey = nextConfigKey;
  const generation = ++configurationGeneration;

  const previousRuntime = activeRuntime;
  const previousScope = activeScope;

  activeDelegate = null;
  activeRuntime = null;
  activeScope = null;

  await disposeTracerRuntime(previousRuntime, previousScope);

  const runtime = ManagedRuntime.make(
    tracingRuntimeLayer(current.fetch, tracesUrl, credential.connection.httpAuthorization),
  );
  const scope = runtime.runSync(Scope.make());

  const delegateExit = await settleExit(() =>
    runtime.runPromiseExit(
      Scope.provide(scope)(
        OtlpTracer.make({
          url: tracesUrl,
          exportInterval: `${exportIntervalMs} millis`,
          resource: current.resource,
        }),
      ),
    ),
  );

  if (Exit.isFailure(delegateExit)) {
    await disposeTracerRuntime(runtime, scope);

    if (generation === configurationGeneration) {
      activeConfigKey = null;
      const url = new URL(tracesUrl);
      Effect.runFork(
        Effect.logWarning("Failed to configure the client tracing exporter").pipe(
          Effect.annotateLogs({
            scheme: url.protocol.replace(/:$/, ""),
            host: url.hostname,
            port: url.port === "" ? undefined : url.port,
            exportIntervalMs,
            ...safeErrorLogAttributes(Cause.squash(delegateExit.cause)),
          }),
        ),
      );
    }
    return;
  }

  if (generation !== configurationGeneration) {
    await disposeTracerRuntime(runtime, scope);
    return;
  }

  activeDelegate = delegateExit.value;
  activeRuntime = runtime;
  activeScope = scope;
}

async function settleExit<A, E>(execute: () => Promise<Exit.Exit<A, E>>): Promise<Exit.Exit<A, E>> {
  try {
    return await execute();
  } catch (defect) {
    return Exit.die(defect);
  }
}

async function disposeTracerRuntime(
  runtime: ManagedRuntime.ManagedRuntime<never, never> | null,
  scope: Scope.Closeable | null,
): Promise<void> {
  if (runtime === null || scope === null) {
    return;
  }

  try {
    await runtime.runPromiseExit(Scope.close(scope, Exit.void));
  } catch {
    // A tracer runtime that will not close cleanly must not stop the next one being built.
  }
  runtime.dispose();
}

export async function __resetClientTracingForTests(options?: {
  readonly keepBinding?: boolean;
}): Promise<void> {
  configurationGeneration++;
  activeConfigKey = null;
  activeDelegate = null;
  pendingConfiguration = Promise.resolve();
  if (options?.keepBinding !== true) {
    binding = null;
  }

  const runtime = activeRuntime;
  const scope = activeScope;
  activeRuntime = null;
  activeScope = null;

  // Closing the scope flushes whatever the exporter still holds, and that last export still
  // has to authenticate, so the credential is dropped only once it is on the wire.
  await disposeTracerRuntime(runtime, scope);
  activeCredential = null;
}
