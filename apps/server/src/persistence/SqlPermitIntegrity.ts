/**
 * SQL permit hold budget.
 *
 * There is one SQLite connection and one permit for it, so every transaction is
 * exclusive. A transaction body that yields to the scheduler keeps the permit
 * while doing nothing, and every other transaction waits behind it. This module
 * watches {@link observeSqlPermits} and fails when a hold exceeds its budget.
 *
 * This is the runtime alternative to typing transaction bodies as synchronous.
 * It catches the same regressions without touching any call site.
 */
import {
  observeSqlPermits,
  type SqlPermitHold,
  type SqlPermitObserver,
} from "./NodeSqliteClient.ts";

/**
 * Budget for one transaction permit hold, in milliseconds.
 *
 * Measured, not guessed. `ShellStall.test.ts` runs the real shell read over an
 * 817 MB copy of a real database, returning 5 projects and 110 threads. Across
 * nine measured reads the transaction held the permit for 4.3 ms to 8.5 ms, of
 * which 0.8 ms to 1.3 ms was SQL, over 7 statements. In-memory transactions in
 * `SqlPermitIntegrity.test.ts` finish in under 5 ms.
 *
 * 50 ms is therefore about six times the slowest healthy hold seen. A hold
 * above it is not slow SQL: it is a body that yielded and left the one
 * connection idle while every other transaction waited. That is worth a stack.
 */
export const DEFAULT_SQL_PERMIT_BUDGET_MS = 50;

export interface SqlPermitReport {
  readonly budgetMs: number;
  readonly holdCount: number;
  readonly worstHoldMs: number;
  readonly totalHoldMs: number;
  readonly totalSqlMs: number;
  readonly statements: number;
  readonly holdsOverBudget: number;
  /** Worst holds first, capped by `retainHolds`. */
  readonly holds: ReadonlyArray<SqlPermitHold>;
}

export interface SqlPermitWatchOptions {
  readonly budgetMs?: number;
  readonly retainHolds?: number;
  /**
   * Capture a stack for every hold. On by default, because a hold over budget
   * is worth naming. An always-on watcher that only reports numbers should
   * turn it off.
   */
  readonly captureStacks?: boolean;
  /** Called as each hold completes. Use to fail fast rather than at the end. */
  readonly onHold?: SqlPermitObserver;
}

export interface SqlPermitWatch {
  readonly report: () => SqlPermitReport;
  readonly stop: () => SqlPermitReport;
}

/**
 * Start recording transaction permit holds. Always call `stop()`: the observer
 * is process-wide and only one can be attached at a time.
 */
export const watchSqlPermits = (options: SqlPermitWatchOptions = {}): SqlPermitWatch => {
  const budgetMs = options.budgetMs ?? DEFAULT_SQL_PERMIT_BUDGET_MS;
  const retainHolds = options.retainHolds ?? 16;

  let holdCount = 0;
  let worstHoldMs = 0;
  let totalHoldMs = 0;
  let totalSqlMs = 0;
  let statements = 0;
  let holdsOverBudget = 0;
  const holds: Array<SqlPermitHold> = [];

  const detach = observeSqlPermits(
    (hold) => {
      holdCount += 1;
      totalHoldMs += hold.holdMs;
      totalSqlMs += hold.sqlMs;
      statements += hold.statements;
      if (hold.holdMs > worstHoldMs) {
        worstHoldMs = hold.holdMs;
      }
      if (hold.holdMs > budgetMs) {
        holdsOverBudget += 1;
      }
      holds.push(hold);
      if (holds.length > retainHolds) {
        holds.sort((left, right) => right.holdMs - left.holdMs);
        holds.length = retainHolds;
      }
      options.onHold?.(hold);
    },
    { captureStacks: options.captureStacks ?? true },
  );

  let stopped = false;

  const buildReport = (): SqlPermitReport => ({
    budgetMs,
    holdCount,
    worstHoldMs,
    totalHoldMs,
    totalSqlMs,
    statements,
    holdsOverBudget,
    holds: [...holds].sort((left, right) => right.holdMs - left.holdMs),
  });

  return {
    report: buildReport,
    stop: () => {
      if (!stopped) {
        stopped = true;
        detach();
      }
      return buildReport();
    },
  };
};

/** Thrown when a transaction held the single SQL permit past its budget. */
export class SqlPermitOverBudgetError extends Error {
  override readonly name = "SqlPermitOverBudgetError";
  readonly report: SqlPermitReport;
  readonly hold: SqlPermitHold;

  constructor(message: string, report: SqlPermitReport, hold: SqlPermitHold, stack: string) {
    super(message);
    this.report = report;
    this.hold = hold;
    this.stack = stack;
  }
}

const roundMs = (value: number): number => Math.round(value * 10) / 10;

export const formatSqlPermitReport = (report: SqlPermitReport): string =>
  `${report.holdCount} permit holds, worst ${roundMs(report.worstHoldMs)} ms ` +
  `(sql ${roundMs(report.totalSqlMs)} ms over ${report.statements} statements), ` +
  `holds over ${report.budgetMs} ms: ${report.holdsOverBudget}`;

export const formatSqlPermitHold = (hold: SqlPermitHold): string =>
  `held ${roundMs(hold.holdMs)} ms, sql ${roundMs(hold.sqlMs)} ms over ` +
  `${hold.statements} statements, idle ${roundMs(hold.holdMs - hold.sqlMs)} ms`;

/**
 * Render the hold's origin as a stack.
 *
 * Effect span names come first, because on a path that opens spans they name
 * the caller exactly. Most of this server's read paths open no span, so the JS
 * stack is the usual answer. It is filtered but never emptied: the permit is
 * taken inside the fiber loop, so the frames that survive name whatever
 * resumed the fiber, which is the next best thing to the caller.
 */
const formatOrigin = (hold: SqlPermitHold): string => {
  if (hold.origin.length > 0) {
    return hold.origin.map((name) => `    at ${name}`).join("\n");
  }
  const frames = hold.stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "));
  const interesting = frames.filter(
    (line) => !line.includes("NodeSqliteClient.ts") && !line.includes("/effect/dist/"),
  );
  return (interesting.length > 0 ? interesting : frames)
    .slice(0, 12)
    .map((line) => `    ${line}`)
    .join("\n");
};

export interface SqlPermitAssertion {
  readonly budgetMs?: number;
  readonly label?: string;
}

/**
 * Throw {@link SqlPermitOverBudgetError} if any hold exceeded the budget. The
 * thrown error's stack names the transaction that held it.
 */
export const assertSqlPermitIntegrity = (
  report: SqlPermitReport,
  options: SqlPermitAssertion = {},
): void => {
  const budgetMs = options.budgetMs ?? report.budgetMs;
  const label = options.label ?? "sql permit";
  const worst = report.holds[0];
  if (worst === undefined || worst.holdMs <= budgetMs) {
    return;
  }
  const message =
    `${label}: transaction held the sql permit for ${roundMs(worst.holdMs)} ms ` +
    `(budget ${budgetMs} ms). ${formatSqlPermitHold(worst)}`;
  throw new SqlPermitOverBudgetError(
    message,
    report,
    worst,
    `SqlPermitOverBudgetError: ${message}\n${formatOrigin(worst)}`,
  );
};
