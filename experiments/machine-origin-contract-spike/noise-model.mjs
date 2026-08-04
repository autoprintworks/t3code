#!/usr/bin/env node
/**
 * The client-half half of the spike for autoprintworks/t3code#20.
 *
 * #20 measures the *cost* of machine traffic in a transcript (75% of the user's
 * side, 3 rows per poke, one minimap entry each) and then leaves the client half
 * open: style, collapse, hide, exclude from the minimap, "or some mix". What it
 * does not say is what any of those policies would actually *recover*, and that
 * turns out to decide whether one field on the message is enough.
 *
 * This replays the real 15-row transcript captured by the #10 spike
 * (`../firstmate-watcher-poke-spike/findings.json`) through three candidate
 * client policies and reports, for each: rows removed, characters removed, and
 * — the number that matters — how many assistant rows are left behind with no
 * visible prompt.
 *
 * It also runs the adjacency heuristic a client would reach for if it wanted to
 * hide a poke's reply without a real prompt-to-reply link, and checks it against
 * the turn ids recorded in the same run.
 *
 * Zero dependencies; reads only committed spike data.
 *
 * Usage:
 *   node noise-model.mjs [--json <path>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({ options: { json: { type: "string" } } });

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, "..", "firstmate-watcher-poke-spike", "findings.json");
const run = JSON.parse(readFileSync(source, "utf8"));

const rows = run.transcript.map((row, index) => ({
  index,
  role: row.role,
  machine: row.carriesOperationalMark === true,
  chars: row.chars,
}));

// The stream carries turn ids; the transcript does not. Assistant rows appear in
// the stream twice (a streaming partial then the final), so collapse to the
// distinct turn ids in order to recover which turn produced which final row.
const assistantTurnOrder = [];
for (const event of run.stream) {
  if (event.type !== "thread.message-sent") continue;
  if (event.payload.role !== "assistant") continue;
  const turnId = event.payload.turnId;
  if (turnId && assistantTurnOrder.at(-1) !== turnId) assistantTurnOrder.push(turnId);
}

// The turn-start request names the message it came from, so the true
// prompt-to-reply pairing is recoverable *here*, from the raw run. The point of
// the exercise is that it is not recoverable in the read model a client sees.
const assistantRows = rows.filter((row) => row.role === "assistant");
assistantRows.forEach((row, ordinal) => {
  row.turnId = assistantTurnOrder[ordinal] ?? null;
});

// Ground truth for "which prompt is this a reply to", taken from the run's own
// ordering of accepted turns rather than from row adjacency.
const userRows = rows.filter((row) => row.role === "user");
const answeredUserRows = userRows.filter((row) => {
  // The archived poke was accepted and then silently dropped (#10's black hole),
  // so it is the one user row in this run that never produced a turn.
  return !(row.machine && rows[row.index + 1]?.role === "user");
});
answeredUserRows.forEach((row, ordinal) => {
  const reply = assistantRows[ordinal];
  if (reply) reply.promptIndex = row.index;
});

const total = {
  rows: rows.length,
  chars: rows.reduce((sum, row) => sum + row.chars, 0),
  userRows: userRows.length,
  machineRows: userRows.filter((row) => row.machine).length,
};

function evaluate(name, description, hidden) {
  const hiddenSet = new Set(hidden);
  const visible = rows.filter((row) => !hiddenSet.has(row.index));
  const orphans = visible.filter(
    (row) =>
      row.role === "assistant" && row.promptIndex !== undefined && hiddenSet.has(row.promptIndex),
  );
  return {
    name,
    description,
    rowsRemoved: hiddenSet.size,
    rowsRemovedPct: Math.round((hiddenSet.size / total.rows) * 100),
    charsRemoved: rows.filter((row) => hiddenSet.has(row.index)).reduce((s, r) => s + r.chars, 0),
    rowsRemaining: visible.length,
    orphanedAssistantRows: orphans.length,
    orphanedPctOfRemaining: Math.round((orphans.length / visible.length) * 100),
    minimapEntriesRemaining: visible.filter((row) => row.role === "user").length,
  };
}

const machineUserIndexes = rows.filter((row) => row.machine).map((row) => row.index);
const repliesToMachine = assistantRows
  .filter((row) => row.promptIndex !== undefined && rows[row.promptIndex].machine)
  .map((row) => row.index);

const policies = [
  evaluate(
    "A: hide machine user rows",
    "Exactly what one optional origin field on the message enables today.",
    machineUserIndexes,
  ),
  evaluate(
    "B: hide machine rows and their replies",
    "What a reader actually wants. Requires a prompt-to-reply link.",
    [...machineUserIndexes, ...repliesToMachine],
  ),
  evaluate("C: minimap only", "Keep every row, drop machine rows from the navigation rail.", []),
];
policies[2].minimapEntriesRemaining = userRows.filter((row) => !row.machine).length;

// --- Can a client fake policy B without a link? ---
// The obvious heuristic: an assistant row replies to the nearest preceding user
// row. Check it against the run's real pairing.
const adjacency = assistantRows.map((row) => {
  let nearest = null;
  for (let index = row.index - 1; index >= 0; index -= 1) {
    if (rows[index].role === "user") {
      nearest = index;
      break;
    }
  }
  return { assistantRow: row.index, guessed: nearest, actual: row.promptIndex ?? null };
});
const adjacencyWrong = adjacency.filter((pair) => pair.guessed !== pair.actual);

const report = {
  source: "experiments/firstmate-watcher-poke-spike/findings.json",
  total,
  policies,
  adjacencyHeuristic: {
    pairs: adjacency.length,
    misattributed: adjacencyWrong.length,
    detail: adjacencyWrong,
  },
};

console.log(`transcript: ${total.rows} rows, ${total.chars} chars`);
console.log(`user rows: ${total.userRows}, of which machine: ${total.machineRows}\n`);
for (const policy of policies) {
  console.log(policy.name);
  console.log(`  ${policy.description}`);
  console.log(
    `  removes ${policy.rowsRemoved}/${total.rows} rows (${policy.rowsRemovedPct}%), ` +
      `${policy.charsRemoved} chars`,
  );
  console.log(
    `  leaves ${policy.rowsRemaining} rows, ${policy.orphanedAssistantRows} of them orphaned ` +
      `(${policy.orphanedPctOfRemaining}% of what remains)`,
  );
  console.log(`  minimap entries remaining: ${policy.minimapEntriesRemaining}\n`);
}
console.log(
  `adjacency heuristic: ${adjacencyWrong.length}/${adjacency.length} replies misattributed`,
);
for (const pair of adjacencyWrong) {
  console.log(`  row ${pair.assistantRow}: guessed prompt ${pair.guessed}, actual ${pair.actual}`);
}

if (flags.json) {
  writeFileSync(flags.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwrote ${flags.json}`);
}
