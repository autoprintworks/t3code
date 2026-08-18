import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  longestNonDecreasingSubsequenceIndices,
  planRewritesForThread,
  repairThreadOrder,
} from "./RepairThreadOrder.ts";

// --- Pure-function unit tests -----------------------------------------
//
// These exercise the ordering algorithm in isolation, without any database,
// because it is the part of the repair whose correctness everything else
// depends on.

it("longestNonDecreasingSubsequenceIndices finds the longest run, preferring the majority chain over a shorter glitch", () => {
  const values = ["a", "b", "c", "d", "z", "z", "z", "e", "f", "g", "h", "i", "j"];
  // Indices 4,5,6 are the "z" glitch block; the majority chain (0-3, 7-12) is
  // longer, so the algorithm must pick that one, not the glitch block.
  const anchors = longestNonDecreasingSubsequenceIndices(values);
  assert.deepStrictEqual(anchors, [0, 1, 2, 3, 7, 8, 9, 10, 11, 12]);
});

it("longestNonDecreasingSubsequenceIndices treats equal values as a valid chain (idempotency guarantee)", () => {
  const values = ["a", "a", "a", "a"];
  assert.deepStrictEqual(longestNonDecreasingSubsequenceIndices(values), [0, 1, 2, 3]);
});

it("planRewritesForThread leaves an already-ordered thread untouched", () => {
  const rows = [
    { rowId: "m1", threadId: "t", groundSequence: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    { rowId: "m2", threadId: "t", groundSequence: 2, createdAt: "2026-01-01T00:01:00.000Z" },
    { rowId: "m3", threadId: "t", groundSequence: 3, createdAt: "2026-01-01T00:02:00.000Z" },
  ];
  assert.deepStrictEqual(planRewritesForThread(rows), []);
});

it("planRewritesForThread interpolates a corrupted block between its surviving neighbours", () => {
  const rows = [
    { rowId: "m1", threadId: "t", groundSequence: 1, createdAt: "2026-01-01T00:03:00.000Z" },
    { rowId: "m2", threadId: "t", groundSequence: 2, createdAt: "2026-01-01T09:03:00.000Z" },
    { rowId: "m3", threadId: "t", groundSequence: 3, createdAt: "2026-01-01T00:04:00.000Z" },
  ];
  const rewrites = planRewritesForThread(rows);
  assert.deepStrictEqual(
    rewrites.map((r) => r.rowId),
    ["m2"],
  );
  const rewrite = rewrites[0]!;
  assert.strictEqual(rewrite.previousCreatedAt, "2026-01-01T09:03:00.000Z");
  // New timestamp must sit strictly between its two neighbours.
  assert.ok(rewrite.nextCreatedAt > "2026-01-01T00:03:00.000Z");
  assert.ok(rewrite.nextCreatedAt < "2026-01-01T00:04:00.000Z");
});

// --- Database-backed integration tests ---------------------------------

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertThread = (sql: SqlClient.SqlClient, threadId: string) =>
  sql`
    INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at)
    VALUES (${threadId}, 'project-1', 'Test thread', '{"provider":"codex","model":"test-model"}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `;

interface MessageFixture {
  readonly messageId: string;
  readonly threadId: string;
  readonly createdAt: string;
}

const insertMessageWithEvent = (
  sql: SqlClient.SqlClient,
  fixture: MessageFixture,
  sequence: number,
) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES
        (${fixture.messageId}, ${fixture.threadId}, 'assistant', 'hi', 0, ${fixture.createdAt}, ${fixture.createdAt})
    `;
    yield* sql`
      INSERT INTO orchestration_events
        (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES
        (${`evt-${fixture.messageId}`}, 'thread', ${fixture.threadId}, ${sequence}, 'thread.message-sent', ${fixture.createdAt}, 'agent',
         ${JSON.stringify({ messageId: fixture.messageId })}, '{}')
    `;
  });

interface ActivityFixture {
  readonly activityId: string;
  readonly threadId: string;
  readonly createdAt: string;
}

let nextStreamVersion = 1;

const insertActivityAppendedEvent = (sql: SqlClient.SqlClient, fixture: ActivityFixture) =>
  sql`
    INSERT INTO orchestration_events
      (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
    VALUES
      (${`evt-${fixture.activityId}`}, 'thread', ${fixture.threadId}, ${nextStreamVersion++}, 'thread.activity-appended', ${fixture.createdAt}, 'agent',
       ${JSON.stringify({ threadId: fixture.threadId, activity: { id: fixture.activityId } })}, '{}')
  `;

/**
 * `projection_thread_activities.sequence`, where present, mirrors the real
 * `orchestration_events.sequence` autoincrement value at projection time
 * (see the module doc comment). To keep that relationship faithful in tests
 * — and avoid mixing an unrelated numbering scheme with the real
 * autoincrement counter — every activity fixture gets a backing event first,
 * and modern rows copy that event's real assigned sequence number.
 * `sequenceColumn: "legacy"` leaves the row's own `sequence` column NULL, so
 * the repair must fall back to the event join, exactly like a row that
 * predates migration 008.
 */
const insertActivity = (
  sql: SqlClient.SqlClient,
  fixture: ActivityFixture,
  sequenceColumn: "modern" | "legacy",
) =>
  Effect.gen(function* () {
    yield* insertActivityAppendedEvent(sql, fixture);
    const [event] = yield* sql<{ readonly sequence: number }>`
      SELECT sequence AS "sequence" FROM orchestration_events WHERE event_id = ${`evt-${fixture.activityId}`}
    `;
    const sequenceValue = sequenceColumn === "modern" ? (event?.sequence ?? null) : null;
    yield* sql`
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, tone, kind, summary, payload_json, created_at, sequence)
      VALUES
        (${fixture.activityId}, ${fixture.threadId}, 'neutral', 'note', 'summary', '{}', ${fixture.createdAt}, ${sequenceValue})
    `;
  });

const messageCreatedAtOrder = (sql: SqlClient.SqlClient, threadId: string) =>
  sql<{ readonly messageId: string }>`
    SELECT message_id AS "messageId"
    FROM projection_thread_messages
    WHERE thread_id = ${threadId}
    ORDER BY created_at ASC, message_id ASC
  `;

const messageRow = (sql: SqlClient.SqlClient, messageId: string) =>
  sql<{ readonly createdAt: string; readonly createdAtOriginal: string | null }>`
    SELECT created_at AS "createdAt", created_at_original AS "createdAtOriginal"
    FROM projection_thread_messages
    WHERE message_id = ${messageId}
  `;

// A realistic clock excursion: four real messages, a three-message block
// stamped ~9 hours in the future (the captain's clock jump), then six more
// real messages once the clock corrected. The "before + after" chain (10
// rows) is longer than the "before + glitch" chain (7 rows), so the repair
// must anchor on the real timestamps and flag only the glitch block — this
// is what the report's real-world data looks like (a short excursion inside
// a much longer, otherwise-correct thread).
const CLOCK_EXCURSION_MESSAGES: ReadonlyArray<{ id: string; createdAt: string }> = [
  { id: "m1", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "m2", createdAt: "2026-01-01T00:01:00.000Z" },
  { id: "m3", createdAt: "2026-01-01T00:02:00.000Z" },
  { id: "m4", createdAt: "2026-01-01T00:03:00.000Z" },
  { id: "m5", createdAt: "2026-01-01T09:03:00.000Z" }, // glitch
  { id: "m6", createdAt: "2026-01-01T09:04:00.000Z" }, // glitch
  { id: "m7", createdAt: "2026-01-01T09:05:00.000Z" }, // glitch
  { id: "m8", createdAt: "2026-01-01T00:04:00.000Z" },
  { id: "m9", createdAt: "2026-01-01T00:05:00.000Z" },
  { id: "m10", createdAt: "2026-01-01T00:06:00.000Z" },
  { id: "m11", createdAt: "2026-01-01T00:07:00.000Z" },
  { id: "m12", createdAt: "2026-01-01T00:08:00.000Z" },
  { id: "m13", createdAt: "2026-01-01T00:09:00.000Z" },
];

/**
 * Message ids are namespaced per thread (`${threadId}-${id}`) because every
 * scenario below shares one in-memory database (`it.layer` builds the layer
 * once per describe block and reuses it across sibling `it.effect` tests, so
 * row ids must stay globally unique across tests, exactly as real UUIDs
 * would be in production).
 */
const messageIdFor = (threadId: string, id: string): string => `${threadId}-${id}`;

const seedClockExcursion = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.gen(function* () {
    yield* insertThread(sql, threadId);
    let sequence = 1;
    for (const message of CLOCK_EXCURSION_MESSAGES) {
      yield* insertMessageWithEvent(
        sql,
        { messageId: messageIdFor(threadId, message.id), threadId, createdAt: message.createdAt },
        sequence,
      );
      sequence++;
    }
  });

layer("repairThreadOrder", (it) => {
  it.effect("dry run reports the glitch block without writing anything", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const threadId = "thread-dry-run";
      yield* seedClockExcursion(sql, threadId);

      const report = yield* repairThreadOrder({ dryRun: true });

      assert.strictEqual(report.dryRun, true);
      const threadReport = report.threads.find((t) => t.threadId === threadId);
      assert.ok(threadReport !== undefined);
      assert.strictEqual(threadReport!.messagesRewritten, 3);

      // Nothing was written: original order is still corrupted.
      const rowsInTimestampOrder = yield* messageCreatedAtOrder(sql, threadId);
      assert.deepStrictEqual(
        rowsInTimestampOrder.map((r) => r.messageId),
        ["m1", "m2", "m3", "m4", "m8", "m9", "m10", "m11", "m12", "m13", "m5", "m6", "m7"].map(
          (id) => messageIdFor(threadId, id),
        ),
      );

      // Dry run must not even add the sidecar column.
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_thread_messages)`;
      assert.ok(!columns.some((c) => c.name === "created_at_original"));
    }),
  );

  it.effect("applying the repair makes timestamp order match sequence order", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const threadId = "thread-apply";
      yield* seedClockExcursion(sql, threadId);

      const report = yield* repairThreadOrder({ dryRun: false });
      const threadReport = report.threads.find((t) => t.threadId === threadId);
      assert.ok(threadReport !== undefined);
      assert.strictEqual(threadReport!.messagesRewritten, 3);

      const rowsInTimestampOrder = yield* messageCreatedAtOrder(sql, threadId);
      assert.deepStrictEqual(
        rowsInTimestampOrder.map((r) => r.messageId),
        CLOCK_EXCURSION_MESSAGES.map((m) => messageIdFor(threadId, m.id)),
      );
    }),
  );

  it.effect("preserves the original timestamps in created_at_original", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const threadId = "thread-sidecar";
      yield* seedClockExcursion(sql, threadId);

      yield* repairThreadOrder({ dryRun: false });

      const glitchRow = yield* messageRow(sql, messageIdFor(threadId, "m6"));
      assert.strictEqual(glitchRow[0]!.createdAtOriginal, "2026-01-01T09:04:00.000Z");
      assert.notStrictEqual(glitchRow[0]!.createdAt, glitchRow[0]!.createdAtOriginal);

      // Rows that were never rewritten keep a NULL sidecar value.
      const untouchedRow = yield* messageRow(sql, messageIdFor(threadId, "m1"));
      assert.strictEqual(untouchedRow[0]!.createdAtOriginal, null);
    }),
  );

  it.effect("is idempotent: a second run rewrites nothing and changes nothing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const threadId = "thread-idempotent";
      yield* seedClockExcursion(sql, threadId);

      yield* repairThreadOrder({ dryRun: false });
      const afterFirstRun = yield* messageCreatedAtOrder(sql, threadId);
      const afterFirstRunRows = yield* sql<{
        readonly messageId: string;
        readonly createdAt: string;
        readonly createdAtOriginal: string | null;
      }>`
        SELECT message_id AS "messageId", created_at AS "createdAt", created_at_original AS "createdAtOriginal"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY message_id ASC
      `;

      const secondReport = yield* repairThreadOrder({ dryRun: false });
      assert.strictEqual(secondReport.totalMessagesRewritten, 0);
      assert.strictEqual(secondReport.totalActivitiesRewritten, 0);
      assert.strictEqual(secondReport.threads.length, 0);

      const afterSecondRun = yield* messageCreatedAtOrder(sql, threadId);
      assert.deepStrictEqual(afterSecondRun, afterFirstRun);

      const afterSecondRunRows = yield* sql<{
        readonly messageId: string;
        readonly createdAt: string;
        readonly createdAtOriginal: string | null;
      }>`
        SELECT message_id AS "messageId", created_at AS "createdAt", created_at_original AS "createdAtOriginal"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY message_id ASC
      `;
      assert.deepStrictEqual(afterSecondRunRows, afterFirstRunRows);
    }),
  );

  it.effect("covers activities: sequence-column rows and legacy event-join rows both repair", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const threadId = "thread-activities";
      yield* insertThread(sql, threadId);
      const activityId = (id: string) => messageIdFor(threadId, id);

      // Rows 1-3 real, row 4 a legacy row (sequence column NULL, ground
      // truth only via the event join) stamped in the future, rows 5-7 real
      // again — a longer "real" chain than the one-row glitch, same shape as
      // the messages scenario above.
      yield* insertActivity(
        sql,
        { activityId: activityId("a1"), threadId, createdAt: "2026-01-01T00:00:00.000Z" },
        "modern",
      );
      yield* insertActivity(
        sql,
        { activityId: activityId("a2"), threadId, createdAt: "2026-01-01T00:01:00.000Z" },
        "modern",
      );
      yield* insertActivity(
        sql,
        { activityId: activityId("a3"), threadId, createdAt: "2026-01-01T00:02:00.000Z" },
        "modern",
      );
      yield* insertActivity(
        sql,
        { activityId: activityId("a4"), threadId, createdAt: "2026-01-01T09:02:00.000Z" },
        "legacy",
      );
      yield* insertActivity(
        sql,
        { activityId: activityId("a5"), threadId, createdAt: "2026-01-01T00:03:00.000Z" },
        "modern",
      );
      yield* insertActivity(
        sql,
        { activityId: activityId("a6"), threadId, createdAt: "2026-01-01T00:04:00.000Z" },
        "modern",
      );
      yield* insertActivity(
        sql,
        { activityId: activityId("a7"), threadId, createdAt: "2026-01-01T00:05:00.000Z" },
        "modern",
      );

      const report = yield* repairThreadOrder({ dryRun: false });
      const threadReport = report.threads.find((t) => t.threadId === threadId);
      assert.ok(threadReport !== undefined);
      assert.strictEqual(threadReport!.activitiesRewritten, 1);

      const rowsInTimestampOrder = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, activity_id ASC
      `;
      assert.deepStrictEqual(
        rowsInTimestampOrder.map((r) => r.activityId),
        ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map(activityId),
      );
    }),
  );

  it.effect("skips rows with no matching event instead of crashing", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const threadId = "thread-orphan";
      yield* insertThread(sql, threadId);
      // A message with no corresponding orchestration_events row at all.
      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES
          ('thread-orphan-orphan-1', ${threadId}, 'assistant', 'hi', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `;

      const report = yield* repairThreadOrder({ dryRun: true });
      assert.strictEqual(report.messagesSkippedNoGroundTruth, 1);
      assert.strictEqual(report.totalMessagesRewritten, 0);
    }),
  );
});
