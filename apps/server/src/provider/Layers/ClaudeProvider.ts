import {
  isProviderSkillUserInvocable,
  type ClaudeSettings,
  type ModelCapabilities,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKUserMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "../Drivers/ClaudeSkills.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  resolveClaudeModelsForVersion,
} from "../ClaudeModelCatalog.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
} as const;
function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

// ── SDK capability probe ────────────────────────────────────────────

// Amazon Bedrock initializes far slower than first-party auth: the SDK boots the
// Bedrock backend and runs the `awsAuthRefresh` credential hook before returning
// account info. The previous 8s budget expired mid-init, so the probe returned
// `undefined` and left the provider unverified and unselectable in the picker.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;

/**
 * Keep workspace-scoped command discovery intact while isolating the status
 * probe from configured MCP servers.
 */
export const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

/** Build the exact SDK options used by the Claude capability probe. */
export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // The probe keeps filesystem setting sources for slash-command discovery,
    // but must not run the user's hooks: it fires every few minutes, so
    // SessionStart hooks would run on every health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Ignore MCP definitions from every filesystem setting source above. The
    // SDK combines this empty explicit map with --strict-mcp-config.
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.environment,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // This is a noninteractive health check, so IDE discovery cannot add any
      // useful capability data. Skipping it also avoids Claude spawning a
      // Windows `tasklist | findstr` process tree on every periodic refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    stderr: () => {},
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  /**
   * Active API backend reported by the SDK's `AccountInfo`. Anthropic OAuth
   * login only applies when `"firstParty"`; for Amazon Bedrock (`"bedrock"`)
   * the subscription/token fields are absent and auth is external AWS creds.
   */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
};

/**
 * Distinct outcomes of {@link probeClaudeCapabilities}. Earlier revisions
 * collapsed every non-success case (timeout, spawn failure, thrown
 * initialization error) into `undefined`, so the only user-visible signal
 * was a fixed "could not verify authentication" warning that misreported a
 * slow machine as an auth problem. Keeping the reason lets
 * `checkClaudeProviderStatus` say what actually happened and lets us log it.
 */
export type ClaudeCapabilitiesProbeOutcome =
  | { readonly _tag: "Succeeded"; readonly probe: ClaudeCapabilitiesProbe }
  /** Initialization returned, but the SDK's `AccountInfo` block was absent. */
  | { readonly _tag: "NoAccountInfo"; readonly probe: ClaudeCapabilitiesProbe }
  | { readonly _tag: "TimedOut" }
  /** Failed before the subprocess could be queried: env or executable resolution. */
  | { readonly _tag: "SetupFailed"; readonly cause: unknown }
  /** The query threw or rejected while spawning or reading initialization data. */
  | { readonly _tag: "InitializationFailed"; readonly cause: unknown };

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

/**
 * Drop the slash commands that stand for a skill the user is not meant to pick.
 *
 * Claude Code surfaces every discovered skill as `/<name>`, so an agent-only
 * skill would otherwise reach the `/` menu through the back door after the
 * skill picker had already hidden it. Filtering here keeps one answer to
 * "may a user start this", the same one `isProviderSkillUserInvocable` gives.
 */
export function withoutAgentOnlySkillCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const hiddenSkillNames = new Set(
    skills
      .filter((skill) => !isProviderSkillUserInvocable(skill))
      .map((skill) => skill.name.toLowerCase()),
  );
  if (hiddenSkillNames.size === 0) {
    return commands;
  }
  return commands.filter((command) => !hiddenSkillNames.has(command.name.toLowerCase()));
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Probe account information by spawning a lightweight Claude Agent SDK
 * session and reading the initialization result.
 *
 * We pass a never-yielding AsyncIterable as the prompt so that no user
 * message is ever written to the subprocess stdin. This means the Claude
 * Code subprocess completes its local initialization IPC (returning
 * account info and slash commands) but never starts an API request to
 * Anthropic. We read the init data and then abort the subprocess.
 *
 * This is used as a fallback when `claude auth status` does not include
 * subscription type information.
 */
type ClaudeCapabilitiesProbeAttemptFailure =
  | { readonly _tag: "SetupFailed"; readonly cause: unknown }
  | { readonly _tag: "InitializationFailed"; readonly cause: unknown };

