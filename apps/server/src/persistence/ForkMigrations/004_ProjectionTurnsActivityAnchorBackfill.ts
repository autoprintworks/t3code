import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Re-anchor turns that fork migration 001 could only leave at sentinel 0.
 *
 * `ForkMigrations/001` backfills `projection_turns.sequence` from, in
 * preference order, the turn's pending user message, the earliest message
 * bound to the turn, then the earliest activity bound to the turn. The first
 * two branches work: 001 backfills `projection_thread_messages.sequence`
 * earlier in its own body, so the values are there by the time the turn
 * backfill reads them.
 *
 * The activity branch cannot work. It reads
 * `projection_thread_activities.sequence`, which is still NULL for every row
 * at that point — upstream migration 008 added the column nullable and the
 * projector never populated it, which is the whole reason
 * `ForkMigrations/002` exists. 002 backfills that column, but it runs *after*
 * 001, and 001 does not run again. So `MIN(activity.sequence)` is `NULL` for
 * every turn, the COALESCE falls through to 0, and a turn whose only anchor
 * is an activity is stranded there.
 *
 * Sentinel 0 sorts before every real sequence, so a stranded turn jumps to
 * the top of its thread instead of sitting where it happened. The turns that
 * hit this are the ones with no user message of their own — a turn resumed or
 * continued without fresh user input — which is exactly the case the activity
 * branch was written to cover.
 *
 * This migration re-runs only that branch, now that 002 has populated the
 * column it depends on. It is the narrow fix: 001 and 002 already shipped and
 * cannot be edited or reordered, and every other branch of 001's backfill
 * produced correct values.
 *
 * Idempotent: it only touches rows still at 0, and only sets a value when a
 * real anchor (`sequence > 0`) exists, so a second run matches nothing. A
 * turn with no bound activity keeps sentinel 0 — there is nothing on the page
 * to anchor it to, the same conclusion 001 reached.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_turns
    SET sequence = (
      SELECT MIN(activity.sequence)
      FROM projection_thread_activities AS activity
      WHERE activity.thread_id = projection_turns.thread_id
        AND activity.turn_id IS NOT NULL
        AND activity.turn_id = projection_turns.turn_id
        AND activity.sequence > 0
    )
    WHERE sequence = 0
      AND EXISTS (
        SELECT 1
        FROM projection_thread_activities AS activity
        WHERE activity.thread_id = projection_turns.thread_id
          AND activity.turn_id IS NOT NULL
          AND activity.turn_id = projection_turns.turn_id
          AND activity.sequence > 0
      )
  `;
});
