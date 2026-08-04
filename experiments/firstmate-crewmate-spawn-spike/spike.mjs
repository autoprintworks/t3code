#!/usr/bin/env node
/**
 * Spike for autoprintworks/t3code#9: spawn one crewmate by hand over the
 * websocket, end to end.
 *
 * Walks the whole lifecycle `bin/backends/t3.sh` will have to drive, in the
 * shape fm-spawn.sh's claude-bg arm drives it — that arm is the precedent
 * because it is the only existing backend with no pane to type into, so the
 * brief becomes the agent's first prompt rather than a line sent to a shell
 * (fm-spawn.sh:1760-1770).
 *
 * Stages:
 *   1. fixture   scratch git repo standing in for $PROJ_ABS
 *   2. lease     treehouse get --lease --lease-holder fm-<ID>   (fm-spawn.sh:1368)
 *   3. connect   #3 auth path: bearer -> wsTicket -> /ws
 *   4. resolve   server.getConfig -> claudeAgent instance + model slug   (#12)
 *   5. project   project.create, workspaceRoot = $PROJ_ABS              (#8)
 *   6. thread    thread.create pinned to the worktree, runtimeMode full-access
 *   7. watch     orchestration.subscribeThread (Ack every Chunk — #7 trap)
 *   8. brief     thread.turn.start carrying the brief contents
 *   9. hold      pause so the captain can watch and type in the desktop GUI
 *  10. interrupt thread.turn.interrupt
 *  11. stop      thread.session.stop
 *  12. teardown  thread.delete, project.delete, treehouse return
 *
 * Every dispatch is recorded as accepted or refused, so the report says what
 * the API turned down rather than dying on the first refusal.
 *
 * Usage:
 *   T3_TOKEN=<bearer> node spike.mjs [--hold 300] [--keep] [--proj <path>]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    proj: { type: "string" },
    hold: { type: "string" },
    keep: { type: "boolean" },
    "no-teardown": { type: "boolean" },
    // The main run's brief can finish before the hold expires, which leaves the
    // interrupt landing on an already-settled session — no evidence at all.
    // This mode gives the crewmate a brief it cannot finish quickly and cuts
    // the hold right down, so the interrupt hits a genuinely running turn.
    "probe-interrupt": { type: "boolean" },
  },
});

const PROBE_INTERRUPT = flags["probe-interrupt"] === true;
const HOLD_SECONDS = Number(flags.hold ?? (PROBE_INTERRUPT ? 12 : 240));

// ---------------------------------------------------------------- findings

/**
 * The ticket asks for two lists: what the API refused, and what firstmate had
 * no natural value for. Collect both as the run goes rather than reconstructing
 * them from the console afterwards.
 */
const findings = { dispatches: [], refusals: [], improvised: [], notes: [] };

const improvised = (field, value, why) => {
  findings.improvised.push({ field, value, why });
  console.log(`  [improvised] ${field}=${JSON.stringify(value)} — ${why}`);
};

const note = (text) => {
  findings.notes.push(text);
  console.log(`  [note] ${text}`);
};

// ------------------------------------------------------------------ fixture

const startedAt = Date.now();
const stamp = () => String(Date.now() - startedAt).padStart(6);

// firstmate mints the task id up front and uses it as both $T and the thread id
// (#8): T3 burns thread ids permanently while firstmate reuses task ids, so the
// id has to come from firstmate's side.
const ID = randomUUID();
const THREAD_TITLE = `fm-${ID.slice(0, 8)}`;
const LEASE_HOLDER = `fm-${ID}`;

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let PROJ_ABS = flags.proj;
let scratchCreated = false;

if (!PROJ_ABS) {
  PROJ_ABS = mkdtempSync(join(tmpdir(), "fm-crew-"));
  scratchCreated = true;
  writeFileSync(join(PROJ_ABS, "README.md"), "# firstmate crewmate spawn spike\n");
  writeFileSync(join(PROJ_ABS, "NOTES.md"), "scratch project standing in for a firstmate project\n");
  git(PROJ_ABS, "init", "-b", "main");
  git(PROJ_ABS, "config", "user.email", "spike@firstmate.local");
  git(PROJ_ABS, "config", "user.name", "firstmate spike");
  git(PROJ_ABS, "add", ".");
  git(PROJ_ABS, "commit", "-m", "scratch project for the crewmate spawn spike");
}
console.log(`[fixture] PROJ_ABS=${PROJ_ABS}`);
console.log(`[fixture] task id ${ID} -> thread title ${THREAD_TITLE}`);

