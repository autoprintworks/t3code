#!/usr/bin/env node
/**
 * Spike for autoprintworks/t3code#3: can a local script (no browser, no
 * desktop window) authenticate to a running T3 server and dispatch an
 * orchestration command?
 *
 * Answer: yes, with no changes to T3. Two steps, both already shipped:
 *
 *   1. `t3 auth session issue --token-only` mints a bearer access token by
 *      writing straight into the server's SQLite state directory. No HTTP
 *      call, no browser, no existing session required — it only needs
 *      filesystem access to the same T3 home the server uses.
 *   2. The bearer token opens `/ws` either directly (Authorization header) or
 *      via a short-lived `?wsTicket=` minted at `/api/auth/websocket-ticket`.
 *      This script uses the ticket path because Node's built-in WebSocket
 *      cannot set request headers — the same constraint a browser has, and
 *      the reason the ticket endpoint exists.
 *
 * Dependency-free: Node's global WebSocket and fetch only. The RPC wire
 * format is one JSON message per WebSocket frame (RpcSerialization.layerJson,
 * apps/server/src/ws.ts) — see sendRequest below.
 *
 * Usage:
 *   T3_TOKEN=<bearer> node spike.mjs
 *   node spike.mjs --token-file ./token.txt
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    "token-file": { type: "string" },
    "base-dir": { type: "string" },
    origin: { type: "string" },
  },
});

/**
 * Where the running server records its origin. `t3 serve`/the desktop backend
 * write this on startup and clear it on shutdown; `t3 pair` reads the same
 * file to find a live server.
 */
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

// A bearer session is a signed envelope, not an opaque handle: the claims are
// readable without the server, which is handy for reporting expiry.
const claims = JSON.parse(
  Buffer.from(token.split(".")[0], "base64url").toString("utf8"),
);
console.log(
  `[token] subject=${claims.sub} scopes=${claims.scopes.join(",")} expires=${new Date(claims.exp).toISOString()}`,
);

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
console.log(`[ticket] expires=${ticket.expiresAt}`);

const wsUrl = `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket.ticket)}`;
const socket = new WebSocket(wsUrl);

const pending = new Map();
let nextRequestId = 1;

/**
 * One JSON message per frame. The server answers a Request with an `Exit`
 * whose `exit` is an encoded Effect Exit — `Success` carries the value,
 * `Failure` carries a cause array.
 */
const sendRequest = (tag, payload) =>
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
socket.addEventListener("error", () => {
  for (const entry of pending.values()) entry.reject(new Error("socket error"));
});

await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("close", (event) => {
    // A rejected upgrade closes without ever opening, which is how bad
    // credentials surface here rather than as an HTTP status.
    reject(new Error(`socket closed before open: ${event.code} ${event.reason}`));
  }, { once: true });
});
console.log("[ws] connected and authenticated");

// project.create/project.delete is the cheapest dispatch that returns a
// receipt without touching a provider or an existing thread.
//
// workspaceRoot must be a directory with no active project, so use a fresh
// temp dir rather than process.cwd(): T3 enforces one active project per
// workspace root, and the cwd is very often already open in the GUI —
// project.create then fails with OrchestrationCommandInvariantError, which
// looks like an auth failure but is not one.
const workspaceRoot = mkdtempSync(join(tmpdir(), "firstmate-spike-"));
const projectId = randomUUID();
const receipt = await sendRequest("orchestration.dispatchCommand", {
  type: "project.create",
  commandId: randomUUID(),
  projectId,
  title: `firstmate-spike-${projectId.slice(0, 8)}`,
  workspaceRoot,
  createdAt: new Date().toISOString(),
});
console.log(`[dispatch] project.create receipt: ${JSON.stringify(receipt)}`);

const cleanup = await sendRequest("orchestration.dispatchCommand", {
  type: "project.delete",
  commandId: randomUUID(),
  projectId,
  force: true,
});
console.log(`[dispatch] project.delete receipt: ${JSON.stringify(cleanup)}`);

rmSync(workspaceRoot, { recursive: true, force: true });
socket.close();
console.log("[done] authenticated, dispatched, received receipts");
