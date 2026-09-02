/**
 * A read-only thread is a window onto work driven somewhere else - a First
 * Mate worker, for instance - and the client shows it with no composer.
 *
 * Stored as an integer because SQLite has no boolean type. Existing rows read
 * back as NULL, which the row schema decodes as "not read-only", so no
 * backfill is needed.
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
