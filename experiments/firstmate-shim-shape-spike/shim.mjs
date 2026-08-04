#!/usr/bin/env node
/**
 * Spike for autoprintworks/t3code#16: what shape is the helper that
 * `bin/backends/t3.sh` dispatches through?
 *
 * This file is both the prototype helper and its own benchmark. The subcommands
 * are the real thing — `bench` spawns THIS file as a cold child process so the
 * numbers include node startup, which is what bash actually pays.
 *
 * The premise under test is #16's: "one-shot process per command (pays connect +
 * ticket + upgrade on every capture) versus a long-lived daemon". Both arms of
 * that assume the WebSocket, because #3 only ever looked at `/ws`. There is a
 * third arm — the environment HTTP API (`GET /api/orchestration/threads/:id`,
 * `POST /api/orchestration/dispatch`) — which takes the same bearer token with
 * no ticket and no upgrade. The bench measures all three, plus a mirror file
 * written by a long-lived subscriber, which is the shape claude-bg's capture
 * actually has (it reads a transcript off disk, it does not call anything).
 *
 * Usage:
 *   node shim.mjs bench [--token-file <path>] [--samples 10] [--keep]
 *   node shim.mjs capture <thread-id> [lines]     # HTTP one-shot
 *   node shim.mjs capture-ws <thread-id> [lines]  # WebSocket one-shot
 *   node shim.mjs busy <thread-id>                # HTTP one-shot
 *   node shim.mjs send <thread-id> <text>         # HTTP one-shot
 *   node shim.mjs mirror <thread-id> --out <file> # long-lived subscriber
 *   node shim.mjs token-info                      # zero-call claim decode
 *   node shim.mjs noop                            # process-startup baseline
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const MODE = argv[0] ?? "bench";
const positional = argv.slice(1).filter((entry) => !entry.startsWith("--"));
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : true;
};

if (MODE === "noop") process.exit(0); // the process-startup floor, measured not assumed

// --------------------------------------------------------------- environment

const T3_HOME = flag("base-dir", process.env.T3CODE_HOME ?? join(homedir(), ".t3"));

const discoverOrigin = () => {
  const explicit = flag("origin", null);
  if (typeof explicit === "string") return explicit;
  const statePath = join(T3_HOME, "userdata", "server-runtime.json");
  return JSON.parse(readFileSync(statePath, "utf8")).origin;
};

const readToken = () => {
  const file = flag("token-file", process.env.T3_TOKEN_FILE ?? null);
  const raw = typeof file === "string" ? readFileSync(file, "utf8") : (process.env.T3_TOKEN ?? "");
  const token = raw.trim();
  if (!token) {
    throw new Error(
      "no bearer token: mint one with `t3 auth session issue --token-only --ttl 30d` and pass " +
        "--token-file or T3_TOKEN",
    );
  }
  return token;
};

/**
 * The session token is `base64url(JSON claims).signature` (SessionStore.ts:647),
 * so expiry, session id and scopes are all readable with no call to anything —
 * no server, no CLI, no state.sqlite. This is what makes a cheap expiry
 * pre-flight possible on every invocation.
 */
