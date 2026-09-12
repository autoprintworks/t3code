// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Build bootstrap. It runs before an
// Effect runtime exists, next to ./public-config.ts, which reads the file this module writes.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Fork-only: upstream ships T3 Connect switched off in a fresh clone. Its public
 * identifiers live in `.env.example`, and `./public-config.ts` only finds them in a
 * repository-root `.env` or `.env.local`. This fork's installer must carry them, so the
 * desktop build copies `.env.example` to `.env` when the clone has neither file. The fork
 * keeps no second copy of the values, so an upstream edit to `.env.example` flows through.
 * See docs/operations/fork-windows-build.md and issue #137.
 */

export type ForkPublicEnvAction =
  /** A `.env` or `.env.local` is already there. Leave the developer's file alone. */
  | "keep-existing"
  /** Neither file is there. Copy `.env.example` to `.env`. */
  | "copy-example"
  /** No `.env.example` to copy from. Build on without T3 Connect. */
  | "no-example";

export interface ForkPublicEnvSources {
  readonly hasEnv: boolean;
  readonly hasEnvLocal: boolean;
  readonly hasEnvExample: boolean;
}

export function decideForkPublicEnv(sources: ForkPublicEnvSources): ForkPublicEnvAction {
  if (sources.hasEnv || sources.hasEnvLocal) return "keep-existing";
  return sources.hasEnvExample ? "copy-example" : "no-example";
}

export interface ForkPublicEnvResult {
  readonly action: ForkPublicEnvAction;
  readonly envPath: string;
}

/**
 * Applies {@link decideForkPublicEnv} to a repository root. Never overwrites an existing
 * file, so a developer's own Clerk instance or relay survives a build.
 */
export function ensureForkPublicEnv(repoRoot: string): ForkPublicEnvResult {
  const envPath = NodePath.join(repoRoot, ".env");
  const examplePath = NodePath.join(repoRoot, ".env.example");
  const action = decideForkPublicEnv({
    hasEnv: NodeFS.existsSync(envPath),
    hasEnvLocal: NodeFS.existsSync(NodePath.join(repoRoot, ".env.local")),
    hasEnvExample: NodeFS.existsSync(examplePath),
  });

  if (action === "copy-example") {
    NodeFS.copyFileSync(examplePath, envPath);
  }

  return { action, envPath };
}

export function describeForkPublicEnv(result: ForkPublicEnvResult): string {
  switch (result.action) {
    case "copy-example":
      return `[desktop-artifact] Copied .env.example to .env, so this build carries T3 Connect's public values.`;
    case "keep-existing":
      return `[desktop-artifact] Using the .env already in the repository root for T3 Connect's public values.`;
    case "no-example":
      return `[desktop-artifact] No .env.example and no .env: this build ships with T3 Connect switched off.`;
  }
}
