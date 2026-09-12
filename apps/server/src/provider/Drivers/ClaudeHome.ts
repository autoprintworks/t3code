import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - effect/Path gives `sep`, the path separator. The PATH list separator is `delimiter`, and only node:path has it.
import * as NodePath from "node:path";

import type { ClaudeSettings, ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

const PATH_VARIABLE_NAME = "PATH";

/**
 * Overlay one turn's environment on the instance environment, for the process
 * that turn spawns.
 *
 * An entry replaces the instance value of the same name, with one exception:
 * an entry named `PATH` is a prefix, not a replacement. Its value is placed in
 * front of the spawn's own PATH and joined with the platform separator, so a
 * turn can add a tool directory without taking away the directories the CLI
 * needs to run.
 *
 * Every entry is matched to the base environment without case, not only PATH.
 * Windows spells the variable `Path` and treats all variable names without
 * case, so an entry writes back to the key the base environment already uses.
 * Write a fresh key instead and the child receives two names for one variable.
 *
 * The result belongs to that spawn alone. Nothing here is stored on the
 * session, so a turn's environment reaches a process only at spawn. A live
 * session keeps the environment it was spawned with, which is why a turn that
 * carries a different one restarts the session first. See
 * `ensureSessionForThread` in
 * `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`.
 */
export const applyTurnEnvironment = (
  baseEnv: NodeJS.ProcessEnv,
  environment: ProviderInstanceEnvironment | undefined,
): NodeJS.ProcessEnv => {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  const keysByUpperName = new Map<string, string>();
  for (const key of Object.keys(next)) {
    keysByUpperName.set(key.toUpperCase(), key);
  }
  for (const variable of environment) {
    const upperName = variable.name.toUpperCase();
    const targetKey = keysByUpperName.get(upperName) ?? variable.name;
    // Remember the key this entry chose, so a later entry that differs only in
    // case lands on the same one.
    keysByUpperName.set(upperName, targetKey);
    if (upperName === PATH_VARIABLE_NAME) {
      const inherited = next[targetKey];
      next[targetKey] =
        inherited !== undefined && inherited.length > 0
          ? `${variable.value}${NodePath.delimiter}${inherited}`
          : variable.value;
      continue;
    }
    next[targetKey] = variable.value;
  }
  return next;
};

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (config: Pick<ClaudeSettings, "homePath">): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