const decodeClaims = (token) => {
  const [payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
};

// ------------------------------------------------------------------ transport

const httpHeaders = (token) => ({ authorization: `Bearer ${token}` });

const fetchThreadSnapshot = async (origin, token, threadId) => {
  const response = await fetch(`${origin}/api/orchestration/threads/${threadId}`, {
    headers: httpHeaders(token),
  });
  const body = await response.text();
  return { status: response.status, bytes: Buffer.byteLength(body), body };
};

/**
 * Three failure shapes worth telling apart, because they look alike from bash:
 *   400 with an EMPTY body  — the payload failed schema decode
 *   400 with a JSON body    — the normalizer refused (invalid_command)
 *   500                     — the shape was fine and the engine refused
 */
const httpDispatch = async (origin, token, command) => {
  const response = await fetch(`${origin}/api/orchestration/dispatch`, {
    method: "POST",
    headers: { ...httpHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `dispatch ${command.type} ${response.status}: ${body ? body.slice(0, 300) : "(empty body — schema decode failure)"}`,
    );
  }
  return JSON.parse(body);
};

/** The #3 path: bearer -> wsTicket -> /ws, then Effect-RPC frames. */
const connectWs = async (origin, token) => {
  const marks = {};
  const at = Date.now();
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: httpHeaders(token),
  });
  if (!ticketResponse.ok) throw new Error(`websocket-ticket ${ticketResponse.status}`);
  const { ticket } = await ticketResponse.json();
  marks.ticketMs = Date.now() - at;

  const openedAt = Date.now();
  const socket = new WebSocket(
    `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`,
  );
  const pending = new Map();
  const streams = new Map();
  let nextId = 1;

  socket.addEventListener("message", (event) => {
    for (const message of [].concat(JSON.parse(event.data))) {
      const requestId = String(message.requestId ?? "");
      if (message._tag === "Chunk") {
        const onValue = streams.get(requestId);
        if (onValue) for (const value of message.values) onValue(value);
        // #7's trap: without the Ack the stream delivers one chunk then stalls.
        socket.send(JSON.stringify({ _tag: "Ack", requestId }));
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
      else entry.reject(new Error(JSON.stringify(message.exit.cause).slice(0, 400)));
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("close", (event) => reject(new Error(`closed ${event.code}`)), {
      once: true,
    });
  });
  marks.upgradeMs = Date.now() - openedAt;

  return {
    marks,
    socket,
    request: (tag, payload) =>
      new Promise((resolve, reject) => {
        const id = String(nextId++);
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      }),
    stream: (tag, payload, onValue) => {
      const id = String(nextId++);
      streams.set(id, onValue);
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
      return id;
    },
    close: () => socket.close(),
  };
};

// ------------------------------------------------------------------ rendering

/**
 * Render a thread snapshot into the plain, escape-free lines `capture` owes
 * firstmate — the same `role: text` shape claude-bg renders from its JSONL
 * (bin/backends/claude-bg.sh:113-162).
 */
const renderThread = (thread, limit) => {
  // Interleaved by createdAt, not messages-then-activities: `capture` means
  // "the last N lines", and a thread has far more activities than messages
  // (one live thread here: 506 activities to 14 messages), so grouping by type
  // would make the tail permanently tool noise and never the recent reply.
  const rows = [];
  for (const message of thread.messages ?? []) {
    if (message.isStreaming || message.streaming) continue; // #9: partials re-emit
    for (const line of String(message.text ?? "").split(/\r?\n/)) {
      const clean = line.replace(/\r/g, "");
      if (clean.trim()) rows.push({ at: message.createdAt, text: `${message.role}: ${clean}` });
    }
  }
  for (const activity of thread.activities ?? []) {
    if (!String(activity.kind ?? "").startsWith("tool.")) continue;
    rows.push({
      at: activity.createdAt,
      text: `[${activity.kind}] ${String(activity.summary ?? "").replace(/\r/g, "")}`.trim(),
    });
  }
  rows.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")));
  return rows
    .slice(-limit)
    .map((row) => row.text)
    .join("\n");
};

/**
 * #7's mapping, computed from one snapshot: session.status for the
 * busy/idle/exited spine, plus the approval / user-input ledger for `blocked`.
 * Both live in the same payload, so `blocked` costs no extra call.
 */
const deriveBusyState = (thread) => {
  const open = new Set();
  for (const activity of thread.activities ?? []) {
    const requestId = activity.payload?.requestId ?? activity.requestId;
    if (!requestId) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      open.add(requestId);
    }
    if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      open.delete(requestId);
    }
  }
  if (open.size > 0) return "blocked";
  const status = thread.session?.status;
  if (!status) return "unknown";
  if (status === "starting" || status === "running") return "busy";
  if (status === "ready" || status === "idle") return "idle";
  if (status === "stopped" || status === "error" || status === "interrupted") return "exited";
  return "unknown";
};

// ------------------------------------------------------------------ one-shots

