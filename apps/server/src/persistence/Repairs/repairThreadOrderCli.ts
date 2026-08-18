#!/usr/bin/env node
/**
 * One-off repair CLI for the thread-order corruption caused by a host clock
 * change (see the "T3 Code: a new reply lands halfway up the thread"
 * diagnosis). Rewrites `created_at` on `projection_thread_messages` and
 * `projection_thread_activities` for rows whose event-store `sequence`
 * order disagrees with their timestamp order.
 *
 * This heals existing damage. It does not stop the corruption from
 * happening again — that is a separate ordering fix (sort transcripts by
 * `sequence`, not wall clock) tracked alongside this repair, not shipped
 * here.
 *
 * Deliberately NOT wired into the `t3` CLI: this is opt-in maintenance the
 * captain runs by hand against an explicit database path, never an
 * automatic migration that touches every install on startup.
 *
 * ## Usage
 *
 * Dry run (default, read-only, reports what WOULD change):
 *
 *   node --experimental-strip-types \
 *     apps/server/src/persistence/Repairs/repairThreadOrderCli.ts \
 *     --db /path/to/state.sqlite
 *
 * Apply for real (writes, wrapped in one transaction):
 *
 *   node --experimental-strip-types \
 *     apps/server/src/persistence/Repairs/repairThreadOrderCli.ts \
 *     --db /path/to/state.sqlite --apply
 *
 * ## Safety
 *
 * Never point this at a database a running T3 Code server has open for
 * writing. Take a read-only snapshot first:
 *
 *   node -e "new (require('node:sqlite').DatabaseSync)('SOURCE', { readOnly: true }).exec(\"VACUUM INTO 'COPY'\")"
 *
 * Verify a dry run against the copy first. Only run --apply against the
 * real database once you are satisfied with the dry-run report, and only
 * while no server has that file open.
 *
 * ## Reversing
 *
 * Every rewritten row keeps its pre-repair timestamp in
 * `created_at_original`. To undo:
 *
 *   UPDATE projection_thread_messages
 *   SET created_at = created_at_original, created_at_original = NULL
 *   WHERE created_at_original IS NOT NULL;
 *
 *   UPDATE projection_thread_activities
 *   SET created_at = created_at_original, created_at_original = NULL
 *   WHERE created_at_original IS NOT NULL;
 */
import * as Effect from "effect/Effect";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { repairThreadOrder, type RepairThreadOrderReport } from "./RepairThreadOrder.ts";

function printUsage(): void {
  console.log(
    [
      "Usage: repairThreadOrderCli.ts --db <path/to/state.sqlite> [--apply]",
      "",
      "  --db <path>   Path to the SQLite database to repair. Required.",
      "  --apply       Write the repair. Without this flag, runs a dry run only.",
      "  --help        Show this message.",
      "",
      "Never point --db at a database a running T3 Code server has open.",
      "Take a copy first (see the file header for the VACUUM INTO command).",
    ].join("\n"),
  );
}

interface ParsedArgs {
  readonly dbPath: string;
  readonly apply: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs | "help" {
  let dbPath: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--db") {
      dbPath = argv[i + 1];
      i++;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    throw new Error(`Unrecognized argument: ${arg}`);
  }
  if (dbPath === undefined || dbPath.length === 0) {
    throw new Error("--db <path> is required.");
  }
  return { dbPath, apply };
}

function formatReport(report: RepairThreadOrderReport): string {
  const lines: string[] = [];
  lines.push(report.dryRun ? "DRY RUN — no rows were written." : "APPLIED — rows were written.");
  lines.push("");
  lines.push(
    `messages:   examined ${report.totalMessagesExamined}, rewritten ${report.totalMessagesRewritten}` +
      (report.messagesSkippedNoGroundTruth > 0
        ? `, skipped (no matching event) ${report.messagesSkippedNoGroundTruth}`
        : ""),
  );
  lines.push(
    `activities: examined ${report.totalActivitiesExamined}, rewritten ${report.totalActivitiesRewritten}` +
      (report.activitiesSkippedNoGroundTruth > 0
        ? `, skipped (no matching event) ${report.activitiesSkippedNoGroundTruth}`
        : ""),
  );
  lines.push("");
  if (report.threads.length === 0) {
    lines.push("No affected threads found.");
  } else {
    lines.push(`Affected threads (${report.threads.length}):`);
    for (const thread of report.threads) {
      lines.push(
        `  ${thread.threadId}: ${thread.messagesRewritten}/${thread.messagesExamined} messages, ` +
          `${thread.activitiesRewritten}/${thread.activitiesExamined} activities`,
      );
    }
  }
  return lines.join("\n");
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    printUsage();
    return;
  }

  const program = Effect.gen(function* () {
    const report = yield* repairThreadOrder({ dryRun: !parsed.apply });
    console.log(formatReport(report));
  });

  Effect.runPromise(
    Effect.scoped(
      program.pipe(
        Effect.provide(
          NodeSqliteClient.layer({
            filename: parsed.dbPath,
            // Belt and braces: a dry run cannot write even if a future edit
            // to the repair logic accidentally tries to.
            readonly: !parsed.apply,
          }),
        ),
      ),
    ),
  ).catch((error: unknown) => {
    console.error("repair-thread-order failed:", error);
    process.exitCode = 1;
  });
}

if (import.meta.main) {
  main();
}
