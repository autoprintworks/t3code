#!/usr/bin/env node
/**
 * Read-only half of the spike for autoprintworks/t3code#28.
 *
 * #15 read the HTTP orchestration surface out of source only. This hits it for
 * real against the installed desktop server and prints exactly what comes back,
 * so `t3.sh` can be written against measured shape rather than inferred shape.
 *
 * Nothing here mutates the server: four GETs and a handful of unauthenticated
 * probes to establish what credential each route actually wants.
 *
 * Usage: node probe-read.mjs [--token-file <path>]
 */
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: { "token-file": { type: "string" } },
});

const t3Home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const runtime = JSON.parse(
  readFileSync(join(t3Home, "userdata", "server-runtime.json"), "utf8"),
);
const origin = runtime.origin;
const token = readFileSync(
  flags["token-file"] ?? join(tmpdir(), "fm-shim-token.txt"),
  "utf8",
).trim();

console.log(`[discover] ${origin} (pid ${runtime.pid})`);

/** One request, reported the way a shell backend would see it: status first. */
const probe = async (label, path, init = {}) => {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${origin}${path}`, init);
  } catch (error) {
    console.log(`[${label}] NETWORK ERROR ${error.message}`);
    return { error };
  }
  const ms = Date.now() - started;
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  console.log(
    `[${label}] ${res.status} ${res.statusText} ${ms}ms content-type=${res.headers.get("content-type")}`,
  );
  return { status: res.status, body, ms };
};

const bearer = { headers: { authorization: `Bearer ${token}` } };

// ── Q5: what credential does the HTTP route actually want? ──────────────────
console.log("\n=== credential ===");
const anon = await probe("shell/anon", "/api/orchestration/shell");
console.log(`  body: ${JSON.stringify(anon.body)}`);
const badToken = await probe("shell/bad-token", "/api/orchestration/shell", {
  headers: { authorization: "Bearer not-a-real-token" },
});
console.log(`  body: ${JSON.stringify(badToken.body)}`);
const queryToken = await probe(
  "shell/query-token",
  `/api/orchestration/shell?token=${encodeURIComponent(token)}`,
);
const withBearer = await probe("shell/bearer", "/api/orchestration/shell", bearer);

// ── Q1: shape of GET /api/orchestration/shell ───────────────────────────────
console.log("\n=== shell ===");
const shell = withBearer.body;
console.log(`top-level keys: ${JSON.stringify(Object.keys(shell ?? {}))}`);
const threads = Array.isArray(shell) ? shell : (shell?.threads ?? []);
console.log(`threads: ${threads.length}`);
for (const thread of threads.slice(0, 6)) {
  console.log(`  - ${JSON.stringify(thread)}`);
}
if (threads[0]) {
  console.log(`thread keys: ${JSON.stringify(Object.keys(threads[0]))}`);
  if (threads[0].session) {
    console.log(`session keys: ${JSON.stringify(Object.keys(threads[0].session))}`);
  }
}

// ── Q4: snapshot, and the workspaceRoot keying #11 depends on ───────────────
console.log("\n=== snapshot ===");
const snapshot = await probe("snapshot", "/api/orchestration/snapshot", bearer);
const snap = snapshot.body;
console.log(`top-level keys: ${JSON.stringify(Object.keys(snap ?? {}))}`);
const projects = snap?.projects ?? [];
console.log(`projects: ${projects.length}`);
for (const project of projects) {
  console.log(
    `  - id=${project.id} workspaceRoot=${JSON.stringify(project.workspaceRoot)} keys=${JSON.stringify(Object.keys(project))}`,
  );
}

// ── threads/:id, the per-thread read a backend would use for one target ─────
console.log("\n=== threads/:id ===");
if (threads[0]?.threadId ?? threads[0]?.id) {
  const id = threads[0].threadId ?? threads[0].id;
  const one = await probe("thread", `/api/orchestration/threads/${id}`, bearer);
  console.log(`  ${JSON.stringify(one.body).slice(0, 1200)}`);
} else {
  console.log("  (no live thread to read)");
}
const missing = await probe(
  "thread/missing",
  "/api/orchestration/threads/00000000-0000-4000-8000-000000000000",
  bearer,
);
console.log(`  body: ${JSON.stringify(missing.body).slice(0, 400)}`);

console.log("\n[done]");
