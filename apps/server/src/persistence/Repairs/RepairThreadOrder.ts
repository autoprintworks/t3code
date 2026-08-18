/**
 * One-off repair for threads whose row order was corrupted by a host clock
 * change. See `docs/internals/thread-order-repair.md` for the diagnosis this
 * repair heals and for why it does not, by itself, prevent recurrence.
 *
 * The transcript's true insertion order is the event store's `sequence`
 * column (`orchestration_events.sequence`, monotonic autoincrement,
 * unaffected by wall-clock changes). Messages have no sequence column of
 * their own, so their ground truth is derived by joining back to the
 * `thread.message-sent` event that created them. Activities already carry a
 * `sequence` column (migration 008); this repair falls back to the same
 * event-store join for any legacy activity row where that column is null.
 *
 * For every thread, this repair finds the longest run of rows whose
 * `created_at` values are already non-decreasing in sequence order and that
 * ends at the thread's most recent row (the "anchors") — anchoring on the
 * most recent row, rather than on whichever non-decreasing run happens to
 * be longest anywhere, matters because a clock excursion can itself produce
 * more rows than the thread has had time to recover since; the most recent
 * row is always trustworthy, since nothing later in sequence order
 * contradicts it. Every other row's `created_at` is rewritten to fit
 * between its nearest anchors, so timestamp order matches sequence order
 * again.
 *
 * Reversible: the pre-repair `created_at` is preserved in a
 * `created_at_original` sidecar column, added lazily by this repair the
 * first time it runs against a database.
 *
 * Idempotent: once a thread's rows are non-decreasing in sequence order, a
 * later run finds nothing to rewrite for it.
 *
 * This module does not run automatically — see `repairThreadOrderCli.ts`
 * for how the captain runs it against a real database.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface RepairThreadOrderOptions {
  /** Dry-run reports what would change without writing. Defaults to true at the CLI layer. */
  readonly dryRun: boolean;
}

export interface RepairThreadOrderThreadReport {
  readonly threadId: string;
  readonly messagesExamined: number;
  readonly messagesRewritten: number;
  readonly activitiesExamined: number;
  readonly activitiesRewritten: number;
}

export interface RepairThreadOrderReport {
  readonly dryRun: boolean;
  readonly totalMessagesExamined: number;
  readonly totalActivitiesExamined: number;
  readonly totalMessagesRewritten: number;
  readonly totalActivitiesRewritten: number;
  /** Rows with no matching `orchestration_events` row at all; left untouched. */
  readonly messagesSkippedNoGroundTruth: number;
  readonly activitiesSkippedNoGroundTruth: number;
  /** Only threads with at least one rewritten row, worst-affected first. */
  readonly threads: ReadonlyArray<RepairThreadOrderThreadReport>;
}

interface Candidate {
  readonly rowId: string;
  readonly threadId: string;
  readonly groundSequence: number;
  readonly createdAt: string;
}

interface PlannedRewrite {
  readonly rowId: string;
  readonly threadId: string;
  readonly previousCreatedAt: string;
  readonly nextCreatedAt: string;
}

/**
 * Reads `arr[index]`, asserting it is in bounds. Every call site here holds
 * that invariant by construction (loop bounds, non-empty checks); this
 * turns a silent `undefined` into a loud failure instead of NaN dates or
 * bad comparisons if that invariant is ever broken by a future edit.
 */
function at<T>(arr: ReadonlyArray<T>, index: number): T {
  const value = arr[index];
  if (value === undefined) {
    throw new Error(`RepairThreadOrder: index ${index} out of bounds (length ${arr.length})`);
  }
  return value;
}

interface SubsequenceDp {
  /** predecessors[i]: index of the row before i in the best run ending at i, or -1. */
  readonly predecessors: ReadonlyArray<number>;
  /** tails[len-1]: index of the row ending the smallest-tailed run of that length seen so far. */
  readonly tails: ReadonlyArray<number>;
}

/**
 * Standard O(n log n) patience-sort DP for the longest non-decreasing
 * subsequence. Ties count as non-decreasing (a run of equal values is a
 * valid anchor chain), which is what makes the repair idempotent: a value
 * that already equals its neighbour is never flagged again on a later run.
 *
 * `predecessors[i]`, reconstructed from any index, always gives the true
 * best non-decreasing run ending exactly at that index — not only for
 * whichever index happens to end the single longest run overall. That lets
 * callers ask for "the best run ending here" for a specific index, not just
 * "the best run anywhere".
 */
