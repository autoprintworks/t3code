/**
 * In-process PortScanner implementation.
 *
 * macOS/Linux: parses `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` (-F output is a
 * stable line-prefixed field format; this is the only `lsof` flag set we rely
 * on).
 *
 * Windows / lsof missing: checks a curated list of common dev ports through
 * the shared Net service.
 *
 * Polling is reference-counted via scoped `retain`. A single layer-scoped fiber
 * polls forever, but each tick is a no-op when the retain count is zero.
 */
import { ThreadId, type DiscoveredLocalServer } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import { LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

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
// process registration that actually moved - drops it back to the base.
const POLL_INTERVAL = Duration.seconds(3);
const POLL_BACKOFF_FACTOR = 2;
const POLL_BACKOFF_MAX_MULTIPLIER = 4;
// Both listener probes stay under the base period, so a scan cannot spill into
// the next one.
const LSOF_TIMEOUT_MS = 2_500;
const WINDOWS_LISTENER_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_NAME_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_NAME_CONCURRENCY = 4;

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

interface TerminalProcessOwner {
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

const splitWindowsAddress = (value: string): { host: string; port: number } | null => {
  const lastColon = value.lastIndexOf(":");
  if (lastColon < 0) return null;
  const rawHost = value.slice(0, lastColon);
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const port = Number.parseInt(value.slice(lastColon + 1), 10);
  if (!Number.isInteger(port) || port < 0 || port >= 65536) return null;
  return { host, port };
};

/**
 * Parses `netstat -ano -p TCP`. A listening row is recognised by its foreign
 * address being the wildcard `0.0.0.0:0` / `[::]:0`, not by the state word,
 * which netstat localises.
 */
export const parseWindowsListenerOutput = (
  raw: string,
  terminalByProcessId: ReadonlyMap<number, TerminalProcessOwner> = new Map(),
): ReadonlyArray<DiscoveredLocalServer> => {
  const seen = new Map<number, DiscoveredLocalServer>();
  for (const line of raw.split(/\r?\n/g)) {
    const [proto, localRaw, foreignRaw, ...rest] = line.trim().split(/\s+/g);
    if (proto?.toUpperCase() !== "TCP" || localRaw === undefined || foreignRaw === undefined) {
      continue;
    }
    const foreign = splitWindowsAddress(foreignRaw);
    if (foreign === null || foreign.port !== 0) continue;
    const local = splitWindowsAddress(localRaw);
    if (local === null || local.port <= 0) continue;
    if (!LSOF_LOCAL_HOST_TOKENS.has(local.host) && local.host !== "::") continue;
    const pid = Number(rest.at(-1));
    const normalizedPid = Number.isInteger(pid) && pid > 0 ? pid : null;
    if (seen.has(local.port)) continue;
    seen.set(local.port, {
      host: "localhost",
      port: local.port,
      url: `http://localhost:${local.port}`,
      processName: null,
      pid: normalizedPid,
      terminal: normalizedPid === null ? null : (terminalByProcessId.get(normalizedPid) ?? null),
    });
  }
  return [...seen.values()].toSorted((left, right) => left.port - right.port);
};

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
  // Opened by anything that means "this host is not idle": a changed listener
  // set, a new retainer, a terminal whose process set moved. The poll loop
  // closes it at the start of each tick and reads it at the end.
  const pollWake = yield* Latch.make(false);
  const scanInFlightRef = yield* Ref.make(false);

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

  // netstat reports a PID but no image name; tasklist answers for one PID in
  // ~35 ms of CPU. Names are cached per PID and pruned to the listeners of the
  // current scan, so a steady set of dev servers costs no extra spawns at all.
  const processNameCacheRef = yield* Ref.make<ReadonlyMap<number, string>>(new Map());

  const windowsProcessNames = Effect.fn("PortDiscovery.windowsProcessNames")(function* (
    pids: ReadonlyArray<number>,
  ) {
    const wanted = [...new Set(pids)];
    const cached = yield* Ref.get(processNameCacheRef);
    const missing = wanted.filter((pid) => !cached.has(pid));
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
    const resolvedByPid = new Map(resolved);
    const next = new Map<number, string>();
    for (const pid of wanted) {
      const name = cached.get(pid) ?? resolvedByPid.get(pid) ?? null;
      if (name !== null) next.set(pid, name);
    }
    yield* Ref.set(processNameCacheRef, next);
    return next;
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
      // and no CIM initialisation.
      const raw = yield* processRunner
        .run({
          command: "netstat.exe",
          args: ["-ano", "-p", "TCP"],
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
      const listeners = parseWindowsListenerOutput(raw, terminalByProcessId);
      const processNameByPid = yield* windowsProcessNames(
        listeners.map((server) => server.pid).filter((pid): pid is number => pid !== null),
      );
      return listeners.map((server) =>
        server.pid === null
          ? server
          : { ...server, processName: processNameByPid.get(server.pid) ?? null },
      );
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
      // One scan at a time: a scan that outlives its period makes the next tick
      // skip rather than overlap it.
      const started = yield* Ref.modify(scanInFlightRef, (busy) => [!busy, true] as const);
      if (!started) {
        yield* Effect.logDebug("preview port scan still running; skipping this tick");
        return;
      }
      yield* Effect.gen(function* () {
        const next = yield* scanOnce();
        const changed = yield* Ref.modify(stateRef, (state) =>
          serversEqual(state.lastSnapshot, next)
            ? [false, state]
            : [true, { ...state, lastSnapshot: next }],
        );
        if (changed) {
          Latch.openUnsafe(pollWake);
          yield* broadcast(next);
        }
      }).pipe(Effect.ensuring(Ref.set(scanInFlightRef, false)));
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("preview port scan failed", Cause.pretty(cause)),
    ),
  );

  // Single layer-scoped polling fiber. Ticks are no-ops when no client is
  // currently retained, so the cost is one Ref.get every period. Periods that
  // find nothing new back off geometrically; a changed listener set, a new
  // retainer, or a terminal whose processes moved drops it back to the base.
  const basePollIntervalMs = Duration.toMillis(POLL_INTERVAL);
  const maxPollIntervalMs = basePollIntervalMs * POLL_BACKOFF_MAX_MULTIPLIER;
  let pollIntervalMs = basePollIntervalMs;

  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Latch.close(pollWake);
        yield* pollTick();
        pollIntervalMs = Latch.isOpen(pollWake)
          ? basePollIntervalMs
          : Math.min(pollIntervalMs * POLL_BACKOFF_FACTOR, maxPollIntervalMs);

        // The base period is never cut short, so a wake can never drive the
        // scanner faster than its configured rate; only the back-off is.
        yield* Effect.sleep(basePollIntervalMs);
        const backoffRemainderMs = pollIntervalMs - basePollIntervalMs;
        if (backoffRemainderMs > 0) {
          yield* Effect.raceFirst(Effect.sleep(backoffRemainderMs), Latch.await(pollWake));
        }
      }),
    ),
  );

  const acquireRetention = Effect.fn("PortDiscovery.retain")(function* () {
    const wasIdle = yield* Ref.modify(stateRef, (state) => [
      state.retainCount === 0,
      { ...state, retainCount: state.retainCount + 1 },
    ]);
    if (wasIdle) {
      // Run an immediate scan + broadcast so the new retainer doesn't have
      // to wait up to POLL_INTERVAL for the first emission.
      Latch.openUnsafe(pollWake);
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
      if (changed) Latch.openUnsafe(pollWake);
    });

  const unregisterTerminal: PortDiscovery["Service"]["unregisterTerminal"] = Effect.fn(
    "PortDiscovery.unregisterTerminal",
  )(function* (input) {
    const changed = yield* Ref.modify(stateRef, (state) => {
      const terminalProcesses = new Map(state.terminalProcesses);
      const removed = terminalProcesses.delete(terminalOwnerKey(input));
      return [removed, removed ? { ...state, terminalProcesses } : state] as const;
    });
    if (changed) Latch.openUnsafe(pollWake);
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
