#!/usr/bin/env node
/**
 * Removes the throwaway T3 projects the #6 probes left in the live database.
 *
 * Only ever touches projects whose title starts with `stophook-` — the prefix
 * every probe in this directory uses — and prints exactly what it is about to
 * delete before deleting it. `~/.t3/userdata` is the live database; nothing
 * here opens it directly, it all goes through the server's own commands.
 *
 * Usage: T3_TOKEN=<bearer> node cleanup.mjs [--dry-run]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const dryRun = process.argv.includes("--dry-run");
const token = process.env.T3_TOKEN?.trim();
if (!token) throw new Error("No bearer token: set T3_TOKEN.");
const log = (...p) => console.log(...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), ".t3");
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
const raw = [];
const rpc = (tag, payload) =>
  new Promise((resolve, reject) => {
    const id = String(n++);
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
  });
const fire = (tag, payload) => {
  socket.send(JSON.stringify({ _tag: "Request", id: String(n++), tag, payload, headers: [] }));
};

socket.addEventListener("message", (event) => {
  for (const m of [].concat(JSON.parse(event.data))) {
    raw.push(m);
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

// The shell subscription carries the project list. Rather than assume the
// envelope shape (this client's stream handling is the known-weak part, see
// README "Left open"), collect raw frames and walk them for project-shaped
// objects.
fire("orchestration.subscribeShell", { requestCompletionMarker: true });
await sleep(6000);

const found = new Map();
const walk = (node) => {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== "object") return;
  const id = node.projectId ?? node.id;
  if (typeof id === "string" && typeof node.title === "string" && node.title.startsWith("stophook-")) {
    found.set(id, node.title);
  }
  Object.values(node).forEach(walk);
};
walk(raw);

if (found.size === 0) {
  log("[result] no projects titled stophook-* found — nothing to remove");
} else {
  for (const [id, title] of found) log(`[found] ${title}  ${id}`);
  if (dryRun) {
    log("[dry-run] nothing deleted");
  } else {
    for (const [id, title] of found) {
      try {
        await rpc("orchestration.dispatchCommand", {
          type: "project.delete",
          commandId: randomUUID(),
          projectId: id,
          force: true,
        });
        log(`[deleted] ${title}  ${id}`);
      } catch (error) {
        log(`[failed]  ${title}  ${id}: ${error.message}`);
      }
    }
  }
}

socket.close();
process.exit(0);
