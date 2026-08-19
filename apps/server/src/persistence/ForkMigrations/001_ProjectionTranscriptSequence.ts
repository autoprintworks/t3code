import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Event-store sequence columns for the rest of the transcript.
 *
 * This is a fork-authored migration (see `../ForkMigrations.ts` for why it
 * tracks separately from upstream's `effect_sql_migrations`). It first
 * shipped as upstream-numbered migration 038, which collided with upstream's
 * own migration 38 the first time a fork build ran against an untouched
 * upstream database. `ForkMigrations.ts` reconciles installs that already
 * ran it under the old id, so this file's content is otherwise unchanged.
 *
 * Migration 008 gave activities a `sequence` because wall-clock timestamps and
 * insertion order disagree whenever the host clock moves. Messages, proposed
 * plans and turns kept ordering by `created_at`/`requested_at`, so one clock
 * excursion permanently reorders a thread: rows written while the clock ran
 * ahead sort below every row written afterwards.
 *
 * These columns make the event-store sequence the ordering key everywhere a
 * transcript row is read or paginated. Wall-clock values stay as display data.
 *
 * The columns are `NOT NULL DEFAULT 0`. Zero means "this row predates the
 * column and its originating event could not be resolved"; it sorts before
 * every real sequence, which is where such a row belongs. Keeping the column
 * non-null lets every ordering and keyset comparison use the raw column, so
 * the indexes below actually serve them.
 *
 * The backfill resolves each existing row's originating event. It builds a
 * temporary id-to-sequence map in one pass over `orchestration_events` rather
 * than running a correlated `json_extract` scan per row: a real thread has
 * thousands of messages over a hundred thousand events, and the per-row form
 * is quadratic.
 *
 * Turns anchor on their pending user message's sequence, not on the
 * `thread.turn-start-requested` event that follows it. The user message is
 * written first, so anchoring on the later event would push every turn's own
 * opening message onto the previous page.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_sequence
    ON projection_thread_messages(thread_id, sequence)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_sequence_created_id
    ON projection_thread_messages(thread_id, sequence, created_at, message_id)
  `;

  yield* sql`
    ALTER TABLE projection_thread_proposed_plans
    ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_proposed_plans_thread_sequence
    ON projection_thread_proposed_plans(thread_id, sequence)
  `;

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0
  `;

  // Serves the windowed thread-detail keyset (thread_id, sequence, turn_id),
  // the sequence-ordered replacement for migration 037's requested_at index.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turns_thread_sequence_keyset
    ON projection_turns(thread_id, sequence, turn_id)
  `;

  // ── Backfill: messages ────────────────────────────────────────────────
  // A streaming message emits many `thread.message-sent` events; the first one
  // is where the message belongs, matching how the projector pins `created_at`
  // to the first event.
  yield* sql`
    CREATE TEMP TABLE tmp_message_sequences (
      message_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO tmp_message_sequences (message_id, sequence)
    SELECT
      json_extract(payload_json, '$.messageId'),
      MIN(sequence)
    FROM orchestration_events
    WHERE event_type = 'thread.message-sent'
      AND json_extract(payload_json, '$.messageId') IS NOT NULL
    GROUP BY json_extract(payload_json, '$.messageId')
  `;

  yield* sql`
    UPDATE projection_thread_messages
    SET sequence = (
      SELECT tmp_message_sequences.sequence
      FROM tmp_message_sequences
      WHERE tmp_message_sequences.message_id = projection_thread_messages.message_id
    )
    WHERE sequence = 0
      AND EXISTS (
        SELECT 1
        FROM tmp_message_sequences
        WHERE tmp_message_sequences.message_id = projection_thread_messages.message_id
      )
  `;

  // ── Backfill: proposed plans ──────────────────────────────────────────
  // Plan ids are provider-supplied, so they are keyed per thread rather than
  // globally.
  yield* sql`
    CREATE TEMP TABLE tmp_proposed_plan_sequences (
      thread_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (thread_id, plan_id)
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO tmp_proposed_plan_sequences (thread_id, plan_id, sequence)
    SELECT
      stream_id,
      json_extract(payload_json, '$.proposedPlan.id'),
      MIN(sequence)
    FROM orchestration_events
    WHERE event_type = 'thread.proposed-plan-upserted'
      AND json_extract(payload_json, '$.proposedPlan.id') IS NOT NULL
    GROUP BY stream_id, json_extract(payload_json, '$.proposedPlan.id')
  `;

  yield* sql`
    UPDATE projection_thread_proposed_plans
    SET sequence = (
      SELECT tmp_proposed_plan_sequences.sequence
      FROM tmp_proposed_plan_sequences
      WHERE tmp_proposed_plan_sequences.thread_id = projection_thread_proposed_plans.thread_id
        AND tmp_proposed_plan_sequences.plan_id = projection_thread_proposed_plans.plan_id
    )
    WHERE sequence = 0
      AND EXISTS (
        SELECT 1
        FROM tmp_proposed_plan_sequences
        WHERE tmp_proposed_plan_sequences.thread_id = projection_thread_proposed_plans.thread_id
          AND tmp_proposed_plan_sequences.plan_id = projection_thread_proposed_plans.plan_id
      )
  `;

  // ── Backfill: turns ───────────────────────────────────────────────────
  // Preference order: the turn's pending user message, then the earliest
  // message bound to the turn, then the earliest activity bound to the turn.
  // A turn with none of those has nothing on the page to anchor anyway.
  yield* sql`
    UPDATE projection_turns
    SET sequence = COALESCE(
      (
        SELECT NULLIF(pending.sequence, 0)
        FROM projection_thread_messages AS pending
        WHERE pending.message_id = projection_turns.pending_message_id
      ),
      (
        SELECT MIN(NULLIF(bound.sequence, 0))
        FROM projection_thread_messages AS bound
        WHERE bound.thread_id = projection_turns.thread_id
          AND bound.turn_id IS NOT NULL
          AND bound.turn_id = projection_turns.turn_id
      ),
      (
        SELECT MIN(activity.sequence)
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = projection_turns.thread_id
          AND activity.turn_id IS NOT NULL
          AND activity.turn_id = projection_turns.turn_id
      ),
      0
    )
    WHERE sequence = 0
  `;

  yield* sql`DROP TABLE tmp_message_sequences`;
  yield* sql`DROP TABLE tmp_proposed_plan_sequences`;
});