function computeNonDecreasingSubsequenceDp(values: ReadonlyArray<string>): SubsequenceDp {
  const n = values.length;
  const predecessors: number[] = Array.from({ length: n }, () => -1);
  const tailIndices: number[] = [];

  for (let i = 0; i < n; i++) {
    const value = at(values, i);
    let lo = 0;
    let hi = tailIndices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at(values, at(tailIndices, mid)) <= value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      predecessors[i] = at(tailIndices, lo - 1);
    }
    if (lo === tailIndices.length) {
      tailIndices.push(i);
    } else {
      tailIndices[lo] = i;
    }
  }

  return { predecessors, tails: tailIndices };
}

function reconstructRunEndingAt(predecessors: ReadonlyArray<number>, endIndex: number): number[] {
  const result: number[] = [];
  let cursor = endIndex;
  while (cursor !== -1) {
    result.push(cursor);
    cursor = at(predecessors, cursor);
  }
  result.reverse();
  return result;
}

/**
 * Longest non-decreasing subsequence, returned as indices into `values`.
 */
export function longestNonDecreasingSubsequenceIndices(values: ReadonlyArray<string>): number[] {
  const n = values.length;
  if (n === 0) return [];
  const dp = computeNonDecreasingSubsequenceDp(values);
  return reconstructRunEndingAt(dp.predecessors, at(dp.tails, dp.tails.length - 1));
}

const ONE_SECOND_MS = 1_000;

/**
 * Plan rewrites for one thread's candidate rows of one table, already
 * sorted by ground-truth sequence ascending.
 *
 * Anchors are the longest non-decreasing `createdAt` run (by sequence
 * order) that ends at this thread's most recent row, not just whichever
 * non-decreasing run happens to be longest anywhere in the candidate set.
 * The most recent row is always trustworthy — nothing later in sequence
 * order contradicts it — so anchoring there guarantees the repair heals
 * toward the current, presumably-correct clock instead of toward a stale
 * excursion. A pure "longest run anywhere" search can pick the wrong side:
 * on a thread whose clock excursion produced more rows than it has had time
 * to recover since, the corrupted block is itself the longer run, and a
 * length-only search would anchor on the corruption and rewrite the good
 * data instead. Every other row gets a new timestamp interpolated between
 * its nearest surviving neighbours, so the full set is non-decreasing in
 * sequence order afterward.
 */
export function planRewritesForThread(
  rows: ReadonlyArray<Candidate>,
): ReadonlyArray<PlannedRewrite> {
  const n = rows.length;
  if (n === 0) return [];

  const dp = computeNonDecreasingSubsequenceDp(rows.map((row) => row.createdAt));
  const anchorIndices = new Set(reconstructRunEndingAt(dp.predecessors, n - 1));

  const rewrites: PlannedRewrite[] = [];
  let i = 0;
  while (i < n) {
    if (anchorIndices.has(i)) {
      i++;
      continue;
    }
    // Walk the contiguous run of non-anchor rows starting at i.
    let j = i;
    while (j < n && !anchorIndices.has(j)) j++;
    const runLength = j - i;
    const lowerAnchorMs = i > 0 ? Date.parse(at(rows, i - 1).createdAt) : null;
    const upperAnchorMs = j < n ? Date.parse(at(rows, j).createdAt) : null;

    for (let k = 0; k < runLength; k++) {
      const row = at(rows, i + k);
      let nextMs: number;
      if (lowerAnchorMs !== null && upperAnchorMs !== null) {
        const step = (upperAnchorMs - lowerAnchorMs) / (runLength + 1);
        nextMs = Math.round(lowerAnchorMs + step * (k + 1));
        // Guard against rounding pushing a value outside its bracket.
        nextMs = Math.min(Math.max(nextMs, lowerAnchorMs), upperAnchorMs);
      } else if (lowerAnchorMs !== null) {
        nextMs = lowerAnchorMs + (k + 1) * ONE_SECOND_MS;
      } else if (upperAnchorMs !== null) {
        nextMs = upperAnchorMs - (runLength - k) * ONE_SECOND_MS;
      } else {
        // No anchor on either side: the whole candidate set for this
        // thread/table disagreed with sequence order. Fall back to a
        // deterministic ladder from the first row's own original stamp.
        nextMs = Date.parse(at(rows, 0).createdAt) + k * ONE_SECOND_MS;
      }
      const nextCreatedAt = new Date(nextMs).toISOString();
      if (nextCreatedAt !== row.createdAt) {
        rewrites.push({
          rowId: row.rowId,
          threadId: row.threadId,
          previousCreatedAt: row.createdAt,
          nextCreatedAt,
        });
      }
    }
    i = j;
  }
  return rewrites;
}

