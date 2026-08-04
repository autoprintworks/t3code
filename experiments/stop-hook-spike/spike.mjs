#!/usr/bin/env node
/**
 * Spike for autoprintworks/t3code#6: does a Claude Code `Stop` hook fire when
 * the turn is driven by T3 through the Agent SDK's `query()` rather than by the
 * interactive CLI?
 *
 * firstmate's zero-token supervision rides a `Stop` hook, so the answer decides
 * whether the first mate can sleep between turns or must be woken over the
 * websocket instead.
 *
 * Method: stand up a throwaway T3 project on a scratch directory whose
 * `.claude/settings.json` registers a trivial recorder (record.mjs) on Stop,
 * SessionStart and SessionEnd; drive real turns through the orchestration
 * websocket; then read the recorder's log back.
 *
 * Four turn boundaries are exercised, matching the ticket's questions:
 *   1-2. two clean completions      -> does it fire, and once per turn?
 *   3.   an interrupted turn        -> does it fire on interrupt?
 *   4.   thread.session.stop        -> does it fire on session stop?
 *
 * The websocket plumbing (token -> ticket -> /ws, one JSON RPC envelope per
 * frame) is inherited from the #3 spike; see ../firstmate-auth-spike/README.md.
 *
 * Usage:
 *   T3_TOKEN=<bearer> node spike.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const token = process.env.T3_TOKEN?.trim();
if (!token) throw new Error("No bearer token: set T3_TOKEN.");

const log = (...parts) => console.log(...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- connection

const runtimePath = join(T3_HOME, "userdata", "server-runtime.json");
const { origin, pid } = JSON.parse(readFileSync(runtimePath, "utf8"));
log(`[discover] ${origin} (pid ${pid})`);

const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
if (!ticketResponse.ok) {
  throw new Error(`websocket-ticket failed: ${ticketResponse.status} ${await ticketResponse.text()}`);
}
const { ticket } = await ticketResponse.json();

const socket = new WebSocket(
  `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`,
);

const pending = new Map();
let nextRequestId = 1;

const send = (tag, payload) => {
  const id = String(nextRequestId++);
  socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  return id;
};

/** Unary call: resolves on the terminal Exit frame. */
const rpc = (tag, payload) =>
  new Promise((resolve, reject) => {
    const id = send(tag, payload);
    pending.set(id, { resolve, reject, values: [] });
  });

/** Stream call: `onValue` per element; the promise settles when the stream ends. */
const stream = (tag, payload, onValue) =>
  new Promise((resolve, reject) => {
    const id = send(tag, payload);
    pending.set(id, { resolve, reject, values: [], onValue });
  });

