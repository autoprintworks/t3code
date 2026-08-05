#!/usr/bin/env node
/**
 * Sub-question 5 of autoprintworks/t3code#47: what does the captain see?
 *
 * N secondmates means N provider instances, and every enabled instance shows
 * up in the model picker (`apps/web/src/providerInstances.ts:78`). The escape
 * hatch, if there is one, is `enabled: false` — but only if a disabled
 * instance can still *run* a thread. This flips `spike_b` to `enabled: false`
 * on the running server, waits for the settings watcher to reconcile, then
 * tries to drive a full turn against it.
 *
 * Restores `enabled: true` on the way out.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const RIG = process.env.SPIKE_RIG ?? "C:\\Users\\Glyn\\AppData\\Local\\Temp\\fm-inst-spike";
const DUMPS = join(RIG, "dumps");
const SETTINGS = join(RIG, "home", "userdata", "settings.json");
const INSTANCE = "spike_b";
const MODEL = process.env.SPIKE_MODEL ?? "gpt-5.4";

const runtime = JSON.parse(readFileSync(join(RIG, "home", "userdata", "server-runtime.json"), "utf8"));
const origin = runtime.origin;
const token = readFileSync(join(RIG, "token.txt"), "utf8").trim();
const auth = { authorization: `Bearer ${token}` };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const setEnabled = (value) => {
  const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
  settings.providerInstances[INSTANCE].enabled = value;
  settings.providerInstances[INSTANCE].config.enabled = value;
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  console.log(`[settings] ${INSTANCE}.enabled = ${value} at ${new Date().toISOString()}`);
};

setEnabled(false);
console.log("[wait] 6s for the settings watcher + registry reconcile");
await sleep(6000);

const worktree = join(RIG, `sess-${INSTANCE}`);
rmSync(worktree, { recursive: true, force: true });
mkdirSync(worktree, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: worktree });
writeFileSync(join(worktree, "README.md"), "scratch for t3code#47\n");
execFileSync("git", ["add", "-A"], { cwd: worktree });
execFileSync("git", ["-c", "user.email=spike@local", "-c", "user.name=spike", "commit", "-qm", "init"], {
  cwd: worktree,
});

const before = new Set(dumpNames());
const projectId = randomUUID();
const threadId = randomUUID();
const modelSelection = { instanceId: INSTANCE, model: MODEL };

console.log("\n=== can a thread be created against a DISABLED instance? ===");
const project = await dispatch("project.create", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `fm47d-${projectId.slice(0, 8)}`,
  workspaceRoot: worktree,
  createdAt: new Date().toISOString(),
});
const thread = await dispatch("thread.create", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: `fm47d-${threadId.slice(0, 8)}`,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: worktree,
  createdAt: new Date().toISOString(),
});

const observations = [];
if (project.ok && thread.ok) {
  console.log("\n=== can a turn be started against it? ===");
  await dispatch("thread.turn.start", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text: "say OK", attachments: [] },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  const deadline = Date.now() + 60_000;
  let last = null;
  while (Date.now() < deadline) {
    const shell = await getShell();
    const t = shell.threads.find((x) => x.id === threadId);
    const seen = t
      ? `status=${t.session?.status ?? "no-session"} inst=${t.session?.providerInstanceId ?? "-"} err=${(t.session?.lastError ?? "").split("\n")[0].slice(0, 120)}`
      : "ABSENT";
    if (seen !== last) {
      console.log(`  ${seen}`);
      observations.push({ seen, session: t?.session ?? null });
      last = seen;
    }
    if (["ready", "idle", "error", "stopped"].includes(t?.session?.status)) break;
    await sleep(500);
  }
}

const fresh = dumpNames().filter((n) => !before.has(n));
console.log("\n=== dumps written while disabled ===");
const classified = fresh.map((name) => {
  const d = JSON.parse(readFileSync(join(DUMPS, name), "utf8"));
  const kind = d.cwd === worktree ? "SESSION" : "probe";
  console.log(`  [${kind}] ${name} tag=${d.SPIKE_TAG} FM_HOME=${d.FM_HOME} cwd=${d.cwd}`);
  return { name, kind, ...d };
});
if (fresh.length === 0) console.log("  (none)");

console.log("\n=== teardown ===");
await dispatch("thread.session.stop", { type: "thread.session.stop", commandId: randomUUID(), threadId, createdAt: new Date().toISOString() });
await dispatch("thread.archive", { type: "thread.archive", commandId: randomUUID(), threadId, createdAt: new Date().toISOString() });
await dispatch("thread.delete", { type: "thread.delete", commandId: randomUUID(), threadId, force: true });
await dispatch("project.delete", { type: "project.delete", commandId: randomUUID(), projectId, force: true });
setEnabled(true);

writeFileSync(
  join(import.meta.dirname, "disabled-transcript.json"),
  JSON.stringify({ instance: INSTANCE, worktree, observations, dumps: classified }, null, 2),
);
console.log("[done] transcript written");