function groupByThread(rows: ReadonlyArray<Candidate>): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>();
  for (const row of rows) {
    const group = groups.get(row.threadId);
    if (group) {
      group.push(row);
    } else {
      groups.set(row.threadId, [row]);
    }
  }
  return groups;
}

type RepairTable = "projection_thread_messages" | "projection_thread_activities";

const ensureSidecarColumn = (sql: SqlClient.SqlClient, table: RepairTable) =>
  Effect.gen(function* () {
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.literal(table)})`;
    const hasColumn = columns.some((column) => column.name === "created_at_original");
    if (!hasColumn) {
      yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN created_at_original TEXT`);
    }
  });

interface CandidateRow {
  readonly threadId: string;
  readonly rowId: string;
  readonly createdAt: string;
  readonly groundSequence: number | null;
}

/**
 * Ground truth for one id column: one row per distinct extracted id, MIN'd
 * down from every matching event. Materialized into an indexed TEMP table
 * (session-local scratch space, not part of the database file — safe on a
 * read-only connection and untouched by dry-run's "no schema writes" rule,
 * which is about the real projection tables) rather than joined as a bare
 * subquery. SQLite's planner will not always build an automatic index for
 * an ephemeral join target this size, and without one the join degrades to
 * nested-loop: on a real database (100k+ events, 100k+ activities) that is
 * tens of billions of comparisons and effectively never finishes. Dropped
 * and rebuilt on every call so a later run — sharing this connection, e.g.
 * repeated calls against one open database — always sees current events.
 */
const buildGroundTruthTempTable = (
  sql: SqlClient.SqlClient,
  tempTable: string,
  idColumn: string,
  eventType: string,
  jsonPath: string,
) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`DROP TABLE IF EXISTS temp.${tempTable}`);
    yield* sql.unsafe(
      `CREATE TEMP TABLE ${tempTable} AS
       SELECT json_extract(payload_json, ?) AS ${idColumn}, MIN(sequence) AS ground_sequence
       FROM orchestration_events
       WHERE event_type = ?
       GROUP BY ${idColumn}`,
      [jsonPath, eventType],
    );
    yield* sql.unsafe(`CREATE UNIQUE INDEX temp.idx_${tempTable}_id ON ${tempTable}(${idColumn})`);
  });

const fetchMessageCandidates = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* buildGroundTruthTempTable(
      sql,
      "repair_message_ground_truth",
      "message_id",
      "thread.message-sent",
      "$.messageId",
    );
    return yield* sql<CandidateRow>`
      SELECT
        m.thread_id AS "threadId",
        m.message_id AS "rowId",
        m.created_at AS "createdAt",
        g.ground_sequence AS "groundSequence"
      FROM projection_thread_messages m
      LEFT JOIN repair_message_ground_truth g ON g.message_id = m.message_id
      ORDER BY m.thread_id ASC, "groundSequence" ASC, m.created_at ASC, m.message_id ASC
    `;
  });

const fetchActivityCandidates = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* buildGroundTruthTempTable(
      sql,
      "repair_activity_ground_truth",
      "activity_id",
      "thread.activity-appended",
      "$.activity.id",
    );
    return yield* sql<CandidateRow>`
      SELECT
        a.thread_id AS "threadId",
        a.activity_id AS "rowId",
        a.created_at AS "createdAt",
        COALESCE(a.sequence, g.ground_sequence) AS "groundSequence"
      FROM projection_thread_activities a
      LEFT JOIN repair_activity_ground_truth g ON g.activity_id = a.activity_id
      ORDER BY a.thread_id ASC, "groundSequence" ASC, a.created_at ASC, a.activity_id ASC
    `;
  });

const fetchThreadRowCounts = (sql: SqlClient.SqlClient, table: RepairTable) =>
  sql<{ readonly threadId: string; readonly count: number }>`
    SELECT thread_id AS "threadId", COUNT(*) AS "count"
    FROM ${sql.literal(table)}
    GROUP BY thread_id
  `;

