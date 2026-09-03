/**
 * Several instances, several agents.
 *
 * Running more than one ACP agent is the point of this driver, and two of those
 * instances may legitimately name the same command: an agent that reads its
 * home from the environment is how one binary serves two accounts. Each
 * instance spawns its own child process over its own stdio pipe, so nothing
 * here is shared and nothing is refused.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ACP_AGENT_DRIVER_KIND,
  AcpAgentSettings,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import { makeAcpAgentAdapter } from "./AcpAgentAdapter.ts";
import { makeTranscriptAgent, readTranscriptFixture } from "./AcpAgentTranscriptAgent.ts";
import { AcpAgentDriver } from "./AcpAgentDriver.ts";

const decodeAcpAgentSettings = Schema.decodeSync(AcpAgentSettings);

it.effect("runs one command twice when only the environment separates the two instances", () =>
  Effect.gen(function* () {
    const agent = yield* makeTranscriptAgent(readTranscriptFixture("first-prompt-opens-a-session"));

    yield* Effect.gen(function* () {
      const settings = decodeAcpAgentSettings({ enabled: true, command: "example-acp-agent" });

      // The same binary, pointed at two homes. This is the ordinary way to run
      // two accounts of one agent, so it has to start two processes rather than
      // be treated as one agent configured twice.
      const work = yield* makeAcpAgentAdapter(settings, {
        instanceId: ProviderInstanceId.make("acp-agent-work"),
        environment: { EXAMPLE_AGENT_HOME: "C:/homes/work" },
      }).pipe(Effect.orDie);
      const home = yield* makeAcpAgentAdapter(settings, {
        instanceId: ProviderInstanceId.make("acp-agent-home"),
        environment: { EXAMPLE_AGENT_HOME: "C:/homes/home" },
      }).pipe(Effect.orDie);

      const start = (adapter: typeof work, threadId: string) =>
        adapter.startSession({
          threadId: ThreadId.make(threadId),
          provider: ACP_AGENT_DRIVER_KIND,
          cwd: "C:/work/repo",
          runtimeMode: "full-access",
        });

      yield* start(work, "acp-two-homes-work");
      yield* start(home, "acp-two-homes-home");

      // Two spawns, both of the configured command, each carrying its own
      // instance's environment. One process serving both would be the bug.
      assert.equal(agent.connections.length, 2);
      assert.deepStrictEqual(
        agent.connections.map((connection) => connection.command.command),
        ["example-acp-agent", "example-acp-agent"],
      );
      assert.deepStrictEqual(
        agent.connections.map((connection) => connection.command.options.env?.EXAMPLE_AGENT_HOME),
        ["C:/homes/work", "C:/homes/home"],
      );
      // Separate sessions on separate processes: each adapter knows its own
      // thread and nothing about the other's.
      assert.isTrue(yield* work.hasSession(ThreadId.make("acp-two-homes-work")));
      assert.isFalse(yield* work.hasSession(ThreadId.make("acp-two-homes-home")));
      assert.isTrue(yield* home.hasSession(ThreadId.make("acp-two-homes-home")));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, agent.spawner),
          NodeCrypto.layer,
        ),
      ),
      Effect.scoped,
    );
  }),
);

it("advertises itself as the many-instance driver it is", () => {
  assert.equal(AcpAgentDriver.driverKind, ACP_AGENT_DRIVER_KIND);
  // Every other driver in this repository is one agent. This one is however
  // many the user configured, which is the whole point of it.
  assert.isTrue(AcpAgentDriver.metadata.supportsMultipleInstances);

  // A new instance starts blank and switched off: nothing is spawned until the
  // user says what to run.
  const blank = AcpAgentDriver.defaultConfig();
  assert.isFalse(blank.enabled);
  assert.equal(blank.command, "");
  assert.equal(blank.args, "");
  assert.equal(blank.workingDirectory, "");
});
