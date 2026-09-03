/**
 * A read-only thread is a window onto work driven somewhere else - a peer
 * session on a configured ACP agent's connection, for instance - and the
 * client shows it with no composer.
 *
 * Stored as an integer because SQLite has no boolean type. The column is
 * `NOT NULL DEFAULT 0`, so SQLite fills every existing row with `0` as part of
 * the `ALTER TABLE` and no backfill statement is needed: every thread that
 * existed before this migration reads back as "not read-only".
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "read_only")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0
    `;
  }
});
