/**
 * `ProviderDriver` for an external agent that speaks the Agent Client Protocol.
 *
 * Every other driver in this repository is one agent: it knows the executable,
 * the arguments, and the name to show. This one knows none of those. It reads
 * them from the instance's settings, which is what lets a user point T3 Code at
 * an ACP agent this build has never heard of without a code change.
 *
 * Several instances can be configured. Each one spawns its own child process
 * over its own stdio pipe, so two instances are two agents even when they name
 * the same command: the settings that separate them, including the
 * environment, are all part of the spawn.
 *
 * @module provider/acpAgent/AcpAgentDriver
 */
import {
  ACP_AGENT_DRIVER_KIND,
  AcpAgentSettings,
  isProviderIconKey,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

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
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Settings hold whatever the user typed, so a key no client has artwork for
 * can reach here. Publishing it would put an instance in the picker with no
 * glyph at all; dropping it lets the driver default stand instead.
 */
function resolveConfiguredIconKey(icon: string | undefined): string | undefined {
  const named = icon?.trim();
  if (!named) return undefined;
  return isProviderIconKey(named) ? named : undefined;
}

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
        iconKey: resolveConfiguredIconKey(effectiveConfig.icon),
        continuationGroupKey: continuationIdentity.continuationKey,
      });
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
          // Probe gate: the instance enabled flag the registry resolved, never the
          // driver config's own `enabled` field.
          isEnabled: () => enabled,
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
