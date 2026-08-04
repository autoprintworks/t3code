#!/usr/bin/env node
/**
 * Spike for autoprintworks/t3code#14: does a treehouse-leased worktree survive
 * T3's checkpointing?
 *
 * The binding design hands T3 a worktree it did not create (#8): firstmate
 * leases it from treehouse, then passes the absolute path as
 * `thread.create.worktreePath`. T3 stores that path unvalidated
 * (orchestration/decider.ts:374) and uses it as the session cwd
 * (checkpointing/Utils.ts:22) — and then checkpointing writes git refs into it
 * and follows branch drift (Layers/CheckpointReactor.ts:565-625).
 *
 * This drives both halves for real, against a SCRATCH server on a SCRATCH
 * project. It never touches ~/.t3/userdata.
 *
 * Stages:
 *   A1 lease     treehouse get --lease  ->  worktree A
 *   A2 thread    project.create + thread.create pinned to worktree A
 *   A3 turn 1    crewmate creates its own fm/<id> branch and commits (#18)
 *   A4 turn 2    crewmate checks out a different branch -> drift-follow probe
 *   A5 return    fm-teardown.sh's order: detach, branch -D, treehouse return --force
 *   A6 delete    thread.delete AFTER the worktree is gone (the firstmate order)
 *   B1 release   treehouse get --lease again -> is it the same pooled worktree?
 *   B2 carryover inventory the reused worktree before anything runs in it
 *   B3 turn      thread B does one turn on the reused worktree
 *   B4 delete    thread.delete BEFORE the return (the other order)
 *   B5 return    treehouse return --force
 *
 * Every git observation is snapshotted into findings.json so the report quotes
 * measurements rather than recollection.
 *
 * Usage:
 *   node spike.mjs --lab <dir> [--keep]
 *
 * `--lab` must hold `proj/` (the scratch git repo), `t3home/` (the scratch T3
 * base-dir, with a server already listening) and `token.txt` (a bearer token
 * issued with `t3 auth session issue --token-only --base-dir <lab>/t3home`).
 * See README.md for the exact setup commands.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    lab: { type: "string" },
    // Which scratch server to drive. Branch-drift following only exists after
    // v0.0.31, so the interesting runs point at a nightly's base-dir.
    home: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean" },
  },
});

const LAB = (flags.lab ?? "").replace(/\\/g, "/");
if (!LAB) throw new Error("--lab is required");
const PROJ = join(LAB, "proj");
const T3HOME = flags.home ? flags.home.replace(/\\/g, "/") : join(LAB, "t3home");
const OUT = flags.out ?? join(process.cwd(), "findings.json");

const startedAt = Date.now();
const stamp = () => String(Date.now() - startedAt).padStart(6);

const findings = { setup: {}, stages: [], observations: {}, notes: [] };
const note = (text) => {
  findings.notes.push(text);
  console.log(`  [note] ${text}`);
};

// ------------------------------------------------------------------ git eyes

/** Run a command, never throwing: the failure itself is often the measurement. */
const run = (bin, args, cwd) => {
  try {
    const stdout = execFileSync(bin, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.replace(/\r/g, "").trim(), stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? "").replace(/\r/g, "").trim(),
      stderr: String(error.stderr ?? error.message).replace(/\r/g, "").trim(),
      status: error.status ?? null,
    };
  }
};

const git = (cwd, ...args) => run("git", args, cwd);
const gitOut = (cwd, ...args) => git(cwd, ...args).stdout;

const commonDir = (cwd) => {
  const raw = gitOut(cwd, "rev-parse", "--git-common-dir");
  if (!raw) return null;
  return raw.startsWith("/") || /^[A-Za-z]:/.test(raw) ? raw : join(cwd, raw);
};

/** refs/t3/checkpoints/* are ordinary shared refs, so read them from both ends. */
const checkpointRefs = (cwd) =>
  gitOut(cwd, "for-each-ref", "--format=%(refname) %(objectname:short)", "refs/t3")
    .split("\n")
    .filter(Boolean);

