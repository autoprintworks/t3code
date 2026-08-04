#!/usr/bin/env node
/**
 * Third probe for autoprintworks/t3code#6.
 *
 * firstmate's real Stop entry is not the trivial one the main spike used: it
 * carries `asyncRewake: true` and `timeout: 28800` on
 * `fm-claude-stop-autoarm.sh`. The ticket flags this as a further
 * SDK-support question — a hook that fires with a plain config but whose
 * settings block is rejected (or whose extra keys are dropped) once those two
 * fields are present would still break firstmate's supervision.
 *
 * This registers the Stop hook exactly as firstmate does and runs one clean
 * turn. Boilerplate is duplicated from the sibling probes on purpose: each is
 * standalone and runnable without the others.
 *
 * Usage: T3_TOKEN=<bearer> node async-rewake-probe.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const token = process.env.T3_TOKEN?.trim();
if (!token) throw new Error("No bearer token: set T3_TOKEN.");
const log = (...p) => console.log(...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { origin } = JSON.parse(readFileSync(join(T3_HOME, "userdata", "server-runtime.json"), "utf8"));
const { ticket } = await (
  await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  })
).json();
const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`);
const pending = new Map();
let n = 1;
const rpc = (tag, payload) =>
  new Promise((resolve, reject) => {
    const id = String(n++);
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  });
socket.addEventListener("message", (event) => {
  for (const m of [].concat(JSON.parse(event.data))) {
    if (m._tag !== "Exit") continue;
    const e = pending.get(String(m.requestId));
    if (!e) continue;
    pending.delete(String(m.requestId));
    m.exit._tag === "Success" ? e.resolve(m.exit.value) : e.reject(new Error(JSON.stringify(m.exit.cause)));
  }
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("close", (e) => reject(new Error(`closed ${e.code}`)), { once: true });
});
log("[ws] connected");

const claude = ((await rpc("server.getConfig", {})).providers ?? []).find(
  (p) => p.driver === "claudeAgent",
);
const modelSelection = { instanceId: claude.instanceId, model: "claude-haiku-4-5" };

const workspaceRoot = mkdtempSync(join(tmpdir(), "stophook-async-"));
const hookLog = join(workspaceRoot, "hook-log.jsonl");
mkdirSync(join(workspaceRoot, ".claude"), { recursive: true });
const command = `"${process.execPath}" "${join(import.meta.dirname, "record.mjs")}" "${hookLog}" StopAsync`.replaceAll(
  "\\",
  "/",
);
// Shaped exactly like firstmate's entry for fm-claude-stop-autoarm.sh.
writeFileSync(
  join(workspaceRoot, ".claude", "settings.json"),
  JSON.stringify(
    { hooks: { Stop: [{ hooks: [{ type: "command", command, asyncRewake: true, timeout: 28800 }] }] } },
    null,
    2,
  ),
  "utf8",
);
writeFileSync(join(workspaceRoot, "CLAUDE.md"), "Answer in one word. Never use tools.\n", "utf8");
log(`[scratch] ${workspaceRoot}`);

const projectId = randomUUID();
const threadId = randomUUID();
await rpc("orchestration.dispatchCommand", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `stophook-async-${projectId.slice(0, 8)}`,
  workspaceRoot,
  createdAt: new Date().toISOString(),
});
await rpc("orchestration.dispatchCommand", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: "stophook-async-probe",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
});
await rpc("orchestration.dispatchCommand", {
  type: "thread.turn.start",
  commandId: randomUUID(),
  threadId,
  message: { messageId: randomUUID(), role: "user", text: "Say READY", attachments: [] },
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: new Date().toISOString(),
});
log("[turn] started");

for (let i = 0; i < 60; i++) {
  await sleep(1000);
  if (existsSync(hookLog)) break;
}
await sleep(3000);

if (!existsSync(hookLog)) {
  log("[result] NO hook fired within 60s — asyncRewake/timeout config was NOT honoured");
} else {
  const lines = readFileSync(hookLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  log(`[result] ${lines.length} hook line(s) fired with asyncRewake:true, timeout:28800`);
  for (const line of lines) log(`  ${line.at}  ${line.label}  payload=${JSON.stringify(line.payload)}`);
}
log(`\n[scratch retained] ${workspaceRoot}`);
socket.close();
process.exit(0);
