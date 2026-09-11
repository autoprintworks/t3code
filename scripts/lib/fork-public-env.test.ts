// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env files on disk directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decideForkPublicEnv, ensureForkPublicEnv } from "./fork-public-env.ts";
import { loadRepoEnv } from "./public-config.ts";

const EXAMPLE = [
  "T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk",
  "T3CODE_CLERK_JWT_TEMPLATE=t3-relay",
  "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=hzxSgY2cH10sDU2r",
  "T3CODE_RELAY_URL=https://relay.t3.codes",
  "",
].join("\n");

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
  it("gives a clean clone T3 Connect's public values", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.example"), EXAMPLE);

    expect(ensureForkPublicEnv(repoRoot).action).toBe("copy-example");

    const env = loadRepoEnv({ baseEnv: {}, repoRoot });
    expect(env.T3CODE_CLERK_PUBLISHABLE_KEY).toBe("pk_live_Y2xlcmsudDMuY29kZXMk");
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBe("pk_live_Y2xlcmsudDMuY29kZXMk");
    expect(env.T3CODE_CLERK_JWT_TEMPLATE).toBe("t3-relay");
    expect(env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID).toBe("hzxSgY2cH10sDU2r");
    expect(env.T3CODE_RELAY_URL).toBe("https://relay.t3.codes");
    expect(env.VITE_T3CODE_RELAY_URL).toBe("https://relay.t3.codes");
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

describe("the fork's own .env.example", () => {
  it("still carries the values the installer needs", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../..");
    const env = loadRepoEnv({
      baseEnv: {},
      repoRoot: stageExampleAsEnv(repoRoot),
    });

    expect(env.T3CODE_CLERK_PUBLISHABLE_KEY).toBe("pk_live_Y2xlcmsudDMuY29kZXMk");
    expect(env.T3CODE_RELAY_URL).toBe("https://relay.t3.codes");
  });
});

/** Copies the repository's real `.env.example` into a scratch root, then applies the fork rule. */
function stageExampleAsEnv(repoRoot: string) {
  const staged = makeTemporaryDirectory();
  NodeFS.copyFileSync(
    NodePath.join(repoRoot, ".env.example"),
    NodePath.join(staged, ".env.example"),
  );
  ensureForkPublicEnv(staged);
  return staged;
}

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-fork-public-env-"));
  temporaryDirectories.push(directory);
  return directory;
}
