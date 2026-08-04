#!/usr/bin/env node
/**
 * Why does the mirror hold fewer lines than the HTTP capture of the same
 * thread? Dump every message-sent event a turn produces, with its streaming
 * flag and text length, next to what the snapshot ends up holding.
 *
 * Usage: node probe-events.mjs --token-file <path>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
const origin = JSON.parse(
  readFileSync(join(T3_HOME, "userdata", "server-runtime.json"), "utf8"),
).origin;
const token = readFileSync(flag("token-file"), "utf8").trim();
const headers = { authorization: `Bearer ${token}` };

const dispatch = async (command) => {
  const response = await fetch(`${origin}/api/orchestration/dispatch`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${command.type} ${response.status}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
};

const PROJ = mkdtempSync(join(tmpdir(), "fm-events-"));
const git = (...args) => execFileSync("git", args, { cwd: PROJ, stdio: "ignore" });
writeFileSync(join(PROJ, "README.md"), "# probe\n");
git("init", "-b", "main");
git("config", "user.email", "spike@firstmate.local");
git("config", "user.name", "firstmate spike");
git("add", ".");
git("commit", "-m", "probe");

const ticket = (
  await (
    await fetch(`${origin}/api/auth/websocket-ticket`, { method: "POST", headers })
  ).json()
).ticket;
const socket = new WebSocket(
  `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`,
);
const pending = new Map();
let nextId = 1;
const request = (tag, payload) =>
  new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  });

const events = [];
socket.addEventListener("message", (event) => {
  for (const message of [].concat(JSON.parse(event.data))) {
    const requestId = String(message.requestId ?? "");
    if (message._tag === "Chunk") {
      for (const item of message.values) {
        if (item.kind === "event" && item.event.type === "thread.message-sent") {
          events.push({
            role: item.event.payload.role,
            streaming: item.event.payload.streaming,
            messageId: item.event.payload.messageId,
            textLength: String(item.event.payload.text ?? "").length,
            lines: String(item.event.payload.text ?? "").split(/\r?\n/).length,
          });
        }
      }
      socket.send(JSON.stringify({ _tag: "Ack", requestId }));
      continue;
    }
    if (message._tag !== "Exit") continue;
    const entry = pending.get(requestId);
    if (!entry) continue;
    pending.delete(requestId);
    if (message.exit._tag === "Success") entry.resolve(message.exit.value);
    else entry.reject(new Error(JSON.stringify(message.exit.cause).slice(0, 300)));
  }
});
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

const config = await request("server.getConfig", {});
const instances = config.providers?.instances ?? config.providers ?? [];
const claude = instances.find((entry) => entry.driver === "claudeAgent");
const modelSelection = { instanceId: claude.instanceId, model: claude.models?.[0]?.slug };

const projectId = randomUUID();
const threadId = randomUUID();
await dispatch({
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `fm-events-${projectId.slice(0, 8)}`,
  workspaceRoot: PROJ,
  createdAt: new Date().toISOString(),
});
await dispatch({
  type: "thread.create",
  commandId: randomUUID(),
  threadId,
  projectId,
  title: `fm-${threadId.slice(0, 8)}`,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: new Date().toISOString(),
});

socket.send(
  JSON.stringify({
    _tag: "Request",
    id: String(nextId++),
    tag: "orchestration.subscribeThread",
    payload: { threadId },
    headers: [],
  }),
);
await new Promise((resolve) => setTimeout(resolve, 1500));

await dispatch({
  type: "thread.turn.start",
  commandId: randomUUID(),
  threadId,
  message: {
    messageId: randomUUID(),
    role: "user",
    text: "Reply with a numbered list of 40 short lines, each naming a different colour.",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: new Date().toISOString(),
});

await new Promise((resolve) => setTimeout(resolve, 60_000));

const snapshot = await (
  await fetch(`${origin}/api/orchestration/threads/${threadId}`, { headers })
).json();

console.log("message-sent events:");
for (const event of events) {
  console.log(
    `  role=${event.role} streaming=${JSON.stringify(event.streaming)} ` +
      `len=${event.textLength} lines=${event.lines} id=${event.messageId.slice(0, 8)}`,
  );
}
console.log("\nsnapshot messages:");
for (const message of snapshot.thread.messages ?? []) {
  console.log(
    `  role=${message.role} isStreaming=${JSON.stringify(message.isStreaming)} ` +
      `streaming=${JSON.stringify(message.streaming)} len=${String(message.text ?? "").length}`,
  );
}

await dispatch({ type: "thread.delete", commandId: randomUUID(), threadId, force: true });
await dispatch({ type: "project.delete", commandId: randomUUID(), projectId, force: true });
socket.close();
process.exit(0);
