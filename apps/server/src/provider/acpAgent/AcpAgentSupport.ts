/**
 * Spawn contract for a user-configured external ACP agent.
 *
 * Every other provider in this repository knows its own executable. This one
 * does not: the command, its arguments, and the directory it starts in are
 * settings, so a user can point T3 Code at any agent that speaks the Agent
 * Client Protocol over stdio without a code change.
 *
 * Everything below the spawn is the shared runtime in `../acp/`. The only
 * thing this module adds to it is a handle on the spawned process, so the
 * adapter can tell "the agent is thinking" apart from "the agent is gone".
 *
 * @module provider/acpAgent/AcpAgentSupport
 */
import type { AcpAgentSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { expandHomePath } from "../../pathExpansion.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";

/**
 * Auth method id sent to `authenticate` when the instance names none.
 *
 * ACP has no "skip authentication" call, so a client that cannot authenticate
 * still has to say something. Agents that publish no auth methods ignore the
 * id and answer `{}`.
 */
export const DEFAULT_ACP_AGENT_AUTH_METHOD_ID = "none";

/**
 * Host invariants, stated once so the certification suite can assert them
 * against the same constant the runtime uses.
 *
 * A configured agent runs as its own process with its own filesystem access;
 * T3 Code does not read or write files on its behalf and does not host a
 * terminal for it. Advertising either capability would invite an agent to use
 * it, and the recorded transcripts would not catch that.
 */
export const ACP_AGENT_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const satisfies EffectAcpSchema.InitializeRequest["clientCapabilities"];

/** T3 Code hosts no MCP servers on a configured agent's behalf. */
export const ACP_AGENT_MCP_SERVERS: ReadonlyArray<EffectAcpSchema.McpServer> = [];

export type AcpAgentSpawnSettings = Pick<
  AcpAgentSettings,
  "command" | "args" | "workingDirectory" | "authMethodId"
>;

/**
 * Split the `args` setting into an argument vector.
 *
 * One argument per line, because a spawned process gets no shell and there is
 * no correct way to split `--flag "a b"` that also leaves Windows paths
 * intact. Blank lines are dropped so a trailing newline is not an empty
 * argument.
 */
export function parseAcpAgentArgs(args: string | null | undefined): ReadonlyArray<string> {
  if (!args) return [];
  return args
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The directory the agent process starts in.
 *
 * Default is the project directory, which is what an agent that works on the
 * files in front of it wants. An instance that must run somewhere fixed - a
 * daemon front-end serving one home, say - overrides it.
 *
 * A spawned process gets no shell, so `~` is expanded here rather than reaching
 * the platform verbatim and becoming a literal directory named `~`.
 */
export function resolveAcpAgentCwd(
  settings: Pick<AcpAgentSpawnSettings, "workingDirectory"> | null | undefined,
  projectCwd: string,
): string {
  const configured = settings?.workingDirectory?.trim();
  return configured ? expandHomePath(configured) : projectCwd;
}

export function resolveAcpAgentAuthMethodId(
  settings: Pick<AcpAgentSpawnSettings, "authMethodId"> | null | undefined,
): string {
  return settings?.authMethodId?.trim() || DEFAULT_ACP_AGENT_AUTH_METHOD_ID;
}

export function buildAcpAgentSpawnInput(
  settings: AcpAgentSpawnSettings | null | undefined,
  projectCwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.command?.trim() ?? "",
    args: parseAcpAgentArgs(settings?.args),
    cwd: resolveAcpAgentCwd(settings, projectCwd),
    ...(environment ? { env: environment } : {}),
  };
}

interface AcpAgentRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "mcpServers" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly agentSettings: AcpAgentSpawnSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

/** What an agent process exit looks like once the platform error is folded in. */
export interface AcpAgentExit {
  /** The process exit code, or `null` when the platform could not report one. */
  readonly code: number | null;
}

export interface AcpAgentRuntime {
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  /**
   * Resolves when the agent process backing this runtime exits, for any reason.
   *
   * `AcpSessionRuntime` keeps the child handle to itself, and its event queue
   * is not shut down when the process dies, so nothing downstream would notice
   * an agent that crashed. Capturing the handle on its way through the spawner
   * gets an exit signal without widening the shared runtime's service.
   */
  readonly awaitAgentExit: Effect.Effect<AcpAgentExit>;
}

/**
 * Wraps a spawner so the first process it spawns is handed to `onHandle`.
 * `AcpSessionRuntime` spawns exactly one child per runtime.
 */
const captureSpawnedAgent = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  onHandle: (handle: ChildProcessSpawner.ChildProcessHandle) => Effect.Effect<void>,
): ChildProcessSpawner.ChildProcessSpawner["Service"] => ({
  ...spawner,
  spawn: (command) => Effect.tap(spawner.spawn(command), onHandle),
});

export const makeAcpAgentRuntime = (
  input: AcpAgentRuntimeInput,
): Effect.Effect<AcpAgentRuntime, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope> =>
  Effect.gen(function* () {
    const agentHandle = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildAcpAgentSpawnInput(input.agentSettings, input.cwd, input.environment),
        clientCapabilities: ACP_AGENT_CLIENT_CAPABILITIES,
        mcpServers: ACP_AGENT_MCP_SERVERS,
        authMethodId: resolveAcpAgentAuthMethodId(input.agentSettings),
      }).pipe(
        Layer.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            captureSpawnedAgent(input.childProcessSpawner, (handle) =>
              Effect.asVoid(Deferred.succeed(agentHandle, handle)),
            ),
          ),
        ),
      ),
    );
    const acp = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    const awaitAgentExit = Deferred.await(agentHandle).pipe(
      Effect.flatMap((handle) =>
        handle.exitCode.pipe(
          Effect.map((code): AcpAgentExit => ({ code })),
          // A platform error means the exit status could not be read, not that
          // the agent is alive; reporting it as an exit of unknown code is the
          // honest reading.
          Effect.catchCause(() => Effect.succeed<AcpAgentExit>({ code: null })),
        ),
      ),
    );
    return { acp, awaitAgentExit };
  });

/**
 * Model ids are opaque strings owned by the agent's own menu, so they are only
 * trimmed - never expanded through T3 Code's per-provider alias table, which
 * knows nothing about a driver whose agent is chosen at runtime.
 *
 * There is deliberately no fallback id. Naming one would be T3 Code inventing a
 * model the agent never offered, and the caller that has nothing to resolve
 * wants "no model" rather than a guess.
 */
export function resolveAcpAgentModelId(model: string | null | undefined): string | undefined {
  return model?.trim() || undefined;
}

export function currentAcpAgentModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}