function toCandidates(rows: ReadonlyArray<CandidateRow>): {
  readonly candidates: ReadonlyArray<Candidate>;
  readonly skipped: number;
} {
  const candidates: Candidate[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.groundSequence === null) {
      skipped++;
      continue;
    }
    candidates.push({
      rowId: row.rowId,
      threadId: row.threadId,
      groundSequence: row.groundSequence,
      createdAt: row.createdAt,
    });
  }
  return { candidates, skipped };
}

function planAllRewrites(candidates: ReadonlyArray<Candidate>): ReadonlyArray<PlannedRewrite> {
  const rewrites: PlannedRewrite[] = [];
  for (const group of groupByThread(candidates).values()) {
    rewrites.push(...planRewritesForThread(group));
  }
  return rewrites;
}

function countByThread(rewrites: ReadonlyArray<PlannedRewrite>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rewrite of rewrites) {
    counts.set(rewrite.threadId, (counts.get(rewrite.threadId) ?? 0) + 1);
  }
  return counts;
}

const applyRewrites = (
  sql: SqlClient.SqlClient,
  table: RepairTable,
  idColumn: "message_id" | "activity_id",
  rewrites: ReadonlyArray<PlannedRewrite>,
) =>
  Effect.forEach(
    rewrites,
    (rewrite) =>
      sql.unsafe(
        `UPDATE ${table}
         SET created_at = ?,
             created_at_original = COALESCE(created_at_original, ?)
         WHERE ${idColumn} = ?`,
        [rewrite.nextCreatedAt, rewrite.previousCreatedAt, rewrite.rowId],
      ),
    { concurrency: 1, discard: true },
  );

export const repairThreadOrder = Effect.fn("repairThreadOrder")(function* (
  options: RepairThreadOrderOptions,
): Effect.fn.Return<RepairThreadOrderReport, SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;

  // Detection is pure reads. The sidecar column (needed only to write) is
  // added lazily below, and only when we are actually about to write —
  // dry-run must not touch the schema either.
  const messageRows = yield* fetchMessageCandidates(sql);
  const activityRows = yield* fetchActivityCandidates(sql);
  const messageThreadCounts = yield* fetchThreadRowCounts(sql, "projection_thread_messages");
  const activityThreadCounts = yield* fetchThreadRowCounts(sql, "projection_thread_activities");

  const { candidates: messageCandidates, skipped: messagesSkippedNoGroundTruth } =
    toCandidates(messageRows);
  const { candidates: activityCandidates, skipped: activitiesSkippedNoGroundTruth } =
    toCandidates(activityRows);

  const messageRewrites = planAllRewrites(messageCandidates);
  const activityRewrites = planAllRewrites(activityCandidates);

  if (!options.dryRun && (messageRewrites.length > 0 || activityRewrites.length > 0)) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* ensureSidecarColumn(sql, "projection_thread_messages");
        yield* ensureSidecarColumn(sql, "projection_thread_activities");
        yield* applyRewrites(sql, "projection_thread_messages", "message_id", messageRewrites);
        yield* applyRewrites(sql, "projection_thread_activities", "activity_id", activityRewrites);
      }),
    );
  }

  const messagesByThread = countByThread(messageRewrites);
  const activitiesByThread = countByThread(activityRewrites);
  const messageTotalsByThread = new Map(
    messageThreadCounts.map((row) => [row.threadId, row.count] as const),
  );
  const activityTotalsByThread = new Map(
    activityThreadCounts.map((row) => [row.threadId, row.count] as const),
  );

  const affectedThreadIds = new Set([...messagesByThread.keys(), ...activitiesByThread.keys()]);
  const threads: RepairThreadOrderThreadReport[] = [...affectedThreadIds]
    .map((threadId) => ({
      threadId,
      messagesExamined: messageTotalsByThread.get(threadId) ?? 0,
      messagesRewritten: messagesByThread.get(threadId) ?? 0,
      activitiesExamined: activityTotalsByThread.get(threadId) ?? 0,
      activitiesRewritten: activitiesByThread.get(threadId) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.messagesRewritten + b.activitiesRewritten - (a.messagesRewritten + a.activitiesRewritten),
    );

  return {
    dryRun: options.dryRun,
    totalMessagesExamined: messageRows.length,
    totalActivitiesExamined: activityRows.length,
    totalMessagesRewritten: messageRewrites.length,
    totalActivitiesRewritten: activityRewrites.length,
    messagesSkippedNoGroundTruth,
    activitiesSkippedNoGroundTruth,
    threads,
  };
});
