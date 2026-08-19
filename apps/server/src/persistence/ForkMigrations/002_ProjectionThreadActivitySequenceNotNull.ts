import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * `projection_thread_activities.sequence` (migration 008) has been NULL for
 * every row since it was added. The projector populated it from
 * `activity.sequence`, a domain field no caller ever sets, instead of the
 * event envelope's own `sequence` — the field messages, proposed plans and
 * turns all order by (see `ProjectionPipeline.ts`, `thread.activity-appended`
 * handling). That projector bug is fixed alongside this migration; this file
 * repairs the data it already wrote and closes off the column so it cannot
 * silently go NULL again.
 *
 * SQLite has no `ALTER COLUMN`, so making the column NOT NULL means
 * rebuilding the table. The backfill uses the same single-pass shape as
 * migration 038 (now `ForkMigrations/001`): one scan of `orchestration_events`
 * into a temp table keyed by activity id — the table's own primary key, and
 * globally unique — then a join per row during the rebuild's INSERT ... SELECT
 * rather than a correlated subquery per row. `activity_id` uniqueness makes
 * this a simple 1:1 lookup, unlike the thread-scoped plan backfill in 001.
 *
 * Cost on the reference database (116,544 activity rows): one full scan of
 * `orchestration_events` filtered by `event_type`, one full scan of
 * `projection_thread_activities` to populate the rebuilt table, then the
 * table swap. All within the migration's transaction, so a crash mid-way
 * rolls back rather than leaving the column half NOT-NULL.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TEMP TABLE tmp_activity_sequences (
      activity_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO tmp_activity_sequences (activity_id, sequence)
    SELECT
      json_extract(payload_json, '$.activity.id'),
      MIN(sequence)
    FROM orchestration_events
    WHERE event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.id') IS NOT NULL
    GROUP BY json_extract(payload_json, '$.activity.id')
  `;

  yield* sql`
    CREATE TABLE projection_thread_activities__rebuild (
      activity_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      tone TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;

  // COALESCE order: keep an already-populated value (defensive — none exist
  // today), else the event store's sequence for that activity, else 0 (same
  // "predates the column" convention migration 038 uses for messages/plans/
  // turns).
  yield* sql`
    INSERT INTO projection_thread_activities__rebuild (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
    )
    SELECT
      activities.activity_id,
      activities.thread_id,
      activities.turn_id,
      activities.tone,
      activities.kind,
      activities.summary,
      activities.payload_json,
      COALESCE(
        activities.sequence,
        (
          SELECT tmp.sequence
          FROM tmp_activity_sequences AS tmp
          WHERE tmp.activity_id = activities.activity_id
        ),
        0
      ),
      activities.created_at
    FROM projection_thread_activities AS activities
  `;

  yield* sql`DROP TABLE projection_thread_activities`;
  yield* sql`ALTER TABLE projection_thread_activities__rebuild RENAME TO projection_thread_activities`;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_created
    ON projection_thread_activities(thread_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence
    ON projection_thread_activities(thread_id, sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_activities_thread_sequence_created_id
    ON projection_thread_activities(thread_id, sequence, created_at, activity_id)
  `;

  yield* sql`DROP TABLE tmp_activity_sequences`;
});
