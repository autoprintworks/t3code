/**
 * Undo the fork's transcript ordering column and restore upstream's schema.
 *
 * Fork migrations 001, 002 and 004 made an event-store `sequence` the ordering
 * key for messages, proposed plans, turns and activities, because wall-clock
 * timestamps disagree with insertion order whenever the host clock moves. That
 * ordering column was the fork's largest read-model delta, and the migration
 * that introduced it first shipped under an upstream-owned migration id, so a
 * database an upstream build had already migrated could not take it. The fork
 * now orders the timeline by creation time, as upstream does, and accepts the
 * clock-jump caveat.
 *
 * Three things have to come back to upstream's shape:
 *
 * 1. `projection_thread_messages`, `projection_thread_proposed_plans` and
 *    `projection_turns` lose the `sequence` column fork migration 001 added,
 *    together with the indexes that served it. Upstream never had either.
 * 2. `projection_thread_activities.sequence` is upstream's own column
 *    (migration 008) and stays, but fork migration 002 rebuilt it as
 *    `NOT NULL DEFAULT 0` and backfilled every row. Upstream leaves it nullable
 *    and never writes it, and its read sorts NULLs first. Leaving the backfill
 *    in place would sort every new activity, written with no sequence, above
 *    the whole existing history. Dropping and re-adding the column restores
 *    upstream's declaration and clears the values in one step.
 * 3. The legacy `effect_sql_migrations` row for id 38 goes. Effect's `Migrator`
 *    tracks progress by the single highest id ever recorded, so a database that
 *    ran the fork's first ordering migration under that id would silently skip
 *    upstream's own migration 38 forever.
 *
 * Every step is guarded or `IF EXISTS`, so this is a no-op on a fresh database
 * and on a database only an upstream build has migrated.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** The upstream-numbered id and name the fork's first ordering migration ran under. */
const LEGACY_MIGRATION_ID = 38;
const LEGACY_MIGRATION_NAME = "ProjectionTranscriptSequence";

type ColumnInfo = { readonly name: string; readonly notnull: number };

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite refuses to drop an indexed column, so the fork's indexes go first.
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_messages_thread_sequence`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_messages_thread_sequence_created_id`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_thread_proposed_plans_thread_sequence`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_turns_thread_sequence_keyset`;

  const messageColumns = yield* sql<ColumnInfo>`PRAGMA table_info(projection_thread_messages)`;
  if (messageColumns.some((column) => column.name === "sequence")) {
    yield* sql`ALTER TABLE projection_thread_messages DROP COLUMN sequence`;
  }

  const planColumns = yield* sql<ColumnInfo>`PRAGMA table_info(projection_thread_proposed_plans)`;
  if (planColumns.some((column) => column.name === "sequence")) {
    yield* sql`ALTER TABLE projection_thread_proposed_plans DROP COLUMN sequence`;
  }

  const turnColumns = yield* sql<ColumnInfo>`PRAGMA table_info(projection_turns)`;
  if (turnColumns.some((column) => column.name === "sequence")) {
    yield* sql`ALTER TABLE projection_turns DROP COLUMN sequence`;
  }

  // Only a database fork migration 002 rebuilt has this column NOT NULL; on
  // every other database it is already upstream's nullable, never-written one.
  const activityColumns = yield* sql<ColumnInfo>`PRAGMA table_info(projection_thread_activities)`;
  const activitySequence = activityColumns.find((column) => column.name === "sequence");
  if (activitySequence !== undefined && activitySequence.notnull !== 0) {
    yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_sequence`;
    yield* sql`DROP INDEX IF EXISTS idx_projection_thread_activities_thread_sequence_created_id`;
    yield* sql`ALTER TABLE projection_thread_activities DROP COLUMN sequence`;
    yield* sql`ALTER TABLE projection_thread_activities ADD COLUMN sequence INTEGER`;
    // Recreated verbatim from upstream migrations 008 and 029.
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence
      ON projection_thread_activities(thread_id, sequence)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence_created_id
      ON projection_thread_activities(thread_id, sequence, created_at, activity_id)
    `;
  }

  yield* sql`
    DELETE FROM effect_sql_migrations
    WHERE migration_id = ${LEGACY_MIGRATION_ID} AND name = ${LEGACY_MIGRATION_NAME}
  `;
});
