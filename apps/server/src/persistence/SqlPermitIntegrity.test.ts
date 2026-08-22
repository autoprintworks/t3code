// @effect-diagnostics globalTimers:off - the pause has to hold the permit on
// the real clock, so a test clock would defeat it.
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as SqliteClient from "./NodeSqliteClient.ts";
import {
  SqlPermitOverBudgetError,
  assertSqlPermitIntegrity,
  formatSqlPermitReport,
  watchSqlPermits,
} from "./SqlPermitIntegrity.ts";

const layer = it.layer(SqliteClient.layerMemory());

/**
 * A transaction body that yields. This is what the budget exists to catch: the
 * permit is exclusive, so the pause is time no other transaction can run.
 */
const PAUSE_MS = 120;

layer("SqlPermitIntegrity", (it) => {
  it.effect("records hold time, sql time, and statement count for a transaction", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS holds(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;

      const watch = watchSqlPermits({ budgetMs: 50 });
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO holds(name) VALUES (${"alpha"})`;
            yield* sql`SELECT COUNT(*) AS total FROM holds`;
          }),
        )
        .pipe(Effect.ensuring(Effect.sync(() => watch.stop())));
      const report = watch.stop();

      assert.equal(report.holdCount, 1);
      // BEGIN, INSERT, SELECT and COMMIT all run on the held connection.
      assert.isAtLeast(report.statements, 4);
      assert.isAbove(report.totalSqlMs, 0);
      assert.isBelow(report.worstHoldMs, 50);
      assert.equal(report.holdsOverBudget, 0);
      assert.include(formatSqlPermitReport(report), "permit holds");
    }),
  );

  it.effect("fails with a stack when a transaction body pauses while holding the permit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS holds(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;

      const watch = watchSqlPermits({ budgetMs: 50 });
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT COUNT(*) AS total FROM holds`;
            yield* Effect.promise(
              () => new Promise<void>((resolve) => setTimeout(resolve, PAUSE_MS)),
            );
          }),
        )
        .pipe(
          Effect.withSpan("paused transaction body"),
          Effect.ensuring(Effect.sync(() => watch.stop())),
        );
      const report = watch.stop();

      assert.equal(report.holdCount, 1);
      assert.isAbove(report.worstHoldMs, PAUSE_MS - 20);
      assert.equal(report.holdsOverBudget, 1);

      const hold = report.holds[0]!;
      // The whole cost is idle time: the database was asked for almost nothing.
      assert.isBelow(hold.sqlMs, 20);

      let thrown: unknown;
      try {
        assertSqlPermitIntegrity(report, { label: "transaction body" });
      } catch (error) {
        thrown = error;
      }

      assert.instanceOf(thrown, SqlPermitOverBudgetError);
      const stack = (thrown as SqlPermitOverBudgetError).stack ?? "";
      assert.include(stack, "SqlPermitOverBudgetError: transaction body: transaction held");
      // The Effect span chain names the caller; the JS stack cannot, because
      // the permit is taken inside the fiber loop.
      assert.include(stack, "at paused transaction body");
      assert.deepEqual(hold.origin, ["paused transaction body"]);
    }),
  );

  it.effect("costs nothing once the observer is detached", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE IF NOT EXISTS holds(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;

      const watch = watchSqlPermits();
      const first = watch.stop();
      yield* sql.withTransaction(sql`SELECT COUNT(*) AS total FROM holds`);
      const second = watch.report();

      assert.equal(first.holdCount, 0);
      assert.equal(second.holdCount, 0);
    }),
  );
});