socket.addEventListener("message", (event) => {
  for (const message of [].concat(JSON.parse(event.data))) {
    const entry = pending.get(String(message.requestId));
    if (!entry) continue;
    if (message._tag === "Chunk") {
      for (const value of message.values ?? []) entry.onValue?.(value);
      continue;
    }
    if (message._tag !== "Exit") continue;
    pending.delete(String(message.requestId));
    if (message.exit._tag === "Success") entry.resolve(message.exit.value);
    else entry.reject(new Error(JSON.stringify(message.exit.cause)));
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener(
    "close",
    (event) => reject(new Error(`socket closed before open: ${event.code} ${event.reason}`)),
    { once: true },
  );
});
log("[ws] connected");

// ------------------------------------------------------- model selection (#12)
// #12: the decider copies modelSelection through verbatim, so a concrete
// {instanceId, model} must be resolved up front — project defaults are not a
// fallback, and an unknown model string is never validated.

const config = await rpc("server.getConfig", {});
const providers = config.providers ?? config.config?.providers ?? [];
const claude =
  providers.find((p) => p.driver === "claudeAgent" || p.driver === "claude") ?? providers[0];
if (!claude) throw new Error(`no provider instances in getConfig: ${JSON.stringify(config).slice(0, 400)}`);
if (process.env.DUMP_PROVIDER) {
  log(`[provider raw] ${JSON.stringify(claude, null, 2).slice(0, 4000)}`);
  process.exit(0);
}
const modelId = (m) =>
  typeof m === "string" ? m : (m.id ?? m.model ?? m.modelId ?? m.value ?? m.slug ?? m.name);
const models = (claude.models ?? []).map(modelId).filter(Boolean);
// Prefer the cheapest available model: this spike measures hook plumbing, not
// answer quality, and every turn is a one-word reply.
const model = models.find((m) => /haiku/i.test(m)) ?? models[0];
log(`[model] instanceId=${claude.instanceId} driver=${claude.driver} model=${model}`);
log(`[model] available=${JSON.stringify(claude.availability)} models=${JSON.stringify(models)}`);
const modelSelection = { instanceId: claude.instanceId, model };

// --------------------------------------------------------- scratch project

const workspaceRoot = mkdtempSync(join(tmpdir(), "stophook-"));
const hookLog = join(workspaceRoot, "hook-log.jsonl");
const recorder = join(import.meta.dirname, "record.mjs");
mkdirSync(join(workspaceRoot, ".claude"), { recursive: true });

// process.execPath rather than a bare `node`: the hook is spawned by the SDK,
// and assuming its PATH is the captain's is exactly the kind of thing this
// spike is supposed to be measuring rather than relying on.
const hookCommand = (label) =>
  `"${process.execPath}" "${recorder}" "${hookLog}" ${label}`.replaceAll("\\", "/");

writeFileSync(
  join(workspaceRoot, ".claude", "settings.json"),
  `${JSON.stringify(
    {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: hookCommand("Stop"), timeout: 30 }] }],
        SessionStart: [
          { hooks: [{ type: "command", command: hookCommand("SessionStart"), timeout: 30 }] },
        ],
        SessionEnd: [
          { hooks: [{ type: "command", command: hookCommand("SessionEnd"), timeout: 30 }] },
        ],
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
// A CLAUDE.md keeps the turns terse and cheap.
writeFileSync(
  join(workspaceRoot, "CLAUDE.md"),
  "Answer in one word. Never use tools.\n",
  "utf8",
);
log(`[scratch] ${workspaceRoot}`);

const projectId = randomUUID();
const threadId = randomUUID();

await rpc("orchestration.dispatchCommand", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `stophook-${projectId.slice(0, 8)}`,
  workspaceRoot,
  createdAt: new Date().toISOString(),
});
await rpc("orchestration.dispatchCommand", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: "stophook-probe",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
});
log(`[thread] projectId=${projectId} threadId=${threadId}`);

// ------------------------------------------------------------- observation
// #7 (which events mark busy/waiting/done) is still open, so this records every
// event type rather than assuming one, and uses the assistant-complete event
// only as a turn-end heuristic backed by a timeout.

const events = [];
stream("orchestration.subscribeThread", { threadId }, (value) => {
  for (const event of [].concat(value?.events ?? value ?? [])) {
    if (!event?.type) continue;
    events.push({ at: new Date().toISOString(), type: event.type });
    log(`  [event] ${event.type}`);
  }
}).catch((error) => log(`[subscribe] ended: ${error.message}`));

const hookLines = () =>
  existsSync(hookLog)
    ? readFileSync(hookLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

const waitFor = async (label, predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(500);
  }
  log(`[wait] TIMEOUT after ${timeoutMs}ms waiting for ${label}`);
  return false;
};

const startTurn = async (text) => {
  const before = events.length;
  await rpc("orchestration.dispatchCommand", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  return before;
};

const turnEnded = (from) =>
  events.slice(from).some((e) => e.type === "thread.message.assistant.complete");

// --- boundary 1 & 2: clean completions -------------------------------------
for (const [index, text] of [["1", "Say ONE"], ["2", "Say TWO"]]) {
  log(`[turn ${index}] start`);
  const from = await startTurn(text);
  await waitFor(`turn ${index} to complete`, () => turnEnded(from), 180_000);
  // Hooks are spawned asynchronously; give the recorder a beat to land.
  await sleep(4000);
  log(`[turn ${index}] hook lines so far: ${hookLines().length}`);
}

// --- boundary 3: interrupt --------------------------------------------------
log("[turn 3] start (to be interrupted)");
const linesBeforeInterrupt = hookLines().length;
await startTurn("Count slowly from 1 to 500, one number per line.");
await sleep(6000);
await rpc("orchestration.dispatchCommand", {
  type: "thread.turn.interrupt",
  commandId: randomUUID(),
  threadId,
  createdAt: new Date().toISOString(),
});
log("[turn 3] interrupt dispatched");
await sleep(10_000);
log(`[turn 3] hook lines added by interrupt: ${hookLines().length - linesBeforeInterrupt}`);

// --- boundary 4: session stop ----------------------------------------------
const linesBeforeStop = hookLines().length;
await rpc("orchestration.dispatchCommand", {
  type: "thread.session.stop",
  commandId: randomUUID(),
  threadId,
  createdAt: new Date().toISOString(),
});
log("[session] stop dispatched");
await sleep(10_000);
log(`[session] hook lines added by session stop: ${hookLines().length - linesBeforeStop}`);

// -------------------------------------------------------------------- report

log("\n================ HOOK LOG ================");
for (const line of hookLines()) {
  log(
    `${line.at}  ${line.label}  cwd=${line.cwd}\n    env=${JSON.stringify(line.env)}\n    payload=${JSON.stringify(line.payload)}`,
  );
}
log("================ EVENTS ==================");
const counts = {};
for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
log(JSON.stringify(counts, null, 2));
log(`\n[scratch retained] ${workspaceRoot}`);
log(`[cleanup] project ${projectId} left in place; delete with project.delete if unwanted`);

socket.close();
process.exit(0);
