#!/usr/bin/env node
/**
 * The watcher half of the spike for autoprintworks/t3code#10.
 *
 * This is a SEPARATE PROCESS on purpose. firstmate's watcher is a detached
 * shell loop that wakes a sleeping mate by injecting text into its session; it
 * shares no connection, no memory and no lifetime with the mate. So the T3
 * analogue has to be a process that stands up its own authenticated socket from
 * nothing but a bearer token on disk, dispatches one `thread.turn.start`, and
 * exits. Anything the spike proves by calling into its own already-open socket
 * would be proving the wrong thing.
 *
 * Prints one JSON object on stdout and exits 0 whether the dispatch was
 * accepted or refused — a refusal is a result, not a crash.
 *
 * Usage:
 *   node watcher-poke.mjs --token-file <path> --thread <id> --text <poke>
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  options: {
    "token-file": { type: "string" },
    "base-dir": { type: "string" },
    origin: { type: "string" },
    thread: { type: "string" },
    text: { type: "string" },
    "text-file": { type: "string" },
    // The mate's own runtime mode is what the server uses (the decider reads
    // targetThread.runtimeMode, not the command's), but send it anyway so the
    // command is byte-shaped like the composer's.
    "runtime-mode": { type: "string", default: "full-access" },
  },
});

const started = Date.now();
const result = { ok: false, pid: process.pid, threadId: flags.thread };

try {
  const token = readFileSync(flags["token-file"], "utf8").trim();
  if (!token) throw new Error("empty token file");

  const origin =
    flags.origin ??
    JSON.parse(
      readFileSync(
        join(
          flags["base-dir"] ?? process.env.T3CODE_HOME ?? join(homedir(), ".t3"),
          "userdata",
          "server-runtime.json",
        ),
        "utf8",
      ),
    ).origin;
  result.origin = origin;

  // Node's built-in WebSocket cannot set headers, so the bearer token buys a
  // short-lived ticket first (#3). A watcher therefore needs one HTTP round
  // trip before it can poke — worth knowing for a shell backend.
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!ticketResponse.ok) {
    throw new Error(`websocket-ticket ${ticketResponse.status}: ${await ticketResponse.text()}`);
  }
  const wsTicket = (await ticketResponse.json()).ticket;
  result.ticketMs = Date.now() - started;

  const socket = new WebSocket(
    `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(wsTicket)}`,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    socket.addEventListener("close", (event) => reject(new Error(`closed ${event.code}`)), {
      once: true,
    });
  });
  result.connectedMs = Date.now() - started;

  const messageId = randomUUID();
  const commandId = randomUUID();
  const text = flags["text-file"] ? readFileSync(flags["text-file"], "utf8") : (flags.text ?? "");

  const value = await new Promise((resolve, reject) => {
    const requestId = "1";
    socket.addEventListener("message", (event) => {
      for (const message of [].concat(JSON.parse(event.data))) {
        if (message._tag !== "Exit" || String(message.requestId) !== requestId) continue;
        if (message.exit._tag === "Success") resolve(message.exit.value);
        else reject(new Error(JSON.stringify(message.exit.cause)));
      }
    });
    socket.send(
      JSON.stringify({
        _tag: "Request",
        id: requestId,
        tag: "orchestration.dispatchCommand",
        // Field for field what packages/client-runtime's startThreadTurn sends
        // from the composer, minus the parts the composer fills from UI state.
        payload: {
          type: "thread.turn.start",
          commandId,
          threadId: flags.thread,
          message: { messageId, role: "user", text, attachments: [] },
          runtimeMode: flags["runtime-mode"],
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        },
        headers: [],
      }),
    );
  });

  result.ok = true;
  result.messageId = messageId;
  result.commandId = commandId;
  result.receipt = value;
  result.totalMs = Date.now() - started;
  socket.close();
} catch (error) {
  result.error = String(error.message).slice(0, 900);
  result.totalMs = Date.now() - started;
}

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(0);
