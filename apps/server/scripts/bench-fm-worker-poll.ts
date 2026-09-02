/**
 * FORK DELTA (fm provider) - the measurement harness for the worker-session
 * poll.
 *
 * `docs/internals/fm-worker-threads.md` states four things about the poll that
 * a unit test cannot: what one poll costs, whether the Node event loop is free
 * while it runs, what happens when the door accepts a request and never
 * answers it, and what happens when a session disappears while its load is in
 * flight. Every one of those is a wall-clock question, and `it.effect` runs on
 * a virtual clock, so this runs outside vitest against a real subprocess over
 * a real pipe.
 *
 * Usage:
 *   node apps/server/scripts/bench-fm-worker-poll.ts
 *     [--workers 0,50,200] [--seconds 15] [--interval-ms 200]
 *
 * Everything above the spawn is the shipping path: `AcpSessionRuntime`, its
 * bounded peer requests, its poll loop, and the ndjson framing underneath.
 * `fm-worker-poll-door.mjs` stands in for `fm-acp` because the measurement is
 * of this side of the wire.
 */
// @effect-diagnostics nodeBuiltinImport:off
// A benchmark reports to a terminal; routing it through Effect's logger would
// only make the numbers harder to read.
// @effect-diagnostics globalConsole:off
// @effect-diagnostics globalConsoleInEffect:off
// The harness times itself against the wall clock on purpose: a `Clock` that
// could be virtual is exactly what this script exists to avoid.
// @effect-diagnostics globalDate:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as AcpSessionRuntime from "../src/provider/acp/AcpSessionRuntime.ts";
import type { AcpPeerSession } from "../src/provider/acp/AcpPeerSessions.ts";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token?.startsWith("--")) {
    const next = process.argv[index + 1];
    args.set(token.slice(2), next && !next.startsWith("--") ? next : "true");
  }
}
const arg = (name: string, fallback: string) => args.get(name) ?? fallback;

const WORKER_COUNTS = arg("workers", "0,50,200").split(",").map(Number);
const SECONDS = Number(arg("seconds", "15"));
const INTERVAL_MS = Number(arg("interval-ms", "200"));

const DOOR_SCRIPT = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "fm-worker-poll-door.mjs",
);

const percentile = (samples: ReadonlyArray<number>, fraction: number): number => {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index] ?? Number.NaN;
};

const ms = (value: number) => `${value.toFixed(2)} ms`;

/** One run against a freshly spawned door. */
const withRuntime = <A>(
  input: {
    readonly env: NodeJS.ProcessEnv;
    readonly pollIntervalMs: number;
    readonly onRequest?: (event: AcpSessionRuntime.AcpSessionRequestLogEvent) => void;
  },
  body: (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  ) => Effect.Effect<A, never, Scope.Scope>,
): Effect.Effect<A, never, Scope.Scope | NodeServices.NodeServices> =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: process.execPath,
          args: [DOOR_SCRIPT],
          env: { ...process.env, ...input.env },
        },
        cwd: process.cwd(),
        clientInfo: { name: "bench-fm-worker-poll", version: "0.0.0" },
        authMethodId: "none",
        peerSessions: { pollInterval: Duration.millis(input.pollIntervalMs) },
        ...(input.onRequest
          ? {
              requestLogger: (event: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
                Effect.sync(() => input.onRequest?.(event)),
            }
          : {}),
      }),
    ).pipe(Effect.orDie);
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
    return yield* body(runtime);
  });

/**
 * Measurements 1 and 2: what one poll costs at a given worker count, and what
 * the event loop delay is while those polls are running.
 */
const measurePoll = (workers: number) =>
  Effect.gen(function* () {
    const durations: Array<number> = [];
    let startedAt: number | undefined;

    const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: 1 });

    const result = yield* withRuntime(
      {
        env: { DOOR_WORKERS: String(workers) },
        pollIntervalMs: INTERVAL_MS,
        onRequest: (event) => {
          if (event.method !== "session/list") return;
          if (event.status === "started") {
            startedAt = NodePerfHooks.performance.now();
            return;
          }
          if (startedAt !== undefined) {
            durations.push(NodePerfHooks.performance.now() - startedAt);
            startedAt = undefined;
          }
        },
      },
      (runtime) =>
        Effect.gen(function* () {
          // Subscribing is what opens the poll's gate, so it happens before
          // `start` forks the loop.
          const subscription = yield* runtime.subscribePeerSessions;
          yield* runtime.start().pipe(Effect.orDie);

          let rosters = 0;
          const drain = yield* PubSub.take(subscription).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                rosters += 1;
              }),
            ),
            Effect.forever,
            Effect.forkScoped,
          );

          histogram.enable();
          yield* Effect.sleep(Duration.seconds(SECONDS));
          histogram.disable();
          yield* Fiber.interrupt(drain).pipe(Effect.ignore);
          return rosters;
        }),
    ).pipe(Effect.scoped);

    return {
      workers,
      polls: durations.length,
      rosters: result,
      p50: percentile(durations, 0.5),
      p99: percentile(durations, 0.99),
      max: durations.length === 0 ? Number.NaN : Math.max(...durations),
      loopP99: histogram.percentile(99) / 1e6,
      loopMax: histogram.max / 1e6,
    };
  });