// The brief lives at $DATA/$ID/brief.md in firstmate (fm-spawn.sh:870). Its
// CONTENTS are what claude-bg passes, so a crewmate on either backend starts
// from byte-identical instructions.
const DATA = join(PROJ_ABS, "data");
mkdirSync(join(DATA, ID), { recursive: true });
const BRIEF = join(DATA, ID, "brief.md");
writeFileSync(
  BRIEF,
  PROBE_INTERRUPT
    ? [
        `# Launch brief — task ${ID}`,
        "",
        "You are a crewmate. Do not use any tools at all.",
        "",
        "Count from 1 to 2000, one number per line, writing each number out as a word",
        "as well as a numeral (for example: `1 — one`). Go all the way to 2000.",
        "",
      ].join("\n")
    : [
    `# Launch brief — task ${ID}`,
    "",
    "You are a crewmate. You are working in your own treehouse worktree; stay inside it.",
    "",
    "## Deliverable",
    "",
    "1. Create `CREWMATE.md` describing, in your own words, which directory you are in",
    "   and what git branch you are on. Include the output of `git rev-parse --abbrev-ref HEAD`.",
    "2. Append one line to `NOTES.md` recording that a crewmate visited.",
    "3. Commit both with the message `crewmate: report for duty`.",
    "4. Then, slowly and one per line, count from 1 to 60 so the captain has something",
    "   to watch while deciding whether to interrupt you.",
    "",
    "Do not push. Do not open a PR. Do not touch anything outside this worktree.",
    "",
  ].join("\n"),
);
console.log(`[fixture] brief at ${BRIEF}`);

// --------------------------------------------------------------------- lease

// The terminal backends type `treehouse get` into a pane and poll its cwd. With
// no pane, claude-bg uses the non-interactive durable lease, which prints the
// path on stdout and keeps the worktree reserved with no process inside it
// (fm-spawn.sh:1362-1372). A T3 crewmate has no pane either, so it inherits
// exactly this path.
let WT = null;
let BRANCH = null;
let leaseMechanism = "treehouse";