const oneShotCapture = async () => {
  const [threadId, linesArg] = positional;
  const origin = discoverOrigin();
  const token = readToken();
  const { status, body } = await fetchThreadSnapshot(origin, token, threadId);
  if (status === 404) {
    process.stderr.write(`error: thread ${threadId} not found (deleted or archived)\n`);
    process.exit(3); // distinct from a transport failure: this is "target gone"
  }
  if (status !== 200) {
    process.stderr.write(`error: thread snapshot ${status}\n`);
    process.exit(1);
  }
  process.stdout.write(`${renderThread(JSON.parse(body).thread, Number(linesArg ?? 40))}\n`);
};

const oneShotCaptureWs = async () => {
  const [threadId, linesArg] = positional;
  const client = await connectWs(discoverOrigin(), readToken());
  const snapshot = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no snapshot in 15s")), 15_000);
    client.stream("orchestration.subscribeThread", { threadId }, (item) => {
      if (item.kind !== "snapshot") return;
      clearTimeout(timer);
      resolve(item.snapshot);
    });
  });
  client.close();
  process.stdout.write(`${renderThread(snapshot.thread, Number(linesArg ?? 40))}\n`);
};

const oneShotBusy = async () => {
  const [threadId] = positional;
  const { status, body } = await fetchThreadSnapshot(discoverOrigin(), readToken(), threadId);
  // A thread that is gone is `exited`, not an error: the caller is a supervisor.
  process.stdout.write(status === 200 ? deriveBusyState(JSON.parse(body).thread) : "exited");
};

const oneShotSend = async () => {
  const [threadId, ...rest] = positional;
  const text = rest.join(" ");
  await httpDispatch(discoverOrigin(), readToken(), {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: "user", text, attachments: [] },
    // Both modes are REQUIRED on the client turn-start command; omitting them
    // is a silent 400 with no body. modelSelection, by contrast, is optional.
    runtimeMode: String(flag("runtime-mode", "full-access")),
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  // No verdict word here on purpose: the exit code is the contract, and
  // bin/backends/t3.sh prints the literal `empty` firstmate requires.
};

const tokenInfo = () => {
  const claims = decodeClaims(readToken());
  const remainingDays = (claims.exp - Date.now()) / 86_400_000;
  process.stdout.write(
    [
      `session_id=${claims.sid}`,
      `subject=${claims.sub}`,
      `expires_at=${new Date(claims.exp).toISOString()}`,
      `expires_in_days=${remainingDays.toFixed(2)}`,
      `scopes=${claims.scopes.join(",")}`,
      "",
    ].join("\n"),
  );
  if (remainingDays <= 0) process.exit(4);
};

// -------------------------------------------------------------------- mirror

/**
 * The long-lived arm: one subscriber per thread that writes what it sees to
 * disk, so bash reads a file instead of calling anything. This is the shape
 * claude-bg's capture already has, and the only arm where the hot path costs no
 * process at all.
 */
const runMirror = async (threadId, outPath, { onItem } = {}) => {
  const client = await connectWs(discoverOrigin(), readToken());
  const statePath = `${outPath}.state`;
  // Keyed by messageId, in arrival order. An assistant message arrives as a
  // streaming partial carrying the text and then settles with `streaming:false`
  // and an EMPTY text, so the rule is last-non-empty-text-wins per id — not
  // "append the settling event", which mirrors an empty transcript.
  const messages = new Map();
  let thread = null;

  const flush = () => {
    const lines = [];
    for (const message of messages.values()) {
      for (const line of message.text.split(/\r?\n/)) {
        if (line.trim()) lines.push(`${message.role}: ${line}`);
      }
    }
    writeFileSync(`${outPath}.tmp`, `${lines.slice(-2000).join("\n")}\n`);
    renameSync(`${outPath}.tmp`, outPath); // atomic: a reader never sees a half file
    writeFileSync(`${statePath}.tmp`, `${thread ? deriveBusyState(thread) : "unknown"}\n`);
    renameSync(`${statePath}.tmp`, statePath);
  };

  client.stream("orchestration.subscribeThread", { threadId }, (item) => {
    if (item.kind === "snapshot") {
      thread = item.snapshot.thread;
      for (const message of thread.messages ?? []) {
        messages.set(message.messageId, {
          role: message.role,
          text: String(message.text ?? ""),
        });
      }
    } else if (item.kind === "event") {
      const { type, payload } = item.event;
      if (type === "thread.message-sent") {
        const text = String(payload.text ?? "");
        const existing = messages.get(payload.messageId);
        if (!existing || text.length > 0) {
          messages.set(payload.messageId, { role: payload.role, text });
        }
      }
      if (thread) {
        if (type === "thread.session-set") thread.session = payload.session;
        if (type === "thread.activity-appended") {
          thread.activities = [...(thread.activities ?? []), payload.activity];
        }
      }
    }
    flush();
    onItem?.(item);
  });
  return client;
};

// ---------------------------------------------------------------- live probe

/**
 * How big does a one-shot capture actually get? The bench's own thread is two
 * turns old, which flatters the HTTP arm. `getThreadDetailById` hydrates every
 * message and every activity with no LIMIT (ProjectionSnapshotQuery.ts:908-927),
 * so the honest number comes from real threads. Strictly read-only: one GET of
 * the shell, then one GET per thread, against the running server.
 */
const probeLive = async () => {
  const origin = discoverOrigin();
  const token = readToken();
  const shellResponse = await fetch(`${origin}/api/orchestration/shell`, {
    headers: httpHeaders(token),
  });
  const shell = await shellResponse.json();
  const threads = (shell.threads ?? shell.shell?.threads ?? []).map(
    (entry) => entry.threadId ?? entry.id,
  );
  const limit = Number(flag("limit", 40));
  const rows = [];
  for (const threadId of threads.slice(0, limit)) {
    const at = process.hrtime.bigint();
    const { status, bytes, body } = await fetchThreadSnapshot(origin, token, threadId);
    const ms = Number(process.hrtime.bigint() - at) / 1e6;
    if (status !== 200) continue;
    const thread = JSON.parse(body).thread;
    rows.push({
      threadId,
      bytes,
      ms: Number(ms.toFixed(1)),
      messages: (thread.messages ?? []).length,
      activities: (thread.activities ?? []).length,
    });
  }
  rows.sort((a, b) => b.bytes - a.bytes);
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  const report = {
    threadsProbed: rows.length,
    totalBytes: total,
    medianBytes: rows.length ? rows[Math.floor(rows.length / 2)].bytes : 0,
    largest: rows.slice(0, 5),
  };
  const outPath = flag("out", join(process.cwd(), "live-threads.json"));
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`probed ${rows.length} live threads -> ${outPath}`);
  for (const row of report.largest) {
    console.log(
      `  ${row.bytes.toLocaleString()} bytes  ${row.ms}ms  ` +
        `${row.messages} messages / ${row.activities} activities`,
    );
  }
};

