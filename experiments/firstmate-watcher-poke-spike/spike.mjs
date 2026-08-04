#!/usr/bin/env node
/**
 * Spike for autoprintworks/t3code#10: can the watcher wake a sleeping first
 * mate over the websocket?
 *
 * firstmate's watcher wakes a sleeping mate by typing into its live session.
 * With the mate living in a T3 thread that becomes an external process
 * dispatching `thread.turn.start` into the mate's own thread. This drives that
 * end to end and answers the ticket's three questions:
 *
 *   1. Does a self-directed turn.start from outside the GUI behave identically
 *      to typing in the composer?
 *   2. What does the poke render as in the captain's transcript?
 *   3. Does it work while the thread is settled, snoozed, or archived?
 *
 * The mate is a real thread with a real agent in it. The poke always comes from
 * `watcher-poke.mjs` as a CHILD PROCESS with its own token, its own websocket
 * ticket and its own socket — never from this script's already-open connection,
 * because that would prove the wrong thing.
 *
 * Every poke carries firstmate's real operational-input envelope
 * (bin/fm-operational-input.sh:28-30) so the transcript measurement is of the
 * bytes firstmate would actually inject, not a paraphrase.
 *
 * Each phase asks the mate to append one line to WOKE.md containing a secret it
 * was told in the seed turn. That single line proves three things at once: the
 * agent picked the turn up, it acted on the filesystem, and it still had its
 * context.
 *
 * Usage:
 *   node spike.mjs --token-file <path> [--keep] [--only ready,settled]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));

const { values: flags } = parseArgs({
  options: {
    "token-file": { type: "string" },
    "base-dir": { type: "string" },
    origin: { type: "string" },
    out: { type: "string" },
    proj: { type: "string" },
    only: { type: "string" },
    keep: { type: "boolean" },
    // Optional captain window: hold before teardown so a human can look at the
    // transcript in the desktop app and say what the pokes look like there.
    "gui-hold": { type: "string" },
  },
});

const startedAt = Date.now();
const stamp = () => String(Date.now() - startedAt).padStart(6);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------- firstmate's operational envelope

// U+2063 INVISIBLE SEPARATOR + "FIRSTMATE_OP: v1 <kind>: <body>".
// The mark is zero-width, so in a tmux pane the row reads as prose and
// firstmate's scanners still key off it structurally. Whether that survives a
// chat bubble is exactly what question 2 is asking.
const FM_OPERATIONAL_MARK = "⁣";
const encodeOperationalInput = (kind, body) =>
  `${FM_OPERATIONAL_MARK}FIRSTMATE_OP: v1 ${kind}: ${body}`;

// ------------------------------------------------------------------ findings

const findings = { phases: [], dispatches: [], notes: [], improvised: [] };
const note = (text) => {
  findings.notes.push(text);
  console.log(`  [note] ${text}`);
};

// ------------------------------------------------------------------- fixture

const ID = randomUUID();
const THREAD_TITLE = `fm-${ID.slice(0, 8)}`;
// The mate has to prove context survived the wake, so give it something only
// this run knows.
const SECRET = `kittiwake-${randomUUID().slice(0, 6)}`;

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let PROJ_ABS = flags.proj;
let scratchCreated = false;
if (!PROJ_ABS) {
  PROJ_ABS = mkdtempSync(join(tmpdir(), "fm-poke-"));
  scratchCreated = true;
  writeFileSync(join(PROJ_ABS, "README.md"), "# firstmate watcher poke spike\n");
  git(PROJ_ABS, "init", "-b", "main");
  git(PROJ_ABS, "config", "user.email", "spike@firstmate.local");
  git(PROJ_ABS, "config", "user.name", "firstmate spike");
  git(PROJ_ABS, "add", ".");
  git(PROJ_ABS, "commit", "-m", "scratch project for the watcher poke spike");
}
const WOKE = join(PROJ_ABS, "WOKE.md");
console.log(`[fixture] PROJ_ABS=${PROJ_ABS}`);
console.log(`[fixture] mate thread ${ID} (${THREAD_TITLE}), secret ${SECRET}`);

/** Lines the mate has written to WOKE.md so far, one per successful wake. */
const wokeLines = () =>
  existsSync(WOKE)
    ? readFileSync(WOKE, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
    : [];

// ------------------------------------------------------------------- connect

const resolveT3Home = () =>
  flags["base-dir"] ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3");

const origin =
  flags.origin ??
  JSON.parse(readFileSync(join(resolveT3Home(), "userdata", "server-runtime.json"), "utf8")).origin;

const tokenFile = flags["token-file"];
if (!tokenFile) throw new Error("--token-file is required (see the README for minting one)");
const token = readFileSync(tokenFile, "utf8").trim();

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
      // #7 trap: miss the Ack and the stream stalls forever after one chunk.
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
  socket.addEventListener("close", (event) => reject(new Error(`closed ${event.code}`)), {
    once: true,
  });
});
console.log(`[connect] observer socket open on ${origin}`);

