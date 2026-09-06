import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import { retireLegacyOrderingMigrationRow, runForkMigrations } from "./ForkMigrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

// `it.layer` builds its layer once per describe block (a `beforeAll`), so
// tests sharing one `it.layer` call share one in-memory database. Each test
// here needs its own fresh database, so each gets its own `it.layer` call.
const isolatedLayer = () => it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

type ColumnInfo = { readonly name: string; readonly notnull: number };

const columnInfo = (sql: SqlClient.SqlClient, table: string, column: string) =>
  sql<ColumnInfo>`PRAGMA table_info(${sql.literal(table)})`.pipe(
    Effect.map((columns) => columns.find((candidate) => candidate.name === column)),
  );

const forkMigrationRows = (sql: SqlClient.SqlClient) =>
  sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM fork_sql_migrations ORDER BY migration_id
  `;

const EXPECTED_FORK_MIGRATIONS = [
  { migration_id: 3, name: "ProjectionProjectRepositoryIdentity" },
  { migration_id: 5, name: "ProjectionThreadsReadOnly" },
  { migration_id: 6, name: "DropTranscriptSequence" },
];

/**
 * Assert the fork's transcript ordering column is gone and upstream's own
 * activity sequence column is back to its nullable declaration.
 */
const assertUpstreamTranscriptSchema = Effect.fn("assertUpstreamTranscriptSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const table of [
    "projection_thread_messages",
    "projection_thread_proposed_plans",
    "projection_turns",
  ]) {
    assert.strictEqual(
      yield* columnInfo(sql, table, "sequence"),
      undefined,
      `${table} still carries the fork's sequence column`,
    );
  }

  const activitySequence = yield* columnInfo(sql, "projection_thread_activities", "sequence");
  assert.strictEqual(activitySequence?.notnull, 0);
});

/**
 * Rebuild the schema the retired fork migrations 001 and 002 used to leave
 * behind, on a database already migrated through upstream 37. Their source is
 * gone, so the fixture states the shape directly: the three added columns with
 * their indexes, and `projection_thread_activities.sequence` rebuilt NOT NULL
 * over the event-store values that migration backfilled.
 */
