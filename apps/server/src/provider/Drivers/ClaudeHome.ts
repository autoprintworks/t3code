// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
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
 * needs to run. The result belongs to that spawn alone: nothing here is
 * stored on the session, so the next turn starts from the instance
 * environment again.
 */
export const applyTurnEnvironment = (
  baseEnv: NodeJS.ProcessEnv,
  environment: ProviderInstanceEnvironment | undefined,
): NodeJS.ProcessEnv => {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  // Windows spells the variable `Path`. Write the prefix back to the key the
  // base environment already uses, or the child receives two of them.
  const pathKey =
    Object.keys(next).find((key) => key.toUpperCase() === PATH_VARIABLE_NAME) ?? PATH_VARIABLE_NAME;
  for (const variable of environment) {
    if (variable.name.toUpperCase() === PATH_VARIABLE_NAME) {
      const inherited = next[pathKey];
      next[pathKey] =
        inherited !== undefined && inherited.length > 0
          ? `${variable.value}${NodePath.delimiter}${inherited}`
          : variable.value;
      continue;
    }
    next[variable.name] = variable.value;
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
