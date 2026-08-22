/**
 * Runs the loop integrity guard inside the server.
 *
 * `LoopIntegrity.ts` and `SqlPermitIntegrity.ts` are the measurement; this is
 * the wiring. A test asserts and fails. A running server cannot fail a request
 * because something else blocked the loop, so here the same two signals are
 * logged loudly instead, at error level, with whatever names the call site.
 *
 * Three modes, chosen by `T3CODE_LOOP_INTEGRITY`:
 *
 * - `off` - nothing runs. No timer, no async hook, no permit observer, no
 *   allocation. The only residue in the request path is one already-present
 *   `undefined` check per transaction and per statement.
 * - `sample` - a 20 ms unreferenced timer and a permit observer that records
 *   numbers only. No stacks, so a block is reported by size and a permit hold
 *   by its idle time, without naming a line.
 * - `attribute` - `sample` plus stack capture: an `async_hooks` init hook and a
 *   stack per transaction. This is the mode that names the offending call site,
 *   and it is the expensive one.
 *
 * With no environment variable set, the mode is `sample` when the server is
 * running against the Vite dev server or under `NODE_ENV` of `development` or
 * `test`, and `off` otherwise. Production is therefore off unless a developer
 * asks for it, and asking for it is one environment variable.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  DEFAULT_FAIL_OVER_MS,
  formatLoopBlock,
  watchLoopIntegrity,
  type LoopBlock,
} from "./LoopIntegrity.ts";
import {
  DEFAULT_SQL_PERMIT_BUDGET_MS,
  formatSqlPermitHold,
  watchSqlPermits,
} from "../persistence/SqlPermitIntegrity.ts";
import type { SqlPermitHold } from "../persistence/NodeSqliteClient.ts";

export type LoopIntegrityMode = "off" | "sample" | "attribute";

const MODES = new Set<string>(["off", "sample", "attribute"]);

/**
 * Long enough that the sampler is background noise, short enough to resolve a
 * block worth complaining about. A 50 ms block is caught within one tick.
 */
const SERVER_SAMPLE_INTERVAL_MS = 20;

/** Report at most this often, so a stuck server does not drown its own log. */
const REPORT_INTERVAL_MS = 5_000;

const isMode = (value: string): value is LoopIntegrityMode => MODES.has(value);

/**
 * Resolve the mode. An explicit `T3CODE_LOOP_INTEGRITY` always wins, including
 * an explicit `off` in development.
 */
export const resolveMode = (env: NodeJS.ProcessEnv): LoopIntegrityMode => {
  const requested = env.T3CODE_LOOP_INTEGRITY?.trim().toLowerCase();
  if (requested !== undefined && isMode(requested)) {
    return requested;
  }
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const isDevelopment =
    (env.VITE_DEV_SERVER_URL?.trim() ?? "").length > 0 ||
    nodeEnv === "development" ||
    nodeEnv === "test";
  return isDevelopment ? "sample" : "off";
};

const describeBlock = (block: LoopBlock, withStacks: boolean): string =>
  withStacks
    ? formatLoopBlock(block, "event loop")
    : `event loop blocked for ${Math.round(block.durationMs)} ms`;

const describeHold = (hold: SqlPermitHold, withStacks: boolean): string => {
  const summary = `sql permit ${formatSqlPermitHold(hold)}`;
  if (!withStacks || hold.origin.length === 0) {
    return summary;
  }
  return `${summary}\n${hold.origin.map((name) => `    at ${name}`).join("\n")}`;
};

/**
 * Start the guard for the lifetime of the layer's scope. Off by default outside
 * development; see the module comment for what each mode costs.
 */
export const layer: Layer.Layer<never> = Layer.effectDiscard(
  Effect.gen(function* () {
    const mode = resolveMode(process.env);
    if (mode === "off") {
      return;
    }

    const withStacks = mode === "attribute";
    let lastReportedAt = 0;
    const shouldReport = (nowMs: number): boolean => {
      if (nowMs - lastReportedAt < REPORT_INTERVAL_MS) {
        return false;
      }
      lastReportedAt = nowMs;
      return true;
    };

    const loop = watchLoopIntegrity({
      sampleIntervalMs: SERVER_SAMPLE_INTERVAL_MS,
      attributeStacks: withStacks,
      onBlock: (block) => {
        if (block.durationMs <= DEFAULT_FAIL_OVER_MS || !shouldReport(performance.now())) {
          return;
        }
        // Written directly rather than through the Effect logger: this runs in
        // a timer callback with no fiber, and the point is that it is loud.
        process.stderr.write(`[loop-integrity] ${describeBlock(block, withStacks)}\n`);
      },
    });

    const permits = watchSqlPermits({
      budgetMs: DEFAULT_SQL_PERMIT_BUDGET_MS,
      captureStacks: withStacks,
      onHold: (hold) => {
        if (hold.holdMs <= DEFAULT_SQL_PERMIT_BUDGET_MS || !shouldReport(performance.now())) {
          return;
        }
        process.stderr.write(`[loop-integrity] ${describeHold(hold, withStacks)}\n`);
      },
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        loop.stop();
        permits.stop();
      }),
    );

    yield* Effect.logInfo(`Loop integrity guard running in ${mode} mode.`);
  }),
);
