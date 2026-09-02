/**
 * `ProviderDriver` for an external agent that speaks the Agent Client Protocol.
 *
 * Every other driver in this repository is one agent: it knows the executable,
 * the arguments, and the name to show. This one knows none of those. It reads
 * them from the instance's settings, which is what lets a user point T3 Code at
 * an ACP agent this build has never heard of without a code change.
 *
 * Several instances can be configured, and each is a separate agent with its
 * own command line, its own models and its own sessions. The one shape that is
 * refused is two enabled instances that would start the *same* agent; see
 * `./AcpAgentIdentity.ts`.
 *
 * @module provider/acpAgent/AcpAgentDriver
 */
import { ACP_AGENT_DRIVER_KIND, AcpAgentSettings, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeAcpAgentAdapter } from "./AcpAgentAdapter.ts";
import {
  type AcpAgentIdentity,
  acpAgentIdentityKey,
  describeAcpAgentIdentity,
  resolveAcpAgentIdentity,
} from "./AcpAgentIdentity.ts";
import {
  buildInitialAcpAgentProviderSnapshot,
  checkAcpAgentProviderStatus,
  enrichAcpAgentSnapshot,
} from "./AcpAgentProvider.ts";
import { makeAcpAgentTextGeneration } from "./AcpAgentTextGeneration.ts";

const decodeAcpAgentSettings = Schema.decodeSync(AcpAgentSettings);

const DRIVER_KIND = ACP_AGENT_DRIVER_KIND;
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    // The agent is whatever the user pointed us at. T3 Code has no idea where
    // it came from, so it has nothing to offer to update.
    packageName: null,
  }),
);

export type AcpAgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Which instance currently owns which agent, keyed by spawn identity.
 *
 * Configuring several agents is the point of this driver, so instances are not
 * restricted. Configuring the *same* agent twice is a different thing: an ACP
 * agent that keeps state - a session list, a working directory, a queue - has
 * no way to tell two clients apart, and a duplicated instance is the shape a
 * settings form makes easy to reach by accident. The second one is refused with
 * the name of the instance that already holds it.
 */
const agentClaims = new Map<string, ProviderInstance["instanceId"]>();

export const claimAcpAgent = (input: {
  readonly identity: AcpAgentIdentity;
  readonly instanceId: ProviderInstance["instanceId"];
}) =>
  Effect.gen(function* () {
    const key = acpAgentIdentityKey(input.identity, yield* HostProcessPlatform);
    const holder = agentClaims.get(key);
    if (holder !== undefined && holder !== input.instanceId) {
      return yield* new ProviderDriverError({
        driver: DRIVER_KIND,
        instanceId: input.instanceId,
        detail: `Instance '${holder}' already runs ${describeAcpAgentIdentity(input.identity)}. Point this instance at a different agent, or remove the other one.`,
      });
    }
    agentClaims.set(key, input.instanceId);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (agentClaims.get(key) === input.instanceId) {
          agentClaims.delete(key);
        }
      }),
    );
  });

/** Test seam: the claim table outlives any one instance by design. */
export const resetAcpAgentClaims = (): void => {
  agentClaims.clear();
};

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly iconKey: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(input.iconKey ? { iconKey: input.iconKey } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const AcpAgentDriver: ProviderDriver<AcpAgentSettings, AcpAgentDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ACP agent",
    // One instance per agent is the whole point; several instances of this
    // driver is the ordinary case rather than the exception.
    supportsMultipleInstances: true,
  },
  configSchema: AcpAgentSettings,
  defaultConfig: (): AcpAgentSettings => decodeAcpAgentSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies AcpAgentSettings;
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        iconKey: effectiveConfig.icon?.trim() || undefined,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const identity = resolveAcpAgentIdentity(effectiveConfig);
      // Only an agent something would actually start can be held twice. A
      // disabled instance runs nothing, and an instance with no command yet is
      // the state every new one begins in: refusing the second blank instance
      // would stop a user adding their second agent before they had typed its
      // name.
      if (enabled && identity.command !== "") {
        yield* claimAcpAgent({ identity, instanceId });
      }
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.command,
        env: processEnv,
      });

      const adapter = yield* makeAcpAgentAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeAcpAgentTextGeneration();

      const checkProvider = checkAcpAgentProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<AcpAgentSettings>>(
        {
          maintenanceCapabilities,
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            buildInitialAcpAgentProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
          enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
            enrichAcpAgentSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
              httpClient,
            }),
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build the ACP agent snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
