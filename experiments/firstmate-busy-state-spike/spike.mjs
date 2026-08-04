#!/usr/bin/env node
/**
 * Spike for autoprintworks/t3code#7: which `orchestration.subscribeThread`
 * events mark a crewmate busy, waiting, or done?
 *
 * Drives one throwaway thread through every state a firstmate supervisor must
 * tell apart, recording the raw stream item for each so the event -> state
 * mapping is read off a transcript rather than off the schema.
 *
 * Scenarios, in order:
 *   1. turn running -> complete       (a trivial prompt)
 *   2. awaiting approval              (approval-required mode + a command)
 *   3. awaiting user input            (the AskUserQuestion tool)
 *   4. interrupt mid-turn             (thread.turn.interrupt)
 *   5. session stop                   (thread.session.stop)
 *
 * Auth is the #3 path: a bearer token minted by `t3 auth session issue`,
 * exchanged for a short-lived `?wsTicket=`.
 *
 * Usage:
 *   T3_TOKEN=<bearer> node spike.mjs [--keep] [--scenario 1,2,3]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    "token-file": { type: "string" },
    "base-dir": { type: "string" },
    origin: { type: "string" },
    out: { type: "string" },
    scenario: { type: "string" },
    keep: { type: "boolean" },
  },
});

const wanted = new Set(
  (flags.scenario ?? "1,2,3,4,5").split(",").map((entry) => entry.trim()),
);

const resolveT3Home = () =>
  flags["base-dir"] ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3");

const discoverOrigin = () => {
  if (flags.origin) return flags.origin;
  const statePath = join(resolveT3Home(), "userdata", "server-runtime.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  console.log(`[discover] ${statePath} -> ${state.origin} (pid ${state.pid})`);
  return state.origin;
};

const readToken = () => {
  const token = flags["token-file"]
    ? readFileSync(flags["token-file"], "utf8").trim()
    : process.env.T3_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "No bearer token. Mint one with `t3 auth session issue --token-only --ttl 30d`, " +
        "then pass it as T3_TOKEN or --token-file.",
    );
  }
  return token;
};

const origin = discoverOrigin();
const token = readToken();

const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
if (!ticketResponse.ok) {
  throw new Error(
    `websocket-ticket failed: ${ticketResponse.status} ${await ticketResponse.text()}`,
  );
}
const ticket = await ticketResponse.json();

const socket = new WebSocket(
  `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket.ticket)}`,
);

const pending = new Map();
const streams = new Map();
let nextRequestId = 1;

const sendRaw = (message) => socket.send(JSON.stringify(message));

const sendRequest = (tag, payload) =>
  new Promise((resolve, reject) => {
    const id = String(nextRequestId++);
    pending.set(id, { resolve, reject });
    sendRaw({ _tag: "Request", id, tag, payload, headers: [] });
  });

/**
 * Streaming RPCs are not fire-and-forget. The server holds one latch per
 * request id and only refills it when the client answers a Chunk with an Ack
 * (RpcServer.ts:190) — miss that and the stream delivers exactly one chunk and
 * then silently stalls forever, which reads like "no events" rather than like
 * backpressure.
 */
const openStream = (tag, payload, onValue) => {
  const id = String(nextRequestId++);
  streams.set(id, onValue);
  sendRaw({ _tag: "Request", id, tag, payload, headers: [] });
  return id;
};

socket.addEventListener("message", (event) => {
  for (const message of [].concat(JSON.parse(event.data))) {
    const requestId = String(message.requestId ?? "");
    if (message._tag === "Chunk") {
      const onValue = streams.get(requestId);
      if (onValue) for (const value of message.values) onValue(value);
      sendRaw({ _tag: "Ack", requestId });
      continue;
    }
    if (message._tag !== "Exit") continue;
    if (streams.has(requestId)) {
      streams.delete(requestId);
      console.log(`[stream ${requestId}] closed: ${JSON.stringify(message.exit)}`);
      continue;
    }
    const entry = pending.get(requestId);
    if (!entry) continue;
    pending.delete(requestId);
    if (message.exit._tag === "Success") entry.resolve(message.exit.value);
    else entry.reject(new Error(JSON.stringify(message.exit.cause)));
  }
});
socket.addEventListener("error", () => {
  for (const entry of pending.values()) entry.reject(new Error("socket error"));
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener(
    "close",
    (event) => reject(new Error(`socket closed before open: ${event.code} ${event.reason}`)),
    { once: true },
  );
});
console.log("[ws] connected and authenticated");

// ---------------------------------------------------------------- model pick

// Per #12: never map harness -> instanceId. Find the instance whose driver is
// the claude agent and take its first model slug.
const config = await sendRequest("server.getConfig", {});
const providers = config.providers?.instances ?? config.providers ?? [];
const claude = (Array.isArray(providers) ? providers : []).find(
  (entry) => entry.driver === "claudeAgent" || entry.instanceId === "claudeAgent",
);
if (!claude) {
  throw new Error(
    `no claudeAgent provider instance in server.getConfig: ${JSON.stringify(providers).slice(0, 400)}`,
  );
}
const model = claude.models?.[0]?.slug ?? claude.models?.[0]?.id;
const modelSelection = { instanceId: claude.instanceId, model };
console.log(
  `[model] instanceId=${claude.instanceId} driver=${claude.driver} model=${model} availability=${JSON.stringify(claude.availability)}`,
);

