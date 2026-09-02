/**
 * Spawn contract for a user-configured external ACP agent.
 *
 * Every other provider here knows its own executable. This one does not: the
 * command, its arguments and the directory it starts in are settings, so a user
 * can point T3 Code at any agent that speaks ACP over stdio without a code
 * change.
 *
 * Everything below the spawn is the shared runtime in `../acp/`. All this module
 * adds is a handle on the spawned process, so the adapter can tell "the agent is
 * thinking" apart from "the agent is gone".
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
 * Auth method id sent to `authenticate` when the instance names none. ACP has
 * no "skip authentication" call, so a client still has to say something.
 */
export const DEFAULT_ACP_AGENT_AUTH_METHOD_ID = "none";

/**
 * A configured agent runs as its own process with its own filesystem access.
 * T3 Code reads and writes nothing on its behalf and hosts no terminal for it,
 * and advertising either would invite an agent to use it.
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
 * One argument per line, because a spawned process gets no shell and there is
 * no correct way to split `--flag "a b"` that also leaves Windows paths intact.
 */
export function parseAcpAgentArgs(args: string | null | undefined): ReadonlyArray<string> {
  if (!args) return [];
  return args
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The directory the agent starts in: the thread's project by default, or a
 * fixed one for an instance that fronts a daemon serving a single home.
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

export interface AcpAgentExit {
  /** The process exit code, or `null` when the platform could not report one. */
  readonly code: number | null;
}

export interface AcpAgentRuntime {
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  /**
   * Resolves when the agent process exits, for any reason. `AcpSessionRuntime`
   * keeps the child handle to itself and does not shut its event queue down on
   * a crash, so nothing downstream would otherwise notice.
   */
  readonly awaitAgentExit: Effect.Effect<AcpAgentExit>;
}

/** `AcpSessionRuntime` spawns exactly one child, and this catches its handle. */
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
 * Model ids belong to the agent's own menu, so they are trimmed and nothing
 * more - never expanded through T3 Code's per-provider alias table. There is
 * deliberately no fallback id: naming one would invent a model the agent never
 * offered, where the caller wants "no model".
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
