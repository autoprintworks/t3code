/**
 * Snapshot and model discovery for a user-configured external ACP agent.
 *
 * The probe is one ACP conversation and nothing else: initialize, open a
 * session, read the version off `agentInfo` and the model menu off the session
 * result, then stop. It never prompts, because a prompt would start real work
 * in the user's agent just to populate a dropdown.
 *
 * Other drivers run `<binary> --version` first and treat its exit code as the
 * health check. There is no such command here. The agent is whatever the user
 * pointed us at, its version flag is its own business, and ACP already carries
 * the answer: `initialize` returns `agentInfo`, which names the agent and its
 * version. One probe therefore reports installed, healthy, versioned and the
 * model list together, and an agent that cannot be started fails it in the one
 * place a user has to look.
 *
 * @module provider/acpAgent/AcpAgentProvider
 */
import type {
  AcpAgentSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  type AcpAgentIdentity,
  describeAcpAgentIdentity,
  resolveAcpAgentIdentity,
} from "./AcpAgentIdentity.ts";
import { makeAcpAgentRuntime, resolveAcpAgentModelId } from "./AcpAgentSupport.ts";

/**
 * What T3 Code shows before the instance's own settings override it.
 *
 * `displayName` is a placeholder: the driver stamps the name the user gave the
 * instance over the top.
 *
 * `requiresNewThreadForModelChange` is the conservative reading of a protocol
 * whose agents differ. ACP allows `session/set_model` mid-session but does not
 * make an agent accept one, and T3 Code cannot ask in advance which kind it is
 * pointed at. Declaring the switch unsupported means a model change starts a
 * fresh session, which every ACP agent can do, and the flag is what tells the
 * user that before they lose the conversation rather than after.
 */
