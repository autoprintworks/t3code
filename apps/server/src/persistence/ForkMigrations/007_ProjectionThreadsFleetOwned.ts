/**
 * A fleet-owned thread is one the First Mate daemon created for itself. It is
 * read-only, so the user watches rather than steers, and the daemon may still
 * start turns on it. `read_only` alone cannot say that: an ACP worker mirror
 * is read-only too, and nothing may prompt one.
 *
 * Stored as an integer because SQLite has no boolean type, and mirroring
 * `read_only` from fork migration 5. The column is `NOT NULL DEFAULT 0`, so
 * SQLite fills every existing row with `0` as part of the `ALTER TABLE` and
 * no backfill statement is needed: every thread that existed before this
 * migration reads back as "not the fleet's", which is what every one of them
 * is.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "fleet_owned")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fleet_owned INTEGER NOT NULL DEFAULT 0
    `;
  }
});
