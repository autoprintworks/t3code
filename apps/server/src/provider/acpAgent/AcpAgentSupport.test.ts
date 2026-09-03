/**
 * The spawn contract.
 *
 * The certification suite in `AcpAgentTranscript.test.ts` replaces the spawn
 * with a transcript-backed stub, so this file is where the argv the driver
 * would hand the operating system is pinned down. Between the two, every layer
 * of the shipping path is asserted.
 */
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AcpAgentSettings } from "@t3tools/contracts";

import {
  ACP_AGENT_CLIENT_CAPABILITIES,
  ACP_AGENT_MCP_SERVERS,
  buildAcpAgentSpawnInput,
  currentAcpAgentModelIdFromSessionSetup,
  DEFAULT_ACP_AGENT_AUTH_METHOD_ID,
  parseAcpAgentArgs,
  resolveAcpAgentAuthMethodId,
  resolveAcpAgentCwd,
  resolveAcpAgentModelId,
} from "./AcpAgentSupport.ts";

const decodeAcpAgentSettings = Schema.decodeSync(AcpAgentSettings);

it("runs the configured command in the project directory by default", () => {
  const spawn = buildAcpAgentSpawnInput(
    decodeAcpAgentSettings({ enabled: true, command: "example-acp-agent" }),
    "C:/work/repo",
  );

  assert.equal(spawn.command, "example-acp-agent");
  assert.deepStrictEqual(spawn.args, []);
  // The default is where the user's files are, which is what an agent that
  // works on the project in front of it needs.
  assert.equal(spawn.cwd, "C:/work/repo");
});

it("passes one argument per line, and drops the blank ones", () => {
  // A spawned process gets no shell, so there is no correct way to split
  // `--flag "a b"` that also leaves a Windows path intact. One line, one
  // argument, and a trailing newline is not an empty argument.
  assert.deepStrictEqual(parseAcpAgentArgs("acp\n--config\nC:/Program Files/a b/c.json\n"), [
    "acp",
    "--config",
    "C:/Program Files/a b/c.json",
  ]);
  assert.deepStrictEqual(parseAcpAgentArgs("  \n\n"), []);
  assert.deepStrictEqual(parseAcpAgentArgs(undefined), []);

  const spawn = buildAcpAgentSpawnInput(
    decodeAcpAgentSettings({ enabled: true, command: "npx", args: "-y\n@example/acp-agent" }),
    "C:/work/repo",
  );
  assert.deepStrictEqual(spawn.args, ["-y", "@example/acp-agent"]);
});

it("honours a fixed working directory and passes the environment through", () => {
  const spawn = buildAcpAgentSpawnInput(
    decodeAcpAgentSettings({
      enabled: true,
      command: "  C:/tools/example-acp-agent.exe  ",
      workingDirectory: "  C:/servers/one  ",
    }),
    "C:/work/repo",
    { EXAMPLE_AGENT_TOKEN: "abc" },
  );

  // An agent that serves one fixed place - a daemon front end, say - is not a
  // per-project process, so it overrides the project directory.
  assert.equal(spawn.command, "C:/tools/example-acp-agent.exe");
  assert.equal(spawn.cwd, "C:/servers/one");
  assert.deepStrictEqual(spawn.env, { EXAMPLE_AGENT_TOKEN: "abc" });
});

it("falls back to the project directory when no working directory is set", () => {
  assert.equal(resolveAcpAgentCwd(undefined, "C:/work/repo"), "C:/work/repo");
  assert.equal(resolveAcpAgentCwd({ workingDirectory: "   " }, "C:/work/repo"), "C:/work/repo");
});

it("declares no filesystem and no terminal capability to the agent", () => {
  // A configured agent is its own process with its own filesystem access.
  // Advertising either capability would invite it to use one T3 Code does not
  // implement, and the golden transcripts would not catch that.
  assert.deepStrictEqual(ACP_AGENT_CLIENT_CAPABILITIES, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  assert.deepStrictEqual(ACP_AGENT_MCP_SERVERS, []);
});

it("names an auth method even when the instance configures none", () => {
  // ACP has no "skip authentication" call, so a client still has to say
  // something. Agents that publish no auth methods ignore the id.
  assert.equal(resolveAcpAgentAuthMethodId(undefined), DEFAULT_ACP_AGENT_AUTH_METHOD_ID);
  assert.equal(resolveAcpAgentAuthMethodId({ authMethodId: "   " }), "none");
  assert.equal(resolveAcpAgentAuthMethodId({ authMethodId: " oauth " }), "oauth");
});

it("treats agent model ids as opaque and invents none of its own", () => {
  assert.equal(resolveAcpAgentModelId(" fast "), "fast");
  // No fallback id: a model T3 Code names is a model the agent never offered.
  assert.equal(resolveAcpAgentModelId(""), undefined);
  assert.equal(resolveAcpAgentModelId(undefined), undefined);

  assert.equal(
    currentAcpAgentModelIdFromSessionSetup({
      sessionId: "sess-1a2b3c4d5e6f7a8b",
      models: { availableModels: [{ modelId: "fast", name: "fast" }], currentModelId: "fast" },
    }),
    "fast",
  );
  // `backend-unavailable` answers `session/new` with no model list at all.
  assert.equal(
    currentAcpAgentModelIdFromSessionSetup({ sessionId: "sess-1a2b3c4d5e6f7a8b" }),
    undefined,
  );
});
