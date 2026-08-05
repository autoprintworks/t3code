#!/usr/bin/env node
/**
 * Session half of the spike for autoprintworks/t3code#47.
 *
 * The rig's first measurement caught the codex **status probe** spawn, which
 * uses `extendEnv: true` and therefore proves nothing about the trap named in
 * the issue. The trap lives on the **session** path
 * (`CodexSessionRuntime.ts:736`, `const extendEnv = options.environment ===
 * undefined`), which is a different spawn with different semantics.
 *
 * This drives a real thread turn against a thread pinned to the custom
 * provider instance `spike_a`, and reads back the child's own view of its
 * environment through the `--require` hook wired into the instance's
 * `NODE_OPTIONS`. The two spawns are told apart by `cwd`: the probe inherits
 * the server's cwd, the session gets the thread's `worktreePath`.
 *
 * The turn is expected to fail — `node.exe` is not codex — but the failure
 * happens *after* the spawn, which is all this needs.
 *
 * Run `setup.mjs` first. Everything it creates it removes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const RIG = process.env.SPIKE_RIG ?? "C:\\Users\\Glyn\\AppData\\Local\\Temp\\fm-inst-spike";
const DUMPS = join(RIG, "dumps");
const INSTANCE = process.env.SPIKE_INSTANCE ?? "spike_a";
const MODEL = process.env.SPIKE_MODEL ?? "gpt-5.4";

const runtime = JSON.parse(readFileSync(join(RIG, "home", "userdata", "server-runtime.json"), "utf8"));
const origin = runtime.origin;
const token = readFileSync(join(RIG, "token.txt"), "utf8").trim();
const auth = { authorization: `Bearer ${token}` };

const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = () => String(Date.now() - started).padStart(6);

const getShell = async () =>
  (await fetch(`${origin}/api/orchestration/shell`, { headers: auth })).json();

const dispatch = async (label, command) => {
  const res = await fetch(`${origin}/api/orchestration/dispatch`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => null);
  console.log(`  [${res.ok ? "ok " : "REFUSED"}] ${label} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return { ok: res.ok, status: res.status, body };
};

const dumpNames = () => (existsSync(DUMPS) ? readdirSync(DUMPS) : []);
const readDump = (name) => JSON.parse(readFileSync(join(DUMPS, name), "utf8"));

// A dedicated worktree, distinct from the server's cwd, so the session spawn's
// dump is distinguishable from the periodic status probe's dump.
const worktree = join(RIG, `sess-${INSTANCE}`);
rmSync(worktree, { recursive: true, force: true });
mkdirSync(worktree, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: worktree });
writeFileSync(join(worktree, "README.md"), "scratch for t3code#47\n");
execFileSync("git", ["add", "-A"], { cwd: worktree });
execFileSync("git", ["-c", "user.email=spike@local", "-c", "user.name=spike", "commit", "-qm", "init"], {
  cwd: worktree,
});
console.log(`[worktree] ${worktree}`);
console.log(`[origin]   ${origin}`);
console.log(`[pinned]   instanceId=${INSTANCE} model=${MODEL}`);

const before = new Set(dumpNames());
console.log(`[dumps]    ${before.size} present before the turn`);

const projectId = randomUUID();
const threadId = randomUUID();
const modelSelection = { instanceId: INSTANCE, model: MODEL };

console.log("\n=== project.create / thread.create pinned to the custom instance ===");
const project = await dispatch("project.create", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `fm47-${projectId.slice(0, 8)}`,
  workspaceRoot: worktree,
  createdAt: new Date().toISOString(),
});
const thread = await dispatch("thread.create", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: `fm47-${threadId.slice(0, 8)}`,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: worktree,
  createdAt: new Date().toISOString(),
});

const observations = [];
if (project.ok && thread.ok) {
  console.log("\n=== thread.turn.start ===");
  const turn = await dispatch("thread.turn.start", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text: "say OK", attachments: [] },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });

  // Sub-question 4 lives in this loop: does the polled read still report the
  // pinned instance and a sane busy state?
  console.log("\n=== polled shell (sub-question 4) ===");
  const deadline = Date.now() + 90_000;
  let last = null;
  let sawNewDump = false;
  while (Date.now() < deadline) {
    const shell = await getShell();
    const t = shell.threads.find((x) => x.id === threadId);
    const seen = t
      ? `status=${t.session?.status ?? "no-session"} inst=${t.session?.providerInstanceId ?? "-"} ` +
        `sel=${t.modelSelection?.instanceId ?? "-"} turn=${t.latestTurn?.state ?? "none"} ` +
        `appr=${t.hasPendingApprovals} input=${t.hasPendingUserInput}`
      : "ABSENT";
    if (seen !== last) {
      console.log(`  ${el()}ms  ${seen}`);
      observations.push({ at: Date.now() - started, seen, session: t?.session ?? null, thread: t ?? null });
      last = seen;
    }
    const fresh = dumpNames().filter((n) => !before.has(n));
    if (fresh.length > 0 && !sawNewDump) {
      console.log(`  ${el()}ms  new dump files: ${fresh.join(", ")}`);
      sawNewDump = true;
    }
    if (["ready", "idle", "error", "stopped"].includes(t?.session?.status)) break;
    await sleep(500);
  }
  console.log(`  turn.start dispatch status=${turn.status}`);
}

console.log("\n=== dumps written during this run ===");
const fresh = dumpNames().filter((n) => !before.has(n));
const classified = fresh.map((name) => {
  const d = readDump(name);
  const kind = d.cwd === worktree ? "SESSION" : "probe";
  console.log(
    `  [${kind}] ${name} cwd=${d.cwd}\n            argv=${JSON.stringify(d.argv)}\n` +
      `            FM_HOME=${d.FM_HOME} hasPATH=${d.hasPATH} pathLen=${d.pathLen} envKeys=${d.envKeyCount} hostVars=${JSON.stringify(d.sampleHostVars)}`,
  );
  return { name, kind, ...d };
});
if (!classified.some((d) => d.kind === "SESSION")) {
  console.log("  [!] no dump with the thread worktree as cwd — the session spawn was not observed");
}

console.log("\n=== teardown ===");
await dispatch("thread.session.stop", {
  type: "thread.session.stop",
  commandId: randomUUID(),
  threadId,
  createdAt: new Date().toISOString(),
});
await dispatch("thread.archive", {
  type: "thread.archive",
  commandId: randomUUID(),
  threadId,
  createdAt: new Date().toISOString(),
});
await dispatch("thread.delete", { type: "thread.delete", commandId: randomUUID(), threadId, force: true });
await dispatch("project.delete", { type: "project.delete", commandId: randomUUID(), projectId, force: true });

writeFileSync(
  join(import.meta.dirname, `session-transcript-${INSTANCE}.json`),
  JSON.stringify({ instance: INSTANCE, model: MODEL, worktree, observations, dumps: classified }, null, 2),
);
console.log("[done] transcript written");