const dispatch = async (label, command) => {
  try {
    const value = await sendRequest("orchestration.dispatchCommand", command);
    findings.dispatches.push({ label, type: command.type, ok: true });
    console.log(`  +${stamp()}ms  [ok]      ${label}`);
    return { ok: true, value };
  } catch (error) {
    const detail = String(error.message).slice(0, 900);
    findings.dispatches.push({ label, type: command.type, ok: false, error: detail });
    console.log(`  +${stamp()}ms  [REFUSED] ${label}\n            ${detail}`);
    return { ok: false, error: detail };
  }
};

// ------------------------------------------------------------------- resolve

const config = await sendRequest("server.getConfig", {});
const providerList = config.providers?.instances ?? config.providers ?? [];
const claude = (Array.isArray(providerList) ? providerList : []).find(
  (entry) => entry.driver === "claudeAgent" || entry.instanceId === "claudeAgent",
);
if (!claude) throw new Error("no claudeAgent provider instance");
const modelSelection = { instanceId: claude.instanceId, model: claude.models?.[0]?.slug };
console.log(`[resolve] ${modelSelection.instanceId} / ${modelSelection.model}`);

// ------------------------------------------------- project + the mate thread

const projectId = randomUUID();
await dispatch("project.create", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `fm-mate-${projectId.slice(0, 8)}`,
  workspaceRoot: PROJ_ABS,
  createdAt: new Date().toISOString(),
});

const threadResult = await dispatch("thread.create (the first mate)", {
  type: "thread.create",
  commandId: randomUUID(),
  threadId: ID,
  projectId,
  title: THREAD_TITLE,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
});
if (!threadResult.ok) throw new Error("thread.create refused — nothing to poke");

// --------------------------------------------------------------------- watch

const log = [];
let marked = false;
let lastSnapshot = null;

const record = (item) => {
  const entry = { at: Date.now() - startedAt, kind: item.kind };
  if (item.kind === "event") {
    entry.type = item.event.type;
    entry.payload = item.event.payload;
  } else if (item.kind === "snapshot") {
    lastSnapshot = item.snapshot.thread;
    entry.session = item.snapshot.thread.session;
  } else {
    marked = true;
  }
  log.push(entry);

  // The message event is FLAT (payload.role), unlike the nested command (#9).
  const detail =
    entry.type === "thread.session-set"
      ? `  status=${entry.payload.session.status} turn=${entry.payload.session.activeTurnId ?? "null"}`
      : entry.type === "thread.message-sent"
        ? `  role=${entry.payload.role} streaming=${entry.payload.streaming} turnId=${entry.payload.turnId ?? "null"}`
        : entry.type === "thread.activity-appended"
          ? `  activity=${entry.payload.activity.kind}`
          : "";
  console.log(`  +${stamp()}ms  ${entry.type ?? entry.kind}${detail}`);
};

