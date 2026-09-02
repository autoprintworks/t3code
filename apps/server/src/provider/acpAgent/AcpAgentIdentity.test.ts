/**
 * Which agent process an instance would start.
 *
 * The working directory is a path a user types, so a tilde is a value they are
 * actively invited to use. Nothing expands it for a spawned process, and on
 * Windows nothing expands it at all, so a raw pass-through would hand the agent
 * a literal directory named `~`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { AcpAgentSettings } from "@t3tools/contracts";

import { describeAcpAgentIdentity, resolveAcpAgentIdentity } from "./AcpAgentIdentity.ts";
import { buildAcpAgentSpawnInput } from "./AcpAgentSupport.ts";

const decodeAcpAgentSettings = Schema.decodeSync(AcpAgentSettings);

const identityFor = (command: string, workingDirectory?: string, args?: string) =>
  resolveAcpAgentIdentity({
    command,
    ...(args === undefined ? {} : { args }),
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
  });

it("expands a tilde working directory before the agent ever sees it", () => {
  const expected = NodePath.join(NodeOS.homedir(), "agents", "one");

  assert.equal(identityFor("example-acp-agent", "~/agents/one").workingDirectory, expected);

  // The spawn input is the thing that actually reaches the operating system.
  const spawn = buildAcpAgentSpawnInput(
    decodeAcpAgentSettings({
      enabled: true,
      command: "example-acp-agent",
      workingDirectory: "  ~/agents/one  ",
    }),
    "C:/work/repo",
  );
  assert.equal(spawn.cwd, expected);

  // A bare `~` is a directory too, and `~\` is how a Windows user types it.
  assert.equal(identityFor("example-acp-agent", "~").workingDirectory, NodeOS.homedir());
  assert.equal(
    identityFor("example-acp-agent", String.raw`~\agents`).workingDirectory,
    NodePath.join(NodeOS.homedir(), "agents"),
  );
});

it("follows the project when no working directory is configured", () => {
  assert.isUndefined(identityFor("example-acp-agent").workingDirectory);
  assert.isUndefined(identityFor("example-acp-agent", "   ").workingDirectory);
});

it("names the agent the way a failed probe has to say it", () => {
  assert.equal(
    describeAcpAgentIdentity(identityFor("npx", undefined, "-y\n@example/acp-agent")),
    "npx -y @example/acp-agent",
  );
  assert.equal(
    describeAcpAgentIdentity(identityFor("example-acp-agent", "C:/agents/one")),
    "example-acp-agent (in C:/agents/one)",
  );
});
