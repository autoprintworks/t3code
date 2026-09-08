import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
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

effectIt("does not swallow process probe defects", () =>
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

effectIt("does not swallow process probe interruption", () =>
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

const netstatFixture = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2352",
  "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242",
  "  TCP    127.0.0.1:5173         127.0.0.1:53124        ESTABLISHED     4242",
  "  TCP    192.168.1.20:139       0.0.0.0:0              LISTENING       4",
  "  TCP    [::1]:8080             [::]:0                 ABHOEREN        777",
].join("\r\n");

describe("parseWindowsListenerOutput", () => {
  it("recognises listeners without reading the localised state word", () => {
    const servers = PortScanner.parseWindowsListenerOutput(netstatFixture);
    expect(servers.map((server) => server.port)).toEqual([135, 5173, 8080]);
    expect(servers.map((server) => server.pid)).toEqual([2352, 4242, 777]);
    expect(servers.every((server) => server.host === "localhost")).toBe(true);
  });

  it("ignores established rows and non-local bind addresses", () => {
    const ports = PortScanner.parseWindowsListenerOutput(netstatFixture).map(
      (server) => server.port,
    );
    expect(ports).not.toContain(53_124);
    expect(ports).not.toContain(139);
  });

  it("attaches the owning terminal by process id", () => {
    const [server] = PortScanner.parseWindowsListenerOutput(
      "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242",
      new Map([
        [4242, { threadId: ThreadId.make("thread_1"), terminalId: "term_1", title: "dev" }],
      ]),
    );
    expect(server?.terminal?.terminalId).toBe("term_1");
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

effectIt("spawns one netstat per scan and caches tasklist names across scans", () =>
  Effect.gen(function* () {
    const runs: string[] = [];
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) => {
              runs.push(`${input.command} ${input.args.join(" ")}`);
              const stdout =
                input.command === "netstat.exe"
                  ? netstatFixture
                  : `"node.exe","${/PID eq (\d+)/.exec(input.args.join(" "))?.[1] ?? "0"}","Console","1","51,204 K"`;
              return Effect.succeed({
                stdout,
                stderr: "",
                code: 0 as never,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              });
            },
          }),
          Net.layer,
          Layer.succeed(HostProcessPlatform, "win32"),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const first = yield* scanner.scan();
      expect(first.map((server) => server.processName)).toEqual(["node", "node", "node"]);
      expect(runs.filter((run) => run.startsWith("netstat.exe"))).toHaveLength(1);
      expect(runs.filter((run) => run.startsWith("tasklist.exe"))).toHaveLength(3);

      yield* scanner.scan();
      // Second round: one more netstat, and no tasklist at all because every
      // listener pid is already in the name cache.
      expect(runs.filter((run) => run.startsWith("netstat.exe"))).toHaveLength(2);
      expect(runs.filter((run) => run.startsWith("tasklist.exe"))).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  }),
);