const waitFor = async (label, predicate, timeoutMs = 180_000, fromIndex = 0) => {
  const deadline = Date.now() + timeoutMs;
  let cursor = fromIndex;
  while (Date.now() < deadline) {
    for (; cursor < log.length; cursor++) if (predicate(log[cursor])) return log[cursor];
    await sleep(150);
  }
  console.log(`  !! timed out waiting for ${label}`);
  return null;
};

const isStatus = (entry, ...statuses) =>
  entry.type === "thread.session-set" && statuses.includes(entry.payload.session.status);

/** Wait for a turn to start and then finish, from a point in the stream. */
const awaitTurn = async (fromIndex, timeoutMs = 240_000) => {
  const running = await waitFor("turn running", (entry) => isStatus(entry, "running"), 90_000, fromIndex);
  const runningIndex = running ? log.indexOf(running) : fromIndex;
  const settled = await waitFor(
    "turn settled",
    (entry) => isStatus(entry, "ready", "idle", "stopped", "error"),
    timeoutMs,
    runningIndex + 1,
  );
  return { running, settled };
};

console.log("\n=== subscribeThread ===");
openStream("orchestration.subscribeThread", { threadId: ID, requestCompletionMarker: true }, record);
await waitFor("subscription marker", () => marked, 15_000);

/** The lifecycle flags a captain's inbox is derived from. */
const lifecycle = () => ({
  archivedAt: lastSnapshot?.archivedAt ?? null,
  settledOverride: lastSnapshot?.settledOverride ?? null,
  settledAt: lastSnapshot?.settledAt ?? null,
  snoozedUntil: lastSnapshot?.snoozedUntil ?? null,
  sessionStatus: lastSnapshot?.session?.status ?? null,
});

/**
 * Re-read the thread from the server rather than trusting the accumulated
 * stream: the snapshot is what a client renders, so it is the honest source for
 * "what does the captain see".
 */
const readThread = async () => {
  let snapshot = null;
  const id = openStream("orchestration.subscribeThread", { threadId: ID }, (item) => {
    if (item.kind === "snapshot") snapshot = item.snapshot.thread;
  });
  for (let i = 0; i < 100 && !snapshot; i++) await sleep(100);
  sendRaw({ _tag: "Interrupt", requestId: id });
  streams.delete(id);
  if (snapshot) lastSnapshot = snapshot;
  return snapshot;
};

// ----------------------------------------------------------------- seed turn

console.log("\n=== seed: the mate takes up station ===");
const seedIndex = log.length;
const seedMessageId = randomUUID();
await dispatch("thread.turn.start (seed)", {
  type: "thread.turn.start",
  commandId: randomUUID(),
  threadId: ID,
  message: {
    messageId: seedMessageId,
    role: "user",
    text: [
      "You are a first mate on watch. Two standing rules for this session:",
      "",
      `1. Your watch word is \`${SECRET}\`. Remember it.`,
      "2. Whenever you are woken, append EXACTLY ONE line to `WOKE.md` in the project root",
      "   of the form `<reason> <watch word>`, then stop and reply in one short sentence.",
      "   Create the file if it does not exist. Never rewrite existing lines.",
      "",
      "Right now: reply with the single word `aye` and do nothing else. Do not create WOKE.md yet.",
    ].join("\n"),
    attachments: [],
  },
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: new Date().toISOString(),
});
await awaitTurn(seedIndex);
await readThread();
console.log(`[seed] mate on station: ${JSON.stringify(lifecycle())}`);

// The composer sends this exact command shape (packages/client-runtime
// operations/commands.ts:239) with only commandId and createdAt minted
// client-side, so record the seed message payload for a field-by-field diff
// against a poke's.
const seedMessage = log.find(
  (entry) => entry.type === "thread.message-sent" && entry.payload.messageId === seedMessageId,
);

// ---------------------------------------------------------------- the phases