const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) => {
  const abort = new AbortController();

  const setup = Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    return { claudeEnvironment, executablePath };
  }).pipe(
    // makeClaudeEnvironment/resolveClaudeSdkExecutablePath are typed as
    // never-failing today, but catch defects too so a future change to
    // either can't silently reintroduce the old blanket discard.
    Effect.catchCause((cause: unknown) =>
      Effect.fail<ClaudeCapabilitiesProbeAttemptFailure>({ _tag: "SetupFailed", cause }),
    ),
  );

  const attempt = setup.pipe(
    Effect.flatMap(({ claudeEnvironment, executablePath }) =>
      Effect.tryPromise({
        try: async () => {
          const q = claudeQuery({
            // Never yield — we only need initialization data, not a conversation.
            // This prevents any prompt from reaching the Anthropic API.
            // oxlint-disable-next-line require-yield
            prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
              await waitForAbortSignal(abort.signal);
            })(),
            options: buildClaudeCapabilitiesProbeQueryOptions({
              executablePath,
              abortController: abort,
              environment: claudeEnvironment,
              cwd,
            }),
          });
          const init = await q.initializationResult();
          const account = init.account as
            | {
                readonly email?: string;
                readonly subscriptionType?: string;
                readonly tokenSource?: string;
                readonly apiProvider?: string;
              }
            | undefined;
          const probe: ClaudeCapabilitiesProbe = {
            email: account?.email,
            subscriptionType: account?.subscriptionType,
            tokenSource: account?.tokenSource,
            apiProvider: account?.apiProvider,
            slashCommands: parseClaudeInitializationCommands(init.commands),
          };
          return { probe, hasAccount: account !== undefined };
        },
        catch: (cause): ClaudeCapabilitiesProbeAttemptFailure => ({
          _tag: "InitializationFailed",
          cause,
        }),
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
  );

  return Effect.timed(attempt).pipe(
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.flatMap((result) => {
      if (Result.isFailure(result)) {
        const failure = result.failure;
        const message =
          failure._tag === "SetupFailed"
            ? "Claude capabilities probe failed before it could query the Claude Agent CLI."
            : "Claude capabilities probe failed while querying the Claude Agent CLI for initialization data.";
        return Effect.logWarning(message, { reason: failure._tag, cause: failure.cause }).pipe(
          Effect.as(failure),
        );
      }
      if (Option.isNone(result.success)) {
        return Effect.logWarning(
          "Claude capabilities probe timed out waiting for Claude Agent CLI initialization data.",
          { timeoutMs: CAPABILITIES_PROBE_TIMEOUT_MS },
        ).pipe(Effect.as<ClaudeCapabilitiesProbeOutcome>({ _tag: "TimedOut" }));
      }
      const [elapsed, { probe, hasAccount }] = result.success.value;
      if (!hasAccount) {
        return Effect.logWarning(
          "Claude capabilities probe returned initialization data without an account block.",
          { elapsedMs: Duration.toMillis(elapsed) },
        ).pipe(Effect.as<ClaudeCapabilitiesProbeOutcome>({ _tag: "NoAccountInfo", probe }));
      }
      return Effect.succeed<ClaudeCapabilitiesProbeOutcome>({ _tag: "Succeeded", probe });
    }),
  );
};

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

/**
 * User-visible warning for every non-`Succeeded` capabilities probe outcome.
 * A timeout is not an authentication failure, so it gets its own wording;
 * the original "could not verify" message is kept only for the case it
 * genuinely describes (`NoAccountInfo`) rather than any discarded failure.
 */
function claudeCapabilitiesWarningMessage(
  outcome: Exclude<ClaudeCapabilitiesProbeOutcome, { readonly _tag: "Succeeded" }>,
): string {
  switch (outcome._tag) {
    case "TimedOut":
      return "Claude authentication check timed out; authentication status was not determined.";
    case "SetupFailed":
      return "Claude authentication check could not run: failed to prepare the Claude Agent CLI.";
    case "InitializationFailed":
      return "Claude authentication check could not run: the Claude Agent CLI initialization probe failed.";
    case "NoAccountInfo":
      return "Could not verify Claude authentication status from initialization result.";
  }
}

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbeOutcome>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    modelCatalog.models.map((entry) => entry.model),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
  ).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    resolveClaudeModelsForVersion(modelCatalog, parsedVersion),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
  const versionUpgradeMessage = formatClaudeVersionUpgradeMessage(modelCatalog, parsedVersion);

  const capabilitiesOutcome: ClaudeCapabilitiesProbeOutcome = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(
        Effect.orElseSucceed(
          (): ClaudeCapabilitiesProbeOutcome => ({
            _tag: "InitializationFailed",
            cause: "resolveCapabilities effect failed",
          }),
        ),
      )
    : { _tag: "InitializationFailed", cause: "no capabilities resolver configured" };
  // Any outcome that carries a probe (Succeeded or NoAccountInfo) still ran
  // initialization successfully, so its slash commands are real data.
  const probe =
    capabilitiesOutcome._tag === "Succeeded" || capabilitiesOutcome._tag === "NoAccountInfo"
      ? capabilitiesOutcome.probe
      : undefined;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = [
    {
      name: "compact",
      description: "Summarize the conversation and reduce context usage",
    },
    ...(probe?.slashCommands ?? []),
  ];
  const dedupedSlashCommands = withoutAgentOnlySkillCommands(
    dedupeSlashCommands(slashCommands),
    skills,
  );

  if (capabilitiesOutcome._tag !== "Succeeded") {
    const message = claudeCapabilitiesWarningMessage(capabilitiesOutcome);
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message,
      },
    });
  }

  const capabilities = capabilitiesOutcome.probe;
  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ?? apiProviderAuthMetadata(capabilities.apiProvider);
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = (
  claudeSettings: ClaudeSettings,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  });

export { probeClaudeCapabilities };