// ------------------------------------------------------------------ recorder

const startedAt = Date.now();
const log = [];
let marked = false;

const record = (item) => {
  const entry = {
    at: Date.now() - startedAt,
    kind: item.kind,
    scenario: currentScenario,
  };
  if (item.kind === "event") {
    entry.type = item.event.type;
    entry.sequence = item.event.sequence;
    entry.payload = item.event.payload;
  } else if (item.kind === "snapshot") {
    entry.snapshotSequence = item.snapshot.snapshotSequence;
    entry.session = item.snapshot.thread.session;
    entry.latestTurn = item.snapshot.thread.latestTurn;
  } else {
    marked = true;
  }
  log.push(entry);

  const detail =
    item.kind !== "event"
      ? ""
      : item.event.type === "thread.session-set"
        ? `  session.status=${item.event.payload.session.status} activeTurnId=${item.event.payload.session.activeTurnId ?? "null"} lastError=${item.event.payload.session.lastError ?? "null"}`
        : item.event.type === "thread.activity-appended"
          ? `  activity.kind=${item.event.payload.activity.kind} tone=${item.event.payload.activity.tone} summary=${JSON.stringify(item.event.payload.activity.summary).slice(0, 70)}`
          : "";
  console.log(
    `  +${String(entry.at).padStart(6)}ms  ${entry.kind === "event" ? entry.type : entry.kind}${detail}`,
  );
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `predicate` sees a matching recorded entry, or time out. */
const waitFor = async (label, predicate, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    for (; cursor < log.length; cursor++) {
      if (predicate(log[cursor])) return log[cursor];
    }
    await sleep(150);
  }
  console.log(`  !! timed out waiting for ${label}`);
  return null;
};

const isSession = (status) => (entry) =>
  entry.type === "thread.session-set" && entry.payload.session.status === status;

const isActivity = (kind) => (entry) =>
  entry.type === "thread.activity-appended" && entry.payload.activity.kind === kind;

// ------------------------------------------------------------------- fixture

const workspaceRoot = mkdtempSync(join(tmpdir(), "fm-busy-"));
writeFileSync(join(workspaceRoot, "README.md"), "firstmate busy-state spike\n");
const projectId = randomUUID();
const threadId = randomUUID();
let currentScenario = "setup";
let deleted = false;

await sendRequest("orchestration.dispatchCommand", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `fm-busy-${projectId.slice(0, 8)}`,
  workspaceRoot,
  createdAt: new Date().toISOString(),
});

await sendRequest("orchestration.dispatchCommand", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: `fm-busy-${threadId.slice(0, 8)}`,
  modelSelection,
  // approval-required so scenario 2 can actually stall on an approval; a
  // full-access crewmate never raises one.
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
});
console.log(`[fixture] project=${projectId} thread=${threadId} root=${workspaceRoot}`);

openStream(
  "orchestration.subscribeThread",
  { threadId, requestCompletionMarker: true },
  record,
);
await waitFor("subscription marker", () => marked, 15_000);

const startTurn = (text, runtimeMode = "approval-required") =>
  sendRequest("orchestration.dispatchCommand", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });

const scenario = async (id, title, body) => {
  if (!wanted.has(id)) return;
  currentScenario = `${id}-${title}`;
  console.log(`\n=== scenario ${id}: ${title} ===`);
  await body();
};

// -------------------------------------------------------- 1. run to complete

await scenario("1", "turn runs and completes", async () => {
  await startTurn("Reply with exactly the word: ok. Use no tools.", "full-access");
  await waitFor("session running", isSession("running"));
  const done = await waitFor(
    "session leaving running",
    (entry) =>
      entry.type === "thread.session-set" &&
      ["idle", "ready", "error"].includes(entry.payload.session.status),
  );
  console.log(`  -> settled as ${done?.payload.session.status}`);
  await sleep(2000);
});

// ------------------------------------------------------------- 2. approval

await scenario("2", "awaiting approval", async () => {
  await startTurn(
    "Use the Write tool to create a file named probe.txt in the current directory " +
      "containing the single line `firstmate-approval-probe`. Do not ask me anything " +
      "first, and do not use any other tool.",
  );
  await waitFor("approval.requested", isActivity("approval.requested"));
  await sleep(3000);
  const requested = log.findLast((entry) => isActivity("approval.requested")(entry));
  if (!requested) {
    console.log("  !! no approval was ever raised — see the runtime-mode note in README");
    return;
  }
  const requestId =
    requested.payload.activity.payload?.requestId ??
    requested.payload.activity.payload?.request?.requestId;
  console.log(`  -> pending approval requestId=${requestId}`);
  console.log(
    `  -> activity.payload = ${JSON.stringify(requested.payload.activity.payload).slice(0, 600)}`,
  );
  if (requestId) {
    await sendRequest("orchestration.dispatchCommand", {
      type: "thread.approval.respond",
      commandId: randomUUID(),
      threadId,
      requestId,
      decision: "accept",
      createdAt: new Date().toISOString(),
    });
    await waitFor("approval.resolved", isActivity("approval.resolved"), 60_000);
  }
  await waitFor(
    "session leaving running",
    (entry) =>
      entry.scenario === currentScenario &&
      entry.type === "thread.session-set" &&
      ["idle", "ready", "error"].includes(entry.payload.session.status),
  );
  await sleep(2000);
});

