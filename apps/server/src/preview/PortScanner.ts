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
 * Listening ports are published only after a bounded HTTP(S) probe finds a
 * successful HTML document or a redirect to one.
 * Positive and negative results are cached briefly by candidate URL and listener identity,
 * limiting repeated requests without leaving stale classifications around.
 *
 * Polling is reference-counted via scoped `retain`. A single layer-scoped fiber
 * polls forever, but each tick is a no-op when the retain count is zero. The
 * cadence backs off while nothing changes and snaps back to the base period
 * when it does; that policy is shared with the terminal subprocess poll and
 * lives in `pollLoop.ts`. Scans are serialised by a semaphore, so a retainer
 * arriving mid-scan waits for the scan in flight and then gets its own rather
 * than waiting a full period.
 */
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  ThreadId,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import { isLoopbackHost, LSOF_LOCAL_HOST_TOKENS } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import * as PollLoop from "../pollLoop.ts";
import * as ProcessRunner from "../processRunner.ts";

export class PortDiscovery extends Context.Service<
  PortDiscovery,
  {
    readonly scan: (
      configuredUrls?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<DiscoveredLocalServer>>;
    readonly subscribe: (
      input: {
        readonly configuredUrls: ReadonlyArray<string>;
        readonly initialSnapshot: ReadonlyArray<DiscoveredLocalServer>;
      },
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
// The netstat/lsof failure path. It is inside the round, so it gets the same
// treatment: 16 ports, 4 at a time, 250 ms each is 1000 ms against a 3000 ms
// period, where an unbounded fan-out of untimed connects had no ceiling at all.
const COMMON_PORT_PROBE_CONCURRENCY = 4;
const COMMON_PORT_PROBE_TIMEOUT_MS = 250;
// Pids left over after this many lookups are resolved by the next round rather
// than pushing this one past its period. A first scan on a busy host sees ~36
// listeners, so a cold cache fills over about five rounds.
const WINDOWS_PROCESS_NAME_MAX_PER_SCAN = 8;
// Windows reuses pids, so a name is a guess with a shelf life rather than a
// fact. Re-probing once a minute keeps a reused pid wrong for at most that
// long, and costs one tasklist per listener per minute in the steady state.
const PROCESS_NAME_TTL_MS = 60_000;
const WEB_PROBE_TIMEOUT = Duration.seconds(1);
const WEB_PROBE_CACHE_TTL_MS = Duration.toMillis(Duration.seconds(15));
const WEB_PROBE_CONCURRENCY = 16;
const NAVIGATION_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type Listener = (servers: ReadonlyArray<DiscoveredLocalServer>) => Effect.Effect<void>;

interface ListenerSubscription {
  readonly configuredUrls: ReadonlyArray<string>;
  readonly lastSnapshot: ReadonlyArray<DiscoveredLocalServer>;
}

interface ScannerState {
  readonly listeners: ReadonlyMap<Listener, ListenerSubscription>;
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

interface WebProbeCacheEntry {
  readonly pid: number | null;
  readonly isWeb: boolean;
  readonly expiresAtMillis: number;
}

interface WebProbeGroup {
  readonly server: DiscoveredLocalServer;
  readonly urls: ReadonlyArray<string>;
  readonly configuredKey: string | null;
}

interface WebProbeSnapshot {
  readonly discovered: ReadonlyArray<DiscoveredLocalServer>;
  readonly configured: ReadonlyMap<string, DiscoveredLocalServer>;
}

const terminalOwnerKey = (owner: {
  readonly threadId: string;
  readonly terminalId: string;
}): string => `${owner.threadId}\u0000${owner.terminalId}`;

const parseConfiguredUrl = (raw: string): URL | null => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!isLoopbackHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
};

const localServerKey = (host: string, port: number): string =>
  `${isLoopbackHost(host) ? "loopback" : host.toLowerCase()}:${port}`;

const urlPort = (url: URL): number =>
  url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "http:" ? 80 : 443;

const webProbeCacheKey = (raw: string): string => {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
};

const normalizeConfiguredUrls = (urls: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(
    urls
      .slice(0, CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS)
      .filter((raw) => raw.length <= PREVIEW_URL_MAX_LENGTH)
      .map(parseConfiguredUrl)
      .filter((url): url is URL => url !== null && url.href.length <= PREVIEW_URL_MAX_LENGTH)
      .map((url) => {
        if (url.hostname === "0.0.0.0") url.hostname = "localhost";
        return url.href;
      })
      .filter((url) => url.length <= PREVIEW_URL_MAX_LENGTH),
  ),
];

const projectWebProbeSnapshot = (
  snapshot: WebProbeSnapshot,
  configuredUrls: ReadonlyArray<string>,
): ReadonlyArray<DiscoveredLocalServer> => {
  const visibleByServer = new Map<string, DiscoveredLocalServer>();
  for (const raw of normalizeConfiguredUrls(configuredUrls)) {
    const url = new URL(raw);
    const port = urlPort(url);
    const serverKey = localServerKey(url.hostname, port);
    if (visibleByServer.has(serverKey)) continue;
    const configured = snapshot.configured.get(webProbeCacheKey(raw));
    if (configured) visibleByServer.set(serverKey, { ...configured, url: raw });
  }
  for (const server of snapshot.discovered) {
    const key = localServerKey(server.host, server.port);
    if (!visibleByServer.has(key)) visibleByServer.set(key, server);
  }
  return [...visibleByServer.values()].toSorted((left, right) => left.port - right.port);
};

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
export const parseWindowsListenerOutput = (
  raw: string,
  options: { readonly truncated?: boolean } = {},
): ReadonlyArray<WindowsListenerRow> => {
  const lines = raw.split(/\r?\n/g);
  // Only a run the output cap cut short can end mid-row, and that row's port or
  // pid would be read as a smaller whole number. Output that ended on its own
  // keeps its last row, with or without a trailing line terminator.
  if (options.truncated === true && lines.at(-1) !== "") lines.pop();
  const seen = new Map<number, WindowsListenerRow>();
  for (const line of lines) {
    const parts = line.trim().split(/\s+/g);
    // Proto, local address, foreign address, state, pid. The state word is
    // localised and some locales print it with a space in it, so the pid is read
    // from the end rather than from a fixed column. A UDP row has no state and
    // four columns; it is dropped by the proto check below.
    if (parts.length < 5) continue;
    const [proto, localRaw, foreignRaw] = parts;
    const pidRaw = parts.at(-1);
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
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const stateRef = yield* Ref.make<ScannerState>({
    listeners: new Map(),
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
  const webProbeCacheRef = yield* Ref.make<ReadonlyMap<string, WebProbeCacheEntry>>(new Map());
  // One scan at a time. A retainer that arrives mid-scan queues behind the scan
  // in flight and then gets its own, rather than reading a snapshot taken
  // before it existed or waiting a whole period for the next round.
  const scanSemaphore = yield* Semaphore.make(1);

  const probeCommonPorts = Effect.fn("PortDiscovery.probeCommonPorts")(function* () {
    const results = yield* Effect.forEach(
      COMMON_DEV_PORTS,
      (port) =>
        net.isPortAvailableOnLoopback(port).pipe(
          Effect.timeout(Duration.millis(COMMON_PORT_PROBE_TIMEOUT_MS)),
          // A probe that does not answer in time is not evidence of a listener.
          Effect.orElseSucceed(() => true),
          Effect.map((available) => ({
            port,
            listening: !available,
          })),
        ),
      { concurrency: COMMON_PORT_PROBE_CONCURRENCY },
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

  const probeWebUrl = Effect.fn("PortDiscovery.probeWebUrl")((url: string) =>
    httpClient.get(url).pipe(
      Effect.map((response) => {
        const location = response.headers.location?.trim();
        if (NAVIGATION_REDIRECT_STATUSES.has(response.status) && location) return url;
        if (response.status < 200 || response.status >= 300) return null;
        if (response.status === 204 || response.status === 205) return null;
        const contentType = response.headers["content-type"]
          ?.split(";", 1)[0]
          ?.trim()
          .toLowerCase();
        return contentType === "text/html" || contentType === "application/xhtml+xml" ? url : null;
      }),
      Effect.scoped,
      Effect.timeoutOption(WEB_PROBE_TIMEOUT),
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    ),
  );

  const makeWebProbeGroups = (
    servers: ReadonlyArray<DiscoveredLocalServer>,
    configuredUrls: ReadonlyArray<string>,
  ): ReadonlyArray<WebProbeGroup> => {
    const serversByKey = new Map(
      servers.map((server) => [localServerKey(server.host, server.port), server] as const),
    );
    const groups: WebProbeGroup[] = [];
    const configuredResources = new Set<string>();

    for (const raw of configuredUrls) {
      const url = new URL(raw);
      const port = urlPort(url);
      const key = localServerKey(url.hostname, port);
      const resourceKey = webProbeCacheKey(raw);
      if (configuredResources.has(resourceKey)) continue;
      configuredResources.add(resourceKey);
      groups.push({
        server: serversByKey.get(key) ?? {
          host: url.hostname,
          port,
          url: raw,
          processName: null,
          pid: null,
          terminal: null,
        },
        urls: [raw],
        configuredKey: resourceKey,
      });
    }

    for (const server of servers) {
      groups.push({
        server,
        urls: [`http://${server.host}:${server.port}`, `https://${server.host}:${server.port}`],
        configuredKey: null,
      });
    }

    return groups;
  };

  const probeWebServers = Effect.fn("PortDiscovery.probeWebServers")(function* (
    servers: ReadonlyArray<DiscoveredLocalServer>,
    configuredUrls: ReadonlyArray<string>,
  ) {
    const nowMillis = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(webProbeCacheRef);
    const groups = makeWebProbeGroups(servers, configuredUrls);
    const batchProbes = new Map<
      string,
      Effect.Effect<{ readonly probe: WebProbeCacheEntry; readonly fresh: boolean }>
    >();
    const batchProbeSemaphore = yield* Semaphore.make(1);
    const getProbe = (url: string, pid: number | null) => {
      const key = webProbeCacheKey(url);
      const identity = `${key}\u0000${pid ?? ""}`;
      return batchProbeSemaphore
        .withPermits(1)(
          Effect.gen(function* () {
            const existing = batchProbes.get(identity);
            if (existing) return [existing] as const;
            const cachedProbe = cached.get(key);
            const cachedIsCurrent =
              cachedProbe?.pid === pid && cachedProbe.expiresAtMillis > nowMillis;
            const memoized = yield* Effect.cached(
              cachedIsCurrent
                ? Effect.succeed({ probe: cachedProbe, fresh: false })
                : probeWebUrl(url).pipe(
                    Effect.map((result) => ({
                      probe: { pid, isWeb: result !== null, expiresAtMillis: 0 },
                      fresh: true,
                    })),
                  ),
            );
            batchProbes.set(identity, memoized);
            return [memoized] as const;
          }),
        )
        .pipe(Effect.flatMap(([probe]) => probe));
    };
    const probed = yield* Effect.forEach(
      groups,
      (group) =>
        Effect.gen(function* () {
          const probes: Array<readonly [string, WebProbeCacheEntry, boolean]> = [];
          let visibleUrl: string | null = null;
          for (const url of group.urls) {
            const key = webProbeCacheKey(url);
            const { probe, fresh } = yield* getProbe(url, group.server.pid);
            probes.push([key, probe, fresh]);
            if (probe.isWeb) {
              visibleUrl = url;
              break;
            }
          }
          return { group, probes, visibleUrl };
        }),
      { concurrency: WEB_PROBE_CONCURRENCY },
    );
    const completedAtMillis = yield* Clock.currentTimeMillis;
    const nextCache = new Map(
      [...cached].filter(([, probe]) => probe.expiresAtMillis > completedAtMillis),
    );
    const discovered: DiscoveredLocalServer[] = [];
    const configured = new Map<string, DiscoveredLocalServer>();
    for (const { group, probes, visibleUrl } of probed) {
      for (const [key, probe, fresh] of probes) {
        nextCache.set(
          key,
          fresh ? { ...probe, expiresAtMillis: completedAtMillis + WEB_PROBE_CACHE_TTL_MS } : probe,
        );
      }
      if (visibleUrl === null) continue;
      const server = { ...group.server, url: visibleUrl };
      if (group.configuredKey === null) discovered.push(server);
      else configured.set(group.configuredKey, server);
    }
    yield* Ref.set(webProbeCacheRef, nextCache);
    return { discovered, configured } satisfies WebProbeSnapshot;
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
            // A tasklist that timed out or would not spawn said nothing about
            // this pid. Dropping it from this round's results is what keeps it
            // out of the cache, so the next round probes it again. A tasklist
            // that ran and named nothing is an answer, and is cached as `null`.
            Effect.catch((cause) =>
              Effect.logDebug("tasklist failed for a listening pid", { cause, pid }).pipe(
                Effect.as(null),
              ),
            ),
          ),
      { concurrency: WINDOWS_PROCESS_NAME_CONCURRENCY },
    );
    const resolvedAt = yield* Clock.currentTimeMillis;
    const resolvedByPid = new Map(resolved.filter((entry) => entry !== null));
    // One read-modify-write, so two overlapping callers cannot lose each
    // other's lookups.
    return yield* Ref.modify(processNameCacheRef, (current) => {
      const next = new Map<number, ProcessNameEntry>();
      const names = new Map<number, string>();
      for (const pid of wanted) {
        const probed = resolvedByPid.get(pid);
        const existing = current.get(pid);
        // An expired entry that this round had no room to re-probe keeps its
        // old name. It stays expired, so it is still first in the queue for the
        // next round; dropping it instead would blink the label to null and back
        // on no new evidence, and every blink broadcasts and wakes the poll.
        const entry: ProcessNameEntry | undefined =
          probed === undefined
            ? existing
            : { name: probed, expiresAtMs: resolvedAt + PROCESS_NAME_TTL_MS };
        if (entry === undefined) continue;
        next.set(pid, entry);
        if (entry.name !== null) names.set(pid, entry.name);
      }
      return [names as ReadonlyMap<number, string>, next as ReadonlyMap<number, ProcessNameEntry>];
    });
  });

  const scanUnlocked = Effect.fn("PortDiscovery.scanUnlocked")(function* (
    configuredUrls: ReadonlyArray<string>,
  ) {
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
          Effect.map((result) => ({
            stdout: result.stdout,
            truncated: result.stdoutTruncated,
          })),
          Effect.catchTags({
            ProcessSpawnError: recoverWindowsProbeFailure,
            ProcessStdinError: recoverWindowsProbeFailure,
            ProcessOutputLimitError: recoverWindowsProbeFailure,
            ProcessReadError: recoverWindowsProbeFailure,
            ProcessTimeoutError: recoverWindowsProbeFailure,
          }),
        );
      if (raw === null) return yield* probeWebServers(yield* probeCommonPorts(), configuredUrls);
      const rows = parseWindowsListenerOutput(raw.stdout, { truncated: raw.truncated });
      const processNameByPid = yield* windowsProcessNames(
        rows.map((row) => row.pid).filter((pid): pid is number => pid !== null),
      );
      return yield* probeWebServers(
        windowsListenersToServers(rows, processNameByPid, terminalByProcessId),
        configuredUrls,
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
    if (lsofResult !== null) return yield* probeWebServers(lsofResult, configuredUrls);
    return yield* probeWebServers(yield* probeCommonPorts(), configuredUrls);
  });

  const scanSnapshot = Effect.fn("PortDiscovery.scanSnapshot")(
    (configuredUrls: ReadonlyArray<string>) =>
      scanSemaphore.withPermits(1)(scanUnlocked(configuredUrls)),
  );

  const scanOnce: PortDiscovery["Service"]["scan"] = (configuredUrls = []) => {
    const normalized = normalizeConfiguredUrls(configuredUrls);
    return scanSnapshot(normalized).pipe(
      Effect.map((snapshot) => projectWebProbeSnapshot(snapshot, normalized)),
    );
  };

  const pollTick = Effect.fn("PortDiscovery.pollTick")(
    function* () {
      if ((yield* Ref.get(stateRef)).retainCount <= 0) return;
      const configuredUrls = [
        ...new Set(
          [...(yield* Ref.get(stateRef)).listeners.values()].flatMap(
            (subscription) => subscription.configuredUrls,
          ),
        ),
      ];
      const snapshot = yield* scanSnapshot(configuredUrls);
      const notifications = yield* Ref.modify(stateRef, (state) => {
        const listeners = new Map(state.listeners);
        const changed: Array<readonly [Listener, ReadonlyArray<DiscoveredLocalServer>]> = [];
        for (const [listener, subscription] of listeners) {
          const next = projectWebProbeSnapshot(snapshot, subscription.configuredUrls);
          if (serversEqual(subscription.lastSnapshot, next)) continue;
          listeners.set(listener, { ...subscription, lastSnapshot: next });
          changed.push([listener, next]);
        }
        return [changed, { ...state, listeners }];
      });
      // A round that moved something means the host is not idle, so the poll
      // drops back to its base period rather than staying decayed.
      if (notifications.length > 0) poll.wakeUnsafe();
      yield* Effect.forEach(notifications, ([listener, servers]) => listener(servers), {
        discard: true,
      });
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
    (input, listener) =>
      Effect.acquireRelease(
        Ref.update(stateRef, (state) => {
          const listeners = new Map(state.listeners);
          listeners.set(listener, {
            configuredUrls: normalizeConfiguredUrls(input.configuredUrls),
            lastSnapshot: input.initialSnapshot,
          });
          return { ...state, listeners };
        }),
        () =>
          Ref.update(stateRef, (state) => {
            const listeners = new Map(state.listeners);
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