const ACP_AGENT_PRESENTATION = {
  displayName: "ACP agent",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * How long the probe waits for the agent to answer `initialize` and open a
 * session. Long enough for an agent that starts a runtime first, short enough
 * that a wedged agent does not hold the settings panel open.
 */
export const ACP_AGENT_PROBE_TIMEOUT_MS = 15_000;

/**
 * Empty on purpose. Model ids are opaque strings owned by the agent's own menu,
 * so there is no honest built-in list to ship: the real one arrives with the
 * session and replaces this. `OpenCodeProvider` ships the same empty list for
 * the same reason.
 */
const ACP_AGENT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [];

/**
 * An instance with no command is not broken, it is unfinished, and saying so is
 * the whole job of this message: a settings form that offers a new instance
 * before the user has typed anything is exactly how a user gets here.
 */
const NO_COMMAND_MESSAGE = "No command is configured for this ACP agent.";

interface AcpAgentSnapshotInput {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly installed: boolean;
  readonly version?: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly message?: string;
}

/**
 * Every snapshot here carries the same presentation and the same "auth is the
 * agent's own business" answer, so only the probe is ever interesting. Naming
 * the envelope once keeps each branch below to the sentence it is about.
 */
function acpAgentSnapshot(input: AcpAgentSnapshotInput): ServerProviderDraft {
  return buildServerProvider({
    presentation: ACP_AGENT_PRESENTATION,
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

function acpAgentModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = ACP_AGENT_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildAcpAgentDiscoveredModels(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  return modelState.availableModels
    .map((model): ServerProviderModel | undefined => {
      const slug = resolveAcpAgentModelId(model.modelId);
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

/**
 * The version the agent gave for itself, or `null` when it named none.
 *
 * `agentInfo` is optional in ACP, so an agent is allowed to stay anonymous.
 * That is reported as "no version" rather than as a failure: an agent that
 * answers every request is working whether or not it says what it is.
 */
export function acpAgentVersionFromInitialize(
  initializeResult: EffectAcpSchema.InitializeResponse,
): string | null {
  return initializeResult.agentInfo?.version?.trim() || null;
}

export function buildInitialAcpAgentProviderSnapshot(
  agentSettings: AcpAgentSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = acpAgentModelsFromSettings(agentSettings.customModels);

    if (!agentSettings.enabled) {
      return acpAgentSnapshot({
        enabled: false,
        checkedAt,
        models,
        installed: false,
        status: "warning",
        message: "This agent is disabled in T3 Code settings.",
      });
    }

    if (agentSettings.command.trim() === "") {
      return acpAgentSnapshot({
        enabled: true,
        checkedAt,
        models,
        installed: false,
        status: "error",
        message: NO_COMMAND_MESSAGE,
      });
    }

    return acpAgentSnapshot({
      enabled: true,
      checkedAt,
      models,
      installed: true,
      status: "warning",
      message: "Checking the ACP agent...",
    });
  });
}

interface AcpAgentProbeResult {
  readonly version: string | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

const probeAcpAgent = (
  agentSettings: AcpAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtime = yield* makeAcpAgentRuntime({
      agentSettings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* runtime.acp.start();
    return {
      version: acpAgentVersionFromInitialize(started.initializeResult),
      models: buildAcpAgentDiscoveredModels(started.sessionSetupResult.models),
    } satisfies AcpAgentProbeResult;
  }).pipe(Effect.scoped);

function errorMessageOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const { message } = error as { readonly message?: unknown };
  return typeof message === "string" ? message.trim() : "";
}

/**
 * Whether the failure was "there is no such program".
 *
 * The spawn failure arrives wrapped: the ACP runtime reports an `AcpSpawnError`
 * carrying the operating system's own error as its `cause`, and that inner
 * error is the one that knows a file was not found. Unwrapping one level is
 * what separates "the command is wrong" from "the agent started and then went
 * wrong", which are different things for a user to go and fix.
 */
function isMissingCommandFailure(error: unknown): boolean {
  if (isCommandMissingCause(error)) return true;
  if (typeof error === "object" && error !== null && "cause" in error) {
    return isCommandMissingCause((error as { readonly cause: unknown }).cause);
  }
  return false;
}

/**
 * What went wrong, in the words of whatever went wrong, plus the command line
 * the user can go and try for themselves.
 *
 * A generic sentence would throw away both the agent's own diagnosis and the
 * argv it was given, which leaves the user with nothing to check. The command
 * line is always named because a driver configured entirely from settings has
 * no other way to say which agent this is.
 */
export function buildAcpAgentProbeFailureMessage(
  identity: AcpAgentIdentity,
  cause: Cause.Cause<unknown>,
): string {
  const where = describeAcpAgentIdentity(identity);
  const failure = Cause.findErrorOption(cause);
  const error = Option.isSome(failure) ? failure.value : undefined;
  if (isMissingCommandFailure(error)) {
    return `\`${where}\` could not be started. Check that the command is installed and on PATH.`;
  }
  const detail = errorMessageOf(error);
  return detail
    ? `\`${where}\` did not open an ACP session: ${detail}`
    : `\`${where}\` did not open an ACP session.`;
}

export const checkAcpAgentProviderStatus = Effect.fn("checkAcpAgentProviderStatus")(function* (
  agentSettings: AcpAgentSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = acpAgentModelsFromSettings(agentSettings.customModels);

  if (!agentSettings.enabled) {
    return acpAgentSnapshot({
      enabled: false,
      checkedAt,
      models: fallbackModels,
      installed: false,
      status: "warning",
      message: "This agent is disabled in T3 Code settings.",
    });
  }

  const identity = resolveAcpAgentIdentity(agentSettings);
  if (identity.command === "") {
    return acpAgentSnapshot({
      enabled: true,
      checkedAt,
      models: fallbackModels,
      installed: false,
      status: "error",
      message: NO_COMMAND_MESSAGE,
    });
  }

  const probeExit = yield* probeAcpAgent(agentSettings, environment).pipe(
    Effect.timeoutOption(ACP_AGENT_PROBE_TIMEOUT_MS),
    Effect.exit,
  );

  if (Exit.isFailure(probeExit)) {
    const failure = Cause.findErrorOption(probeExit.cause);
    const missing = Option.isSome(failure) && isMissingCommandFailure(failure.value);
    yield* Effect.logWarning("ACP agent probe failed.", {
      errorTag: causeErrorTag(probeExit.cause),
    });
    return acpAgentSnapshot({
      enabled: true,
      checkedAt,
      models: fallbackModels,
      // A command that was never found is not installed. Anything else got far
      // enough to be a program, so the update machinery has something to talk
      // about even though the session failed.
      installed: !missing,
      status: "error",
      message: buildAcpAgentProbeFailureMessage(identity, probeExit.cause),
    });
  }

  if (Option.isNone(probeExit.value)) {
    yield* Effect.logWarning(`ACP agent probe timed out after ${ACP_AGENT_PROBE_TIMEOUT_MS}ms.`);
    return acpAgentSnapshot({
      enabled: true,
      checkedAt,
      models: fallbackModels,
      installed: true,
      status: "error",
      message: `\`${describeAcpAgentIdentity(identity)}\` did not answer within ${ACP_AGENT_PROBE_TIMEOUT_MS}ms.`,
    });
  }

  const probe = probeExit.value.value;
  const models =
    probe.models.length > 0
      ? acpAgentModelsFromSettings(agentSettings.customModels, probe.models)
      : fallbackModels;

  return acpAgentSnapshot({
    enabled: true,
    checkedAt,
    models,
    version: probe.version,
    installed: true,
    status: "ready",
  });
});

export const enrichAcpAgentSnapshot = (input: {
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
      Effect.logWarning("ACP agent version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
