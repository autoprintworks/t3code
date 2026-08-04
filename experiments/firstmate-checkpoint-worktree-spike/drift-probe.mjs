#!/usr/bin/env node
/**
 * Follow-up probe for autoprintworks/t3code#14.
 *
 * The main spike found that a crewmate checking out a different branch inside a
 * treehouse-leased worktree produced NO `thread.meta-updated` — T3's
 * branch-drift following (Layers/CheckpointReactor.ts:565-625) stayed silent.
 * That is either a property of externally-supplied worktrees in general, or
 * something specific to the path treehouse hands over.
 *
 * So run the same drift twice, changing only the worktree's provenance:
 *   arm "treehouse" — worktree leased with `treehouse get --lease`
 *   arm "plain"     — worktree created with `git worktree add --detach`
 *
 * Both threads are created the same way, with the same shape of absolute path,
 * and both are told to check out a new branch. Whichever arm emits
 * `thread.meta-updated` tells us which half of the guard chain is failing.
 *
 * Usage: node drift-probe.mjs --lab <dir>
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    lab: { type: "string" },
    // v0.0.31 predates branch-drift following, so the probe has to be pointed at
    // a second scratch server built from a nightly that contains it.
    home: { type: "string" },
    out: { type: "string" },
  },
});
const LAB = (flags.lab ?? "").replace(/\\/g, "/");
if (!LAB) throw new Error("--lab is required");
const PROJ = join(LAB, "proj");
const T3HOME = flags.home ? flags.home.replace(/\\/g, "/") : join(LAB, "t3home");
const OUT = flags.out ?? join(process.cwd(), "drift-findings.json");

const run = (bin, args, cwd) => {
  try {
    return {
      ok: true,
      stdout: execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        .replace(/\r/g, "")
        .trim(),
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? "").replace(/\r/g, "").trim(),
      stderr: String(error.stderr ?? error.message).replace(/\r/g, "").trim(),
    };
  }
};
const gitOut = (cwd, ...args) => run("git", args, cwd).stdout;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- connect

const token = readFileSync(join(T3HOME, "..", "token.txt"), "utf8").trim();
const { origin } = JSON.parse(readFileSync(join(T3HOME, "userdata", "server-runtime.json"), "utf8"));
const wsTicket = (
  await (
    await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })
  ).json()
).ticket;

const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(wsTicket)}`);
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
      continue;
    }
    const entry = pending.get(requestId);
    if (!entry) continue;
    pending.delete(requestId);
    if (message.exit._tag === "Success") entry.resolve(message.exit.value);
    else entry.reject(new Error(JSON.stringify(message.exit.cause)));
  }
});
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

const config = await sendRequest("server.getConfig", {});
const instances = config.providers?.instances ?? config.providers ?? [];
const claude = instances.find((entry) => entry.driver === "claudeAgent");
const modelSelection = { instanceId: claude.instanceId, model: claude.models[0].slug ?? claude.models[0].id };

// One-active-project-per-workspace-root is an invariant (#3), so adopt the
// project the main spike already created rather than failing on the refusal.
let projectId = randomUUID();
try {
  await sendRequest("orchestration.dispatchCommand", {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: `fm14-drift-${projectId.slice(0, 8)}`,
    workspaceRoot: PROJ,
    createdAt: new Date().toISOString(),
  });
} catch (error) {
  const existing = /Active project '([0-9a-f-]+)' already exists/.exec(String(error.message));
  if (!existing) throw error;
  projectId = existing[1];
  console.log(`[setup] adopted existing project ${projectId}`);
}

// ---------------------------------------------------------------------- arms

const results = [];

/** Create a thread on `worktree`, drift its branch, and report what T3 recorded. */
const probe = async (label, worktree) => {
  const threadId = randomUUID();
  const short = threadId.slice(0, 8);
  const startBranch = `start/${short}`;
  const driftBranch = `drift/${short}`;

  // Put the worktree on a real branch first so the recorded branch is one the
  // thread genuinely started on — drift-following ignores a null branch.
  run("git", ["checkout", "-b", startBranch], worktree);

  await sendRequest("orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId,
    title: `drift-${label}-${short}`,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: startBranch,
    worktreePath: worktree,
    createdAt: new Date().toISOString(),
  });

  const log = [];
  let snapshotWorktreePath;
  let snapshotBranch;
  openStream("orchestration.subscribeThread", { threadId, requestCompletionMarker: true }, (item) => {
    if (item.kind === "snapshot") {
      snapshotWorktreePath = item.snapshot.thread?.worktreePath;
      snapshotBranch = item.snapshot.thread?.branch;
      return;
    }
    if (item.kind !== "event") return;
    log.push({ type: item.event.type, payload: item.event.payload });
  });
  await sleep(4000);

  await sendRequest("orchestration.dispatchCommand", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: {
      messageId: randomUUID(),
      role: "user",
      text: [
        `Run exactly: git checkout -b ${driftBranch}`,
        "Then report the output of `git rev-parse --abbrev-ref HEAD`.",
        "Change no files. Then stop and say DONE.",
      ].join("\n"),
    attachments: [],
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });

  const deadline = Date.now() + 240_000;
  let settled = false;
  while (Date.now() < deadline && !settled) {
    await sleep(500);
    const last = log.findLast((entry) => entry.type === "thread.session-set");
    settled =
      last !== undefined && ["idle", "ready", "stopped", "error"].includes(last.payload.session.status);
  }
  // The drift-follow dispatch happens off the turn.completed receipt, after the
  // session settles; give the reactor room rather than racing it.
  await sleep(10_000);

  // `thread.meta-updated` is not one of the event types subscribeThread relays,
  // so the drift-follow is invisible on the live stream. Re-subscribe and read
  // the fresh snapshot instead: the read model is the authority on what T3
  // thinks the thread's branch is.
  const branchAtCreate = snapshotBranch ?? startBranch;
  snapshotBranch = undefined;
  openStream("orchestration.subscribeThread", { threadId, requestCompletionMarker: true }, (item) => {
    if (item.kind === "snapshot") snapshotBranch = item.snapshot.thread?.branch;
  });
  await sleep(5000);

  const result = {
    label,
    worktreePathSent: worktree,
    worktreePathRecorded: snapshotWorktreePath,
    pathsIdentical: snapshotWorktreePath === worktree,
    branchRecordedAtCreate: branchAtCreate,
    branchRecordedAfterTurn: snapshotBranch ?? null,
    branchCheckedOutAfterTurn: gitOut(worktree, "rev-parse", "--abbrev-ref", "HEAD"),
    driftFollowed: snapshotBranch === driftBranch,
    metaUpdatedEventsOnStream: log.filter((entry) => entry.type === "thread.meta-updated").length,
    eventTypes: [...new Set(log.map((entry) => entry.type))],
  };
  results.push(result);
  console.log(
    `\n[${label}] sent=${worktree}\n[${label}] recorded=${snapshotWorktreePath}\n` +
      `[${label}] identical=${result.pathsIdentical} checkedOut=${result.branchCheckedOutAfterTurn} ` +
      `recorded=${result.branchRecordedAfterTurn} driftFollowed=${result.driftFollowed}`,
  );

  await sendRequest("orchestration.dispatchCommand", {
    type: "thread.session.stop",
    commandId: randomUUID(),
    threadId,
    createdAt: new Date().toISOString(),
  });
  await sleep(3000);
  await sendRequest("orchestration.dispatchCommand", {
    type: "thread.delete",
    commandId: randomUUID(),
    threadId,
    force: true,
  });
  return result;
};

