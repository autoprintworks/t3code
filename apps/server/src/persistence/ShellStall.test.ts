/**
 * Loop integrity of the shell read, measured against a real database.
 *
 * This is the guard's own proof. `/api/orchestration/shell` is the request that
 * froze the server, so this test runs the real `getShellSnapshot()` over a copy
 * of a real database and fails when the event loop stops responding or the SQL
 * permit is held past its budget.
 *
 * Two budgets, both the user's symptom stated as numbers: one shell read under
 * 250 ms, and no single event loop block over 50 ms.
 *
 * Two modes, one file:
 *
 * - Default (warm): the first read primes the request path's caches and is not
 *   measured. The reads after it must stay fast and must not own the loop.
 * - `T3_LOOP_INTEGRITY_COLD=1` (cold): nothing is primed, so the first read
 *   pays the cold-start cost. Before #72 that cost was `git rev-parse` spawned
 *   once per project on the loop thread, and this mode was how the guard named
 *   it. Keep the mode: it is the cheapest way to re-run that measurement when
 *   a cold path regresses.
 *
 * Both modes need a database copy at `<worktree>/.t3/userdata/state.sqlite`,
 * which is not in the repository. Seed the copy once, and never point this at
 * live state:
 *
 * ```
 * node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'/.t3/userdata/state.sqlite',{readOnly:true});db.exec(\"VACUUM INTO '<worktree>/.t3/userdata/state.sqlite'\");db.close()"
 * ```
 *
 * Skips when that copy is absent, so it is inert in CI while a developer with
 * real data still gets the signal.
 */
// @effect-diagnostics nodeBuiltinImport:off - the test skips itself when the
// database copy is missing, which has to be decided before any layer is built.
// @effect-diagnostics globalTimers:off - waiting for the loop to go quiet is a
// wall-clock wait, not a scheduled effect.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  assertLoopIntegrity,
  formatLoopIntegrityReport,
  watchLoopIntegrity,
} from "../diagnostics/LoopIntegrity.ts";
import {
  DEFAULT_SQL_PERMIT_BUDGET_MS,
  assertSqlPermitIntegrity,
  formatSqlPermitReport,
  watchSqlPermits,
} from "./SqlPermitIntegrity.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/** Resolved from this file, not the working directory, so the runner's cwd cannot move it. */
const DATABASE_PATH = NodeURL.fileURLToPath(
  new URL("../../../../.t3/userdata/state.sqlite", import.meta.url),
);

/** One shell read must stay inside a human's idea of instant. */
const SHELL_READ_BUDGET_MS = 250;

/** One block this long drops fifteen frames and misses a websocket heartbeat. */
const LOOP_BLOCK_BUDGET_MS = 50;

const MEASURED_READS = 3;

/** One quiet window this long means the priming read's tail has finished. */
const SETTLE_WINDOW_MS = 250;

/** Give up waiting for quiet after this long and measure anyway. */
const SETTLE_TIMEOUT_MS = 30_000;

const COLD = process.env.T3_LOOP_INTEGRITY_COLD === "1";

const roundMs = (value: number): number => Math.round(value * 10) / 10;

/**
 * Wait for the loop to go quiet.
 *
 * A read can leave child processes running, and their exit callbacks land on
 * the loop thread after the read has already returned. Measuring through that
 * tail measures cold start a second time, which is what made this test flaky
 * before.
 */
const settleLoop = Effect.promise(async () => {
  const deadline = performance.now() + SETTLE_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const watch = watchLoopIntegrity({ sampleIntervalMs: 2 });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WINDOW_MS));
    if (watch.stop().blocksOverFrameBudget === 0) {
      return;
    }
  }
});

// Migrations run against the copy, so a snapshot taken before a schema change
// still works. `RepositoryIdentityResolver` is deliberately absent: since #72
// the shell read serves repository identity from a column and spawns nothing.
const shellSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(makeSqlitePersistenceLive(DATABASE_PATH)),
  Layer.provideMerge(NodeServices.layer),
);

const describeIfDatabase = NodeFS.existsSync(DATABASE_PATH)
  ? it.layer(shellSnapshotLayer)
  : undefined;

if (describeIfDatabase === undefined) {
  it.skip(`shell snapshot loop integrity (no database copy at ${DATABASE_PATH})`, () => {});
} else {
  describeIfDatabase("shell snapshot loop integrity", (it) => {
    it.effect(
      `a ${COLD ? "cold" : "warm"} shell read is fast and never owns the event loop`,
      () =>
        Effect.gen(function* () {
          const snapshotQuery = yield* ProjectionSnapshotQuery;

          if (!COLD) {
            // Prime the request path's caches. Cold-start cost is measured by
            // the opt-in cold mode, not here.
            yield* snapshotQuery.getShellSnapshot();
            yield* settleLoop;
          }

          let worstReadMs = 0;
          const reads = COLD ? 1 : MEASURED_READS;

          for (let run = 1; run <= reads; run += 1) {
            const loop = watchLoopIntegrity({ sampleIntervalMs: 2, attributeStacks: true });
            const permits = watchSqlPermits({ budgetMs: DEFAULT_SQL_PERMIT_BUDGET_MS });
            const startedAt = performance.now();
            const snapshot = yield* snapshotQuery.getShellSnapshot();
            const totalMs = performance.now() - startedAt;
            const permitReport = permits.stop();
            const loopReport = loop.stop();

            worstReadMs = Math.max(worstReadMs, totalMs);
            // Printed for every run, pass or fail: these are the numbers the
            // permit budget was chosen from. Written straight to stderr because
            // the test reporter swallows console output from a passing test.
            process.stderr.write(
              `  run ${run}: total ${roundMs(totalMs)} ms | ` +
                `in transaction ${roundMs(permitReport.totalHoldMs)} ms | ` +
                `sql ${roundMs(permitReport.totalSqlMs)} ms (${permitReport.statements} statements) | ` +
                `after transaction ${roundMs(totalMs - permitReport.totalHoldMs)} ms | ` +
                `projects ${snapshot.projects.length}, threads ${snapshot.threads.length}\n` +
                `          ${formatSqlPermitReport(permitReport)}\n` +
                `          ${formatLoopIntegrityReport(loopReport)}
`,
            );

            assertLoopIntegrity(loopReport, {
              failOverMs: LOOP_BLOCK_BUDGET_MS,
              label: `shell read run ${run}`,
            });
            assertSqlPermitIntegrity(permitReport, { label: `shell read run ${run}` });
          }

          if (worstReadMs > SHELL_READ_BUDGET_MS) {
            assert.fail(
              roundMs(worstReadMs),
              SHELL_READ_BUDGET_MS,
              `one shell read took ${roundMs(worstReadMs)} ms`,
            );
          }
        }),
      { timeout: 180_000 },
    );
  });
}
