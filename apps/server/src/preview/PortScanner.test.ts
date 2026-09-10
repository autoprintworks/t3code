import * as NodeNet from "node:net";

import { it as effectIt } from "@effect/vitest";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  ThreadId,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { FetchHttpClient } from "effect/unstable/http";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const processProbeFailure: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
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
  );

const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: processProbeFailure,
});

let integrationListeningPort: number | null = null;

const TestIntegrationNet = Layer.succeed(Net.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: (port) => Effect.sync(() => port !== integrationListeningPort),
  hasListenerOnHost: (port) => Effect.sync(() => port === integrationListeningPort),
  reserveLoopbackPort: () => Effect.succeed(40_000),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

const makeProbeFailureLayer = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProcessRunner,
      TestIntegrationNet,
      Layer.succeed(HostProcessPlatform, "win32"),
      FetchHttpClient.layer,
    ),
  ),
);

const LSOF_TEST_PORT = 43_123;

const makeLsofScannerLayer = (input: {
  readonly pid: () => number;
  readonly fetch: typeof globalThis.fetch;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

const openServer = (
  port: number,
  onConnection: (socket: NodeNet.Socket) => void,
): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer(onConnection);
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
  onConnection: (socket: NodeNet.Socket) => void,
) {
  for (const port of ports) {
    const server = yield* openServer(port, onConnection);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS, (socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello");
    });
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);

const commonNonHttpServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS.toReversed(), (socket) => {
    socket.on("error", () => undefined);
    socket.once("data", () => socket.end("MYSQL\r\n\r\n"));
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns an HTTP server we just opened on a curated dev port",
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
    "scan() excludes a listening port that does not speak HTTP",
    Effect.fn("PortScannerTest.scanExcludesNonHttpServer")(function* () {
      const { port } = yield* commonNonHttpServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      expect(result.some((server) => server.port === port)).toBe(false);
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe({ configuredUrls: [], initialSnapshot: [] }, (servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt.effect("revalidates a successful HTML probe after its cache entry expires", () => {
  let responds = true;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toEqual([`http://localhost:${LSOF_TEST_PORT}/`]);

    responds = false;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("keeps a full configured URL when the discovered server root fails", () => {
  const requests: string[] = [];
  const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === configuredUrl
        ? new Response("docs", { headers: { "content-type": "text/html" } })
        : new Response("not found", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(configuredUrl);
    expect(requests).toContain(configuredUrl);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("probes configured custom ports through a canonical loopback host", () => {
  const customPort = 43_124;
  const configuredUrl = `http://0.0.0.0:${customPort}/docs`;
  const expectedUrl = `http://localhost:${customPort}/docs`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.host).toBe("localhost");
    expect(servers[0]?.port).toBe(customPort);
    expect(servers[0]?.url).toBe(expectedUrl);
    expect(requests).toEqual([expectedUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("preserves explicit loopback hosts and bounds wildcard rewrites", () => {
  const ipv4Url = "https://127.0.0.1:43125/docs";
  const ipv6Url = "http://[::1]:43126/docs";
  const wildcardPrefix = "http://0.0.0.0/";
  const maximumWildcardUrl = `${wildcardPrefix}${"a".repeat(
    PREVIEW_URL_MAX_LENGTH - wildcardPrefix.length,
  )}`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([ipv4Url, ipv6Url, maximumWildcardUrl]);
    expect(servers.map((server) => server.url)).toEqual([ipv4Url, ipv6Url]);
    expect(requests).toEqual([ipv4Url, ipv6Url]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("projects configured paths independently for simultaneous subscribers", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    const adminSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    yield* scanner.subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => docsSnapshots.push(servers)),
    );
    yield* scanner.subscribe({ configuredUrls: [adminUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => adminSnapshots.push(servers)),
    );
    yield* scanner.retain;

    expect(docsSnapshots.at(-1)?.[0]?.url).toBe(docsUrl);
    expect(adminSnapshots.at(-1)?.[0]?.url).toBe(adminUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect(
  "keeps each subscriber's candidates when their combined union exceeds the per-client cap",
  () => {
    const firstSubscriberUrls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:${LSOF_TEST_PORT}/app-${index}`,
    );
    const secondSubscriberUrl = `http://localhost:${LSOF_TEST_PORT}/app-${CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS}`;
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(
        String(input) === secondSubscriberUrl
          ? new Response("app", { headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404 }),
      )) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const secondSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
      yield* scanner.subscribe(
        { configuredUrls: firstSubscriberUrls, initialSnapshot: [] },
        () => Effect.void,
      );
      yield* scanner.subscribe(
        { configuredUrls: [secondSubscriberUrl], initialSnapshot: [] },
        (servers) => Effect.sync(() => secondSnapshots.push(servers)),
      );
      yield* scanner.retain;

      expect(secondSnapshots.at(-1)?.[0]?.url).toBe(secondSubscriberUrl);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

effectIt.effect("stops probing a subscriber's configured paths after its scope closes", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsScope = yield* Scope.make();
    yield* scanner
      .subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, () => Effect.void)
      .pipe(Effect.provideService(Scope.Scope, docsScope));
    yield* scanner.subscribe(
      { configuredUrls: [adminUrl], initialSnapshot: [] },
      () => Effect.void,
    );
    yield* scanner.retain;
    yield* Scope.close(docsScope, Exit.void);

    requests.length = 0;
    // The fork's poll backs off while nothing changes, so rounds are spaced 3,
    // 6 then 12 seconds apart rather than every 3. Advance past a full backed-off
    // cycle so at least one round lands after the web probe cache expires.
    yield* TestClock.adjust(Duration.seconds(60));
    expect(requests).toContain(adminUrl);
    expect(requests).not.toContain(docsUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect("uses the current configured fragment when readiness comes from cache", () => {
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });
  const oldUrl = `http://localhost:${LSOF_TEST_PORT}/docs#old`;
  const newUrl = `http://localhost:${LSOF_TEST_PORT}/docs#new`;

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect((yield* scanner.scan([oldUrl]))[0]?.url).toBe(oldUrl);
    const requestCount = requests.length;
    expect((yield* scanner.scan([newUrl]))[0]?.url).toBe(newUrl);
    expect(requests).toHaveLength(requestCount);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("shares a configured root probe with discovered-root classification", () => {
  const requests: string[] = [];
  const rootUrl = `http://localhost:${LSOF_TEST_PORT}/`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan([rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl]);

    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan([rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl, rootUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("starts fresh cache entries after the probing batch completes", () =>
  Effect.gen(function* () {
    const baseClock = yield* Clock.Clock;
    const times = [0, 20_000, 20_000, 20_000];
    let timeIndex = 0;
    const currentTimeMillis = () => times[Math.min(timeIndex++, times.length - 1)]!;
    const clock: Clock.Clock = {
      ...baseClock,
      currentTimeMillisUnsafe: currentTimeMillis,
      currentTimeMillis: Effect.sync(currentTimeMillis),
    };
    const requests: string[] = [];
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan()).toHaveLength(1);
      expect(yield* scanner.scan()).toHaveLength(1);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
  }),
);

effectIt.effect("caches a failed web probe until its bounded cache entry expires", () => {
  let responds = false;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toHaveLength(2);

    responds = true;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toHaveLength(3);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("falls back to HTTPS and does not follow redirects while probing", () => {
  const redirects: Array<string | undefined> = [];
  const fetchFn = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    redirects.push(init?.redirect);
    if (String(input).startsWith("http:")) throw new TypeError("TLS listener");
    return new Response(null, { status: 302, headers: { location: "https://example.com" } });
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(`https://localhost:${LSOF_TEST_PORT}`);
    expect(redirects).toEqual(["manual", "manual"]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "excludes HTTP errors, non-navigation responses, and successful non-documents",
  () => {
    let pid = 1;
    let makeResponse = () =>
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const fetchFn = ((_input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(makeResponse())) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => pid, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("ready", { status: 200, headers: { "content-type": "text/plain" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 304, headers: { location: "/cached" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response(null, { status: 204, headers: { "content-type": "text/html" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 302 });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("<html />", {
          status: 200,
          headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
        });
      expect(yield* scanner.scan()).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("aborts HTTP and HTTPS probes when they time out", () => {
  const aborted: string[] = [];
  const fetchFn = ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        aborted.push(String(input));
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    })) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const scanFiber = yield* Effect.forkChild(scanner.scan());
    yield* TestClock.adjust(Duration.seconds(2));
    expect(yield* Fiber.join(scanFiber)).toHaveLength(0);
    expect(aborted).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ]);
  }).pipe(Effect.provide(layer));
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
    const ports = PortScanner.parseWindowsListenerOutput(truncated, { truncated: true }).map(
      (row) => row.port,
    );
    // 517 is what the row would read as if the tail were parsed anyway.
    expect(ports).toEqual([135, 1042, 7679]);
  });

  it("keeps the last row when the output has no trailing newline", () => {
    const complete = `${netstatFixture}  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242`;
    const rows = PortScanner.parseWindowsListenerOutput(complete);
    expect(rows.find((row) => row.port === 5173)).toEqual({ port: 5173, pid: 4242 });
  });

  it("reads the pid when the localised state word contains a space", () => {
    // Italian Windows prints LISTENING as "IN ASCOLTO", which splits into two
    // columns, so the pid is not the fifth field.
    const localised =
      "  TCP    127.0.0.1:5173         0.0.0.0:0              IN ASCOLTO      4242\r\n";
    expect(PortScanner.parseWindowsListenerOutput(localised)).toEqual([{ port: 5173, pid: 4242 }]);
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
  /** Asked before each tasklist run; true makes that run fail to spawn. */
  readonly tasklistFails?: () => boolean;
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
              if (input.command === "tasklist.exe" && options.tasklistFails?.() === true) {
                return yield* new ProcessRunner.ProcessTimeoutError({
                  command: input.command,
                  argumentCount: input.args.length,
                  cwd: input.cwd,
                  timeoutMs: 500,
                });
              }
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
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
        Net.layer,
        Layer.succeed(HostProcessPlatform, "win32"),
        // These tests count spawned processes, so the web probe must never reach
        // the network. It still has to answer as a web server: `scan` returns
        // only the listeners the probe confirmed, so a refused probe would empty
        // the snapshot these tests read.
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, ((
              _input: Parameters<typeof globalThis.fetch>[0],
            ) =>
              Promise.resolve(
                new Response("app", { headers: { "content-type": "text/html" } }),
              )) as typeof globalThis.fetch),
          ),
        ),
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

effectIt.effect("does not cache a name for a pid whose tasklist run failed", () =>
  Effect.gen(function* () {
    const runs: string[] = [];
    let failing = true;
    const layer = recordingWindowsLayer(runs, { tasklistFails: () => failing });

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const first = yield* scanner.scan();
      expect(first.map((server) => server.processName)).toEqual([null, null, null]);
      expect(countOf(runs, "tasklist.exe")).toBe(3);

      // A tasklist that failed said nothing about the pid, so the next scan asks
      // again instead of serving "unnameable" from the cache for a minute.
      failing = false;
      const second = yield* scanner.scan();
      expect(countOf(runs, "tasklist.exe")).toBe(6);
      expect(second.map((server) => server.processName)).toEqual(["node", "node", "node"]);
    }).pipe(Effect.provide(layer));
  }),
);

effectIt.effect("keeps an expired name until a probe replaces it", () =>
  Effect.gen(function* () {
    const runs: string[] = [];
    // Twenty listeners against a batch cap of eight, so a scan can never
    // re-probe every expired entry.
    const rows = Array.from(
      { length: 20 },
      (_, index) =>
        `  TCP    127.0.0.1:${9000 + index}         0.0.0.0:0              LISTENING       ${1000 + index}`,
    );
    const layer = recordingWindowsLayer(runs, { netstatStdout: `${rows.join("\r\n")}\r\n` });

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.scan();
      yield* scanner.scan();
      const third = yield* scanner.scan();
      expect(countOf(runs, "tasklist.exe")).toBe(20);
      expect(third.filter((server) => server.processName === null)).toEqual([]);

      // Every entry is past its lifetime now, and this scan can re-probe only
      // eight of them. The other twelve keep the name they already had: no name
      // goes from a string to null without a probe that says so.
      yield* TestClock.adjust("61 seconds");
      const fourth = yield* scanner.scan();
      expect(countOf(runs, "tasklist.exe")).toBe(28);
      expect(fourth.map((server) => server.processName)).toEqual(
        third.map((server) => server.processName),
      );
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
