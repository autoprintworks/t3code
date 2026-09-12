#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A plain Node CLI. It runs
// before any Effect runtime exists, and its console output is the gate's log.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/**
 * Guard for the fork feature manifest at the repository root. Run by the fork
 * update gate (`.github/workflows/fork-update.yml`) and by CI, so an upstream
 * merge that deletes a file or a test a fork feature lives in fails before
 * anything is published. A feature with no `keep` line fails here too, because
 * a conflict resolver has no rule to follow without one. See
 * docs/agents/upstream-conflict-resolution.md and
 * docs/operations/fork-windows-build.md.
 */

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const manifestPath = NodePath.resolve(repoRoot, "fork-features.json");

export interface ForkFeature {
  readonly name: string;
  readonly description: string;
  /**
   * The per-file rule an upstream merge conflict in {@link files} is settled
   * by: what of ours must survive, and what takes upstream. Read by the worker
   * brief in docs/agents/upstream-conflict-resolution.md.
   */
  readonly keep: string;
  /** Every file the feature lives in, fork-only or patched from upstream. */
  readonly files: readonly string[];
  /** Test file that fails on plain upstream without the feature. */
  readonly test: string;
  /** Narrows {@link test} to one named test inside that file. */
  readonly testName?: string;
  /** True when any file in {@link files} also exists upstream. */
  readonly patchesUpstream: boolean;
}

export class ForkFeatureManifestError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Fork feature manifest is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ForkFeatureManifestError";
    this.problems = problems;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parses the manifest and reports every shape problem at once, rather than
 * failing on the first one, so a bad edit takes one run to fix.
 */
export function parseForkFeatures(source: string): readonly ForkFeature[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new ForkFeatureManifestError([`not valid JSON: ${(cause as Error).message}`]);
  }

  const features = (parsed as { features?: unknown }).features;
  if (!Array.isArray(features) || features.length === 0) {
    throw new ForkFeatureManifestError(['expected a non-empty "features" array']);
  }

  const problems: string[] = [];
  const seen = new Set<string>();

  features.forEach((entry, index) => {
    const feature = entry as Partial<ForkFeature>;
    const label = isNonEmptyString(feature.name) ? feature.name : `features[${index}]`;

    if (!isNonEmptyString(feature.name)) problems.push(`${label}: "name" must be a string`);
    else if (seen.has(feature.name)) problems.push(`${label}: duplicate "name"`);
    else seen.add(feature.name);

    if (!isNonEmptyString(feature.description)) {
      problems.push(`${label}: "description" must be a string`);
    }
    if (!isNonEmptyString(feature.keep)) {
      problems.push(`${label}: "keep" must say what of ours survives and what takes upstream`);
    }
    if (
      !Array.isArray(feature.files) ||
      feature.files.length === 0 ||
      !feature.files.every(isNonEmptyString)
    ) {
      problems.push(`${label}: "files" must be a non-empty array of paths`);
    }
    if (!isNonEmptyString(feature.test)) {
      problems.push(`${label}: "test" must be a test file path`);
    }
    if (feature.testName !== undefined && !isNonEmptyString(feature.testName)) {
      problems.push(`${label}: "testName" must be a string when present`);
    }
    if (typeof feature.patchesUpstream !== "boolean") {
      problems.push(`${label}: "patchesUpstream" must be a boolean`);
    }
  });

  if (problems.length > 0) {
    throw new ForkFeatureManifestError(problems);
  }

  return features as readonly ForkFeature[];
}

/**
 * Every path a feature claims, with the feature that claims it, so a missing
 * path names the fork feature that just lost its home.
 */
export function collectClaimedPaths(
  features: readonly ForkFeature[],
): readonly { readonly feature: string; readonly path: string; readonly kind: "file" | "test" }[] {
  return features.flatMap((feature) => [
    ...feature.files.map((path) => ({ feature: feature.name, path, kind: "file" as const })),
    { feature: feature.name, path: feature.test, kind: "test" as const },
  ]);
}

export function findMissingPaths(
  features: readonly ForkFeature[],
  exists: (path: string) => boolean,
): readonly string[] {
  return collectClaimedPaths(features)
    .filter(({ path }) => !exists(path))
    .map(({ feature, path, kind }) => `${feature}: ${kind} "${path}" does not exist`);
}

/**
 * Test runs to make, one per named test plus a single batch for everything
 * else, so the common case is one process rather than one per feature.
 */
export function planTestRuns(features: readonly ForkFeature[]): readonly (readonly string[])[] {
  const batched: string[] = [];
  const named: string[][] = [];

  for (const feature of features) {
    if (feature.testName === undefined) {
      if (!batched.includes(feature.test)) batched.push(feature.test);
    } else {
      named.push([feature.test, "-t", feature.testName]);
    }
  }

  return batched.length > 0 ? [batched, ...named] : named;
}

/**
 * Absolute path to vite-plus's `vp` entry script, for spawning through
 * {@link process.execPath}. Windows resolves `node_modules/.bin/vp` to a `.CMD`
 * shim that `execFileSync` cannot run without a shell. Deliberately duplicated
 * from scripts/release-smoke.ts rather than shared: that file is upstream's and
 * this one is the fork's, so the copy keeps the fork's patch set smaller.
 */
function resolveVpEntryPath(): string {
  const require = NodeModule.createRequire(import.meta.url);
  const manifest: { bin?: Record<string, string> } = JSON.parse(
    NodeFS.readFileSync(require.resolve("vite-plus/package.json"), "utf8"),
  );
  const relativeEntry = manifest.bin?.vp;
  if (relativeEntry === undefined) {
    throw new Error(`Expected a "vp" bin entry in vite-plus's package.json.`);
  }
  return NodePath.resolve(
    NodePath.dirname(require.resolve("vite-plus/package.json")),
    relativeEntry,
  );
}

function main(): void {
  const features = parseForkFeatures(NodeFS.readFileSync(manifestPath, "utf8"));
  const missing = findMissingPaths(features, (path) =>
    NodeFS.existsSync(NodePath.resolve(repoRoot, path)),
  );

  if (missing.length > 0) {
    console.error(`Fork features have lost ${missing.length} path(s):`);
    for (const problem of missing) console.error(`  - ${problem}`);
    console.error(
      "\nAn upstream merge moved or deleted a file a fork feature lives in. Move the feature, or update fork-features.json to say where it lives now.",
    );
    process.exit(1);
  }

  console.log(`Fork features: ${features.length} entries, every file and test present.`);

  const vpEntryPath = resolveVpEntryPath();
  for (const args of planTestRuns(features)) {
    console.log(`\nvp test run ${args.join(" ")}`);
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [vpEntryPath, "test", "run", ...args],
      { cwd: repoRoot, stdio: "inherit" },
    );
    if (result.status !== 0) {
      console.error(`\nFork feature tests failed: vp test run ${args.join(" ")}`);
      process.exit(result.status ?? 1);
    }
  }

  console.log("\nFork feature tests passed.");
}

if (import.meta.main) {
  main();
}
