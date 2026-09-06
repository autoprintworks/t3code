/**
 * Provider status probes obey the user's enabled flag.
 *
 * A probe spawns the provider's CLI, so it must only run for a provider the
 * user turned on. Two flags look like they could gate it:
 *
 *   - the **outer** flag on the `ProviderInstanceConfig` envelope, which is
 *     what the settings UI toggles, and
 *   - the **inner** `enabled` field inside the driver's own config payload.
 *
 * Only the outer flag gates a probe. The registry resolves it once and hands
 * it to `ProviderDriver.create`, which passes it to `makeManagedServerProvider`
 * as `isEnabled`.
 *
 * These tests boot the real drivers against a recording `ChildProcessSpawner`
 * and a recording `HttpClient`, so "was this provider probed?" is answered by
 * the process spawns and network calls the boot actually made, not by a stub.
 *
 * @module provider/Layers/ProviderStatusProbe.test
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AcpAgentSettings,
  type ClaudeSettings,
  type CodexSettings,
  type CursorSettings,
  type GrokSettings,
  type OpenCodeSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AcpAgentDriver } from "../acpAgent/AcpAgentDriver.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import { GrokDriver } from "../Drivers/GrokDriver.ts";
import { OpenCodeDriver } from "../Drivers/OpenCodeDriver.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import type { ProviderInstanceRegistryShape } from "../Services/ProviderInstanceRegistry.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const DRIVERS = [
  CodexDriver,
  ClaudeDriver,
  CursorDriver,
  GrokDriver,
  OpenCodeDriver,
  AcpAgentDriver,
];

const CODEX_ID = ProviderInstanceId.make("codex_default");
const CLAUDE_ID = ProviderInstanceId.make("claude_default");
const CURSOR_ID = ProviderInstanceId.make("cursor_default");
const GROK_ID = ProviderInstanceId.make("grok_default");
const OPENCODE_ID = ProviderInstanceId.make("opencode_default");
const ACP_AGENT_ID = ProviderInstanceId.make("acp_agent_default");

const ACP_AGENT_COMMAND = "t3-probe-test-acp-agent";

/**
 * Everything a probe would have to touch to reach the outside world, recorded
 * so a test can say "nothing ran" or "only this one ran".
 *
 * `firstSpawn` is the latch a positive test waits on: the probe runs on a
 * forked fiber, so the test has to wait for the spawn rather than assume it.
 */
interface ProbeLog {
  readonly spawns: Array<string>;
  readonly httpRequests: Array<string>;
  readonly firstSpawn: Deferred.Deferred<string>;
}

const makeProbeLog = (): ProbeLog => ({
  spawns: [],
  httpRequests: [],
  firstSpawn: Deferred.makeUnsafe<string>(),
});

const describeCommand = (command: ChildProcess.Command): string =>
  ChildProcess.isStandardCommand(command)
    ? [command.command, ...command.args].join(" ")
    : JSON.stringify(command);

/**
 * A spawner that records the command and then refuses to start it. Every
 * driver treats a failed spawn as "CLI not installed", which is a complete
 * probe result, so the probe finishes fast instead of waiting for its timeout.
 */
const makeSpawnerLayer = (log: ProbeLog) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const described = describeCommand(command);
        log.spawns.push(described);
        yield* Deferred.succeed(log.firstSpawn, described).pipe(Effect.ignore);
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcessSpawner",
          method: "spawn",
          pathOrDescriptor: described,
        });
      }),
    ),
  );

const makeHttpClientLayer = (log: ProbeLog) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        log.httpRequests.push(request.url);
        return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
      }),
    ),
  );

// `OpenCodeDriver.create` yields `OpenCodeRuntime`, which needs the spawner,
// so the recording spawner has to be in place beneath it. `Layer.merge` lets
// the recording spawner win over the one `NodeServices.layer` ships.
const makeTestLayer = (log: ProbeLog) => {
  const infraLayer = OpenCodeRuntimeLive.pipe(
    Layer.provideMerge(Layer.merge(NodeServices.layer, makeSpawnerLayer(log))),
  );
  return ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-status-probe-test",
  }).pipe(
    Layer.provideMerge(infraLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(makeHttpClientLayer(log)),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  );
};

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  ...overrides,
});

