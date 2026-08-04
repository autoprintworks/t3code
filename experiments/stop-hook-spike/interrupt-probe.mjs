#!/usr/bin/env node
/**
 * Follow-up probe for autoprintworks/t3code#6.
 *
 * The main spike settled that `Stop` fires on clean turn completion and that
 * `thread.session.stop` produces `SessionEnd` rather than `Stop`. It did *not*
 * settle the interrupt case: the interrupted turn was a one-word refusal that
 * had already finished before `thread.turn.interrupt` landed, so its `Stop`
 * proves nothing about interrupts.
 *
 * This probe forces a genuinely long turn (a shell loop), waits until the
 * transcript shows the tool actually running, interrupts, and only then looks
 * for a `Stop`. The mid-flight check is the whole point — without it the
 * result is indistinguishable from the ambiguous one it replaces.
 *
 * Usage: T3_TOKEN=<bearer> node interrupt-probe.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const token = process.env.T3_TOKEN?.trim();
if (!token) throw new Error("No bearer token: set T3_TOKEN.");

const log = (...p) => console.log(...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { origin } = JSON.parse(readFileSync(join(T3_HOME, "userdata", "server-runtime.json"), "utf8"));
const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
const { ticket } = await ticketResponse.json();
const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`);

const pending = new Map();
let nextRequestId = 1;
const rpc = (tag, payload) =>
  new Promise((resolve, reject) => {
    const id = String(nextRequestId++);
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  });

socket.addEventListener("message", (event) => {
  for (const message of [].concat(JSON.parse(event.data))) {
    if (message._tag !== "Exit") continue;
    const entry = pending.get(String(message.requestId));
    if (!entry) continue;
    pending.delete(String(message.requestId));
    if (message.exit._tag === "Success") entry.resolve(message.exit.value);
    else entry.reject(new Error(JSON.stringify(message.exit.cause)));
  }
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("close", (e) => reject(new Error(`closed: ${e.code}`)), { once: true });
});
log("[ws] connected");

const config = await rpc("server.getConfig", {});
const claude = (config.providers ?? []).find((p) => p.driver === "claudeAgent");
const modelSelection = { instanceId: claude.instanceId, model: "claude-haiku-4-5" };

const workspaceRoot = mkdtempSync(join(tmpdir(), "stophook-int-"));
const hookLog = join(workspaceRoot, "hook-log.jsonl");
const recorder = join(import.meta.dirname, "record.mjs");
mkdirSync(join(workspaceRoot, ".claude"), { recursive: true });
const hookCommand = (label) =>
  `"${process.execPath}" "${recorder}" "${hookLog}" ${label}`.replaceAll("\\", "/");
writeFileSync(
  join(workspaceRoot, ".claude", "settings.json"),
  JSON.stringify(
    {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: hookCommand("Stop"), timeout: 30 }] }],
        SessionEnd: [{ hooks: [{ type: "command", command: hookCommand("SessionEnd"), timeout: 30 }] }],
      },
    },
    null,
    2,
  ),
  "utf8",
);
log(`[scratch] ${workspaceRoot}`);

const projectId = randomUUID();
const threadId = randomUUID();
await rpc("orchestration.dispatchCommand", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `stophook-int-${projectId.slice(0, 8)}`,
  workspaceRoot,
  createdAt: new Date().toISOString(),
});
await rpc("orchestration.dispatchCommand", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: "stophook-interrupt-probe",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
});
log(`[thread] ${threadId}`);

const lines = () =>
  existsSync(hookLog)
    ? readFileSync(hookLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

await rpc("orchestration.dispatchCommand", {
  type: "thread.turn.start",
  commandId: randomUUID(),
  threadId,
  message: {
    messageId: randomUUID(),
    role: "user",
    text:
      "Use the Bash tool to run exactly this, and wait for it to finish:\n" +
      "for i in $(seq 1 180); do echo tick-$i; sleep 1; done",
    attachments: [],
  },
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: new Date().toISOString(),
});
log("[turn] started (long shell loop)");

// Mid-flight proof: the transcript must show a tool_use before we interrupt.
// Without this the interrupt could land after a fast completion and the result
// would be as ambiguous as the run this probe exists to replace.
const transcriptDir = join(
  homedir(),
  ".claude",
  "projects",
  `C--Users-Glyn-AppData-Local-Temp-${workspaceRoot.split(/[\\/]/).pop()}`,
);
const transcriptHasToolUse = () => {
  try {
    for (const file of readdirSync(transcriptDir)) {
      if (!file.endsWith(".jsonl")) continue;
      if (readFileSync(join(transcriptDir, file), "utf8").includes('"tool_use"')) return true;
    }
  } catch {}
  return false;
};

let inFlight = false;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  if (lines().some((l) => l.label === "Stop")) {
    log(`[abort] a Stop fired at t+${i}s, before any interrupt — turn ended on its own.`);
    break;
  }
  if (transcriptHasToolUse()) {
    inFlight = true;
    log(`[proof] tool_use present in transcript at t+${i}s — turn is genuinely mid-flight`);
    break;
  }
}

const before = lines().length;
log(`[state] hook lines before interrupt: ${before} (mid-flight proven: ${inFlight})`);

await rpc("orchestration.dispatchCommand", {
  type: "thread.turn.interrupt",
  commandId: randomUUID(),
  threadId,
  createdAt: new Date().toISOString(),
});
log("[interrupt] dispatched");
await sleep(20_000);

const after = lines();
log(`[result] hook lines added by interrupt: ${after.length - before}`);
for (const line of after.slice(before)) {
  log(`  ${line.at}  ${line.label}  payload=${JSON.stringify(line.payload)}`);
}
log(`\n[scratch retained] ${workspaceRoot}`);
socket.close();
process.exit(0);
