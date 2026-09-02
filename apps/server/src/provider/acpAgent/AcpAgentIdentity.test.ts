/**
 * Which agent process an instance would start, and when two instances are the
 * same one.
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

import {
  acpAgentIdentityKey,
  describeAcpAgentIdentity,
  resolveAcpAgentIdentity,
} from "./AcpAgentIdentity.ts";
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
  // `undefined`, not the project path: two instances that both follow the
  // project are the same agent only if their command line is.
  assert.isUndefined(identityFor("example-acp-agent").workingDirectory);
  assert.isUndefined(identityFor("example-acp-agent", "   ").workingDirectory);
});

it("gives two spellings of one agent the same claim key", () => {
  const one = identityFor("example-acp-agent", "C:/agents/one");
  const two = identityFor("example-acp-agent", "C:/agents/one/");
  assert.equal(acpAgentIdentityKey(one, "win32"), acpAgentIdentityKey(two, "win32"));

  assert.notEqual(
    acpAgentIdentityKey(one, "win32"),
    acpAgentIdentityKey(identityFor("example-acp-agent", "C:/agents/two"), "win32"),
  );

  // Case folds where the filesystem does, and only there.
  const shouted = identityFor("Example-ACP-Agent", "C:/Agents/One");
  assert.equal(acpAgentIdentityKey(one, "win32"), acpAgentIdentityKey(shouted, "win32"));
  assert.equal(acpAgentIdentityKey(one, "darwin"), acpAgentIdentityKey(shouted, "darwin"));
  assert.notEqual(acpAgentIdentityKey(one, "linux"), acpAgentIdentityKey(shouted, "linux"));
});

it("counts the arguments as part of the agent", () => {
  // `npx -y @example/one` and `npx -y @example/two` are one command and two
  // agents. Comparing on the command alone would refuse the second instance a
  // user had every right to configure.
  const one = identityFor("npx", undefined, "-y\n@example/one");
  const two = identityFor("npx", undefined, "-y\n@example/two");
  assert.notEqual(acpAgentIdentityKey(one, "linux"), acpAgentIdentityKey(two, "linux"));

  // Arguments are compared verbatim: an agent is free to treat `-v` and
  // `--verbose` as different things.
  assert.notEqual(
    acpAgentIdentityKey(identityFor("agent", undefined, "-v"), "linux"),
    acpAgentIdentityKey(identityFor("agent", undefined, "--verbose"), "linux"),
  );
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
