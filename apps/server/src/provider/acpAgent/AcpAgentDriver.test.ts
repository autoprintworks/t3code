/**
 * One instance per agent process.
 *
 * Several instances of this driver is the ordinary case: that is how a user
 * runs two different ACP agents side by side. Two instances that start the
 * *same* agent is a different thing. An ACP agent that keeps state - a session
 * list, a working directory, a queue - has no way to tell two clients apart,
 * and the settings form makes a duplicated instance easy to reach by accident,
 * so the second one is refused by name here.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { ACP_AGENT_DRIVER_KIND, ProviderInstanceId } from "@t3tools/contracts";

import { AcpAgentDriver, claimAcpAgent, resetAcpAgentClaims } from "./AcpAgentDriver.ts";
import { resolveAcpAgentIdentity } from "./AcpAgentIdentity.ts";

const instance = (id: string) => ProviderInstanceId.make(id);

const withFreshClaims = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    resetAcpAgentClaims();
    return yield* body;
  }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(resetAcpAgentClaims)));

it.effect("refuses a second instance pointed at the agent another one already runs", () =>
  withFreshClaims(
    Effect.gen(function* () {
      const first = resolveAcpAgentIdentity({
        command: "example-acp-agent",
        workingDirectory: "C:/agents/one",
      });
      yield* claimAcpAgent({ identity: first, instanceId: instance("acp-agent-one") });

      // A trailing separator is the same directory, so it is the same agent.
      const second = resolveAcpAgentIdentity({
        command: "example-acp-agent",
        workingDirectory: "C:/agents/one/",
      });
      const error = yield* claimAcpAgent({
        identity: second,
        instanceId: instance("acp-agent-two"),
      }).pipe(Effect.flip);

      assert.equal(error._tag, "ProviderDriverError");
      // Both halves of the fix: which instance already holds it, and which
      // agent it is holding.
      assert.include(error.detail, "acp-agent-one");
      assert.include(error.detail, "example-acp-agent");
      assert.include(error.detail, "C:/agents/one");
    }),
  ),
);

it.effect("lets a fleet of agents run, one instance each", () =>
  withFreshClaims(
    Effect.gen(function* () {
      yield* claimAcpAgent({
        identity: resolveAcpAgentIdentity({ command: "npx", args: "-y\n@example/one" }),
        instanceId: instance("acp-agent-one"),
      });
      // One command, two agents. Comparing on the command alone would refuse
      // the second instance a user had every right to configure.
      yield* claimAcpAgent({
        identity: resolveAcpAgentIdentity({ command: "npx", args: "-y\n@example/two" }),
        instanceId: instance("acp-agent-two"),
      });
      // Reloading an instance re-claims the agent it already holds, rather
      // than locking itself out of it.
      yield* claimAcpAgent({
        identity: resolveAcpAgentIdentity({ command: "npx", args: "-y\n@example/one" }),
        instanceId: instance("acp-agent-one"),
      });
    }),
  ),
);

it.effect("releases the agent when the instance that claimed it is torn down", () =>
  withFreshClaims(
    Effect.gen(function* () {
      const identity = resolveAcpAgentIdentity({ command: "example-acp-agent" });
      const scope = yield* Scope.make("sequential");
      yield* claimAcpAgent({ identity, instanceId: instance("acp-agent-one") }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );

      yield* Scope.close(scope, Exit.void);

      // Removing an instance and adding one on the same agent is an ordinary
      // thing to do; a claim that outlived its owner would be a one-way door.
      yield* claimAcpAgent({ identity, instanceId: instance("acp-agent-two") });
    }),
  ),
);

it("advertises itself as the many-instance driver it is", () => {
  assert.equal(AcpAgentDriver.driverKind, ACP_AGENT_DRIVER_KIND);
  // Every other driver in this repository is one agent. This one is however
  // many the user configured, which is the whole point of it.
  assert.isTrue(AcpAgentDriver.metadata.supportsMultipleInstances);

  // A new instance starts blank and switched off: nothing is spawned, and
  // nothing is claimed, until the user says what to run.
  const blank = AcpAgentDriver.defaultConfig();
  assert.isFalse(blank.enabled);
  assert.equal(blank.command, "");
  assert.equal(blank.args, "");
  assert.equal(blank.workingDirectory, "");
});