const makeCursorConfig = (overrides: Partial<CursorSettings>): CursorSettings => ({
  enabled: false,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
  ...overrides,
});

const makeGrokConfig = (overrides: Partial<GrokSettings>): GrokSettings => ({
  enabled: false,
  binaryPath: "grok",
  customModels: [],
  ...overrides,
});

const makeOpenCodeConfig = (overrides: Partial<OpenCodeSettings>): OpenCodeSettings => ({
  enabled: false,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
  ...overrides,
});

const makeAcpAgentConfig = (overrides: Partial<AcpAgentSettings>): AcpAgentSettings => ({
  enabled: false,
  command: ACP_AGENT_COMMAND,
  args: "--acp",
  workingDirectory: "",
  icon: "",
  authMethodId: "",
  customModels: [],
  ...overrides,
});

/**
 * One instance of every shipped driver.
 *
 * `outerEnabled` is the envelope flag the settings UI toggles.
 * `innerEnabled` is the driver config's own flag, which must never decide
 * whether a probe runs.
 */
const makeConfigMap = (input: {
  readonly outerEnabled: ReadonlyArray<ProviderInstanceId>;
  readonly innerEnabled?: boolean;
}): ProviderInstanceConfigMap => {
  const innerEnabled = input.innerEnabled ?? false;
  const outer = (instanceId: ProviderInstanceId) => input.outerEnabled.includes(instanceId);
  return {
    [CODEX_ID]: {
      driver: ProviderDriverKind.make("codex"),
      enabled: outer(CODEX_ID),
      config: makeCodexConfig({ enabled: innerEnabled }),
    },
    [CLAUDE_ID]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: outer(CLAUDE_ID),
      config: makeClaudeConfig({ enabled: innerEnabled }),
    },
    [CURSOR_ID]: {
      driver: ProviderDriverKind.make("cursor"),
      enabled: outer(CURSOR_ID),
      config: makeCursorConfig({ enabled: innerEnabled }),
    },
    [GROK_ID]: {
      driver: ProviderDriverKind.make("grok"),
      enabled: outer(GROK_ID),
      config: makeGrokConfig({ enabled: innerEnabled }),
    },
    [OPENCODE_ID]: {
      driver: ProviderDriverKind.make("opencode"),
      enabled: outer(OPENCODE_ID),
      config: makeOpenCodeConfig({ enabled: innerEnabled }),
    },
    [ACP_AGENT_ID]: {
      driver: ProviderDriverKind.make("acpAgent"),
      enabled: outer(ACP_AGENT_ID),
      config: makeAcpAgentConfig({ enabled: innerEnabled }),
    },
  };
};

/**
 * Force one complete snapshot pass on every instance.
 *
 * `refresh` runs the same gated pass the startup probe runs, and it waits for
 * it, so once this returns every instance has been through the decision at
 * least once. That makes "no spawn was recorded" a statement about work that
 * finished rather than about work that has not started yet.
 */
const settleEverySnapshot = (registry: ProviderInstanceRegistryShape) =>
  Effect.gen(function* () {
    const instances = yield* registry.listInstances;
    yield* Effect.forEach(instances, (instance) => instance.snapshot.refresh, {
      concurrency: "unbounded",
      discard: true,
    });
    return instances;
  });

const awaitFirstSpawn = (log: ProbeLog) =>
  Deferred.await(log.firstSpawn).pipe(Effect.timeout("30 seconds"));