console.log("=== arm 1: treehouse-leased worktree ===");
const holder = `fm-${randomUUID()}`;
const lease = run("treehouse", ["get", "--lease", "--lease-holder", holder], PROJ);
if (!lease.ok) throw new Error(`treehouse lease failed: ${lease.stderr}`);
const treehouseWorktree = lease.stdout.split("\n").filter(Boolean).at(-1);
await probe("treehouse", treehouseWorktree);

console.log("\n=== arm 2: plain `git worktree add` ===");
const plainWorktree = join(LAB, "plain-wt");
if (existsSync(plainWorktree)) {
  run("git", ["worktree", "remove", "--force", plainWorktree], PROJ);
  rmSync(plainWorktree, { recursive: true, force: true });
}
const added = run("git", ["worktree", "add", "--detach", plainWorktree], PROJ);
if (!added.ok) throw new Error(`git worktree add failed: ${added.stderr}`);
await probe("plain", plainWorktree);

// ------------------------------------------------------------------ teardown

run("treehouse", ["return", "--force", treehouseWorktree], PROJ);
run("git", ["worktree", "remove", "--force", plainWorktree], PROJ);

writeFileSync(OUT, JSON.stringify({ results }, null, 2));
console.log(`\n[report] drift followed: ${results.map((r) => `${r.label}=${r.driftFollowed}`).join(", ")}`);
console.log(`[report] ${OUT}`);
socket.close();
process.exit(0);
