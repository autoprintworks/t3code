/**
 * A stand-in ACP agent that hosts peer sessions, for
 * `bench-acp-worker-poll.ts`.
 *
 * Plain Node with no dependencies, so it can be spawned as a real subprocess
 * over a real pipe: the point of the measurement is the cost of the poll on
 * the shipping path, and a spawner stub would remove the two parts of it that
 * actually touch the event loop - the child process and the ndjson framing.
 *
 * Behaviour is set by environment variables:
 *
 * - `AGENT_WORKERS` - how many worker sessions `session/list` answers with.
 * - `AGENT_SILENT` - comma-separated methods to read and never answer.
 * - `AGENT_DROP_AFTER` - after this many `session/list` answers, stop listing
 *   the workers. Models a session that vanishes while its load is in flight.
 * - `AGENT_LIST_DELAY_MS` - milliseconds to wait before answering
 *   `session/list`, for measuring a slow agent rather than an absent one.
 */
const WORKERS = Number(process.env.AGENT_WORKERS ?? "0");
const SILENT = new Set((process.env.AGENT_SILENT ?? "").split(",").filter(Boolean));
const DROP_AFTER = Number(process.env.AGENT_DROP_AFTER ?? "0");
const LIST_DELAY_MS = Number(process.env.AGENT_LIST_DELAY_MS ?? "0");

const SUPERVISOR = "acp-bench-supervisor";
let listCount = 0;

const workerRows = Array.from({ length: WORKERS }, (_unused, index) => ({
  sessionId: `acp-bench-worker-${String(index)}`,
  cwd: `/repo/worker-${String(index)}`,
  title: `worker ${String(index)}`,
}));

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const answer = (id, result) => {
  write({ jsonrpc: "2.0", id, result });
};

const handle = (message) => {
  const { method, id } = message;
  if (typeof method !== "string") return;
  if (SILENT.has(method)) return;

  switch (method) {
    case "initialize":
      answer(id, {
        protocolVersion: 1,
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {} },
          promptCapabilities: { audio: false, embeddedContext: false, image: false },
        },
      });
      return;
    case "session/new":
      answer(id, { sessionId: SUPERVISOR });
      return;
    case "session/list": {
      listCount += 1;
      const dropped = DROP_AFTER > 0 && listCount > DROP_AFTER;
      const sessions = [
        { sessionId: SUPERVISOR, cwd: "/repo", title: "supervisor" },
        ...(dropped ? [] : workerRows),
      ];
      if (LIST_DELAY_MS > 0) {
        setTimeout(() => answer(id, { sessions }), LIST_DELAY_MS);
        return;
      }
      answer(id, { sessions });
      return;
    }
    case "session/load":
      answer(id, {});
      return;
    case "authenticate":
      answer(id, {});
      return;
    default:
      if (id !== undefined) {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } });
      }
  }
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length > 0) handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
