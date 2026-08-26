/**
 * FORK DELTA (fm provider) - one place that answers "which First Mate home is
 * this instance serving?".
 *
 * The door resolves its home from `--home`, else `FM_V2_HOME`, else
 * `~/.firstmate/v2`. T3 Code has to resolve the same chain for three reasons
 * that all fail quietly if they disagree with the door: the `--home` argument
 * must be expanded before it is handed to a process that gets no shell, a
 * failed probe should name the directory it tried, and two provider instances
 * pointed at one home must be refused rather than silently fighting over it.
 *
 * @module provider/fm/FmHome
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expandHomePath } from "../../pathExpansion.ts";

/** Matches the door's own fallback when no `--home` and no `FM_V2_HOME` is set. */
export const FM_HOME_ENV_VAR = "FM_V2_HOME";

export type FmHomeSource = "setting" | "environment" | "default";

export interface FmHome {
  /**
   * The value to hand the door: `~` expanded, but otherwise left as written,
   * because the door resolves a relative `--home` against its own cwd and T3
   * Code must not quietly move it somewhere else.
   */
  readonly path: string;
  readonly source: FmHomeSource;
}

export function resolveFmHome(
  fmSettings: { readonly homePath?: string | null | undefined } | null | undefined,
  environment?: NodeJS.ProcessEnv,
): FmHome {
  const configured = fmSettings?.homePath?.trim();
  if (configured) {
    return { path: expandHomePath(configured), source: "setting" };
  }
  const fromEnvironment = environment?.[FM_HOME_ENV_VAR]?.trim();
  if (fromEnvironment) {
    return { path: expandHomePath(fromEnvironment), source: "environment" };
  }
  return { path: NodePath.join(NodeOS.homedir(), ".firstmate", "v2"), source: "default" };
}

/**
 * The identity two instances are compared on. The door derives its session
 * identity from the lexically normalised home path, so this normalises the same
 * way: resolve, then case-fold on the platforms whose filesystems do. The
 * platform is passed in rather than read from `process`, so a test can ask
 * about a platform it is not running on.
 */
export function fmHomeKey(home: FmHome, platform: NodeJS.Platform): string {
  const resolved = NodePath.resolve(home.path);
  return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/** How the home should be named in a message the user reads. */
export function describeFmHome(home: FmHome): string {
  switch (home.source) {
    case "setting":
      return `${home.path} (from the First Mate home path setting)`;
    case "environment":
      return `${home.path} (from ${FM_HOME_ENV_VAR})`;
    case "default":
      return `${home.path} (the door's default home)`;
  }
}
