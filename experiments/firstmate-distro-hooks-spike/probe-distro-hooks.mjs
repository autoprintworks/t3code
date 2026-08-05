#!/usr/bin/env node
/**
 * Live probe for autoprintworks/t3code#31.
 *
 * #4 answered the harness half of "does the first mate instantiate inside a T3
 * thread?" but was retargeted mid-flight from the firstmate distro to t3code,
 * so it never measured the distro's own `.claude/settings.json` hooks. #6
 * covered the Stop hook alone. This probe covers the rest of the surface, live,
 * in a real T3 thread rooted at the distro:
 *
 *   - SessionStart  -> bin/fm-sessionstart-nudge.sh
 *   - PreToolUse/Bash -> bin/fm-arm-pretool-check.sh, bin/fm-cd-pretool-check.sh
 *   - PreToolUse/.*   -> bin/fm-subagent-pretool-check.sh
 *
 * Every one of those three scripts was run by hand first (see README) so its
 * verdict in *this* environment is known. That is what lets a silent hook be
 * told apart from a hook that never fired.
 *
 * Everything runs over HTTP alone, per #28. The thread is archived at the end,
 * per #13's forced stop-then-archive order; the distro's T3 project is left
 * alone because deleting it would cascade into the captain's own threads.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DISTRO = "C:/00_AI_Development/firstmate-claude-code";
const OUT = import.meta.dirname;

const t3Home = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const runtime = JSON.parse(
  readFileSync(join(t3Home, "userdata", "server-runtime.json"), "utf8"),
);
const origin = runtime.origin;
const token = readFileSync(join(tmpdir(), "fm-shim-token.txt"), "utf8").trim();
const auth = { authorization: `Bearer ${token}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startedAt = Date.now();
const transcript = [];
const record = (e) => transcript.push({ at: Date.now() - startedAt, ...e });

const getShell = async () =>
  (await fetch(`${origin}/api/orchestration/shell`, { headers: auth })).json();

const getThread = async (id) => {
  const res = await fetch(`${origin}/api/orchestration/threads/${id}`, {
    headers: auth,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const dispatch = async (label, command) => {
  const res = await fetch(`${origin}/api/orchestration/dispatch`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => null);
  const ok = res.status >= 200 && res.status < 300;
  console.log(`  [${ok ? "ok " : "REFUSED"}] ${label} -> ${res.status}`);
  record({ kind: "dispatch", label, status: res.status, body });
  return { ok, status: res.status, body };
};

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
      record({ kind: "observe", label, seen });
      last = seen;
    }
    if (predicate(thread, shell)) return { thread, seen };
    await sleep(1000);
  }
  console.log(`    [timeout] ${label} (last=${last})`);
  record({ kind: "timeout", label, last });
  return { thread: null, seen: last };
};

// ── the probe brief the thread runs ─────────────────────────────────────────
const BRIEF = `You are a measurement probe for autoprintworks/t3code issue #31. Do NOT do any firstmate work, do not classify this as an intake, and do not spawn anything.

Three of the probes below are EXPECTED to be blocked by a hook. A block IS the result: record the exact blocking message verbatim and move straight on. Do not retry, do not work around a block, do not reach the same goal another way.

Answer 0 from what is ALREADY in your context, before running anything:

0. Did you receive, ahead of this message, any instruction containing the text "FIRSTMATE_OP" or "session-start"? Quote it verbatim, or write ABSENT.

Then:

1. Run Bash: pkill -f fm-watch
2. Run Bash: cd projects/foo
3. Use the Task tool once (any subagent type, prompt "say hi").
4. List every skill available to you this session. State explicitly, one per line, whether each of these is present: afk, ahoy, ask-user-authority, bearings, bootstrap-diagnostics, decision-hold-lifecycle, diagnostic-reasoning, firstmate-codexapp, firstmate-coding-guidelines, firstmate-orca, fmx-respond, harness-adapters, project-management, quota-array-dispatch, secondmate-provisioning, shelve, stow, stuck-crewmate-recovery, updatefirstmate.
5. Is the content of AGENTS.md in your context? (CLAUDE.md is a symlink to it.) Quote its first heading and its first sentence.
6. Run: bash bin/fm-session-start.sh ; echo "EXIT=$?" — record the complete output and the exit code.
7. Run: echo "PROJECT_DIR=[$CLAUDE_PROJECT_DIR] ENTRYPOINT=[$CLAUDE_CODE_ENTRYPOINT] PWD=[$PWD] FM_HOME=[$FM_HOME]" ; claude --version

Finally, use the Write tool to save the whole report as markdown to this absolute path:
C:/00_AI_Development/t3code/experiments/firstmate-distro-hooks-spike/observed.md

Then reply with just: DONE`;

// ── resolve the distro's T3 project (#11: derive, never cache) ──────────────
const norm = (p) => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
const shell0 = await getShell();
const modelSelection = shell0.threads[0]?.modelSelection;
console.log(`[model] ${JSON.stringify(modelSelection)}`);

let project = shell0.projects.find((p) => norm(p.workspaceRoot ?? "") === norm(DISTRO));
let projectId = project?.id;
if (projectId) {
  console.log(`[project] adopted existing ${projectId} (${project.title})`);
  record({ kind: "project", mode: "adopted", projectId });
} else {
  projectId = randomUUID();
  console.log(`[project] none for ${DISTRO}; creating ${projectId}`);
  const created = await dispatch("project.create", {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: "firstmate-claude-code",
    workspaceRoot: DISTRO,
    createdAt: new Date().toISOString(),
  });
  if (!created.ok) {
    console.log("[abort] could not create the project");
    process.exit(1);
  }
  record({ kind: "project", mode: "created", projectId });
}

// ── thread ──────────────────────────────────────────────────────────────────
const threadId = randomUUID();
console.log("\n=== thread.create on the distro ===");
const thread = await dispatch("thread.create", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: `fm-hooks-probe-${threadId.slice(0, 8)}`,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: DISTRO,
  createdAt: new Date().toISOString(),
});
if (!thread.ok) {
  console.log("[abort] thread.create refused");
  process.exit(1);
}
await watchUntil("appears", threadId, (t) => Boolean(t), 20_000);

console.log("\n=== turn.start: the probe brief ===");
await dispatch("thread.turn.start", {
  type: "thread.turn.start",
  commandId: randomUUID(),
  threadId,
  message: {
    messageId: randomUUID(),
    role: "user",
    text: BRIEF,
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
  900_000,
);

// ── capture the hydrated transcript ─────────────────────────────────────────
console.log("\n=== GET threads/:id (hydrated detail) ===");
const detail = await getThread(threadId);
console.log(`  status ${detail.status}`);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "thread-detail.json"), JSON.stringify(detail.body, null, 2));
writeFileSync(join(OUT, "probe-transcript.json"), JSON.stringify(transcript, null, 2));
writeFileSync(join(OUT, "thread-id.txt"), `${threadId}\n${projectId}\n`);
console.log("[done] thread-detail.json, probe-transcript.json, thread-id.txt written");
console.log(`[thread] ${threadId}  [project] ${projectId}`);
console.log("Teardown is deliberately NOT run here — inspect the thread in the GUI first.");
