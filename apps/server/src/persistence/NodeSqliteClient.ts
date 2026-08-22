/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";
import * as NodePerfHooks from "node:perf_hooks";

import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

/**
 * One completed hold of the single transaction connection permit.
 *
 * `sqlMs` is time spent inside SQLite on this connection while the permit was
 * held. `holdMs - sqlMs` is the interesting number: it is time the one writer
 * was reserved while nothing was being asked of the database, which happens
 * whenever a transaction body yields to the scheduler.
 */
export interface SqlPermitHold {
  readonly holdMs: number;
  readonly sqlMs: number;
  readonly statements: number;
  /**
   * Span names from the transaction outwards, e.g.
   * `["sql.transaction", "ProjectionSnapshotQuery.getShellSnapshot"]`. The JS
   * stack cannot name the caller here because the acquirer runs inside the
   * Effect fiber loop, so the span chain is the call site.
   */
  readonly origin: ReadonlyArray<string>;
  /** Raw JS stack at acquisition, kept for the rare non-Effect caller. */
  readonly stack: string;
}

export type SqlPermitObserver = (hold: SqlPermitHold) => void;

interface ActiveSqlPermitHold {
  readonly startedAt: number;
  readonly origin: ReadonlyArray<string>;
  readonly stack: string;
  sqlMs: number;
  statements: number;
}

export interface SqlPermitObserverOptions {
  /**
   * Capture a JS stack and the Effect span chain at acquisition. Costs roughly
   * ten microseconds per transaction, so a long-running observer that only
   * needs the numbers should leave it off.
   */
  readonly captureStacks?: boolean;
}

let permitObserver: SqlPermitObserver | undefined;
let permitStacks = true;
let activeHold: ActiveSqlPermitHold | undefined;

/**
 * Attach an observer for transaction permit holds. Off by design: with no
 * observer the client does not read the clock, capture a stack, or allocate.
 * Returns a function that detaches it again.
 */
export const observeSqlPermits = (
  observer: SqlPermitObserver,
  options: SqlPermitObserverOptions = {},
): (() => void) => {
  permitObserver = observer;
  permitStacks = options.captureStacks ?? true;
  return () => {
    if (permitObserver === observer) {
      permitObserver = undefined;
      permitStacks = true;
      activeHold = undefined;
    }
  };
};

const EMPTY_ORIGIN: ReadonlyArray<string> = [];

function captureHoldStack(): string {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, captureHoldStack);
  return holder.stack ?? "";
}

const captureHoldOrigin = (context: Context.Context<never>): ReadonlyArray<string> => {
  const names: Array<string> = [];
  let span = Context.getOption(context, Tracer.ParentSpan);
  while (Option.isSome(span) && names.length < 8) {
    const current = span.value;
    // An external span carries an id from another process and no name, so the
    // chain ends there.
    if (current._tag !== "Span") {
      break;
    }
    names.push(current.name);
    span = current.parent;
  }
  return names;
};

const beginPermitHold = (context: Context.Context<never>): void => {
  if (permitObserver === undefined) {
    return;
  }
  activeHold = {
    startedAt: NodePerfHooks.performance.now(),
    origin: permitStacks ? captureHoldOrigin(context) : EMPTY_ORIGIN,
    stack: permitStacks ? captureHoldStack() : "",
    sqlMs: 0,
    statements: 0,
  };
};

const endPermitHold = (): void => {
  const hold = activeHold;
  const observer = permitObserver;
  activeHold = undefined;
  if (hold === undefined || observer === undefined) {
    return;
  }
  observer({
    holdMs: NodePerfHooks.performance.now() - hold.startedAt,
    sqlMs: hold.sqlMs,
    statements: hold.statements,
    origin: hold.origin,
    stack: hold.stack,
  });
};

/**
 * Attribute one statement's wall time to the hold in progress. The permit is
 * exclusive and there is one connection, so statements running during a hold
 * belong to it.
 */
const recordPermitStatement = (startedAt: number): void => {
  const hold = activeHold;
  if (hold === undefined) {
    return;
  }
  hold.sqlMs += NodePerfHooks.performance.now() - startedAt;
  hold.statements += 1;
};

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedErrorClass<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedErrorClass<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

const makeWithDatabase = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
  openDatabase: () => NodeSqlite.DatabaseSync,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: openDatabase,
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, {
            message: "Failed to open database",
            operation: "open",
          }),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, {
              message: "Failed to close database",
              operation: "close",
            }),
          }),
      }).pipe(Effect.orDie),
    );

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => db.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, {
              message: "Failed to prepare statement",
              operation: "prepare",
            }),
          }),
      });

    const prepareCache = yield* Cache.make({
      capacity: options.prepareCacheSize ?? 200,
      timeToLive: options.prepareCacheTTL ?? Duration.minutes(10),
      lookup: prepare,
    });

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      raw: boolean,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const sqlStartedAt = activeHold === undefined ? 0 : NodePerfHooks.performance.now();
        try {
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          if (hasRows(statement)) {
            return Effect.succeed(statement.all(...(params as any)));
          }
          const result = statement.run(...(params as any));
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, {
                message: "Failed to execute statement",
                operation: "execute",
              }),
            }),
          );
        } finally {
          if (activeHold !== undefined) {
            recordPermitStatement(sqlStartedAt);
          }
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw));

    const runStatementValues = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
    ) =>
      Effect.acquireUseRelease(
        Effect.succeed(statement),
        (statement) =>
          Effect.try({
            try: () => {
              const sqlStartedAt = activeHold === undefined ? 0 : NodePerfHooks.performance.now();
              try {
                if (hasRows(statement)) {
                  statement.setReturnArrays(true);
                  // Safe to cast to array after we've setReturnArrays(true)
                  return statement.all(...(params as any)) as unknown as ReadonlyArray<
                    ReadonlyArray<unknown>
                  >;
                }
                statement.run(...(params as any));
                return [];
              } finally {
                if (activeHold !== undefined) {
                  recordPermitStatement(sqlStartedAt);
                }
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, {
                  message: "Failed to execute statement",
                  operation: "execute",
                }),
              }),
          }),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifySqliteError(cause, {
                  message: "Failed to reset statement result mode",
                  operation: "resetResultMode",
                }),
              }),
          }).pipe(Effect.orDie),
      );

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (statement) =>
        runStatementValues(statement, params),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatementValues(statement, params ?? []),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [], false)),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;

  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  const releasePermit = Effect.suspend(() => {
    endPermitHold();
    return semaphore.release(1);
  });

  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => {
        beginPermitHold(fiber.context);
        return Scope.addFinalizer(scope, releasePermit);
      }),
      connection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    options,
    () =>
      new NodeSqlite.DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
      }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new NodeSqlite.DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError | SqlError> =>
  Layer.effect(Client.SqlClient, Config.unwrap(config).pipe(Effect.flatMap(make))).pipe(
    Layer.provide(Reactivity.layer),
  );

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (
  config: SqliteMemoryClientConfig = {},
): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, makeMemory(config)).pipe(Layer.provide(Reactivity.layer));
