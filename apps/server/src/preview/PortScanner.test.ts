import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: (input) =>
    Effect.fail(
      new ProcessRunner.ProcessSpawnError({
        command: input.command,
        argumentCount: input.args.length,
        cwd: input.cwd,
        cause: PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "PowerShell is not installed in the test environment",
        }),
      }),
    ),
});

const makeProbeFailureLayer = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(TestProcessRunner, Net.layer, Layer.succeed(HostProcessPlatform, "win32")),
  ),
);

const openServer = (port: number): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer();
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
) {
  for (const port of ports) {
    const server = yield* openServer(port);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS),
  ({ server }) => closeServer(server),
);

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns a server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe((servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt.effect("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = makeProbeFailureLayer(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt.effect("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = makeProbeFailureLayer(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);

// Appended below the existing suites so the Windows test-suite work in issue 80
// can move the blocks above without conflicting with these.

/**
 * Captured from `netstat.exe -ano` on the development machine (Windows 11 Pro
 * 26200) and trimmed to the interesting rows, verbatim otherwise. Port 7679
 * listens on IPv6 only and appears nowhere in the IPv4 table, so it is exactly
 * the listener the old `-p TCP` probe could not see.
 */
const netstatFixture = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2352",
  "  TCP    127.0.0.1:1042         0.0.0.0:0              LISTENING       21072",
  "  TCP    127.0.0.1:1042         127.0.0.1:49807        ESTABLISHED     21072",
  "  TCP    192.168.1.150:139      0.0.0.0:0              LISTENING       4",
  "  TCP    [::1]:7679             [::]:0                 LISTENING       7036",
  "  UDP    0.0.0.0:3702           *:*                                    7276",
  "",
].join("\r\n");

describe("splitWindowsAddress", () => {
  it("splits an IPv4 address", () => {
    expect(PortScanner.splitWindowsAddress("127.0.0.1:5173")).toEqual({
      host: "127.0.0.1",
      port: 5173,
    });
  });

  it("unwraps the brackets around an IPv6 host", () => {
    expect(PortScanner.splitWindowsAddress("[::1]:8080")).toEqual({ host: "::1", port: 8080 });
    expect(PortScanner.splitWindowsAddress("[::]:0")).toEqual({ host: "::", port: 0 });
  });

  it("rejects a value with no port, or a port out of range", () => {
    expect(PortScanner.splitWindowsAddress("127.0.0.1")).toBe(null);
    expect(PortScanner.splitWindowsAddress("127.0.0.1:")).toBe(null);
    expect(PortScanner.splitWindowsAddress("127.0.0.1:70000")).toBe(null);
    expect(PortScanner.splitWindowsAddress("*:*")).toBe(null);
  });
});

describe("parseWindowsListenerOutput", () => {
  it("recognises listeners without reading the localised state word", () => {
    const rows = PortScanner.parseWindowsListenerOutput(netstatFixture);
    expect(rows.map((row) => row.port)).toEqual([135, 1042, 7679]);
    expect(rows.map((row) => row.pid)).toEqual([2352, 21072, 7036]);
  });

  it("sees a listener that exists on IPv6 only", () => {
    const rows = PortScanner.parseWindowsListenerOutput(netstatFixture);
    expect(rows.find((row) => row.port === 7679)).toEqual({ port: 7679, pid: 7036 });
  });

  it("ignores established rows, UDP rows, and non-local bind addresses", () => {
    const ports = PortScanner.parseWindowsListenerOutput(netstatFixture).map((row) => row.port);
    expect(ports).not.toContain(49_807);
    expect(ports).not.toContain(3702);
    expect(ports).not.toContain(139);
  });

  it("drops a final row that the output cap cut short", () => {
    const truncated = `${netstatFixture}  TCP    127.0.0.1:517`;
    const ports = PortScanner.parseWindowsListenerOutput(truncated).map((row) => row.port);
    // 517 is what the row would read as if the tail were parsed anyway.
    expect(ports).toEqual([135, 1042, 7679]);
  });
});

describe("windowsListenersToServers", () => {
  it("joins the netstat rows to their process name and owning terminal", () => {
    const servers = PortScanner.windowsListenersToServers(
      [
        { port: 5173, pid: 4242 },
        { port: 8080, pid: null },
      ],
      new Map([[4242, "node"]]),
      new Map([[4242, { threadId: ThreadId.make("thread_1"), terminalId: "term_1" }]]),
    );
    expect(servers[0]).toEqual({
      host: "localhost",
      port: 5173,
      url: "http://localhost:5173",
      processName: "node",
      pid: 4242,
      terminal: { threadId: "thread_1", terminalId: "term_1" },
    });
    expect(servers[1]?.processName).toBe(null);
    expect(servers[1]?.terminal).toBe(null);
  });
});

describe("parseTasklistProcessName", () => {
  it("reads the image name out of a csv row and drops the .exe", () => {
    expect(PortScanner.parseTasklistProcessName('"node.exe","4242","Console","1","51,204 K"')).toBe(
      "node",
    );
  });

  it("returns null when tasklist found no match", () => {
    expect(
      PortScanner.parseTasklistProcessName(
        "INFO: No tasks are running which match the specified criteria.",
      ),
    ).toBe(null);
  });
});

interface FakeRunnerOptions {
  readonly netstatStdout?: string;
  readonly tasklistStdout?: (pid: string) => string;
  /** Held by every netstat run, so a scan can be parked mid-flight. */
  readonly gate?: Latch.Latch;
}

const recordingWindowsLayer = (runs: string[], options: FakeRunnerOptions = {}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) =>
            Effect.gen(function* () {
              runs.push(`${input.command} ${input.args.join(" ")}`);
              if (input.command === "netstat.exe" && options.gate !== undefined) {
                yield* Latch.await(options.gate);
              }
              const pid = /PID eq (\d+)/.exec(input.args.join(" "))?.[1] ?? "0";
              return {
                stdout:
                  input.command === "netstat.exe"
                    ? (options.netstatStdout ?? netstatFixture)
                    : (options.tasklistStdout?.(pid) ??
                      `"node.exe","${pid}","Console","1","51,204 K"`),
                stderr: "",
                code: 0 as never,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        }),
        Net.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
      ),
    ),
  );