describe("provider status probes honour the enabled flag", () => {
  it.live("probes nothing when every provider instance is off", () => {
    const log = makeProbeLog();
    return Effect.gen(function* () {
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: DRIVERS,
        configMap: makeConfigMap({ outerEnabled: [] }),
      });

      const instances = yield* settleEverySnapshot(registry);
      expect(instances).toHaveLength(6);

      for (const instance of instances) {
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(snapshot.enabled).toBe(false);
        // Skipping the probe must not leave the provider stuck on a pending
        // snapshot: the user still gets told the provider is off.
        expect(snapshot.message).toContain("disabled in T3 Code settings.");
      }

      expect(log.spawns).toEqual([]);
      expect(log.httpRequests).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer(log)));
  });

  it.live("probes only the one provider the user turned on", () => {
    const log = makeProbeLog();
    return Effect.gen(function* () {
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: DRIVERS,
        // Codex is on at the envelope while its driver config says `enabled:
        // false`, so a probe here also proves the inner flag does not gate.
        configMap: makeConfigMap({ outerEnabled: [CODEX_ID], innerEnabled: false }),
      });

      yield* awaitFirstSpawn(log);
      yield* settleEverySnapshot(registry);

      expect(log.spawns.length).toBeGreaterThan(0);
      for (const spawn of log.spawns) {
        expect(spawn).toContain("codex");
      }

      const codex = yield* registry.getInstance(CODEX_ID);
      expect((yield* codex!.snapshot.getSnapshot).enabled).toBe(true);

      for (const instanceId of [CLAUDE_ID, CURSOR_ID, GROK_ID, OPENCODE_ID, ACP_AGENT_ID]) {
        const instance = yield* registry.getInstance(instanceId);
        expect((yield* instance!.snapshot.getSnapshot).enabled).toBe(false);
      }
    }).pipe(Effect.provide(makeTestLayer(log)));
  });

  it.live("probes nothing when the outer flag is off and the driver config flag is on", () => {
    const log = makeProbeLog();
    return Effect.gen(function* () {
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: DRIVERS,
        configMap: makeConfigMap({ outerEnabled: [], innerEnabled: true }),
      });

      const instances = yield* settleEverySnapshot(registry);
      for (const instance of instances) {
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(snapshot.enabled).toBe(false);
        expect(snapshot.message).toContain("disabled in T3 Code settings.");
      }

      expect(log.spawns).toEqual([]);
      expect(log.httpRequests).toEqual([]);
    }).pipe(Effect.provide(makeTestLayer(log)));
  });

  it.live("probes an external ACP agent only once its outer flag is on", () => {
    const log = makeProbeLog();
    return Effect.gen(function* () {
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: DRIVERS,
        configMap: makeConfigMap({ outerEnabled: [ACP_AGENT_ID], innerEnabled: false }),
      });

      yield* awaitFirstSpawn(log);
      yield* settleEverySnapshot(registry);

      expect(log.spawns.length).toBeGreaterThan(0);
      for (const spawn of log.spawns) {
        expect(spawn).toContain(ACP_AGENT_COMMAND);
      }
    }).pipe(Effect.provide(makeTestLayer(log)));
  });

  it.live("probes a provider after a settings change turns it on", () => {
    const log = makeProbeLog();
    return Effect.gen(function* () {
      const { registry, mutator } = yield* makeProviderInstanceRegistry({
        drivers: DRIVERS,
        configMap: makeConfigMap({ outerEnabled: [] }),
      });

      yield* settleEverySnapshot(registry);
      expect(log.spawns).toEqual([]);

      // The settings change: the user turns Codex on.
      yield* mutator.reconcile(makeConfigMap({ outerEnabled: [CODEX_ID] }));

      yield* awaitFirstSpawn(log);
      yield* settleEverySnapshot(registry);

      expect(log.spawns.length).toBeGreaterThan(0);
      for (const spawn of log.spawns) {
        expect(spawn).toContain("codex");
      }

      const codex = yield* registry.getInstance(CODEX_ID);
      expect((yield* codex!.snapshot.getSnapshot).enabled).toBe(true);
    }).pipe(Effect.provide(makeTestLayer(log)));
  });
});