const applyRetiredForkSchema = Effect.fn("applyRetiredForkSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE INDEX idx_projection_thread_messages_thread_sequence
    ON projection_thread_messages(thread_id, sequence)
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_messages_thread_sequence_created_id
    ON projection_thread_messages(thread_id, sequence, created_at, message_id)
  `;

  yield* sql`
    ALTER TABLE projection_thread_proposed_plans ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_proposed_plans_thread_sequence
    ON projection_thread_proposed_plans(thread_id, sequence)
  `;

  yield* sql`ALTER TABLE projection_turns ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE INDEX idx_projection_turns_thread_sequence_keyset
    ON projection_turns(thread_id, sequence, turn_id)
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
  yield* sql`
    INSERT INTO projection_thread_activities__rebuild
    SELECT activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
      COALESCE(sequence, 0), created_at
    FROM projection_thread_activities
  `;
  yield* sql`DROP TABLE projection_thread_activities`;
  yield* sql`ALTER TABLE projection_thread_activities__rebuild RENAME TO projection_thread_activities`;
  yield* sql`
    CREATE INDEX idx_projection_thread_activities_thread_created
    ON projection_thread_activities(thread_id, created_at)
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_activities_thread_sequence
    ON projection_thread_activities(thread_id, sequence)
  `;
  yield* sql`
    CREATE INDEX idx_projection_thread_activities_thread_sequence_created_id
    ON projection_thread_activities(thread_id, sequence, created_at, activity_id)
  `;

  // The row the retired migration recorded under an upstream-owned id.
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (38, 'ProjectionTranscriptSequence')
  `;
});

// State 1: a fresh install with no database.
isolatedLayer()("ForkMigrations - fresh database", (it) => {
  it.effect("runs clean and leaves no transcript ordering column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* retireLegacyOrderingMigrationRow();
      yield* runMigrations();
      yield* runForkMigrations();

      yield* assertUpstreamTranscriptSchema();
      assert.deepStrictEqual(yield* forkMigrationRows(sql), EXPECTED_FORK_MIGRATIONS);
    }),
  );
});

// State 2: a database the current upstream release has migrated. Its
// migrations 38-40 are upstream's own and must survive untouched, and the fork
// must add nothing to `effect_sql_migrations` that could collide with them.
isolatedLayer()("ForkMigrations - upstream-migrated database", (it) => {
  it.effect("opens without a collision and keeps upstream's migration rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES
          (38, 'ProjectionThreadsPinOrderKey'),
          (39, 'ProjectionProjectsDefaultThreadEnvMode'),
          (40, 'ProjectionProjectFaviconPath')
      `;

      yield* retireLegacyOrderingMigrationRow();
      yield* runMigrations();
      yield* runForkMigrations();

      yield* assertUpstreamTranscriptSchema();
      assert.deepStrictEqual(yield* forkMigrationRows(sql), EXPECTED_FORK_MIGRATIONS);

      const upstreamRows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        WHERE migration_id >= 38 ORDER BY migration_id
      `;
      assert.deepStrictEqual(upstreamRows, [
        { migration_id: 38, name: "ProjectionThreadsPinOrderKey" },
        { migration_id: 39, name: "ProjectionProjectsDefaultThreadEnvMode" },
        { migration_id: 40, name: "ProjectionProjectFaviconPath" },
      ]);
    }),
  );
});

// State 3: a database an older fork build left with the ordering column in
// place, recorded under the upstream-owned id 38.
isolatedLayer()("ForkMigrations - database carrying the retired ordering column", (it) => {
  it.effect("drops the column, clears the activity backfill, and frees slot 38", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES (
          'activity-1', 'thread-1', NULL, 'info', 'test.kind', 'summary', '{}', 7,
          '2026-08-01T00:00:00.000Z'
        )
      `;
      yield* applyRetiredForkSchema();

      yield* retireLegacyOrderingMigrationRow();
      yield* runMigrations();
      yield* runForkMigrations();

      yield* assertUpstreamTranscriptSchema();
      assert.deepStrictEqual(yield* forkMigrationRows(sql), EXPECTED_FORK_MIGRATIONS);

      // The backfilled values go with the column. Left behind, they would sort
      // the whole existing history above every activity written afterwards.
      const activities = yield* sql<{
        readonly activity_id: string;
        readonly sequence: number | null;
      }>`SELECT activity_id, sequence FROM projection_thread_activities`;
      assert.deepStrictEqual(activities, [{ activity_id: "activity-1", sequence: null }]);

      // Slot 38 is upstream's again, so upstream's own migration 38 is not
      // skipped by the migrator's highest-id-wins bookkeeping.
      const legacyRows = yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id >= 38
      `;
      assert.deepStrictEqual(legacyRows, []);
    }),
  );
});

// Startup runs both migrators every time. A second pass must find nothing to do.
isolatedLayer()("ForkMigrations - repeat startup", (it) => {
  it.effect("is a no-op on the second run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* retireLegacyOrderingMigrationRow();
      yield* runMigrations();
      yield* runForkMigrations();
      // A second startup: the repair runs again on a database that no longer
      // carries the borrowed row, and neither pass finds anything to do.
      yield* retireLegacyOrderingMigrationRow();
      const secondPass = yield* runForkMigrations();

      assert.deepStrictEqual(secondPass, []);
      yield* assertUpstreamTranscriptSchema();
      assert.deepStrictEqual(yield* forkMigrationRows(sql), EXPECTED_FORK_MIGRATIONS);
    }),
  );
});

// The repair has to hand the id back before upstream's migrator reads the
// table, not after it. Running it second would work only while upstream owns
// nothing above 38: a startup that recorded 39 first would leave the borrowed
// row below the maximum, where deleting it restores nothing.
isolatedLayer()("ForkMigrations - legacy migration id repair", (it) => {
  it.effect("frees slot 38 before upstream's migrator runs, and is a no-op without it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // A fresh database has no migrations table at all.
      yield* retireLegacyOrderingMigrationRow();

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (38, 'ProjectionTranscriptSequence', '2026-08-01T00:00:00.000Z')
      `;

      yield* retireLegacyOrderingMigrationRow();

      const maximum = yield* sql<{ readonly maximum: number }>`
        SELECT MAX(migration_id) AS maximum FROM effect_sql_migrations
      `;
      assert.strictEqual(maximum[0]?.maximum, 37);
    }),
  );
});

// An upstream row that happens to sit at 38 is not the fork's to delete.
isolatedLayer()("ForkMigrations - legacy migration id repair, upstream row at 38", (it) => {
  it.effect("leaves a row with another name alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (38, 'SomeUpstreamMigration', '2026-08-01T00:00:00.000Z')
      `;

      yield* retireLegacyOrderingMigrationRow();

      const rows = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id = 38
      `;
      assert.deepStrictEqual(rows, [{ name: "SomeUpstreamMigration" }]);
    }),
  );
});