const countOf = (runs: ReadonlyArray<string>, command: string): number =>
  runs.filter((run) => run.startsWith(command)).length;

effectIt.effect("spawns one netstat per scan and caches tasklist names across scans", () =>
  Effect.gen(function* () {
    const runs: string[] = [];
    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const first = yield* scanner.scan();
      expect(first.map((server) => server.processName)).toEqual(["node", "node", "node"]);
      expect(countOf(runs, "netstat.exe")).toBe(1);
      expect(countOf(runs, "tasklist.exe")).toBe(3);

      yield* scanner.scan();
      // Second round: one more netstat, and no tasklist at all because every
      // listener pid is already in the name cache.
      expect(countOf(runs, "netstat.exe")).toBe(2);
      expect(countOf(runs, "tasklist.exe")).toBe(3);
    }).pipe(Effect.provide(recordingWindowsLayer(runs)));
  }),
);

effectIt.effect("re-probes a name once its cache entry has aged out", () =>
  Effect.gen(function* () {
    const runs: string[] = [];
    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.scan();
      expect(countOf(runs, "tasklist.exe")).toBe(3);

      // Just under the entry lifetime: still cached, so still no lookups.
      yield* TestClock.adjust("59 seconds");
      yield* scanner.scan();
      expect(countOf(runs, "tasklist.exe")).toBe(3);

      // Past it: a pid Windows may since have handed to another process is
      // looked up again rather than trusted forever.
      yield* TestClock.adjust("2 seconds");
      yield* scanner.scan();
      expect(countOf(runs, "tasklist.exe")).toBe(6);
    }).pipe(Effect.provide(recordingWindowsLayer(runs)));
  }),
);

effectIt.effect("caches the pids tasklist cannot name, so they are not re-probed every scan", () =>
  Effect.gen(function* () {
    const runs: string[] = [];
    const layer = recordingWindowsLayer(runs, {
      tasklistStdout: () => "INFO: No tasks are running which match the specified criteria.",
    });
    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const first = yield* scanner.scan();
      expect(first.map((server) => server.processName)).toEqual([null, null, null]);
      expect(countOf(runs, "tasklist.exe")).toBe(3);

      yield* scanner.scan();
      expect(countOf(runs, "tasklist.exe")).toBe(3);
    }).pipe(Effect.provide(layer));
  }),
);

effectIt.effect(
  "resolves at most one batch of names per scan and finishes the rest next scan",
  () =>
    Effect.gen(function* () {
      const runs: string[] = [];
      // Twenty listeners on twenty pids, against a batch cap of eight.
      const rows = Array.from(
        { length: 20 },
        (_, index) =>
          `  TCP    127.0.0.1:${9000 + index}         0.0.0.0:0              LISTENING       ${1000 + index}`,
      );
      const layer = recordingWindowsLayer(runs, { netstatStdout: `${rows.join("\r\n")}\r\n` });

      yield* Effect.gen(function* () {
        const scanner = yield* PortScanner.PortDiscovery;
        const first = yield* scanner.scan();
        expect(first).toHaveLength(20);
        expect(countOf(runs, "tasklist.exe")).toBe(8);
        expect(first.filter((server) => server.processName !== null)).toHaveLength(8);

        yield* scanner.scan();
        expect(countOf(runs, "tasklist.exe")).toBe(16);
        const third = yield* scanner.scan();
        expect(countOf(runs, "tasklist.exe")).toBe(20);
        expect(third.filter((server) => server.processName !== null)).toHaveLength(20);
      }).pipe(Effect.provide(layer));
    }),
);

effectIt.effect("a retainer arriving mid-scan is served as soon as that scan ends", () =>
  Effect.gen(function* () {
    const runs: string[] = [];
    const gate = yield* Latch.make(true);
    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;

      // First retainer: the gate is open, so its scan completes inline.
      const firstScope = yield* Scope.make();
      yield* scanner.retain.pipe(Effect.provideService(Scope.Scope, firstScope));
      expect(countOf(runs, "netstat.exe")).toBe(1);

      // Park the poll loop's next round mid-scan.
      yield* Latch.close(gate);
      yield* TestClock.adjust("3 seconds");
      expect(countOf(runs, "netstat.exe")).toBe(2);

      // That retainer leaves and a new one arrives while the scan is still in
      // flight. Its scan is queued behind the one running, not dropped.
      yield* Scope.close(firstScope, Exit.void);
      const secondScope = yield* Scope.make();
      // `startImmediately` runs the new retainer up to its first parking point
      // before control comes back here, so the assertion below sees the state
      // it reached rather than a scheduling accident.
      const arriving = yield* Effect.forkChild(
        scanner.retain.pipe(Effect.provideService(Scope.Scope, secondScope)),
        { startImmediately: true },
      );
      expect(countOf(runs, "netstat.exe")).toBe(2);

      // No clock movement from here: the new retainer is served by the end of
      // the scan in flight, not by the next period.
      yield* Latch.open(gate);
      yield* Fiber.join(arriving).pipe(Effect.orDie);
      expect(countOf(runs, "netstat.exe")).toBe(3);
      yield* Scope.close(secondScope, Exit.void);
    }).pipe(Effect.provide(recordingWindowsLayer(runs, { gate })));
  }),
);
