// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env files on disk directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decideForkPublicEnv, ensureForkPublicEnv } from "./fork-public-env.ts";
import { loadRepoEnv } from "./public-config.ts";

/**
 * The repository's own `.env.example` is the only copy of the values, here as well as in
 * the build, so an upstream edit to it flows through instead of failing this test.
 */
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const EXAMPLE = NodeFS.readFileSync(NodePath.join(REPO_ROOT, ".env.example"), "utf8");
const EXPECTED = NodeUtil.parseEnv(EXAMPLE);

/** Short of all four, the installed fork offers no sign-in and the relay cannot list it. */
const REQUIRED_KEYS = [
  "T3CODE_CLERK_PUBLISHABLE_KEY",
  "T3CODE_CLERK_JWT_TEMPLATE",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
  "T3CODE_RELAY_URL",
] as const;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("decideForkPublicEnv", () => {
  it("copies the example only when the clone has neither env file", () => {
    expect(decideForkPublicEnv({ hasEnv: false, hasEnvLocal: false, hasEnvExample: true })).toBe(
      "copy-example",
    );
    expect(decideForkPublicEnv({ hasEnv: true, hasEnvLocal: false, hasEnvExample: true })).toBe(
      "keep-existing",
    );
    expect(decideForkPublicEnv({ hasEnv: false, hasEnvLocal: true, hasEnvExample: true })).toBe(
      "keep-existing",
    );
    expect(decideForkPublicEnv({ hasEnv: false, hasEnvLocal: false, hasEnvExample: false })).toBe(
      "no-example",
    );
  });
});

describe("ensureForkPublicEnv", () => {
  it("gives a clean clone the values the fork's .env.example carries", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.example"), EXAMPLE);

    expect(ensureForkPublicEnv(repoRoot).action).toBe("copy-example");

    const env = loadRepoEnv({ baseEnv: {}, repoRoot });
    for (const key of REQUIRED_KEYS) {
      expect(EXPECTED[key]).toBeTruthy();
      expect(env[key]).toBe(EXPECTED[key]);
    }
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBe(EXPECTED.T3CODE_CLERK_PUBLISHABLE_KEY);
    expect(env.VITE_T3CODE_RELAY_URL).toBe(EXPECTED.T3CODE_RELAY_URL);
  });

  it("keeps a developer's own .env", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.example"), EXAMPLE);
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_RELAY_URL=https://relay.example.test\n",
    );

    expect(ensureForkPublicEnv(repoRoot).action).toBe("keep-existing");
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://relay.example.test",
    );
  });

  it("writes nothing when a .env.local already configures the clone", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.example"), EXAMPLE);
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_RELAY_URL=https://relay.local.test\n",
    );

    expect(ensureForkPublicEnv(repoRoot).action).toBe("keep-existing");
    expect(NodeFS.existsSync(NodePath.join(repoRoot, ".env"))).toBe(false);
  });

  it("builds on without T3 Connect when there is no example to copy", () => {
    const repoRoot = makeTemporaryDirectory();

    expect(ensureForkPublicEnv(repoRoot).action).toBe("no-example");
    expect(NodeFS.existsSync(NodePath.join(repoRoot, ".env"))).toBe(false);
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-fork-public-env-"));
  temporaryDirectories.push(directory);
  return directory;
}
