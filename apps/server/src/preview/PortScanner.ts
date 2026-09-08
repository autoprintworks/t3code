/**
 * In-process PortScanner implementation.
 *
 * macOS/Linux: parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (-F output is a
 * stable line-prefixed field format; this is the only `lsof` flag set we rely
 * on).
 *
 * Windows: parses `netstat -ano`, which covers IPv4 and IPv6 in one run and
 * costs a fraction of the PowerShell `Get-NetTCPConnection` it replaced.
 * netstat reports a pid but no image name, so names come from a filtered
 * `tasklist` per pid, cached and bounded per scan.
 *
 * Neither available: checks a curated list of common dev ports through the
 * shared Net service. This is the fallback, not the Windows path.
 *
 * Polling is reference-counted via scoped `retain`. A single layer-scoped fiber
 * polls forever, but each tick is a no-op when the retain count is zero. The
 * cadence backs off while nothing changes and snaps back to the base period
 * when it does; that policy is shared with the terminal subprocess poll and
 * lives in `pollLoop.ts`. Scans are serialised by a semaphore, so a retainer
 * arriving mid-scan waits for the scan in flight and then gets its own rather
 * than waiting a full period.
 */
import { ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import { LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as PollLoop from "../pollLoop.ts";
import * as ProcessRunner from "../processRunner.ts";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: () => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    readonly subscribe: (
      listener: (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
    readonly registerTerminalProcesses: (input: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly processIds: ReadonlyArray<number>;
    }) => Effect.Effect<void>;
    readonly unregisterTerminal: (input: {
      readonly threadId: string;
      readonly terminalId: string;
    }) => Effect.Effect<void>;
  }
>()("t3/preview/PortScanner/PortDiscovery") {}

export const COMMON_DEV_PORTS: ReadonlyArray<number> = Object.freeze([
  3000, 3001, 3333, 4173, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 8000, 8080, 8081, 8888, 9000,
]);

// Base period, and the geometric back-off a run of unchanged scans decays to.
// Anything that changes - a different listener set, a new retainer, a terminal
// process registration that actually moved - drops it back to the base. The
// engine is `pollLoop.ts`, shared with the terminal subprocess poll.
const POLL_INTERVAL = Duration.seconds(3);
const POLL_BACKOFF_FACTOR = 2;
const POLL_BACKOFF_MAX_MULTIPLIER = 4;
// The whole round, not only each probe, has to fit under the base period. On
// Windows a round is one netstat plus at most two waves of name lookups:
// 1500 + 2 x 500 = 2500 ms against a 3000 ms period.
const LSOF_TIMEOUT_MS = 2_500;
const WINDOWS_LISTENER_TIMEOUT_MS = 1_500;
const WINDOWS_PROCESS_NAME_TIMEOUT_MS = 500;
const WINDOWS_PROCESS_NAME_CONCURRENCY = 4;
// Pids left over after this many lookups are resolved by the next round rather
// than pushing this one past its period. A first scan on a busy host sees ~36
// listeners, so a cold cache fills over about five rounds.
const WINDOWS_PROCESS_NAME_MAX_PER_SCAN = 8;
// Windows reuses pids, so a name is a guess with a shelf life rather than a
// fact. Re-probing once a minute keeps a reused pid wrong for at most that
// long, and costs one tasklist per listener per minute in the steady state.
const PROCESS_NAME_TTL_MS = 60_000;

type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;

interface ScannerState {
  readonly lastSnapshot: ReadonlyArray<DiscoveredLocalServer>;
  readonly listeners: ReadonlySet<Listener>;
  readonly terminalProcesses: ReadonlyMap<
    string,
    {
      readonly owner: TerminalProcessOwner;
      readonly processIds: ReadonlySet<number>;
    }
  >;
  readonly retainCount: number;
}

/**
 * A cached tasklist answer. `null` is a real answer - the pid could not be
 * named - and is cached so it is not re-probed every scan.
 */
interface ProcessNameEntry {
  readonly name: string | null;
  readonly expiresAtMs: number;
}

export interface TerminalProcessOwner {
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

const terminalOwnerKey = (owner: {
  readonly threadId: string;
  readonly terminalId: string;
}): string => `${owner.threadId}\u0000${owner.terminalId}`;

const parseLsofOutput = (
  raw: string,
  terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<string, DiscoveredLocalServer>();
  let pid: number | null = null;
  let processName: string | null = null;

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const tag = line.charAt(0);
    const value = line.slice(1);
    if (tag === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      processName = null;
      continue;
    }
    if (tag === "c") {
      processName = value.trim() || null;
      continue;
    }
    if (tag === "n") {
      const portMatch = parsePortFromLsofName(value);
      if (portMatch == null) continue;
      const url = `http://localhost:${portMatch}`;
      const key = `localhost:${portMatch}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        host: "localhost",
        port: portMatch,
        url,
        processName,
        pid,
        terminal: pid === null ? null : (terminalByProcessId.get(pid) ?? null),
      });
    }
  }

  return Array.from(seen.values()).toSorted((a, b) => a.port - b.port);
};

const parsePortFromLsofName = (name: string): number | null => {
  // Examples: "*:5173", "127.0.0.1:5173", "[::1]:5173", "localhost:5173",
  //           "192.168.1.10:5173 (LISTEN)" — we only care if the host part is local.
  const trimmed = name.split(" ", 1)[0]?.trim() ?? "";
  if (trimmed.length === 0) return null;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon < 0) return null;
  const hostPart = trimmed.slice(0, lastColon);
  const portPart = trimmed.slice(lastColon + 1);
  if (!LSOF_LOCAL_HOST_TOKENS.has(hostPart)) return null;
  const port = Number.parseInt(portPart, 10);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) return null;
  return port;
};

/**
 * Splits a netstat address column into host and port. IPv6 hosts arrive
 * bracketed (`[::1]:8080`) and are returned unbracketed, so `::1` matches the
 * same loopback token set the lsof path uses.
 */
export const splitWindowsAddress = (value: string): { host: string; port: number } | null => {
  const lastColon = value.lastIndexOf(":");
  if (lastColon < 0) return null;
  const rawHost = value.slice(0, lastColon);
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const port = Number.parseInt(value.slice(lastColon + 1), 10);
  if (!Number.isInteger(port) || port < 0 || port >= 65536) return null;
  return { host, port };
};

/**
 * One loopback TCP listener as netstat reports it. This is everything a netstat
 * row actually carries: the image name is not in the output, so it is not in
 * this type either.
 */
export interface WindowsListenerRow {
  readonly port: number;
  readonly pid: number | null;
}

/**
 * Parses `netstat -ano`, which covers IPv4 and IPv6 in one run. A listening row
 * is recognised by its foreign address being the wildcard `0.0.0.0:0` /
 * `[::]:0`, not by the state word, which netstat localises.
 */
export const parseWindowsListenerOutput = (raw: string): ReadonlyArray<WindowsListenerRow> => {
  const lines = raw.split(/\r?\n/g);
  // netstat's output can be cut mid-row by the output cap. Real output always
  // ends with a line terminator, so a non-empty tail segment is a partial row,
  // whose port or pid would otherwise be read as a smaller whole number.
  if (lines.at(-1) !== "") lines.pop();
  const seen = new Map<number, WindowsListenerRow>();
  for (const line of lines) {
    const parts = line.trim().split(/\s+/g);
    // Proto, local address, foreign address, state, pid. A TCP row with fewer
    // columns is not a row we can trust.
    if (parts.length !== 5) continue;
    const [proto, localRaw, foreignRaw, , pidRaw] = parts;
    if (
      proto === undefined ||
      localRaw === undefined ||
      foreignRaw === undefined ||
      pidRaw === undefined
    ) {
      continue;
    }
    if (proto.toUpperCase() !== "TCP") continue;
    const foreign = splitWindowsAddress(foreignRaw);
    if (foreign === null || foreign.port !== 0) continue;
    const local = splitWindowsAddress(localRaw);
    if (local === null || local.port <= 0) continue;
    if (!LSOF_LOCAL_HOST_TOKENS.has(local.host) && local.host !== "::") continue;
    if (seen.has(local.port)) continue;
    const pid = Number(pidRaw);
    seen.set(local.port, {
      port: local.port,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    });
  }
  return [...seen.values()].toSorted((left, right) => left.port - right.port);
};

/**
 * Joins parsed netstat rows to the two things netstat does not know: the image
 * name for each pid, and which terminal owns it.
 */
export const windowsListenersToServers = (
  rows: ReadonlyArray<WindowsListenerRow>,
  processNameByPid: ReadonlyMap<number, string>,
  terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> =>
  rows.map((row) => ({
    host: "localhost",
    port: row.port,
    url: `http://localhost:${row.port}`,
    processName: row.pid === null ? null : (processNameByPid.get(row.pid) ?? null),
    pid: row.pid,
    terminal: row.pid === null ? null : (terminalByProcessId.get(row.pid) ?? null),
  }));

/**
 * Reads the image name out of a `tasklist /nh /fo csv` row, dropping the `.exe`
 * so the wire value matches what `Get-Process` used to report.
 */
export const parseTasklistProcessName = (raw: string): string | null => {
  for (const line of raw.split(/\r?\n/g)) {
    const name = /^"([^"]*)"/.exec(line.trim())?.[1]?.trim();
    if (!name) continue;
    return name.toLowerCase().endsWith(".exe") ? name.slice(0, -4) : name;
  }
  return null;
};