try {
  WT = execFileSync(
    "treehouse",
    ["get", "--lease", "--lease-holder", LEASE_HOLDER],
    {
      cwd: PROJ_ABS,
      encoding: "utf8",
      env: { ...process.env, TREEHOUSE_LEASE_HOLDER: LEASE_HOLDER },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .replace(/\r/g, "")
    .trim();
} catch (error) {
  console.log(`[lease] treehouse get --lease failed: ${String(error.stderr ?? error.message).trim()}`);
  WT = null;
}

if (!WT) {
  // Record it and fall back, rather than aborting: the point of the ticket is
  // the T3 half, and a plain git worktree pins thread.create identically.
  leaseMechanism = "git worktree (treehouse unavailable)";
  note(
    "treehouse get --lease did not yield a worktree in the scratch repo; fell back to " +
      "`git worktree add`. The T3 side is unaffected — thread.create takes a path either " +
      "way — but a real spawn depends on the treehouse lease succeeding.",
  );
  WT = join(tmpdir(), `fm-crew-wt-${ID.slice(0, 8)}`);
  git(PROJ_ABS, "worktree", "add", "-b", LEASE_HOLDER, WT);
}

BRANCH = git(WT, "rev-parse", "--abbrev-ref", "HEAD");
console.log(`[lease] ${leaseMechanism} -> ${WT} (branch ${BRANCH})`);

// firstmate's own guard: refuse to launch into the primary checkout.
if (WT === PROJ_ABS) throw new Error("lease returned the primary checkout — refusing to launch");

// ------------------------------------------------------------------ connect

const resolveT3Home = () =>
  flags["base-dir"] ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3");

const discoverOrigin = () => {
  if (flags.origin) return flags.origin;
  const statePath = join(resolveT3Home(), "userdata", "server-runtime.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  console.log(`[connect] ${statePath} -> ${state.origin} (pid ${state.pid})`);
  return state.origin;
};

const token = (
  flags["token-file"] ? readFileSync(flags["token-file"], "utf8") : (process.env.T3_TOKEN ?? "")
).trim();
if (!token) {
  throw new Error(
    "No bearer token. Mint one with `t3 auth session issue --token-only --ttl 30d`, " +
      "then pass it as T3_TOKEN or --token-file.",
  );
}

const origin = discoverOrigin();

const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
if (!ticketResponse.ok) {
  throw new Error(
    `websocket-ticket failed: ${ticketResponse.status} ${await ticketResponse.text()}`,
  );
}
const wsTicket = (await ticketResponse.json()).ticket;

const socket = new WebSocket(
  `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(wsTicket)}`,
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
      // #7 trap: miss the Ack and the stream delivers one chunk then stalls
      // forever, which reads like "this thread emits no events".
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
console.log("[connect] websocket open and authenticated");

/** Dispatch one command, recording whether it was accepted or refused. */
const dispatch = async (label, command) => {
  try {
    const value = await sendRequest("orchestration.dispatchCommand", command);
    findings.dispatches.push({ label, type: command.type, ok: true });
    console.log(`  +${stamp()}ms  [ok]      ${label}`);
    return { ok: true, value };
  } catch (error) {
    const detail = String(error.message).slice(0, 900);
    findings.dispatches.push({ label, type: command.type, ok: false, error: detail });
    findings.refusals.push({ label, type: command.type, error: detail });
    console.log(`  +${stamp()}ms  [REFUSED] ${label}\n            ${detail}`);
    return { ok: false, error: detail };
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- resolve

// #12: map harness -> driver kind -> instance, never harness -> instanceId
// (firstmate says `claude`, T3 says `claudeAgent`). A concrete {instanceId,
// model} must always be resolved — project.defaultModelSelection is copied
// through verbatim and cannot be deferred to.
const config = await sendRequest("server.getConfig", {});
const providerList = config.providers?.instances ?? config.providers ?? [];
const claude = (Array.isArray(providerList) ? providerList : []).find(
  (entry) => entry.driver === "claudeAgent" || entry.instanceId === "claudeAgent",
);
if (!claude) {
  throw new Error(
    `no claudeAgent provider instance: ${JSON.stringify(providerList).slice(0, 400)}`,
  );
}
const model = claude.models?.[0]?.slug ?? claude.models?.[0]?.id;
const modelSelection = { instanceId: claude.instanceId, model };
console.log(
  `[resolve] instanceId=${claude.instanceId} driver=${claude.driver} model=${model} ` +
    `availability=${JSON.stringify(claude.availability)}`,
);
improvised(
  "modelSelection",
  modelSelection,
  "firstmate's model=default/effort=default are absence markers, not a request for a " +
    "default (#12) — the backend must resolve a concrete instance and slug itself",
);

// ------------------------------------------------------------------- project

// #8: one T3 project per firstmate project, workspaceRoot = $PROJ_ABS.
const projectId = randomUUID();
console.log("\n=== stage 5: project.create ===");
const projectResult = await dispatch("project.create", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `fm-proj-${projectId.slice(0, 8)}`,
  workspaceRoot: PROJ_ABS,
  createdAt: new Date().toISOString(),
});

if (!projectResult.ok) {
  // #3 recorded this trap: the one-active-project-per-workspace-root invariant
  // fails AFTER authenticating, so it reads as an auth failure and is not one.
  note(
    "project.create was refused — if this is the one-active-project-per-workspace-root " +
      "invariant, the backend must adopt the existing project rather than create one.",
  );
}

// -------------------------------------------------------------------- thread

console.log("\n=== stage 6: thread.create (pinned to the worktree) ===");
improvised(
  "title",
  THREAD_TITLE,
  "T3 requires a non-empty thread title; firstmate has no title concept, so #8's " +
    "fm-<ID> convention supplies one",
);
improvised(
  "interactionMode",
  "default",
  "firstmate has no analogue — it is a T3-only axis, so the default stands",
);

const threadResult = await dispatch("thread.create", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId: ID,
  projectId,
  title: THREAD_TITLE,
  modelSelection,
  // #1 established full-access -> permissionMode bypassPermissions, which is
  // what a crewmate needs and what `claude --dangerously-skip-permissions`
  // means in the terminal launch template (fm-spawn.sh:463).
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: BRANCH,
  worktreePath: WT,
  createdAt: new Date().toISOString(),
});

if (!threadResult.ok) {
  console.log("\n[abort] thread.create refused — nothing further to drive.");
  writeFileSync(
    flags.out ?? join(process.cwd(), "findings.json"),
    JSON.stringify(findings, null, 2),
  );
  socket.close();
  process.exit(1);
}

// --------------------------------------------------------------------- watch

const log = [];
let marked = false;

const record = (item) => {
  const entry = { at: Date.now() - startedAt, kind: item.kind };
  if (item.kind === "event") {
    entry.type = item.event.type;
    entry.payload = item.event.payload;
  } else if (item.kind === "snapshot") {
    entry.session = item.snapshot.thread.session;
  } else {
    marked = true;
  }
  log.push(entry);

  const detail =
    entry.type === "thread.session-set"
      ? `  status=${entry.payload.session.status} activeTurnId=${entry.payload.session.activeTurnId ?? "null"}`
      : entry.type === "thread.activity-appended"
        ? `  activity=${entry.payload.activity.kind}`
        : entry.type === "thread.message-sent"
          ? // Asymmetry worth remembering: thread.turn.start NESTS the message
            // (message.text), but the thread.message-sent EVENT is flat —
            // payload.role / payload.text, no `message` wrapper.
            `  role=${entry.payload.role} streaming=${entry.payload.streaming}`
          : "";
  console.log(`  +${stamp()}ms  ${entry.type ?? entry.kind}${detail}`);
};

const waitFor = async (label, predicate, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  while (Date.now() < deadline) {
    for (; cursor < log.length; cursor++) if (predicate(log[cursor])) return log[cursor];
    await sleep(150);
  }
  console.log(`  !! timed out waiting for ${label}`);
  return null;
};

console.log("\n=== stage 7: subscribeThread ===");
openStream("orchestration.subscribeThread", { threadId: ID, requestCompletionMarker: true }, record);
await waitFor("subscription marker", () => marked, 15_000);

// --------------------------------------------------------------------- brief

console.log("\n=== stage 8: thread.turn.start carrying the launch brief ===");
const briefText = readFileSync(BRIEF, "utf8");
note(
  `brief passed as ${briefText.length} bytes of message text, matching claude-bg's ` +
    "CLAUDE_BG_PROMPT=$(cat \"$BRIEF\") (fm-spawn.sh:1766) rather than a path pointer",
);

await dispatch("thread.turn.start (launch brief)", {
  type: "thread.turn.start",
  commandId: randomUUID(),
  threadId: ID,
  message: { messageId: randomUUID(), role: "user", text: briefText, attachments: [] },
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: new Date().toISOString(),
});

await waitFor(
  "session running",
  (entry) =>
    entry.type === "thread.session-set" &&
    ["starting", "running"].includes(entry.payload.session.status),
  60_000,
);

// ---------------------------------------------------------------------- hold

console.log(`\n=== stage 9: HOLD — ${HOLD_SECONDS}s for the captain ===`);
console.log("  Open the T3 Code desktop app now.");
console.log(`    project : fm-proj-${projectId.slice(0, 8)}`);
console.log(`    thread  : ${THREAD_TITLE}`);
console.log(`    worktree: ${WT}`);
console.log("  Check: does the thread appear? Is its transcript live? Can you type into it");
console.log("  and get a reply, while this script still holds the socket?\n");

const holdUntil = Date.now() + HOLD_SECONDS * 1000;
while (Date.now() < holdUntil) {
  await sleep(5000);
  const last = log.findLast((entry) => entry.type === "thread.session-set");
  const remaining = Math.round((holdUntil - Date.now()) / 1000);
  console.log(
    `  [hold] ${remaining}s left — session=${last?.payload.session.status ?? "none"}, ` +
      `${log.length} stream items`,
  );
}

// Whether the captain's typing landed on the wire is itself the answer to the
// GUI half of the ticket: a message this script never sent, arriving on this
// script's subscription, is proof the two surfaces share one thread.
const userMessages = log.filter(
  (entry) => entry.type === "thread.message-sent" && entry.payload.role === "user",
);
note(
  `${userMessages.length} user message(s) seen on the subscription during the run; ` +
    `${Math.max(0, userMessages.length - 1)} of them arrived from the desktop GUI rather ` +
    "than from this script — which is the proof that both surfaces share one thread",
);
for (const entry of userMessages.slice(1)) {
  note(`captain typed in the GUI at +${entry.at}ms: ${JSON.stringify(entry.payload.text.slice(0, 120))}`);
}

// ----------------------------------------------------------------- interrupt

console.log("\n=== stage 10: thread.turn.interrupt ===");
await dispatch("thread.turn.interrupt", {
  type: "thread.turn.interrupt",
  commandId: randomUUID(),
  threadId: ID,
  createdAt: new Date().toISOString(),
});
// #7: an interrupt surfaces as session.status error, never interrupted.
const afterInterrupt = await waitFor(
  "session settling after interrupt",
  (entry) =>
    entry.type === "thread.session-set" &&
    ["interrupted", "error", "ready", "idle", "stopped"].includes(entry.payload.session.status),
  60_000,
);
note(`interrupt settled the session as ${afterInterrupt?.payload.session.status ?? "nothing"}`);
await sleep(3000);

// ---------------------------------------------------------------------- stop

console.log("\n=== stage 11: thread.session.stop ===");
await dispatch("thread.session.stop", {
  type: "thread.session.stop",
  commandId: randomUUID(),
  threadId: ID,
  createdAt: new Date().toISOString(),
});
await waitFor(
  "session stopped",
  (entry) =>
    entry.type === "thread.session-set" &&
    ["stopped", "idle", "ready"].includes(entry.payload.session.status),
  60_000,
);
await sleep(2000);

// ------------------------------------------------------------------ teardown

const outPath = flags.out ?? join(process.cwd(), "findings.json");

if (flags.keep || flags["no-teardown"]) {
  console.log("\n[teardown] skipped (--keep); thread, project and lease left in place");
} else {
  console.log("\n=== stage 12: teardown ===");
  await dispatch("thread.delete", {
    type: "thread.delete",
    commandId: randomUUID(),
    threadId: ID,
    force: true,
  });
  await dispatch("project.delete", {
    type: "project.delete",
    commandId: randomUUID(),
    projectId,
    force: true,
  });

  // fm-teardown.sh releases the lease with `treehouse return`.
  if (leaseMechanism === "treehouse") {
    try {
      // `treehouse return` takes the worktree PATH, not the lease holder.
      execFileSync("treehouse", ["return", WT], {
        cwd: PROJ_ABS,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      console.log("  [ok]      treehouse return");
    } catch (error) {
      note(`treehouse return failed: ${String(error.stderr ?? error.message).trim().slice(0, 300)}`);
    }
  }

  if (scratchCreated) {
    try {
      rmSync(PROJ_ABS, { recursive: true, force: true });
      rmSync(WT, { recursive: true, force: true });
    } catch (error) {
      // #7 saw the same thing: the server holds a handle after project.delete.
      console.log(`[teardown] scratch left behind (${error.code}): ${PROJ_ABS}`);
    }
  }
}

// -------------------------------------------------------------------- report

findings.summary = {
  taskId: ID,
  threadTitle: THREAD_TITLE,
  projectId,
  projAbs: PROJ_ABS,
  worktree: WT,
  branch: BRANCH,
  leaseMechanism,
  modelSelection,
  streamItems: log.length,
  accepted: findings.dispatches.filter((entry) => entry.ok).length,
  refused: findings.refusals.length,
};
writeFileSync(outPath, JSON.stringify({ ...findings, stream: log }, null, 2));

console.log("\n[report] ---------------------------------------------");
console.log(`  dispatched : ${findings.dispatches.length}`);
console.log(`  accepted   : ${findings.summary.accepted}`);
console.log(`  refused    : ${findings.refusals.length}`);
for (const refusal of findings.refusals) console.log(`     - ${refusal.label}: ${refusal.error.slice(0, 200)}`);
console.log(`  improvised : ${findings.improvised.length} field(s)`);
for (const entry of findings.improvised) console.log(`     - ${entry.field}`);
console.log(`  stream     : ${log.length} items -> ${outPath}`);

socket.close();
console.log("[done]");
process.exit(0);