/** The control for measurement 2: loop delay with no poll running at all. */
const measureIdleLoop = Effect.gen(function* () {
  const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  yield* Effect.sleep(Duration.seconds(SECONDS));
  histogram.disable();
  return { loopP99: histogram.percentile(99) / 1e6, loopMax: histogram.max / 1e6 };
});

/**
 * Measurement 3: the door accepts `session/load` and never answers it.
 *
 * The two questions are how long the caller waits before it gives up, and
 * whether the poll went on running while it waited.
 */
const measureSilentLoad = Effect.gen(function* () {
  let polls = 0;
  const startedAt = NodePerfHooks.performance.now();

  const outcome = yield* withRuntime(
    {
      env: { DOOR_WORKERS: "1", DOOR_SILENT: "session/load" },
      pollIntervalMs: INTERVAL_MS,
      onRequest: (event) => {
        if (event.method === "session/list" && event.status === "succeeded") polls += 1;
      },
    },
    (runtime) =>
      Effect.gen(function* () {
        const subscription = yield* runtime.subscribePeerSessions;
        yield* runtime.start().pipe(Effect.orDie);
        const roster = yield* PubSub.take(subscription);
        const worker = roster[0];
        if (worker === undefined) return { detail: "no worker listed", elapsed: 0, polls: 0 };

        const loadStartedAt = NodePerfHooks.performance.now();
        const pollsBefore = polls;
        const exit = yield* Effect.exit(runtime.loadPeerSession(worker.sessionId));
        return {
          detail: exit._tag === "Failure" ? "failed" : "unexpectedly succeeded",
          elapsed: NodePerfHooks.performance.now() - loadStartedAt,
          polls: polls - pollsBefore,
        };
      }),
  ).pipe(Effect.scoped);

  return { ...outcome, total: NodePerfHooks.performance.now() - startedAt };
});

/**
 * Measurement 4: the session disappears while its load is still in flight.
 *
 * "Gone" is decided by the door answering `session/list` without it, so the
 * question is whether that answer still lands while the load is stuck.
 */
const measureVanishMidLoad = Effect.gen(function* () {
  let loads = 0;

  return yield* withRuntime(
    {
      env: { DOOR_WORKERS: "1", DOOR_SILENT: "session/load", DOOR_DROP_AFTER: "2" },
      pollIntervalMs: INTERVAL_MS,
      onRequest: (event) => {
        if (event.method === "session/load" && event.status === "started") loads += 1;
      },
    },
    (runtime) =>
      Effect.gen(function* () {
        const subscription = yield* runtime.subscribePeerSessions;
        yield* runtime.start().pipe(Effect.orDie);
        const first = yield* PubSub.take(subscription);
        const worker = first[0];
        if (worker === undefined) {
          return { detail: "no worker listed", elapsed: Number.NaN, loads };
        }

        const loadFiber = yield* Effect.forkScoped(
          Effect.exit(runtime.loadPeerSession(worker.sessionId)),
        );
        const startedAt = NodePerfHooks.performance.now();

        // The next roster is the one the door answered without the worker.
        const gone = yield* waitForEmptyRoster(subscription);
        const elapsed = NodePerfHooks.performance.now() - startedAt;
        yield* Fiber.interrupt(loadFiber).pipe(Effect.ignore);
        return { detail: gone ? "reported gone" : "never reported gone", elapsed, loads };
      }),
  ).pipe(Effect.scoped);
});

const waitForEmptyRoster = (
  subscription: PubSub.Subscription<ReadonlyArray<AcpPeerSession>>,
): Effect.Effect<boolean> =>
  PubSub.take(subscription).pipe(
    Effect.flatMap((roster) =>
      roster.length === 0 ? Effect.succeed(true) : waitForEmptyRoster(subscription),
    ),
    Effect.timeoutOption(Duration.seconds(30)),
    Effect.map((option) => option._tag === "Some"),
  );

const program = Effect.gen(function* () {
  console.log(`node ${process.version} on ${NodeOS.type()} ${NodeOS.release()}`);
  console.log(`poll interval ${String(INTERVAL_MS)} ms, ${String(SECONDS)} s per run\n`);

  const idle = yield* measureIdleLoop;
  console.log("1+2. poll cost and event loop delay");
  console.log(`  control (no poll)          loop p99 ${ms(idle.loopP99)}  max ${ms(idle.loopMax)}`);
  for (const workers of WORKER_COUNTS) {
    const result = yield* measurePoll(workers);
    console.log(
      `  ${String(workers).padStart(4)} workers  ${String(result.polls).padStart(4)} polls` +
        `  p50 ${ms(result.p50)}  p99 ${ms(result.p99)}  max ${ms(result.max)}` +
        `  loop p99 ${ms(result.loopP99)}  max ${ms(result.loopMax)}` +
        `  rosters ${String(result.rosters)}`,
    );
  }

  console.log("\n3. door accepts session/load and never answers");
  const silent = yield* measureSilentLoad;
  console.log(
    `  load ${silent.detail} after ${ms(silent.elapsed)}; ` +
      `${String(silent.polls)} polls completed while it waited`,
  );

  console.log("\n4. session disappears while its load is in flight");
  const vanish = yield* measureVanishMidLoad;
  console.log(
    `  ${vanish.detail} after ${ms(vanish.elapsed)}; ${String(vanish.loads)} session/load sent`,
  );
});

await Effect.runPromise(program.pipe(Effect.provide(NodeServices.layer)));