const processIdSetsEqual = (
  left: ReadonlySet<number> | undefined,
  right: ReadonlySet<number>,
): boolean => {
  if (left === undefined) return right.size === 0;
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
};

const serversEqual = (
  left: ReadonlyArray<DiscoveredLocalServer>,
  right: ReadonlyArray<DiscoveredLocalServer>,
): boolean => {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b) return false;
    if (
      a.host !== b.host ||
      a.port !== b.port ||
      a.url !== b.url ||
      a.processName !== b.processName ||
      a.pid !== b.pid ||
      a.terminal?.threadId !== b.terminal?.threadId ||
      a.terminal?.terminalId !== b.terminal?.terminalId
    ) {
      return false;
    }
  }
  return true;
};

export const make = Effect.gen(function* PortDiscoveryMake() {
  const net = yield* Net.NetService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const hostPlatform = yield* HostProcessPlatform;
  const stateRef = yield* Ref.make<ScannerState>({
    lastSnapshot: [],
    listeners: new Set(),
    terminalProcesses: new Map(),
    retainCount: 0,
  });
  // Woken by anything that means "this host is not idle": a changed listener
  // set, a new retainer, a terminal whose process set moved. See `pollLoop.ts`
  // for what a wake does to the cadence.
  const poll = yield* PollLoop.makeBackoffPoll({
    basePeriod: POLL_INTERVAL,
    factor: POLL_BACKOFF_FACTOR,
    maxMultiplier: POLL_BACKOFF_MAX_MULTIPLIER,
  });
  // One scan at a time. A retainer that arrives mid-scan queues behind the scan
  // in flight and then gets its own, rather than reading a snapshot taken
  // before it existed or waiting a whole period for the next round.
  const scanMutex = yield* Semaphore.make(1);

  const probeCommonPorts = Effect.fn("PortDiscovery.probeCommonPorts")(function* () {
    const results = yield* Effect.forEach(
      COMMON_DEV_PORTS,
      (port) =>
        net.isPortAvailableOnLoopback(port).pipe(
          Effect.map((available) => ({
            port,
            listening: !available,
          })),
        ),
      { concurrency: "unbounded" },
    );
    return results
      .filter((result) => result.listening)
      .map<DiscoveredLocalServer>((result) => ({
        host: "localhost",
        port: result.port,
        url: `http://localhost:${result.port}`,
        processName: null,
        pid: null,
        terminal: null,
      }));
  });

  const recoverProcessProbeFailure =
    (probe: "lsof" | "windows-listeners") => (error: ProcessRunner.ProcessRunError) =>
      Effect.logDebug("preview port process probe failed; falling back to common-port probes", {
        cause: error,
        probe,
        platform: hostPlatform,
      }).pipe(Effect.as(null));

  // netstat reports a pid but no image name; tasklist answers for one pid in
  // ~35 ms of CPU. Names are cached per pid, pruned to the listeners of the
  // current scan, and expire after `PROCESS_NAME_TTL_MS`, so a steady set of dev
  // servers costs almost nothing while a reused pid cannot keep a stale name.
  // A pid that cannot be named caches its `null`, so it is not re-probed every
  // scan.
  const processNameCacheRef = yield* Ref.make<ReadonlyMap<number, ProcessNameEntry>>(new Map());

  const windowsProcessNames = Effect.fn("PortDiscovery.windowsProcessNames")(function* (
    pids: ReadonlyArray<number>,
  ) {
    const wanted = [...new Set(pids)];
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(processNameCacheRef);
    const stale = (pid: number): boolean => {
      const entry = cached.get(pid);
      return entry === undefined || entry.expiresAtMs <= now;
    };
    // Whatever is left over is picked up next round, so a host with hundreds of
    // fresh listeners cannot stretch one round past its period.
    const missing = wanted.filter(stale).slice(0, WINDOWS_PROCESS_NAME_MAX_PER_SCAN);
    const resolved = yield* Effect.forEach(
      missing,
      (pid) =>
        processRunner
          .run({
            command: "tasklist.exe",
            args: ["/nh", "/fo", "csv", "/fi", `PID eq ${pid}`],
            timeout: Duration.millis(WINDOWS_PROCESS_NAME_TIMEOUT_MS),
            maxOutputBytes: 64 * 1024,
            outputMode: "truncate",
          })
          .pipe(
            Effect.map((result) => [pid, parseTasklistProcessName(result.stdout)] as const),
            Effect.orElseSucceed(() => [pid, null] as const),
          ),
      { concurrency: WINDOWS_PROCESS_NAME_CONCURRENCY },
    );
    const resolvedAt = yield* Clock.currentTimeMillis;
    const resolvedByPid = new Map(resolved);
    // One read-modify-write, so two overlapping callers cannot lose each
    // other's lookups.
    return yield* Ref.modify(processNameCacheRef, (current) => {
      const next = new Map<number, ProcessNameEntry>();
      const names = new Map<number, string>();
      for (const pid of wanted) {
        const probed = resolvedByPid.get(pid);
        const existing = current.get(pid);
        const entry: ProcessNameEntry | undefined =
          probed === undefined
            ? existing !== undefined && existing.expiresAtMs > resolvedAt
              ? existing
              : undefined
            : { name: probed, expiresAtMs: resolvedAt + PROCESS_NAME_TTL_MS };
        if (entry === undefined) continue;
        next.set(pid, entry);
        if (entry.name !== null) names.set(pid, entry.name);
      }
      return [names as ReadonlyMap<number, string>, next as ReadonlyMap<number, ProcessNameEntry>];
    });
  });

  const scanOnce = Effect.fn("PortDiscovery.scan")(function* () {
    const state = yield* Ref.get(stateRef);
    const terminalByProcessId = new Map<number, TerminalProcessOwner>();
    for (const registration of state.terminalProcesses.values()) {
      for (const processId of registration.processIds) {
        terminalByProcessId.set(processId, registration.owner);
      }
    }
    if (hostPlatform === "win32") {
      const recoverWindowsProbeFailure = recoverProcessProbeFailure("windows-listeners");
      // netstat is a plain console executable: ~35 ms of CPU against the ~1.9 s
      // that `Get-NetTCPConnection` cost, because it pays no PowerShell start-up
      // and no CIM initialisation. No `-p TCP`, which is IPv4 only and hides
      // every IPv6 listener; the parser filters on the proto column instead.
      const raw = yield* processRunner
        .run({
          command: "netstat.exe",
          args: ["-ano"],
          timeout: Duration.millis(WINDOWS_LISTENER_TIMEOUT_MS),
          maxOutputBytes: 4 * 1024 * 1024,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((result) => result.stdout),
          Effect.catchTags({
            ProcessSpawnError: recoverWindowsProbeFailure,
            ProcessStdinError: recoverWindowsProbeFailure,
            ProcessOutputLimitError: recoverWindowsProbeFailure,
            ProcessReadError: recoverWindowsProbeFailure,
            ProcessTimeoutError: recoverWindowsProbeFailure,
          }),
        );
      if (raw === null) return yield* probeCommonPorts();
      const rows = parseWindowsListenerOutput(raw);
      const processNameByPid = yield* windowsProcessNames(
        rows.map((row) => row.pid).filter((pid): pid is number => pid !== null),
      );
      return windowsListenersToServers(rows, processNameByPid, terminalByProcessId);
    }
    const recoverLsofProbeFailure = recoverProcessProbeFailure("lsof");
    const lsofResult = yield* processRunner
      .run({
        command: "lsof",
        args: ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"],
        timeout: Duration.millis(LSOF_TIMEOUT_MS),
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((result) => parseLsofOutput(result.stdout, terminalByProcessId)),
        Effect.catchTags({
          ProcessSpawnError: recoverLsofProbeFailure,
          ProcessStdinError: recoverLsofProbeFailure,
          ProcessOutputLimitError: recoverLsofProbeFailure,
          ProcessReadError: recoverLsofProbeFailure,
          ProcessTimeoutError: recoverLsofProbeFailure,
        }),
      );
    if (lsofResult !== null) return lsofResult;
    return yield* probeCommonPorts();
  });

  const broadcast = Effect.fn("PortDiscovery.broadcast")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
  ) {
    const listeners = (yield* Ref.get(stateRef)).listeners;
    yield* Effect.forEach(listeners, (listener) => listener(servers), { discard: true });
  });

  const pollTick = Effect.fn("PortDiscovery.pollTick")(
    function* () {
      if ((yield* Ref.get(stateRef)).retainCount <= 0) return;
      yield* scanMutex.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* scanOnce();
          const changed = yield* Ref.modify(stateRef, (state) =>
            serversEqual(state.lastSnapshot, next)
              ? [false, state]
              : [true, { ...state, lastSnapshot: next }],
          );
          if (changed) {
            poll.wakeUnsafe();
            yield* broadcast(next);
          }
        }),
      );
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("preview port scan failed", Cause.pretty(cause)),
    ),
  );

  // Single layer-scoped polling fiber. Rounds are no-ops when no client is
  // currently retained, so the cost is one Ref.get every period.
  yield* Effect.forkScoped(poll.run(pollTick()));

  const acquireRetention = Effect.fn("PortDiscovery.retain")(function* () {
    const wasIdle = yield* Ref.modify(stateRef, (state) => [
      state.retainCount === 0,
      { ...state, retainCount: state.retainCount + 1 },
    ]);
    if (wasIdle) {
      // Run an immediate scan + broadcast so the new retainer doesn't have to
      // wait up to POLL_INTERVAL for the first emission. If a scan is already
      // running this queues behind it rather than being dropped.
      poll.wakeUnsafe();
      yield* pollTick();
    }
  });

  const retain: PortDiscovery["Service"]["retain"] = Effect.acquireRelease(acquireRetention(), () =>
    Ref.update(stateRef, (state) => ({
      ...state,
      retainCount: Math.max(0, state.retainCount - 1),
    })),
  );

  const subscribe: PortDiscovery["Service"]["subscribe"] = Effect.fn("PortDiscovery.subscribe")(
    (listener) =>
      Effect.acquireRelease(
        Ref.update(stateRef, (state) => ({
          ...state,
          listeners: new Set([...state.listeners, listener]),
        })),
        () =>
          Ref.update(stateRef, (state) => {
            const listeners = new Set(state.listeners);
            listeners.delete(listener);
            return { ...state, listeners };
          }),
      ),
  );

  const registerTerminalProcesses: PortDiscovery["Service"]["registerTerminalProcesses"] =
    Effect.fn("PortDiscovery.registerTerminalProcesses")(function* (input) {
      const owner = {
        threadId: ThreadId.make(input.threadId),
        terminalId: input.terminalId,
      };
      const processIds = new Set(
        input.processIds.filter((processId) => Number.isInteger(processId) && processId > 0),
      );
      const changed = yield* Ref.modify(stateRef, (state) => {
        const terminalProcesses = new Map(state.terminalProcesses);
        const key = terminalOwnerKey(owner);
        const previous = terminalProcesses.get(key)?.processIds;
        if (processIds.size === 0) {
          terminalProcesses.delete(key);
        } else {
          terminalProcesses.set(key, { owner, processIds });
        }
        const moved = !processIdSetsEqual(previous, processIds);
        return [moved, moved ? { ...state, terminalProcesses } : state] as const;
      });
      // A terminal that just gained or lost processes is the strongest hint we
      // get that a dev server is about to appear or disappear.
      if (changed) poll.wakeUnsafe();
    });

  const unregisterTerminal: PortDiscovery["Service"]["unregisterTerminal"] = Effect.fn(
    "PortDiscovery.unregisterTerminal",
  )(function* (input) {
    const changed = yield* Ref.modify(stateRef, (state) => {
      const terminalProcesses = new Map(state.terminalProcesses);
      const removed = terminalProcesses.delete(terminalOwnerKey(input));
      return [removed, removed ? { ...state, terminalProcesses } : state] as const;
    });
    if (changed) poll.wakeUnsafe();
  });

  return PortDiscovery.of({
    scan: scanOnce,
    subscribe,
    retain,
    registerTerminalProcesses,
    unregisterTerminal,
  });
}).pipe(Effect.withSpan("PortDiscovery.make"));

export const layer = Layer.effect(PortDiscovery, make);
