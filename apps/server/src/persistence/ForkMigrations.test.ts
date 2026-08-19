import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import { runForkMigrations } from "./ForkMigrations.ts";
import Migration001 from "./ForkMigrations/001_ProjectionTranscriptSequence.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

// `it.layer` builds its layer once per describe block (a `beforeAll`), so
// tests sharing one `it.layer` call share one in-memory database. Each test
// here needs its own fresh database, so each gets its own `it.layer` call.
const isolatedLayer = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const sequenceColumnInfo = (sql: SqlClient.SqlClient, table: string) =>
  sql<{ readonly name: string; readonly notnull: number }>`PRAGMA table_info(${sql.literal(table)})`.pipe(
    Effect.map((columns) => columns.find((column) => column.name === "sequence")),
  );

// State 1: a fresh install with no database.
isolatedLayer()("ForkMigrations - fresh database", (it) => {
  it.effect("runs clean against a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* runForkMigrations();

      const activitySequence = yield* sequenceColumnInfo(sql, "projection_thread_activities");
      assert.strictEqual(activitySequence?.notnull, 1);

      const forkMigrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM fork_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(forkMigrations, [
        { migration_id: 1, name: "ProjectionTranscriptSequence" },
        { migration_id: 2, name: "ProjectionThreadActivitySequenceNotNull" },
      ]);
    }),
  );
});

// State 2: a database that only ever saw our fork, where migration 038
// ("ProjectionTranscriptSequence") already ran under its original,
// upstream-shaped id. The trap: a naive renumber re-runs the same
// ALTER TABLE ADD COLUMN and crashes on "duplicate column name".
isolatedLayer()("ForkMigrations - legacy id 38 already applied", (it) => {
  it.effect("does not re-run migration 38 on a database that already applied it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* Migration001;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (38, 'ProjectionTranscriptSequence')
      `;

      // Confirms the trap is real: replaying the same migration body against
      // a database that already has the columns fails outright.
      const replay = yield* Effect.exit(Migration001);
      assert.strictEqual(replay._tag, "Failure");

      // The actual fix: runForkMigrations recognizes the legacy row and
      // skips migration 1 instead of re-running it.
      yield* runMigrations();
      yield* runForkMigrations();

      const forkMigrations = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM fork_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(forkMigrations, [
        { migration_id: 1, name: "ProjectionTranscriptSequence" },
        { migration_id: 2, name: "ProjectionThreadActivitySequenceNotNull" },
      ]);

      const activitySequence = yield* sequenceColumnInfo(sql, "projection_thread_activities");
      assert.strictEqual(activitySequence?.notnull, 1);
    }),
  );
});

// State 3: a database upstream v0.0.33 has touched. Its migrations 38-40
// are upstream's, not ours, and never add the transcript sequence columns.
isolatedLayer()("ForkMigrations - upstream past slot 38", (it) => {
  it.effect("runs clean against a database upstream has migrated past slot 38", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (38, 'ProjectionThreadsPinOrderKey'),
          (39, 'ProjectionProjectsDefaultThreadEnvMode'),
          (40, 'ProjectionProjectFaviconPath')
      `;

      // Before this fix, our migration was also numbered 38: the migrator's
      // max-id check would see 38 already recorded and skip ours forever.
      yield* runMigrations();
      yield* runForkMigrations();

      const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      assert.ok(messageColumns.some((column) => column.name === "sequence"));

      const activitySequence = yield* sequenceColumnInfo(sql, "projection_thread_activities");
      assert.strictEqual(activitySequence?.notnull, 1);
    }),
  );
});

isolatedLayer()("ForkMigrations - activity sequence backfill", (it) => {
  it.effect("backfills existing NULL activity sequences from the event store", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-1', 'thread', 'thread-1', 1, 'thread.activity-appended',
          '2026-08-01T00:00:00.000Z', 'system',
          '{"threadId":"thread-1","activity":{"id":"activity-1"}}', '{}'
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'activity-1', 'thread-1', NULL, 'info', 'test.kind', 'summary', '{}', NULL,
          '2026-08-01T00:00:00.000Z'
        )
      `;

      yield* runForkMigrations();

      const rows = yield* sql<{ readonly sequence: number }>`
        SELECT sequence FROM projection_thread_activities WHERE activity_id = 'activity-1'
      `;
      assert.strictEqual(rows[0]?.sequence, 1);
    }),
  );
});