// ----------------------------------------------------------- 3. user input

await scenario("3", "awaiting user input", async () => {
  await startTurn(
    "Use the AskUserQuestion tool right now to ask me which colour I prefer, " +
      "with the options red and blue. Ask before doing anything else.",
    "full-access",
  );
  const requested = await waitFor(
    "user-input.requested",
    isActivity("user-input.requested"),
    90_000,
  );
  if (requested) {
    console.log(
      `  -> activity.payload = ${JSON.stringify(requested.payload.activity.payload).slice(0, 600)}`,
    );
  }
  await sleep(3000);
  // Left unanswered on purpose: the interrupt in scenario 4 clears it, and an
  // un-answered request is exactly the state a supervisor has to recognise.
});

// ------------------------------------------------------------- 4. interrupt

await scenario("4", "interrupt mid-turn", async () => {
  // Always start a fresh turn rather than reusing whatever scenario 3 left
  // running: interrupting a turn that is parked on a pending user-input is a
  // different path (it resolves the request and then errors), and conflating
  // the two hides what a plain interrupt looks like.
  await startTurn(
    "Count slowly from 1 to 400, one number per line, with no tools.",
    "full-access",
  );
  await waitFor(
    "session running",
    (entry) => entry.scenario === currentScenario && isSession("running")(entry),
  );
  await sleep(4000);
  await sendRequest("orchestration.dispatchCommand", {
    type: "thread.turn.interrupt",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  });
  await waitFor(
    "session interrupted",
    (entry) =>
      entry.scenario === currentScenario &&
      entry.type === "thread.session-set" &&
      ["interrupted", "idle", "ready", "stopped"].includes(entry.payload.session.status),
    60_000,
  );
  await sleep(3000);
});

// ---------------------------------------------------------- 5. session stop

await scenario("5", "session stop", async () => {
  await sendRequest("orchestration.dispatchCommand", {
    type: "thread.session.stop",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  });
  await waitFor(
    "session stopped",
    (entry) =>
      entry.scenario === currentScenario &&
      entry.type === "thread.session-set" &&
      ["stopped", "idle"].includes(entry.payload.session.status),
    60_000,
  );
  await sleep(3000);
});

// ------------------------------------------------------- 6. thread goes away

// The "gone" arm of the #5 contract: a supervisor polling a dead task must not
// mistake a silent stream for a busy one. Deletes the thread while still
// subscribed and reports whether the subscription closes, errors, or just goes
// quiet.
await scenario("6", "thread deleted underneath the subscription", async () => {
  const before = log.length;
  const streamsOpen = streams.size;
  await sendRequest("orchestration.dispatchCommand", {
    type: "thread.delete",
    commandId: randomUUID(),
    threadId,
    force: true,
  });
  await sleep(8000);
  console.log(
    `  -> stream ${streams.size < streamsOpen ? "CLOSED" : "still open"}; ` +
      `${log.length - before} further stream item(s) after delete`,
  );
  deleted = true;
});

// -------------------------------------------------------------------- report

currentScenario = "teardown";
const outPath = flags.out ?? join(process.cwd(), "transcript.json");
writeFileSync(outPath, JSON.stringify(log, null, 2));
console.log(`\n[report] ${log.length} stream items -> ${outPath}`);

const counts = new Map();
for (const entry of log) {
  const key = entry.kind === "event" ? entry.type : entry.kind;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
console.log("[report] stream item types:");
for (const [key, count] of [...counts].toSorted((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${key}`);
}

if (!flags.keep) {
  if (!deleted) {
    await sendRequest("orchestration.dispatchCommand", {
      type: "thread.delete",
      commandId: randomUUID(),
      threadId,
    });
  }
  await sendRequest("orchestration.dispatchCommand", {
    type: "project.delete",
    commandId: randomUUID(),
    projectId,
    force: true,
  });
  // The server keeps a handle on the workspace root for a while after
  // project.delete, so on Windows the rmdir races and throws EBUSY. The temp
  // dir is disposable either way.
  try {
    rmSync(workspaceRoot, { recursive: true, force: true });
  } catch (error) {
    console.log(`[cleanup] workspace root left behind: ${error.code} ${workspaceRoot}`);
  }
  console.log("[cleanup] thread and project deleted");
}

socket.close();
console.log("[done]");
process.exit(0);
