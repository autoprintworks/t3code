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
 * `retireLegacyOrderingMigrationRow` below is the other half of that story:
 * it hands upstream's id 38 back before upstream's own migrator runs.
 *
 * The fix is a second, independent migration table (`fork_sql_migrations`)
 * with its own id sequence starting at 1. Upstream's table and numbering are
 * untouched and free to grow without limit; this table is exclusively the
 * fork's, and merging upstream never has to look at it. `runForkMigrations`
 * runs after `runMigrations` (see `Layers/Sqlite.ts`).
 *
 * Ids 1, 2 and 4 are retired: they added and maintained the fork's transcript
 * ordering column, which the fork no longer carries. Their gap is deliberate.
 * Reusing a retired id would be skipped on every install that already recorded
 * it, so fork ids are never renumbered and never reused either.
 */
import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ForkMigration0003 from "./ForkMigrations/003_ProjectionProjectRepositoryIdentity.ts";
import ForkMigration0005 from "./ForkMigrations/005_ProjectionThreadsReadOnly.ts";
import ForkMigration0006 from "./ForkMigrations/006_DropTranscriptSequence.ts";

const FORK_MIGRATIONS_TABLE = "fork_sql_migrations";

/** The upstream-numbered id and name the fork's first ordering migration ran under. */
const LEGACY_MIGRATION_ID = 38;
const LEGACY_MIGRATION_NAME = "ProjectionTranscriptSequence";

/**
 * Give upstream back the migration id an older fork build borrowed.
 *
 * A database an older fork build migrated carries an `effect_sql_migrations`
 * row at id 38 for the fork's own ordering migration. The migrator tracks the
 * single highest recorded id, so upstream's real migration 38 would be treated
 * as already done and skipped forever. Deleting that one row lowers the
 * recorded maximum back to 37, and upstream 38 runs on its own terms.
 *
 * This has to happen **before** `runMigrations`, not inside a fork migration
 * that runs after it. Once upstream ships anything above 38, a later startup
 * would record 39 first, the maximum would no longer be the borrowed row, and
 * deleting it afterwards would restore nothing. Running first means the id is
 * already free the very first time upstream's migrator looks at the database.
 *
 * It is safe to run on every startup: the delete is keyed on both the id and
 * the fork's own migration name, so it cannot touch an upstream row that
 * happens to sit at 38, and it does nothing on a database that never carried
 * the row. On a fresh database the migrations table does not exist yet, which
 * is why the table is looked up first rather than assumed.
 */
export const retireLegacyOrderingMigrationRow = Effect.fn("retireLegacyOrderingMigrationRow")(
  function* () {
    const sql = yield* SqlClient.SqlClient;

    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) {
      return;
    }

    yield* sql`
      DELETE FROM effect_sql_migrations
      WHERE migration_id = ${LEGACY_MIGRATION_ID} AND name = ${LEGACY_MIGRATION_NAME}
    `;
  },
);

export const forkMigrationEntries = [
  [3, "ProjectionProjectRepositoryIdentity", ForkMigration0003],
  [5, "ProjectionThreadsReadOnly", ForkMigration0005],
  [6, "DropTranscriptSequence", ForkMigration0006],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const makeForkMigrationLoader = () =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries.map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

/**
 * Run all pending fork migrations. Mirrors `runMigrations` in `Migrations.ts`
 * but tracks progress in `fork_sql_migrations`, independent of upstream's
 * `effect_sql_migrations`. Call after `runMigrations()`.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
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
