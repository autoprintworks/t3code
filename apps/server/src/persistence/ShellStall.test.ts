// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalConsoleInEffect:off
// This is an event loop instrument. It must sample with a raw timer and print
// its measurements, and it reads the seeded database copy synchronously to
// decide whether to skip.
/**
 * ShellStall - the shell read must not own the event loop.
 *
 * Runs the real `ProjectionSnapshotQuery` over a copy of a real database and
 * samples event loop lag with a 1 ms timer while `getShellSnapshot()` runs.
 * Two budgets, both the user's symptom stated as numbers: one shell read under
 * 250 ms, and no single event loop block over 50 ms.
 *
 * Seed the copy once (never point this at live state):
 *
 * ```
 * node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.t3/userdata/state.sqlite',{readOnly:true});db.exec(\"VACUUM INTO '<worktree>/.t3/userdata/state.sqlite'\");db.close()"
 * ```
 *
 * Skips when that copy is absent, so it is inert in CI.
 */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";

const DATABASE_PATH = NodeURL.fileURLToPath(
  new URL("../../../../.t3/userdata/state.sqlite", import.meta.url),
);

/** One shell read must finish inside this. */
const READ_BUDGET_MS = 250;
/** No single event loop block may exceed this. */
const BLOCK_BUDGET_MS = 50;
const RUNS = 3;

interface LoopSample {
  readonly blockedMs: number;
  readonly worstBlockMs: number;
  readonly blocksOver16Ms: number;
  readonly longestBlocks: ReadonlyArray<number>;
}

/**
 * Samples event loop lag on a 1 ms timer. Any gap beyond the 1 ms it asked for
 * is time the loop spent unable to run a callback — i.e. blocked.
 */
function startLoopSampler(): () => LoopSample {
  const blocks: Array<number> = [];
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - previous - 1;
    previous = now;
    if (lag > 1) blocks.push(lag);
  }, 1);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    const sorted = [...blocks].sort((left, right) => right - left);
    return {
      blockedMs: blocks.reduce((total, block) => total + block, 0),
      worstBlockMs: sorted[0] ?? 0,
      blocksOver16Ms: blocks.filter((block) => block > 16).length,
      longestBlocks: sorted.slice(0, 8),
    };
  };
}

const round = (value: number) => Math.round(value);

const snapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(makeSqlitePersistenceLive(DATABASE_PATH)),
  Layer.provideMerge(NodeServices.layer),
);

describe.skipIf(!NodeFS.existsSync(DATABASE_PATH))("shell snapshot stall", () => {
  it("one shell read is fast and never owns the event loop", async () => {
    const program = Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const results: Array<{ readonly totalMs: number; readonly loop: LoopSample }> = [];
      for (let run = 0; run < RUNS; run += 1) {
        const stopSampler = startLoopSampler();
        const startedAt = performance.now();
        const snapshot = yield* snapshotQuery.getShellSnapshot();
        const totalMs = performance.now() - startedAt;
        const loop = stopSampler();
        results.push({ totalMs, loop });

        console.log(
          `  run ${run + 1}: total ${round(totalMs).toString().padStart(6)} ms | ` +
            `loop blocked ${round(loop.blockedMs).toString().padStart(6)} ms, ` +
            `worst single block ${round(loop.worstBlockMs)} ms, ` +
            `blocks over 16 ms: ${loop.blocksOver16Ms}
` +
            `          projects ${snapshot.projects.length}, threads ${snapshot.threads.length}, ` +
            `longest blocks ms: ${loop.longestBlocks.map(round).join(", ")}`,
        );
      }

      return results;
    }).pipe(Effect.provide(snapshotQueryLayer), Effect.scoped);

    // This instrument measures wall time around one read, so it needs a plain
    // runtime rather than the vitest test runtime's fibers.
    // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
    const results = await Effect.runPromise(program);

    const slowest = results.reduce((worst, entry) =>
      entry.totalMs > worst.totalMs ? entry : worst,
    );
    const worstBlockMs = results.reduce(
      (worst, entry) => Math.max(worst, entry.loop.worstBlockMs),
      0,
    );

    expect(
      round(slowest.totalMs),
      `one shell read took ${round(slowest.totalMs)} ms`,
    ).toBeLessThanOrEqual(READ_BUDGET_MS);
    expect(
      round(worstBlockMs),
      `worst single event loop block was ${round(worstBlockMs)} ms`,
    ).toBeLessThanOrEqual(BLOCK_BUDGET_MS);
  }, 120_000);
});