/** The capture path writes a temp index into the common dir; make leaks visible. */
const strayIndexFiles = (cwd) => {
  const dir = commonDir(cwd);
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => entry.startsWith("t3-checkpoint-index-"));
};

const listWorktreeFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((entry) => entry !== ".git").sort() : null;

/**
 * One complete picture of the git state both T3 and treehouse care about.
 * Recorded at every stage boundary so the report can diff two moments.
 */
const inventory = (label, worktree) => {
  const snapshot = {
    label,
    at: Date.now() - startedAt,
    worktreeExists: existsSync(worktree),
    head: worktree && existsSync(worktree) ? gitOut(worktree, "rev-parse", "--abbrev-ref", "HEAD") : null,
    headOid: worktree && existsSync(worktree) ? gitOut(worktree, "rev-parse", "HEAD") : null,
    status:
      worktree && existsSync(worktree)
        ? gitOut(worktree, "status", "--porcelain").split("\n").filter(Boolean)
        : null,
    files: listWorktreeFiles(worktree),
    branchesInRepo: gitOut(PROJ, "for-each-ref", "--format=%(refname:short)", "refs/heads")
      .split("\n")
      .filter(Boolean),
    checkpointRefsFromProject: checkpointRefs(PROJ),
    checkpointRefsFromWorktree:
      worktree && existsSync(worktree) ? checkpointRefs(worktree) : null,
    strayCheckpointIndexes: strayIndexFiles(PROJ),
    gitWorktreeList: gitOut(PROJ, "worktree", "list").split("\n").filter(Boolean),
    treehouseStatus: run("treehouse", ["status"], PROJ).stdout.split("\n").filter(Boolean),
  };
  findings.stages.push(snapshot);
  console.log(
    `\n[inventory ${label}] head=${snapshot.head} refs=${snapshot.checkpointRefsFromProject.length} ` +
      `files=${(snapshot.files ?? []).length} stray=${snapshot.strayCheckpointIndexes.length}`,
  );
  return snapshot;
};

// ------------------------------------------------------------------- connect

const token = readFileSync(join(T3HOME, "..", "token.txt"), "utf8").trim();
const runtime = JSON.parse(readFileSync(join(T3HOME, "userdata", "server-runtime.json"), "utf8"));
const origin = runtime.origin;
console.log(`[connect] scratch server ${origin} (pid ${runtime.pid}), base-dir ${T3HOME}`);

