#!/usr/bin/env node
/**
 * Live-lifecycle half of the spike for autoprintworks/t3code#28.
 *
 * Two questions the read-only probe cannot answer:
 *
 *   1. Does `session.status` over HTTP move through the same values #7 measured
 *      over the websocket — starting/running while busy, ready at a clean turn
 *      end, stopped after `thread.session.stop`?
 *   2. Does a thread vanish from `shell` the moment it is archived, which is
 *      what `target_exists` keys off?
 *
 * It answers both by driving a whole scratch crewmate **over HTTP alone** —
 * `POST /api/orchestration/dispatch` for every command, `GET .../shell` for
 * every read, no websocket anywhere. If that works, `t3.sh` is curl and jq.
 *
 * Everything it creates it removes: scratch repo in the temp dir, its T3
 * project, and the thread.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const t3Home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const runtime = JSON.parse(
  readFileSync(join(t3Home, "userdata", "server-runtime.json"), "utf8"),
);
const origin = runtime.origin;
const token = readFileSync(join(tmpdir(), "fm-shim-token.txt"), "utf8").trim();
const auth = { authorization: `Bearer ${token}` };

const startedAt = Date.now();
const transcript = [];
const record = (entry) => {
  transcript.push({ at: Date.now() - startedAt, ...entry });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getShell = async () => {
  const res = await fetch(`${origin}/api/orchestration/shell`, { headers: auth });
  return res.json();
};

/** Every command goes through the HTTP route, never the socket. */
const dispatch = async (label, command) => {
  const res = await fetch(`${origin}/api/orchestration/dispatch`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => null);
  const ok = res.status >= 200 && res.status < 300;
  console.log(
    `  [${ok ? "ok " : "REFUSED"}] ${label} -> ${res.status} ${JSON.stringify(body).slice(0, 220)}`,
  );
  record({ kind: "dispatch", label, status: res.status, body });
  return { ok, status: res.status, body };
};

/**
 * Poll the shell until `predicate` holds, logging every distinct status seen.
 * This is exactly the loop `fm_backend_t3_busy_state` would run, so its shape
 * is part of the finding.
 */
const watchUntil = async (label, threadId, predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const shell = await getShell();
    const thread = shell.threads.find((t) => t.id === threadId);
    const seen = thread
      ? `${thread.session?.status ?? "no-session"}/turn=${thread.latestTurn?.state ?? "none"}`
      : "ABSENT";
    if (seen !== last) {
      console.log(`    ${String(Date.now() - startedAt).padStart(6)}ms  ${seen}`);
      record({ kind: "observe", label, seen, thread: thread ?? null });
      last = seen;
    }
    if (predicate(thread, shell)) return { thread, seen };
    await sleep(500);
  }
  console.log(`    [timeout] ${label} never satisfied (last=${last})`);
  record({ kind: "timeout", label, last });
  return { thread: null, seen: last };
};

// ── scratch project ─────────────────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), "fm-http-"));
execFileSync("git", ["init", "-q"], { cwd: scratch });
writeFileSync(join(scratch, "README.md"), "scratch for t3code#28\n");
execFileSync("git", ["add", "-A"], { cwd: scratch });
execFileSync("git", ["-c", "user.email=spike@local", "-c", "user.name=spike", "commit", "-qm", "init"], {
  cwd: scratch,
});
console.log(`[scratch] ${scratch}`);

// #12: a spawn must resolve a concrete {instanceId, model}. Rather than
// re-deriving it, copy what the server already reports for a live thread —
// which is itself a finding: shell hands a backend a known-good selection.
const shell0 = await getShell();
const modelSelection = shell0.threads[0]?.modelSelection;
console.log(`[model] ${JSON.stringify(modelSelection)}`);
console.log(`[shell] ${shell0.threads.length} threads, ${shell0.projects.length} projects`);
record({ kind: "baseline", threads: shell0.threads.length, projects: shell0.projects.length });

const projectId = randomUUID();
const threadId = randomUUID();

console.log("\n=== project.create (over HTTP) ===");
const project = await dispatch("project.create", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `fm-http-${projectId.slice(0, 8)}`,
  workspaceRoot: scratch,
  createdAt: new Date().toISOString(),
});

console.log("\n=== thread.create (over HTTP) ===");
const thread = await dispatch("thread.create", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: `fm-${threadId.slice(0, 8)}`,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: scratch,
  createdAt: new Date().toISOString(),
});

if (project.ok && thread.ok) {
  console.log("\n=== does the new thread appear in shell? ===");
  await watchUntil("appears", threadId, (t) => Boolean(t), 15_000);

  console.log("\n=== turn: busy -> clean end ===");
  await dispatch("thread.turn.start", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: {
      messageId: randomUUID(),
      role: "user",
      text: "Reply with exactly the two characters OK and nothing else. Use no tools.",
      attachments: [],
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  await watchUntil(
    "turn end",
    threadId,
    (t) => ["ready", "idle", "error", "stopped"].includes(t?.session?.status),
    180_000,
  );

  console.log("\n=== thread.session.stop ===");
  await dispatch("thread.session.stop", {
    type: "thread.session.stop",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  });
  await watchUntil("stopped", threadId, (t) => t?.session?.status === "stopped", 60_000);

  console.log("\n=== thread.archive -> does it leave shell? ===");
  await dispatch("thread.archive", {
    type: "thread.archive",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  });
  await watchUntil("absent after archive", threadId, (t) => !t, 30_000);

  const afterArchive = await fetch(`${origin}/api/orchestration/threads/${threadId}`, {
    headers: auth,
  });
  console.log(`  GET threads/${threadId.slice(0, 8)} after archive -> ${afterArchive.status}`);
  record({ kind: "get-after-archive", status: afterArchive.status });

  // #13: archiving twice is refused by requireThreadNotArchived. Does the HTTP
  // route surface that as a non-2xx, or as a 2xx carrying a rejected receipt?
  console.log("\n=== thread.archive again (idempotency shape) ===");
  await dispatch("thread.archive (repeat)", {
    type: "thread.archive",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  });

  // And a command against a thread that is gone as far as reads are concerned.
  console.log("\n=== turn.start against the archived thread (#10's black hole) ===");
  await dispatch("thread.turn.start (archived)", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text: "poke", attachments: [] },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
}

// ── teardown ────────────────────────────────────────────────────────────────
console.log("\n=== teardown ===");
await dispatch("thread.delete", {
  type: "thread.delete",
  commandId: randomUUID(),
  threadId,
  force: true,
});
await dispatch("project.delete", {
  type: "project.delete",
  commandId: randomUUID(),
  projectId,
  force: true,
});
try {
  rmSync(scratch, { recursive: true, force: true });
  console.log(`  [ok] removed ${scratch}`);
} catch (error) {
  console.log(`  [scratch left behind] ${error.code}: ${scratch}`);
}

const finalShell = await getShell();
console.log(
  `[shell] back to ${finalShell.threads.length} threads, ${finalShell.projects.length} projects`,
);

writeFileSync(
  join(import.meta.dirname, "lifecycle-transcript.json"),
  JSON.stringify(transcript, null, 2),
);
console.log("\n[done] transcript written");