// --------------------------------------------------------------------- bench

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const summarize = (values) => ({
  n: values.length,
  min: Math.min(...values),
  median: median(values),
  max: Math.max(...values),
});

/** Cold child process, timed exactly the way bash times it. */
const timeChild = (args) => {
  const at = process.hrtime.bigint();
  const result = spawnSync(process.execPath, [process.argv[1], ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ms: Number(process.hrtime.bigint() - at) / 1e6,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const timeCommand = (command, args) => {
  const at = process.hrtime.bigint();
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  return {
    ms: Number(process.hrtime.bigint() - at) / 1e6,
    status: result.status,
    stdout: result.stdout ?? "",
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runBench = async () => {
  const SAMPLES = Number(flag("samples", 10));
  const tokenFile = flag("token-file", null);
  const tokenArgs = typeof tokenFile === "string" ? ["--token-file", tokenFile] : [];
  const origin = discoverOrigin();
  const token = readToken();
  const findings = { environment: {}, phases: {}, notes: [] };
  const note = (text) => {
    findings.notes.push(text);
    console.log(`  [note] ${text}`);
  };

  const claims = decodeClaims(token);
  findings.environment = {
    origin,
    node: process.version,
    platform: process.platform,
    session: {
      sessionId: claims.sid,
      subject: claims.sub,
      expiresAt: new Date(claims.exp).toISOString(),
      scopes: claims.scopes,
    },
  };
  console.log(`[env] ${origin}  node ${process.version}  ${process.platform}`);
  console.log(`[env] token sid=${claims.sid} exp=${new Date(claims.exp).toISOString()}`);

  // --- fixture -------------------------------------------------------------
  const PROJ = mkdtempSync(join(tmpdir(), "fm-shim-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: PROJ, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(PROJ, "README.md"), "# firstmate shim shape spike\n");
  git("init", "-b", "main");
  git("config", "user.email", "spike@firstmate.local");
  git("config", "user.name", "firstmate spike");
  git("add", ".");
  git("commit", "-m", "scratch project for the shim shape spike");

  // Model resolution is the one thing HTTP cannot serve: server.getConfig is an
  // RPC with no route in EnvironmentHttpApi. It is a spawn-time cost only.
  const control = await connectWs(origin, token);
  const config = await control.request("server.getConfig", {});
  const instances = config.providers?.instances ?? config.providers ?? [];
  const claude = (Array.isArray(instances) ? instances : []).find(
    (entry) => entry.driver === "claudeAgent",
  );
  if (!claude) throw new Error("no claudeAgent provider instance configured");
  const modelSelection = { instanceId: claude.instanceId, model: claude.models?.[0]?.slug };
  console.log(`[fixture] model ${modelSelection.instanceId}/${modelSelection.model}`);

  const projectId = randomUUID();
  const threadId = randomUUID();
  await httpDispatch(origin, token, {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: `fm-shim-${projectId.slice(0, 8)}`,
    workspaceRoot: PROJ,
    createdAt: new Date().toISOString(),
  });
  await httpDispatch(origin, token, {
    type: "thread.create",
    commandId: randomUUID(),
    threadId,
    projectId,
    title: `fm-${threadId.slice(0, 8)}`,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    // Nullable but REQUIRED: omit either and thread.create is a bodyless 400.
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  note(
    "project.create and thread.create both went over POST /api/orchestration/dispatch — the " +
      "whole spawn sequence #9 drove over the websocket is available on plain HTTP",
  );
  note(
    "thread.create requires branch and worktreePath (nullable, not optional) and " +
      "thread.turn.start requires runtimeMode and interactionMode; omitting any of them is a " +
      "400 with an EMPTY body, which is how a schema decode failure differs from the " +
      "normalizer's JSON invalid_command 400 and the engine's 500",
  );
  console.log(`[fixture] project ${projectId} thread ${threadId} root ${PROJ}`);

  // --- mirror, running for the whole bench ---------------------------------
  const mirrorPath = join(PROJ, "mirror.log");
  const mirrorLag = [];
  let lastSeenAt = 0;
  const mirror = await runMirror(threadId, mirrorPath, {
    onItem: () => {
      lastSeenAt = Date.now();
    },
  });

  const readMirrorState = () => {
    try {
      return readFileSync(`${mirrorPath}.state`, "utf8").trim();
    } catch {
      return null;
    }
  };

  const waitForBusy = async (want, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // The mirror writes nothing until its first stream item, so a reader must
      // treat "no file yet" as "no answer yet" rather than as an error.
      const state = readMirrorState();
      if (state && want.includes(state)) return state;
      await sleep(250);
    }
    return null;
  };

  // --- a turn, so the transcript is not empty ------------------------------
  console.log("\n=== turn 1: give the thread a transcript ===");
  await httpDispatch(origin, token, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: {
      messageId: randomUUID(),
      role: "user",
      text:
        "Reply with a numbered list of 40 short lines, each naming a different colour. " +
        "Use no tools at all.",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  const afterTurn1 = await waitForBusy(["idle", "exited"], 180_000);
  console.log(`[turn 1] settled as ${afterTurn1}`);
  const snapshot1 = await fetchThreadSnapshot(origin, token, threadId);
  console.log(`[turn 1] snapshot payload ${snapshot1.bytes} bytes`);

  // --- process floor -------------------------------------------------------
  console.log("\n=== bench: cold process floor ===");
  const floor = [];
  for (let i = 0; i < SAMPLES; i++) floor.push(timeChild(["noop"]).ms);
  findings.phases.processFloor = summarize(floor);
  console.log(`  node startup: median ${median(floor).toFixed(1)}ms`);

  // --- cold one-shots ------------------------------------------------------
  console.log("\n=== bench: cold one-shot capture ===");
  const coldHttp = [];
  const coldWs = [];
  let captureSample = "";
  for (let i = 0; i < SAMPLES; i++) {
    const http = timeChild(["capture", threadId, "40", ...tokenArgs]);
    if (http.status !== 0) throw new Error(`capture failed: ${http.stderr.slice(0, 300)}`);
    captureSample = http.stdout;
    coldHttp.push(http.ms);
    const ws = timeChild(["capture-ws", threadId, "40", ...tokenArgs]);
    if (ws.status !== 0) throw new Error(`capture-ws failed: ${ws.stderr.slice(0, 300)}`);
    coldWs.push(ws.ms);
  }
  findings.phases.coldCaptureHttp = summarize(coldHttp);
  findings.phases.coldCaptureWs = summarize(coldWs);
  console.log(`  http one-shot: median ${median(coldHttp).toFixed(1)}ms`);
  console.log(`  ws   one-shot: median ${median(coldWs).toFixed(1)}ms`);

  // --- curl, i.e. no node at all -------------------------------------------
  console.log("\n=== bench: curl (no node in the hot path) ===");
  const curlProbe = timeCommand("curl", ["--version"]);
  if (curlProbe.status === 0) {
    const curlTimes = [];
    for (let i = 0; i < SAMPLES; i++) {
      const result = timeCommand("curl", [
        "-s",
        "-o",
        "/dev/null",
        "-H",
        `authorization: Bearer ${token}`,
        `${origin}/api/orchestration/threads/${threadId}`,
      ]);
      curlTimes.push(result.ms);
    }
    findings.phases.coldCaptureCurl = summarize(curlTimes);
    console.log(`  curl GET: median ${median(curlTimes).toFixed(1)}ms`);
  } else {
    note("curl not available; the no-node comparison was skipped");
  }

  // --- mirror read ---------------------------------------------------------
  console.log("\n=== bench: mirror file read ===");
  const tailTimes = [];
  for (let i = 0; i < SAMPLES; i++) {
    tailTimes.push(timeCommand("tail", ["-n", "40", mirrorPath]).ms);
  }
  findings.phases.mirrorTail = summarize(tailTimes);
  console.log(`  tail -n 40: median ${median(tailTimes).toFixed(1)}ms`);
  findings.phases.mirrorBytes = statSync(mirrorPath).size;

  // Latency is only half of it: a mirror that is fast and wrong is worthless.
  // Compare what bash would read to what the one-shot capture returns.
  const mirrorLines = timeCommand("tail", ["-n", "40", mirrorPath]).stdout.trim().split("\n");
  const captureLines = captureSample.trim().split("\n");
  findings.phases.mirrorAgreement = {
    mirrorLines: mirrorLines.length,
    captureLines: captureLines.length,
    lastLineMatches: mirrorLines.at(-1) === captureLines.at(-1),
  };
  console.log(
    `  mirror ${mirrorLines.length} lines vs capture ${captureLines.length} lines; ` +
      `last line matches: ${findings.phases.mirrorAgreement.lastLineMatches}`,
  );

  // --- warm socket / warm connection ---------------------------------------
  console.log("\n=== bench: warm (already connected) ===");
  const warmHttp = [];
  for (let i = 0; i < SAMPLES * 2; i++) {
    const at = process.hrtime.bigint();
    await fetchThreadSnapshot(origin, token, threadId);
    warmHttp.push(Number(process.hrtime.bigint() - at) / 1e6);
  }
  findings.phases.warmHttp = summarize(warmHttp);
  console.log(`  warm http GET: median ${median(warmHttp).toFixed(1)}ms`);

  // server.getConfig is the one call the spawn path cannot avoid and the one
  // HTTP cannot serve. Timing it separately keeps it out of the transport
  // comparison, where it would read as websocket overhead and is not.
  const getConfig = [];
  for (let i = 0; i < 5; i++) {
    const at = process.hrtime.bigint();
    await control.request("server.getConfig", {});
    getConfig.push(Number(process.hrtime.bigint() - at) / 1e6);
  }
  findings.phases.serverGetConfigWarm = summarize(getConfig);
  console.log(`  server.getConfig (ws only): median ${median(getConfig).toFixed(1)}ms`);

  // --- dispatch: http vs ws ------------------------------------------------
  console.log("\n=== bench: dispatch (thread.meta.update) ===");
  const dispatchHttp = [];
  const dispatchWs = [];
  for (let i = 0; i < 5; i++) {
    const command = () => ({
      type: "thread.meta.update",
      commandId: randomUUID(),
      threadId,
      title: `fm-${threadId.slice(0, 8)}`,
      updatedAt: new Date().toISOString(),
    });
    let at = process.hrtime.bigint();
    await httpDispatch(origin, token, command());
    dispatchHttp.push(Number(process.hrtime.bigint() - at) / 1e6);
    at = process.hrtime.bigint();
    await control.request("orchestration.dispatchCommand", command());
    dispatchWs.push(Number(process.hrtime.bigint() - at) / 1e6);
  }
  findings.phases.dispatchHttpWarm = summarize(dispatchHttp);
  findings.phases.dispatchWsWarm = summarize(dispatchWs);
  console.log(`  http dispatch: median ${median(dispatchHttp).toFixed(1)}ms`);
  console.log(`  ws   dispatch: median ${median(dispatchWs).toFixed(1)}ms`);

  // --- cold send -----------------------------------------------------------
  // send_text_submit is not the hot path capture is, but it is the one write
  // bash makes per wake, so it gets the same cold-child treatment.
  console.log("\n=== bench: cold one-shot send ===");
  const coldSend = [];
  for (let i = 0; i < 3; i++) {
    const result = timeChild([
      "send",
      threadId,
      "ignore this line; it measures dispatch cost",
      ...tokenArgs,
    ]);
    if (result.status !== 0) throw new Error(`send failed: ${result.stderr.slice(0, 200)}`);
    coldSend.push(result.ms);
  }
  findings.phases.coldSendHttp = summarize(coldSend);
  console.log(`  http one-shot send: median ${median(coldSend).toFixed(1)}ms`);
  await waitForBusy(["idle", "exited"], 180_000);

  // --- snapshot growth -----------------------------------------------------
  console.log("\n=== turn 2: does the hot-path payload grow? ===");
  await httpDispatch(origin, token, {
    type: "thread.turn.start",
    commandId: randomUUID(),
    threadId,
    message: {
      messageId: randomUUID(),
      role: "user",
      text: "Now reply with a numbered list of 120 short lines, each naming a different animal.",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  await waitForBusy(["busy"], 60_000);
  const busyDuringTurn = readMirrorState();
  const busySample = timeChild(["busy", threadId, ...tokenArgs]);
  const afterTurn2 = await waitForBusy(["idle", "exited"], 240_000);
  const snapshot2 = await fetchThreadSnapshot(origin, token, threadId);
  findings.phases.snapshotBytes = {
    afterTurn1: snapshot1.bytes,
    afterTurn2: snapshot2.bytes,
    capturedLines: captureSample.split("\n").length,
  };
  findings.phases.busyState = {
    duringTurn: { mirror: busyDuringTurn, oneShot: busySample.stdout.trim() },
    afterTurn1,
    afterTurn2,
  };
  console.log(`  snapshot bytes: ${snapshot1.bytes} -> ${snapshot2.bytes}`);
  console.log(`  busy during turn: mirror=${busyDuringTurn} one-shot=${busySample.stdout.trim()}`);

  // --- mirror freshness ----------------------------------------------------
  const mirrorMtime = statSync(mirrorPath).mtimeMs;
  findings.phases.mirrorFreshness = {
    lastItemAt: lastSeenAt,
    fileMtime: mirrorMtime,
    lagMs: Math.round(mirrorMtime - lastSeenAt),
    lines: readFileSync(mirrorPath, "utf8").split("\n").length,
  };

  // --- multiplexing --------------------------------------------------------
  console.log("\n=== probe: several subscriptions on one socket ===");
  const secondThreadId = randomUUID();
  await httpDispatch(origin, token, {
    type: "thread.create",
    commandId: randomUUID(),
    threadId: secondThreadId,
    projectId,
    title: `fm-${secondThreadId.slice(0, 8)}`,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: new Date().toISOString(),
  });
  const seen = new Set();
  for (const id of [threadId, secondThreadId]) {
    control.stream("orchestration.subscribeThread", { threadId: id }, (item) => {
      if (item.kind === "snapshot") seen.add(item.snapshot.thread.threadId ?? id);
    });
  }
  await sleep(3000);
  findings.phases.multiplex = { subscribed: 2, snapshotsSeen: seen.size };
  console.log(`  snapshots seen on one socket: ${seen.size}/2`);

  // --- archived and deleted, as capture sees them --------------------------
  console.log("\n=== probe: archived and deleted threads over HTTP ===");
  await httpDispatch(origin, token, {
    type: "thread.archive",
    commandId: randomUUID(),
    threadId: secondThreadId,
    archivedAt: new Date().toISOString(),
  });
  await sleep(1500);
  const archived = await fetchThreadSnapshot(origin, token, secondThreadId);
  const archivedChild = timeChild(["capture", secondThreadId, "40", ...tokenArgs]);
  await httpDispatch(origin, token, {
    type: "thread.delete",
    commandId: randomUUID(),
    threadId: secondThreadId,
    force: true,
  });
  await sleep(1500);
  const deleted = await fetchThreadSnapshot(origin, token, secondThreadId);
  findings.phases.gone = {
    archivedStatus: archived.status,
    archivedExitCode: archivedChild.status,
    deletedStatus: deleted.status,
  };
  console.log(`  archived -> HTTP ${archived.status} (shim exit ${archivedChild.status})`);
  console.log(`  deleted  -> HTTP ${deleted.status}`);

  // --- expired / revoked credential ----------------------------------------
  console.log("\n=== probe: what a bad credential looks like ===");
  const badTokenFile = join(PROJ, "bad.token");
  writeFileSync(badTokenFile, `${token}tampered`);
  const badResponse = await fetch(`${origin}/api/orchestration/threads/${threadId}`, {
    headers: { authorization: `Bearer ${token}tampered` },
  });
  const badChild = timeChild(["capture", threadId, "40", "--token-file", badTokenFile]);
  findings.phases.badCredential = {
    httpStatus: badResponse.status,
    shimExitCode: badChild.status,
    shimStderr: badChild.stderr.trim().slice(0, 200),
  };
  console.log(`  tampered bearer -> HTTP ${badResponse.status}, shim exit ${badChild.status}`);

  // --- teardown ------------------------------------------------------------
  mirror.close();
  if (!flag("keep", false)) {
    await httpDispatch(origin, token, {
      type: "thread.delete",
      commandId: randomUUID(),
      threadId,
      force: true,
    });
    await httpDispatch(origin, token, {
      type: "project.delete",
      commandId: randomUUID(),
      projectId,
      force: true,
    });
  }
  control.close();

  const outPath = flag("out", join(process.cwd(), "findings.json"));
  writeFileSync(outPath, JSON.stringify(findings, null, 2));
  console.log(`\n[report] -> ${outPath}`);

  if (!flag("keep", false)) {
    try {
      rmSync(PROJ, { recursive: true, force: true });
    } catch (error) {
      console.log(`[teardown] scratch left behind (${error.code}): ${PROJ}`);
    }
  }
  process.exit(0);
};

// ----------------------------------------------------------------- dispatch

const run = async () => {
  switch (MODE) {
    case "capture":
      return oneShotCapture();
    case "capture-ws":
      return oneShotCaptureWs();
    case "busy":
      return oneShotBusy();
    case "send":
      return oneShotSend();
    case "token-info":
      return tokenInfo();
    case "mirror": {
      const [threadId] = positional;
      await runMirror(threadId, String(flag("out", `${threadId}.log`)));
      return new Promise(() => {}); // long-lived by design
    }
    case "probe-live":
      return probeLive();
    case "bench":
      return runBench();
    default:
      process.stderr.write(`error: unknown mode '${MODE}'\n`);
      process.exit(2);
  }
};

run().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
});