const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
if (!ticketResponse.ok) {
  throw new Error(`websocket-ticket failed: ${ticketResponse.status} ${await ticketResponse.text()}`);
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
      // #7 trap: miss the Ack and the stream stalls after one chunk.
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

const dispatch = async (label, command) => {
  try {
    const value = await sendRequest("orchestration.dispatchCommand", command);
    console.log(`  +${stamp()}ms  [ok]      ${label}`);
    return { ok: true, value };
  } catch (error) {
    const detail = String(error.message).slice(0, 600);
    console.log(`  +${stamp()}ms  [REFUSED] ${label}\n            ${detail}`);
    note(`${label} was refused: ${detail}`);
    return { ok: false, error: detail };
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- resolve

const config = await sendRequest("server.getConfig", {});
const instances = config.providers?.instances ?? config.providers ?? [];
const claude = instances.find((entry) => entry.driver === "claudeAgent");
if (!claude) throw new Error("scratch server has no claudeAgent instance");
const modelSelection = { instanceId: claude.instanceId, model: claude.models[0].slug ?? claude.models[0].id };
console.log(`[resolve] ${modelSelection.instanceId} / ${modelSelection.model}`);

// -------------------------------------------------------------- thread driver

/** One live subscription per thread, plus the waits the stages need. */
const watchThread = (threadId) => {
  const log = [];
  let marked = false;
  openStream(
    "orchestration.subscribeThread",
    { threadId, requestCompletionMarker: true },
    (item) => {
      if (item.kind === "marker") {
        marked = true;
        return;
      }
      const entry = { at: Date.now() - startedAt, kind: item.kind };
      if (item.kind === "event") {
        entry.type = item.event.type;
        entry.payload = item.event.payload;
      } else if (item.kind === "snapshot") {
        entry.type = "snapshot";
        entry.branch = item.snapshot.thread?.branch ?? null;
        entry.worktreePath = item.snapshot.thread?.worktreePath ?? null;
        entry.session = item.snapshot.thread?.session;
      }
      log.push(entry);
      if (entry.type === "thread.session-set") {
        console.log(`  +${stamp()}ms  session=${entry.payload.session.status}`);
      }
      if (entry.type === "thread.meta-updated") {
        console.log(`  +${stamp()}ms  META UPDATE ${JSON.stringify(entry.payload).slice(0, 200)}`);
      }
    },
  );
  // `from` matters: a turn's "settled" status must not be satisfied by the
  // idle status the thread was already sitting in before the turn started.
  const waitFor = async (label, predicate, timeoutMs, from = 0) => {
    const deadline = Date.now() + timeoutMs;
    let cursor = from;
    while (Date.now() < deadline) {
      for (; cursor < log.length; cursor++) if (predicate(log[cursor])) return { entry: log[cursor], index: cursor++ };
      await sleep(200);
    }
    console.log(`  !! timed out waiting for ${label}`);
    return null;
  };
  return {
    log,
    // The marker never lands in `log`, so poll the flag itself.
    ready: async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !marked) await sleep(200);
      if (!marked) console.log("  !! subscription marker never arrived");
    },
    waitFor,
  };
};

const SETTLED = ["idle", "ready", "stopped", "error", "interrupted"];

/**
 * The branch T3 currently believes the thread is on. `thread.meta-updated` is
 * not among the event types subscribeThread relays, so a drift-follow is
 * invisible on the live stream — a fresh subscription's snapshot is the only
 * client-visible authority.
 */
const readThreadBranch = async (threadId) => {
  let branch;
  openStream("orchestration.subscribeThread", { threadId, requestCompletionMarker: true }, (item) => {
    if (item.kind === "snapshot") branch = item.snapshot.thread?.branch;
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && branch === undefined) await sleep(200);
  return branch ?? null;
};

/** Start a turn and wait until the session settles and checkpointing quiesces. */
const runTurn = async (threadId, watcher, text, timeoutMs = 300_000) => {
  const before = watcher.log.length;
  await dispatch("thread.turn.start", {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  const running = await watcher.waitFor(
    "session running",
    (entry) =>
      entry.type === "thread.session-set" &&
      ["starting", "running"].includes(entry.payload.session.status),
    60_000,
    before,
  );
  const settled = await watcher.waitFor(
    "session settled",
    (entry) => entry.type === "thread.session-set" && SETTLED.includes(entry.payload.session.status),
    timeoutMs,
    running ? running.index + 1 : before,
  );
  // The turn-diff/checkpoint work runs after the session settles; give the
  // reactor a beat rather than racing it with a git read.
  await sleep(6000);
  return {
    settled: settled?.entry.payload.session.status ?? null,
    newEvents: watcher.log.length - before,
  };
};

// ==================================================================== part A

console.log("\n================ A1: lease worktree A from treehouse ================");
const idA = randomUUID();
const shortA = idA.slice(0, 8);
const holderA = `fm-${idA}`;
const branchA = `fm/${shortA}`;

const leaseA = run("treehouse", ["get", "--lease", "--lease-holder", holderA], PROJ);
if (!leaseA.ok) throw new Error(`treehouse lease failed: ${leaseA.stderr}`);
const WT_A = leaseA.stdout.split("\n").filter(Boolean).at(-1);
console.log(`[A1] worktree A = ${WT_A}`);
findings.setup = {
  lab: LAB,
  proj: PROJ,
  t3home: T3HOME,
  origin,
  serverPid: runtime.pid,
  worktreeA: WT_A,
  taskA: idA,
  branchA,
  modelSelection,
};
// #18: a treehouse lease lands on a detached HEAD, so the crewmate names its
// own branch. firstmate therefore passes the branch it *intends*, not one that
// exists yet.
note(`worktree A leased at HEAD=${gitOut(WT_A, "rev-parse", "--abbrev-ref", "HEAD")} (detached is expected, #18)`);
inventory("A1-after-lease", WT_A);

console.log("\n================ A2: project + thread pinned to worktree A ================");
// #3's trap: one active project per workspace root. A second run against the
// same scratch repo must adopt the existing project, not create one.
let projectId = randomUUID();
const projectResult = await dispatch("project.create", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `fm14-proj-${projectId.slice(0, 8)}`,
  workspaceRoot: PROJ,
  createdAt: new Date().toISOString(),
});
if (!projectResult.ok) {
  const existing = /Active project '([0-9a-f-]+)' already exists/.exec(projectResult.error);
  if (!existing) throw new Error("project.create refused for an unexpected reason");
  projectId = existing[1];
  note(`adopted the existing project ${projectId} for ${PROJ}`);
}
const threadA = await dispatch("thread.create (worktree A)", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId: idA,
  projectId,
  title: `fm-${shortA}`,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: branchA,
  worktreePath: WT_A,
  createdAt: new Date().toISOString(),
});
if (!threadA.ok) throw new Error("thread.create refused — nothing to measure");

const watchA = watchThread(idA);
await watchA.ready();

console.log("\n================ A3: turn 1 — crewmate creates its own branch ================");
const turnA1 = await runTurn(
  idA,
  watchA,
  [
    "You are a crewmate working inside your own git worktree. Stay inside it.",
    "",
    `1. Run: git checkout -b ${branchA}`,
    "2. Create a file CREWMATE-A.md containing the output of `git rev-parse --abbrev-ref HEAD`",
    "   and the current directory.",
    '3. Commit only CREWMATE-A.md with the message "crewmate A: report for duty".',
    "",
    "Do not push. Do not open a PR. Do not touch anything outside this worktree.",
    "Then stop and say DONE.",
  ].join("\n"),
);
findings.observations.turnA1 = turnA1;
findings.observations.branchRecordedAfterTurnA1 = await readThreadBranch(idA);
const invA3 = inventory("A3-after-turn-1", WT_A);
note(
  `after turn 1: HEAD=${invA3.head}, ${invA3.checkpointRefsFromProject.length} refs/t3 ref(s) visible ` +
    `from the PRIMARY checkout — checkpoint refs are shared refs, not per-worktree`,
);

console.log("\n================ A4: turn 2 — branch drift probe ================");
const driftBranch = `drifted/${shortA}`;
const turnA2 = await runTurn(
  idA,
  watchA,
  [
    `Run exactly: git checkout -b ${driftBranch}`,
    "Then report the output of `git rev-parse --abbrev-ref HEAD`.",
    "Change no files. Then stop and say DONE.",
  ].join("\n"),
);
findings.observations.turnA2 = turnA2;
const branchAfterDrift = await readThreadBranch(idA);
const headAfterDrift = gitOut(WT_A, "rev-parse", "--abbrev-ref", "HEAD");
findings.observations.drift = {
  branchAtCreate: branchA,
  worktreeHeadAfterDrift: headAfterDrift,
  branchRecordedAfterDrift: branchAfterDrift,
  driftFollowed: branchAfterDrift === headAfterDrift,
};
note(
  `drift probe: worktree HEAD is ${headAfterDrift}, T3 now records branch ` +
    `${branchAfterDrift} (drift ${branchAfterDrift === headAfterDrift ? "FOLLOWED" : "not followed"})`,
);
inventory("A4-after-drift", WT_A);

console.log("\n================ A5: fm-teardown order — detach, branch -D, return ================");
await dispatch("thread.session.stop", {
  type: "thread.session.stop",
  commandId: randomUUID(),
  threadId: idA,
  createdAt: new Date().toISOString(),
});
await sleep(4000);

// fm-teardown.sh:1267-1271 verbatim: detach, drop the current branch, then return.
const currentA = gitOut(WT_A, "rev-parse", "--abbrev-ref", "HEAD");
const detachA = git(WT_A, "checkout", "--detach", "-q");
const dropA = currentA === "HEAD" ? { ok: true, stdout: "(already detached)" } : git(WT_A, "branch", "-D", currentA);
const returnA = run("treehouse", ["return", "--force", WT_A], PROJ);
findings.observations.teardownA = {
  branchAtTeardown: currentA,
  detach: { ok: detachA.ok, stderr: detachA.stderr },
  branchDelete: { ok: dropA.ok, stdout: dropA.stdout, stderr: dropA.stderr },
  treehouseReturn: { ok: returnA.ok, stdout: returnA.stdout, stderr: returnA.stderr, status: returnA.status ?? 0 },
};
console.log(`[A5] treehouse return --force -> ok=${returnA.ok} ${returnA.stderr.slice(0, 300)}`);
const invA5 = inventory("A5-after-return", WT_A);
note(
  `treehouse return --force ${returnA.ok ? "SUCCEEDED" : "FAILED"} with ` +
    `${invA5.checkpointRefsFromProject.length} checkpoint ref(s) still in the repo`,
);

console.log("\n================ A6: thread.delete after the worktree is gone ================");
const deleteA = await dispatch("thread.delete", {
  type: "thread.delete",
  commandId: randomUUID(),
  threadId: idA,
  force: true,
});
findings.observations.threadDeleteA = deleteA;
await sleep(4000);
const invA6 = inventory("A6-after-thread-delete", WT_A);
note(
  `after thread.delete: ${invA6.checkpointRefsFromProject.length} checkpoint ref(s) remain ` +
    "(T3 only deletes checkpoint refs on revert, never on thread deletion)",
);

// ==================================================================== part B

console.log("\n================ B1: lease again — pooled reuse ================");
const idB = randomUUID();
const shortB = idB.slice(0, 8);
const holderB = `fm-${idB}`;
const leaseB = run("treehouse", ["get", "--lease", "--lease-holder", holderB], PROJ);
if (!leaseB.ok) throw new Error(`second treehouse lease failed: ${leaseB.stderr}`);
const WT_B = leaseB.stdout.split("\n").filter(Boolean).at(-1);
findings.observations.pooledReuse = { worktreeA: WT_A, worktreeB: WT_B, sameDirectory: WT_A === WT_B };
console.log(`[B1] worktree B = ${WT_B} (same as A: ${WT_A === WT_B})`);

console.log("\n================ B2: carryover inventory BEFORE anything runs ================");
const invB2 = inventory("B2-reused-worktree-pristine", WT_B);
findings.observations.carryover = {
  crewmateAFileStillPresent: (invB2.files ?? []).includes("CREWMATE-A.md"),
  files: invB2.files,
  dirty: invB2.status,
  head: invB2.head,
  checkpointRefsVisible: invB2.checkpointRefsFromWorktree,
  logFromHead: gitOut(WT_B, "log", "--oneline", "-5").split("\n").filter(Boolean),
};
note(
  `reused worktree carries ${(invB2.status ?? []).length} dirty path(s) and ` +
    `${(invB2.checkpointRefsFromWorktree ?? []).length} of the previous thread's checkpoint refs ` +
    "(visible because the ref store is shared, not because the worktree is dirty)",
);

console.log("\n================ B3: thread B on the reused worktree ================");
const branchB = `fm/${shortB}`;
const threadB = await dispatch("thread.create (reused worktree)", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId: idB,
  projectId,
  title: `fm-${shortB}`,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: branchB,
  worktreePath: WT_B,
  createdAt: new Date().toISOString(),
});
if (!threadB.ok) throw new Error("thread.create for the reused worktree was refused");

const watchB = watchThread(idB);
await watchB.ready();
const turnB1 = await runTurn(
  idB,
  watchB,
  [
    "You are a crewmate who has just been handed a worktree. Report what you inherited.",
    "",
    `1. Run: git checkout -b ${branchB}`,
    "2. Create CREWMATE-B.md containing the output of `ls -a`, `git status --porcelain`,",
    "   `git rev-parse --abbrev-ref HEAD` and `git log --oneline -3`.",
    "3. Do not commit anything.",
    "",
    "Do not touch anything outside this worktree. Then stop and say DONE.",
  ].join("\n"),
);
findings.observations.turnB1 = turnB1;
const invB3 = inventory("B3-after-turn", WT_B);
const crewmateBReport = existsSync(join(WT_B, "CREWMATE-B.md"))
  ? readFileSync(join(WT_B, "CREWMATE-B.md"), "utf8")
  : null;
findings.observations.crewmateBReport = crewmateBReport;
note(
  `thread B checkpoint refs: ${invB3.checkpointRefsFromProject.length} total in the repo ` +
    "(each thread id gets its own refs/t3/checkpoints/<base64url threadId>/ namespace)",
);

console.log("\n================ B4: thread.delete BEFORE the return ================");
await dispatch("thread.session.stop", {
  type: "thread.session.stop",
  commandId: randomUUID(),
  threadId: idB,
  createdAt: new Date().toISOString(),
});
await sleep(4000);
const deleteB = await dispatch("thread.delete", {
  type: "thread.delete",
  commandId: randomUUID(),
  threadId: idB,
  force: true,
});
findings.observations.threadDeleteB = deleteB;
await sleep(4000);
const invB4 = inventory("B4-after-thread-delete-worktree-alive", WT_B);
note(
  `deleting thread B while its worktree still exists left ` +
    `${invB4.checkpointRefsFromProject.length} checkpoint ref(s) — same as deleting it after`,
);

console.log("\n================ B5: return the pooled worktree ================");
const currentB = gitOut(WT_B, "rev-parse", "--abbrev-ref", "HEAD");
const detachB = git(WT_B, "checkout", "--detach", "-q");
const dropB = currentB === "HEAD" ? { ok: true, stdout: "(already detached)" } : git(WT_B, "branch", "-D", currentB);
const returnB = run("treehouse", ["return", "--force", WT_B], PROJ);
findings.observations.teardownB = {
  branchAtTeardown: currentB,
  detach: { ok: detachB.ok, stderr: detachB.stderr },
  branchDelete: { ok: dropB.ok, stdout: dropB.stdout, stderr: dropB.stderr },
  treehouseReturn: { ok: returnB.ok, stdout: returnB.stdout, stderr: returnB.stderr, status: returnB.status ?? 0 },
};
console.log(`[B5] treehouse return --force -> ok=${returnB.ok} ${returnB.stderr.slice(0, 300)}`);
inventory("B5-final", WT_B);

// -------------------------------------------------------------------- report

findings.observations.finalCheckpointRefs = checkpointRefs(PROJ);
findings.observations.finalBranches = gitOut(PROJ, "for-each-ref", "--format=%(refname:short)", "refs/heads")
  .split("\n")
  .filter(Boolean);
findings.observations.finalStrayIndexes = strayIndexFiles(PROJ);
findings.observations.repoSizeAfter = run("git", ["count-objects", "-vH"], PROJ).stdout.split("\n");

writeFileSync(OUT, JSON.stringify(findings, null, 2));

console.log("\n[report] ---------------------------------------------");
console.log(`  worktree A            : ${WT_A}`);
console.log(`  worktree B            : ${WT_B} (reused: ${WT_A === WT_B})`);
console.log(`  treehouse return A    : ${returnA.ok ? "ok" : "FAILED"}`);
console.log(`  treehouse return B    : ${returnB.ok ? "ok" : "FAILED"}`);
console.log(`  checkpoint refs left  : ${findings.observations.finalCheckpointRefs.length}`);
for (const ref of findings.observations.finalCheckpointRefs) console.log(`     ${ref}`);
console.log(`  branches left         : ${findings.observations.finalBranches.join(", ")}`);
console.log(`  stray index files     : ${findings.observations.finalStrayIndexes.length}`);
console.log(`  findings              : ${OUT}`);

socket.close();
process.exit(0);
