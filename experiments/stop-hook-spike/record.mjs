#!/usr/bin/env node
/**
 * Hook recorder for autoprintworks/t3code#6.
 *
 * Registered as the command for Stop / SessionStart / SessionEnd in the scratch
 * project's `.claude/settings.json`. Claude Code feeds a hook its JSON payload
 * on stdin; this appends one JSON line per invocation so the spike can read
 * back exactly what fired, when, and with what.
 *
 * Deliberately records the *environment* alongside the payload: issue #6's
 * open question includes whether the payload carries enough to identify the
 * T3 thread, and if it does not, the environment is the only other channel.
 *
 * Usage (from settings.json): node record.mjs <log-path> <label>
 */
import { appendFileSync, readFileSync } from "node:fs";

const [logPath, label = "unknown"] = process.argv.slice(2);

let raw = "";
try {
  // fd 0 rather than a stream: hooks are short-lived and a sync slurp keeps
  // the recorder from racing its own exit on Windows.
  raw = readFileSync(0, "utf8");
} catch {
  raw = "";
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  payload = { _unparsed: raw };
}

const interesting = (name) =>
  name.startsWith("CLAUDE_") || name.startsWith("T3") || name === "ANTHROPIC_MODEL";

appendFileSync(
  logPath,
  `${JSON.stringify({
    at: new Date().toISOString(),
    label,
    pid: process.pid,
    ppid: process.ppid,
    cwd: process.cwd(),
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => interesting(name)),
    ),
    payload,
  })}\n`,
  "utf8",
);
