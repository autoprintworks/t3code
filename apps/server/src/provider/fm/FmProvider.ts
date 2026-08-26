/**
 * FORK DELTA (fm provider) - snapshot and model discovery for the First Mate
 * ACP door.
 *
 * Discovery is the door's own "model discovery probe": initialize, open a
 * session, read the model menu off the `session/new` result, and stop. It
 * never prompts, because a prompt would allocate a real supervisor
 * conversation in the user's home just to populate a dropdown.
 *
 * @module provider/fm/FmProvider
 */
import type {
  FmSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeFmAcpRuntime, resolveFmModelId } from "./FmAcpSupport.ts";
import { describeFmHome, type FmHome, resolveFmHome } from "./FmHome.ts";

/**
 * `requiresNewThreadForModelChange` is not decoration: the door refuses
 * `session/set_model` once the conversation is live, because a First Mate unit
 * cannot be moved to another model half way through.
 */
const FM_PRESENTATION = {
  displayName: "First Mate",
  badgeLabel: "Fork",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
/**
 * Matches the budget the door's own transcript suite holds itself to for the
 * model-discovery probe, so a door that would fail its certification here
 * fails T3 Code's snapshot rather than hanging the settings panel.
 */
const FM_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Empty on purpose. Model ids are opaque strings owned by the door's menu, so
 * T3 Code has no honest built-in list to ship: the real one arrives from
 * `session/new` and replaces this. Until the probe answers, the snapshot's own
 * "Checking the First Mate ACP door..." message is the discovering state, and
 * a probe that fails ends `error`, where there is no session to pick a model
 * for anyway. `OpenCodeProvider` ships the same empty list for the same
 * reason.
 */
const FM_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [];

interface FmSnapshotInput {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly installed: boolean;
  readonly version?: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly message?: string;
}

/**
 * Every `fm` snapshot carries the same presentation and the same "auth is not
 * a thing the door has" answer, so only the probe is ever interesting. Naming
 * the envelope once keeps each branch below to the sentence it is about.
 */
function fmSnapshot(input: FmSnapshotInput): ServerProviderDraft {
  return buildServerProvider({
    presentation: FM_PRESENTATION,
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: input.models,
    probe: {
      installed: input.installed,
      version: input.version ?? null,
      status: input.status,
      auth: { status: "unknown" },
      ...(input.message === undefined ? {} : { message: input.message }),
    },
  });
}

function fmModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = FM_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildFmDiscoveredModels(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveFmModelId(model.modelId);
      if (slug === undefined || seen.has(slug)) {
        return undefined;
      }
      seen.add(slug);
      return {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      };
    })
    .filter((model): model is ServerProviderModel => model !== undefined);
}

export function buildInitialFmProviderSnapshot(
  fmSettings: FmSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = fmModelsFromSettings(fmSettings.customModels);

    if (!fmSettings.enabled) {
      return fmSnapshot({
        enabled: false,
        checkedAt,
        models,
        installed: false,
        status: "warning",
        message: "First Mate is disabled in T3 Code settings.",
      });
    }

    return fmSnapshot({
      enabled: true,
      checkedAt,
      models,
      installed: true,
      status: "warning",
      message: "Checking the First Mate ACP door...",
    });
  });
}

const runFmVersionCommand = (
  fmSettings: FmSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = fmSettings.binaryPath || "fm-acp";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const discoverFmModelsViaAcp = (
  fmSettings: FmSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeFmAcpRuntime({
      fmSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.acp.start();
    return buildFmDiscoveredModels(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

function errorMessageOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const { message } = error as { readonly message?: unknown };
  return typeof message === "string" ? message.trim() : "";
}

/**
 * The failure a misconfigured user actually hits is "no daemon is serving that
 * home", and the door already says so in its own words. Reporting one generic
 * sentence instead threw away both the diagnosis and the directory, which left
 * the user with nothing to check. So: the door's message when there is one,
 * and the home path either way.
 */
export function buildFmDiscoveryFailureMessage(home: FmHome, cause: Cause.Cause<unknown>): string {
  const where = `Home: ${describeFmHome(home)}.`;
  const failure = Cause.findErrorOption(cause);
  const detail = Option.isSome(failure) ? errorMessageOf(failure.value) : "";
  return detail
    ? `The First Mate ACP door did not open a session: ${detail} ${where}`
    : `The First Mate ACP door is installed but did not open a session. Check that a First Mate daemon is serving this home. ${where}`;
}

export const checkFmProviderStatus = Effect.fn("checkFmProviderStatus")(function* (
  fmSettings: FmSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = fmModelsFromSettings(fmSettings.customModels);

  if (!fmSettings.enabled) {
    return fmSnapshot({
      enabled: false,
      checkedAt,
      models: fallbackModels,
      installed: false,
      status: "warning",
      message: "First Mate is disabled in T3 Code settings.",
    });
  }

  const home = resolveFmHome(fmSettings, environment);

  const versionResult = yield* runFmVersionCommand(fmSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("First Mate ACP door health check failed.", {
      errorTag: error._tag,
    });
    return fmSnapshot({
      enabled: fmSettings.enabled,
      checkedAt,
      models: fallbackModels,
      installed: !isCommandMissingCause(error),
      status: "error",
      message: isCommandMissingCause(error)
        ? "The First Mate ACP door (`fm-acp`) is not installed or not on PATH."
        : "Failed to run the First Mate ACP door health check.",
    });
  }

  if (Option.isNone(versionResult.success)) {
    return fmSnapshot({
      enabled: fmSettings.enabled,
      checkedAt,
      models: fallbackModels,
      installed: true,
      status: "error",
      message: "The First Mate ACP door timed out while running `fm-acp --version`.",
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("First Mate ACP door version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
    });
    return fmSnapshot({
      enabled: fmSettings.enabled,
      checkedAt,
      models: fallbackModels,
      installed: true,
      version,
      status: "error",
      message: "The First Mate ACP door is installed but failed to run.",
    });
  }

  const discoveryExit = yield* discoverFmModelsViaAcp(fmSettings, environment).pipe(
    Effect.timeoutOption(FM_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("First Mate ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
      homePath: home.path,
    });
    return fmSnapshot({
      enabled: fmSettings.enabled,
      checkedAt,
      models: fallbackModels,
      installed: true,
      version,
      status: "error",
      message: buildFmDiscoveryFailureMessage(home, discoveryExit.cause),
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    yield* Effect.logWarning(
      `First Mate ACP model discovery timed out after ${FM_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    );
    return fmSnapshot({
      enabled: fmSettings.enabled,
      checkedAt,
      models: fallbackModels,
      installed: true,
      version,
      status: "error",
      message: `The First Mate ACP door did not answer within ${FM_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
    });
  }

  const discoveredModels = discoveryExit.value.value;
  const models =
    discoveredModels.length > 0
      ? fmModelsFromSettings(fmSettings.customModels, discoveredModels)
      : fallbackModels;

  return fmSnapshot({
    enabled: fmSettings.enabled,
    checkedAt,
    models,
    installed: true,
    version,
    status: "ready",
  });
});

export const enrichFmSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("First Mate version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
