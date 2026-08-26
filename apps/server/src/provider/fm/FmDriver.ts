/**
 * FORK DELTA (fm provider) - the `fm` ProviderDriver.
 *
 * One instance is one door process is one First Mate home. Opening the `fm`
 * provider on a home shows that home's first mate as a thread; a second mate is
 * a second instance whose `homePath` points at a second home. There is no
 * special case for "second mate" anywhere in this file, and that is the point.
 *
 * Lives under `provider/fm/` rather than `provider/Drivers/` so the whole fork
 * delta is one directory plus a handful of marked registration lines. See
 * `docs/internals/fm-provider-fork-delta.md`.
 *
 * @module provider/fm/FmDriver
 */
import { FmSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
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
import { makeFmAdapter } from "./FmAdapter.ts";
import { describeFmHome, type FmHome, fmHomeKey, resolveFmHome } from "./FmHome.ts";
import {
  buildInitialFmProviderSnapshot,
  checkFmProviderStatus,
  enrichFmSnapshot,
} from "./FmProvider.ts";
import { makeFmTextGeneration } from "./FmTextGeneration.ts";

const decodeFmSettings = Schema.decodeSync(FmSettings);

const DRIVER_KIND = ProviderDriverKind.make("fm");
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    // The door ships with First Mate, not from a package registry, so there is
    // nothing for T3 Code to offer to update.
    packageName: null,
  }),
);

export type FmDriverEnv =
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
 * Which instance currently owns which First Mate home, keyed by the normalised
 * home path.
 *
 * `supportsMultipleInstances` is about homes, not about doors on one home. Two
 * doors on one home is not a benign duplicate: the daemon's turn runner only
 * stops the existing process tree when the unit has no live turn, and takes no
 * lock against a second concurrent `POST /turns`, so a second instance
 * prompting the same home starts a second harness against one conversation.
 * Nothing on the First Mate side refuses that, so the refusal belongs here.
 *
 * See `docs/internals/fm-provider-fork-delta.md`.
 */
const fmHomeClaims = new Map<string, ProviderInstance["instanceId"]>();

export const claimFmHome = (input: {
  readonly home: FmHome;
  readonly instanceId: ProviderInstance["instanceId"];
}) =>
  Effect.gen(function* () {
    const key = fmHomeKey(input.home, yield* HostProcessPlatform);
    const holder = fmHomeClaims.get(key);
    if (holder !== undefined && holder !== input.instanceId) {
      return yield* new ProviderDriverError({
        driver: DRIVER_KIND,
        instanceId: input.instanceId,
        detail: `First Mate instance '${holder}' is already serving ${describeFmHome(input.home)}. Point this instance at a different home, or remove the other one.`,
      });
    }
    fmHomeClaims.set(key, input.instanceId);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (fmHomeClaims.get(key) === input.instanceId) {
          fmHomeClaims.delete(key);
        }
      }),
    );
  });

/** Test seam: the claim table outlives any one instance by design. */
export const resetFmHomeClaims = (): void => {
  fmHomeClaims.clear();
};

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const FmDriver: ProviderDriver<FmSettings, FmDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "First Mate",
    // One instance per home is exactly how a fleet of mates is expressed. Two
    // instances on the *same* home is the one shape that is not allowed, and
    // `claimFmHome` below is what refuses it.
    supportsMultipleInstances: true,
  },
  configSchema: FmSettings,
  defaultConfig: (): FmSettings => decodeFmSettings({}),
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
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies FmSettings;
      yield* claimFmHome({
        home: resolveFmHome(effectiveConfig, processEnv),
        instanceId,
      });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeFmAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeFmTextGeneration();

      const checkProvider = checkFmProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<FmSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialFmProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          enrichFmSnapshot({
            snapshot: currentSnapshot,
            maintenanceCapabilities,
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            publishSnapshot,
            httpClient,
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build the First Mate snapshot: ${cause.message ?? String(cause)}`,
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
