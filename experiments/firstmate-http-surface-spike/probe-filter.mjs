#!/usr/bin/env node
/**
 * Second read-only probe for autoprintworks/t3code#28.
 *
 * The first probe found `GET /api/orchestration/shell` returning exactly one
 * thread against 28 projects, which means the route filters. `target_exists`
 * keys off absence, so what gets filtered out is the whole question: a live
 * idle crewmate that shell omits would read as gone.
 *
 * This picks real thread ids straight out of the live state database (opened
 * read-only, never written) and asks the HTTP surface about each class:
 * active, archived, deleted. No server mutation.
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const t3Home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const runtime = JSON.parse(
  readFileSync(join(t3Home, "userdata", "server-runtime.json"), "utf8"),
);
const origin = runtime.origin;
const token = readFileSync(join(tmpdir(), "fm-shim-token.txt"), "utf8").trim();
const bearer = { headers: { authorization: `Bearer ${token}` } };

const db = new DatabaseSync(join(t3Home, "userdata", "state.sqlite"), {
  readOnly: true,
});

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((row) => row.name);
console.log(`[db] tables: ${tables.join(", ")}`);

const threadTable = "projection_threads";
console.log(`[db] thread table: ${threadTable}`);
const columns = db.prepare(`PRAGMA table_info(${threadTable})`).all().map((c) => c.name);
console.log(`[db] columns: ${columns.join(", ")}`);

const counts = db
  .prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN archived_at IS NULL AND deleted_at IS NULL THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived,
       SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted
     FROM ${threadTable}`,
  )
  .get();
console.log(`[db] threads: ${JSON.stringify(counts)}`);

const pick = (where) =>
  db
    .prepare(
      `SELECT thread_id AS id, title, archived_at, deleted_at FROM ${threadTable} WHERE ${where} ORDER BY updated_at DESC LIMIT 3`,
    )
    .all();

const classes = {
  active: pick("archived_at IS NULL AND deleted_at IS NULL"),
  archived: pick("archived_at IS NOT NULL AND deleted_at IS NULL"),
  deleted: pick("deleted_at IS NOT NULL"),
};

const shell = await (await fetch(`${origin}/api/orchestration/shell`, bearer)).json();
const shellIds = new Set(shell.threads.map((t) => t.id));
console.log(`\n[shell] returned ${shell.threads.length} threads, ${shell.projects.length} projects`);

for (const [label, rows] of Object.entries(classes)) {
  console.log(`\n=== ${label} (${rows.length} sampled) ===`);
  for (const row of rows) {
    const res = await fetch(`${origin}/api/orchestration/threads/${row.id}`, bearer);
    const body = await res.json();
    console.log(
      `  ${row.id} "${row.title}" inShell=${shellIds.has(row.id)} GET=${res.status} ${
        res.status === 200
          ? `session=${JSON.stringify(body.thread?.session)} archivedAt=${body.thread?.archivedAt}`
          : JSON.stringify(body).slice(0, 160)
      }`,
    );
  }
}

// Latency matters: busy_state is polled, snapshot is not.
console.log("\n=== latency (5 runs each) ===");
for (const path of ["/api/orchestration/shell", "/api/orchestration/snapshot"]) {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const started = Date.now();
    const res = await fetch(`${origin}${path}`, bearer);
    await res.arrayBuffer();
    times.push(Date.now() - started);
  }
  console.log(`  ${path}: ${times.join("ms, ")}ms`);
}

db.close();
console.log("\n[done]");
