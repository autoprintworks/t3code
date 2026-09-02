/**
 * ForkMigrationsLive - migration runner for fork-authored schema changes.
 *
 * Why this exists instead of adding to `Migrations.ts`:
 *
 * `Migrator.make` (`.repos/effect-smol/packages/effect/src/unstable/sql/Migrator.ts`)
 * tracks progress by the single highest `migration_id` ever recorded in its
 * table, not by which individual ids have run. Any migration numbered above
 * that maximum is treated as pending, no matter who wrote it or which id it
 * was assigned. `apps/server/src/persistence/Migrations.ts` holds upstream's
 * migration sequence and its numbering is upstream's to own; this repo does
 * not renumber it.
 *
 * A fork migration therefore cannot safely reuse a "reserved" high slot in
 * that same table. If it picked, say, id 900, it would work until the first
 * time it ran — at which point the table's maximum becomes 900, and any
 * upstream migration merged in later at id 41, 42, ... would be silently
 * skipped forever (41 <= 900), because the migrator has no way to know an id
 * below the maximum is actually still pending. That failure mode is worse
 * than the collision this file exists to fix: it never throws, it just
 * leaves upstream's schema change unapplied.
 *
 * The fix is a second, independent migration table (`fork_sql_migrations`)
 * with its own id sequence starting at 1. Upstream's table and numbering are
 * untouched and free to grow without limit; this table is exclusively the
 * fork's, and merging upstream never has to look at it. `runForkMigrations`
 * runs after `runMigrations` (see `Layers/Sqlite.ts`).
 *
 * One reconciliation is required for existing installs: this fork's first
 * migration originally shipped as upstream-numbered id 38
 * ("ProjectionTranscriptSequence"), before this split existed. A database
 * that already ran it recorded that fact in `effect_sql_migrations`, not
 * here. Before running fork migration 1, `runForkMigrations` checks for that
 * legacy row and, if present, seeds `fork_sql_migrations` so migration 1 is
 * treated as already done rather than re-run (which would fail on
 * `ALTER TABLE ... ADD COLUMN` against a column that already exists).
 */
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_ProjectionTranscriptSequence.ts";
import ForkMigration0002 from "./ForkMigrations/002_ProjectionThreadActivitySequenceNotNull.ts";
import ForkMigration0003 from "./ForkMigrations/003_ProjectionProjectRepositoryIdentity.ts";
import ForkMigration0004 from "./ForkMigrations/004_ProjectionTurnsActivityAnchorBackfill.ts";
import ForkMigration0005 from "./ForkMigrations/005_ProjectionThreadsReadOnly.ts";

const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

/** The upstream-numbered id and name fork migration 1 ran under before this file existed. */
const LEGACY_MIGRATION_ID = 38;
const LEGACY_MIGRATION_NAME = "ProjectionTranscriptSequence";

export const forkMigrationEntries = [
  [1, "ProjectionTranscriptSequence", ForkMigration0001],
  [2, "ProjectionThreadActivitySequenceNotNull", ForkMigration0002],
  [3, "ProjectionProjectRepositoryIdentity", ForkMigration0003],
  [4, "ProjectionTurnsActivityAnchorBackfill", ForkMigration0004],
  [5, "ProjectionThreadsReadOnly", ForkMigration0005],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const makeForkMigrationLoader = () =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Seed `fork_sql_migrations` if this database already ran fork migration 1
 * under its old upstream-numbered id, so the migrator below skips it instead
 * of re-running (and failing) it. A no-op on every other database: fresh
 * installs and databases upstream migrated past id 38 never match, and once
 * seeded, `INSERT OR IGNORE` makes repeat startups a no-op too.
 */
const reconcileLegacyMigration = Effect.fn("reconcileLegacyMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;

  const legacyRows = yield* sql<{ present: number }>`
    SELECT 1 AS present FROM effect_sql_migrations
    WHERE migration_id = ${LEGACY_MIGRATION_ID} AND name = ${LEGACY_MIGRATION_NAME}
  `;

  if (legacyRows.length === 0) {
    return;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(FORK_MIGRATIONS_TABLE)} (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      name TEXT NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO ${sql(FORK_MIGRATIONS_TABLE)} (migration_id, name)
    VALUES (1, 'ProjectionTranscriptSequence')
  `;
});

const run = Migrator.make({});

/**
 * Run all pending fork migrations. Mirrors `runMigrations` in `Migrations.ts`
 * but tracks progress in `fork_sql_migrations`, independent of upstream's
 * `effect_sql_migrations`. Call after `runMigrations()`.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  yield* reconcileLegacyMigration();

  const executedMigrations = yield* run({
    loader: makeForkMigrationLoader(),
    table: FORK_MIGRATIONS_TABLE,
  });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Fork migration schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