/** Run the watcher as a real child process and return its JSON verdict. */
const runWatcher = (text) => {
  const raw = execFileSync(
    process.execPath,
    [
      join(HERE, "watcher-poke.mjs"),
      "--token-file",
      tokenFile,
      "--thread",
      ID,
      "--text",
      text,
      ...(flags.origin ? ["--origin", flags.origin] : []),
      ...(flags["base-dir"] ? ["--base-dir", flags["base-dir"]] : []),
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return JSON.parse(raw.trim().split(/\r?\n/).pop());
};

const PHASES = [
  {
    name: "ready",
    what: "the mate is idle on station — the plainest sleeping-mate case",
    reason: "stale:fm-crew-a1b2c3 idle 12m with an unclaimed check",
  },
  {
    name: "settled",
    what: "explicitly settled: the captain has parked the thread out of the inbox",
    prepare: () =>
      dispatch("thread.settle", { type: "thread.settle", commandId: randomUUID(), threadId: ID }),
    reason: "signal:fm-crew-d4e5f6 raised a hand while you were parked",
  },
  {
    name: "snoozed",
    what: "snoozed an hour out: suppressed from the inbox until the wake time",
    prepare: () =>
      dispatch("thread.snooze", {
        type: "thread.snooze",
        commandId: randomUUID(),
        threadId: ID,
        snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    reason: "check:ci-red on fm-crew-g7h8i9 before your snooze was due to lift",
  },
  {
    name: "archived",
    what: "archived: gone from the shell entirely",
    prepare: () =>
      dispatch("thread.archive", { type: "thread.archive", commandId: randomUUID(), threadId: ID }),
    reason: "heartbeat:watcher still alive and you are archived",
    after: () =>
      dispatch("thread.unarchive", {
        type: "thread.unarchive",
        commandId: randomUUID(),
        threadId: ID,
      }),
  },
  {
    name: "stopped",
    what: "session stopped: the provider process is gone, the truest 'asleep'",
    prepare: async () => {
      const index = log.length;
      await dispatch("thread.session.stop", {
        type: "thread.session.stop",
        commandId: randomUUID(),
        threadId: ID,
        createdAt: new Date().toISOString(),
      });
      await waitFor("session stopped", (entry) => isStatus(entry, "stopped", "idle"), 60_000, index);
      await sleep(2000);
    },
    reason: "stale:fm-crew-j0k1l2 idle 30m and your session had exited",
  },
  {
    name: "busy",
    what: "poked mid-turn: does the wake land as a steer, a queue, or a refusal?",
    // A brief the mate cannot finish before the poke arrives.
    prepare: async () => {
      const index = log.length;
      await dispatch("thread.turn.start (long turn to interrupt)", {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId: ID,
        message: {
          messageId: randomUUID(),
          role: "user",
          text:
            "Using no tools at all, count from 1 to 400, one per line, writing each number as " +
            "a numeral and as a word (for example `1 - one`). Go all the way to 400. Do not " +
            "touch WOKE.md while doing this.",
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      });
      await waitFor("long turn running", (entry) => isStatus(entry, "running"), 90_000, index);
      await sleep(12_000);
    },
    reason: "signal:fm-crew-m3n4o5 needs a decision, and you are mid-turn",
  },
];

const selected = flags.only
  ? PHASES.filter((phase) => flags.only.split(",").includes(phase.name))
  : PHASES;

for (const phase of selected) {
  console.log(`\n=== phase ${phase.name}: ${phase.what} ===`);
  if (phase.prepare) await phase.prepare();
  await readThread();
  const before = lifecycle();
  const beforeLines = wokeLines().length;
  const beforeIndex = log.length;
  console.log(`  [before] ${JSON.stringify(before)}`);

  // The poke text is firstmate's real envelope carrying a real watcher wake
  // reason, so the transcript row this produces is the row firstmate produces.
  const text = encodeOperationalInput(
    "watcher",
    `WAKE ${phase.reason}. Log this wake in WOKE.md with reason \`${phase.name}\` per your standing rules, then stand by.`,
  );

  const verdict = runWatcher(text);
  console.log(
    `  [watcher pid ${verdict.pid}] ${verdict.ok ? "accepted" : `REFUSED: ${verdict.error}`} ` +
      `(ticket ${verdict.ticketMs}ms, total ${verdict.totalMs}ms)`,
  );

  let acted = false;
  let turn = null;
  if (verdict.ok) {
    turn = await awaitTurn(beforeIndex);
    // Give the write a moment to land after the turn settles.
    for (let i = 0; i < 40 && wokeLines().length <= beforeLines; i++) await sleep(500);
    acted = wokeLines().length > beforeLines;
  }
  await readThread();
  const after = lifecycle();

  const pokeEvent = log
    .slice(beforeIndex)
    .find(
      (entry) =>
        entry.type === "thread.message-sent" && entry.payload.messageId === verdict.messageId,
    );
  const slice = log.slice(beforeIndex);

  const result = {
    phase: phase.name,
    what: phase.what,
    accepted: verdict.ok === true,
    error: verdict.error ?? null,
    watcherPid: verdict.pid,
    ticketMs: verdict.ticketMs ?? null,
    dispatchMs: verdict.totalMs ?? null,
    agentActed: acted,
    wokeLine: acted ? wokeLines().at(-1) : null,
    // A wake is only useful if the mate still knows who it is.
    keptContext: acted ? String(wokeLines().at(-1)).includes(SECRET) : false,
    before,
    after,
    lifecycleEvents: slice
      .filter((entry) => String(entry.type ?? "").match(/unsettled|unsnoozed|archived|settled|snoozed/))
      .map((entry) => entry.type),
    // The transcript cost of one poke, as the captain would count it.
    rowsAdded: slice.filter((entry) => entry.type === "thread.message-sent").length,
    streamItems: slice.length,
    pokeMessage: pokeEvent
      ? {
          role: pokeEvent.payload.role,
          turnId: pokeEvent.payload.turnId,
          streaming: pokeEvent.payload.streaming,
          textPrefix: pokeEvent.payload.text.slice(0, 60),
        }
      : null,
    settledStatus: turn?.settled?.payload.session.status ?? null,
  };
  findings.phases.push(result);
  console.log(
    `  [result] accepted=${result.accepted} acted=${result.agentActed} ` +
      `context=${result.keptContext} lifecycle=[${result.lifecycleEvents.join(",")}]`,
  );
  console.log(`  [after]  ${JSON.stringify(after)}`);
  if (result.wokeLine) console.log(`  [woke]   ${result.wokeLine}`);

  if (phase.after) await phase.after();
  await sleep(1500);
}

// ------------------------------------------------------------ the transcript

console.log("\n=== transcript as the captain sees it ===");
const finalThread = await readThread();
const messages = finalThread?.messages ?? [];
const transcript = messages.map((message) => ({
  role: message.role,
  // Does the invisible mark survive the round trip into the read model?
  carriesOperationalMark: typeof message.text === "string" && message.text.includes(FM_OPERATIONAL_MARK),
  chars: message.text?.length ?? 0,
  text: (message.text ?? "").slice(0, 140),
}));
for (const row of transcript) {
  console.log(
    `  ${row.role.padEnd(9)} mark=${row.carriesOperationalMark ? "yes" : "no "} ` +
      `${JSON.stringify(row.text.slice(0, 96))}`,
  );
}

const userRows = transcript.filter((row) => row.role === "user");
const pokeRows = userRows.filter((row) => row.carriesOperationalMark);
note(
  `${transcript.length} transcript rows, ${userRows.length} of them user rows, ` +
    `${pokeRows.length} of those machine pokes — ` +
    `${Math.round((100 * pokeRows.length) / Math.max(1, userRows.length))}% of the captain's ` +
    "own side of the conversation is watcher traffic",
);

// The wire has no provenance field at all (ThreadMessageSentPayload,
// packages/contracts/src/orchestration.ts:1056) — this checks that empirically
// rather than only by reading the schema.
if (seedMessage && findings.phases[0]?.pokeMessage) {
  const seedKeys = Object.keys(seedMessage.payload).sort();
  const pokeEntry = log.find(
    (entry) =>
      entry.type === "thread.message-sent" &&
      entry.payload.text?.includes(FM_OPERATIONAL_MARK) &&
      entry.payload.role === "user",
  );
  const pokeKeys = pokeEntry ? Object.keys(pokeEntry.payload).sort() : [];
  findings.payloadComparison = {
    seedKeys,
    pokeKeys,
    identicalKeySets: JSON.stringify(seedKeys) === JSON.stringify(pokeKeys),
    differingFields: seedKeys
      .filter((key) => !["messageId", "text", "createdAt", "updatedAt", "turnId"].includes(key))
      .filter((key) => JSON.stringify(seedMessage.payload[key]) !== JSON.stringify(pokeEntry?.payload[key])),
  };
  note(
    `poke and composer-shaped message payloads carry identical key sets: ` +
      `${findings.payloadComparison.identicalKeySets}; fields differing beyond id/text/timestamps: ` +
      `${JSON.stringify(findings.payloadComparison.differingFields)}`,
  );
}

// ---------------------------------------------------------------- gui window

if (flags["gui-hold"]) {
  const seconds = Number(flags["gui-hold"]);
  console.log(`\n=== HOLD ${seconds}s — open the desktop app and look at ${THREAD_TITLE} ===`);
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await sleep(5000);
    console.log(`  [hold] ${Math.round((until - Date.now()) / 1000)}s left`);
  }
}

// ------------------------------------------------------------------ teardown

if (!flags.keep) {
  console.log("\n=== teardown ===");
  await dispatch("thread.delete", {
    type: "thread.delete",
    commandId: randomUUID(),
    threadId: ID,
  });
  await dispatch("project.delete", {
    type: "project.delete",
    commandId: randomUUID(),
    projectId,
  });
}

// -------------------------------------------------------------------- report

findings.summary = {
  threadId: ID,
  threadTitle: THREAD_TITLE,
  projectId,
  projAbs: PROJ_ABS,
  secret: SECRET,
  modelSelection,
  serverOrigin: origin,
  phases: findings.phases.map((phase) => ({
    phase: phase.phase,
    accepted: phase.accepted,
    acted: phase.agentActed,
    keptContext: phase.keptContext,
    lifecycle: phase.lifecycleEvents,
  })),
  transcriptRows: transcript.length,
  userRows: userRows.length,
  pokeRows: pokeRows.length,
};
findings.transcript = transcript;
findings.wokeFile = wokeLines();

const outPath = flags.out ?? join(HERE, "findings.json");
writeFileSync(outPath, JSON.stringify({ ...findings, stream: log }, null, 2));

console.log("\n[report] ---------------------------------------------");
for (const phase of findings.phases) {
  console.log(
    `  ${phase.phase.padEnd(9)} accepted=${String(phase.accepted).padEnd(5)} ` +
      `acted=${String(phase.agentActed).padEnd(5)} context=${String(phase.keptContext).padEnd(5)} ` +
      `rows=${phase.rowsAdded} lifecycle=[${phase.lifecycleEvents.join(",")}]`,
  );
}
console.log(`  transcript : ${transcript.length} rows, ${pokeRows.length}/${userRows.length} user rows are pokes`);
console.log(`  findings   : ${outPath}`);

if (scratchCreated && !flags.keep) {
  try {
    rmSync(PROJ_ABS, { recursive: true, force: true });
  } catch (error) {
    console.log(`[teardown] scratch left behind (${error.code}): ${PROJ_ABS}`);
  }
}

socket.close();
console.log("[done]");
process.exit(0);
