/**
 * What the settings card says when the configured agent does not answer.
 *
 * A driver configured entirely from settings has one job in a failure: say
 * which command line failed, and repeat whatever the failure said for itself.
 * The user typed that command line, so it is the one thing they can go and try
 * by hand, and a generic sentence in its place leaves them nothing to check.
 *
 * The successful probe is certified against a golden transcript in
 * `AcpAgentTranscript.test.ts`; this file covers the branches a real agent
 * cannot be made to take on demand.
 */
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AcpSchema from "effect-acp/schema";

import { AcpAgentSettings } from "@t3tools/contracts";

import { ProviderCommandNotFoundError } from "../providerSnapshot.ts";
import { resolveAcpAgentIdentity } from "./AcpAgentIdentity.ts";
import {
  acpAgentVersionFromInitialize,
  buildAcpAgentDiscoveredModels,
  buildAcpAgentProbeFailureMessage,
  buildInitialAcpAgentProviderSnapshot,
} from "./AcpAgentProvider.ts";

const decodeAcpAgentSettings = Schema.decodeSync(AcpAgentSettings);
const decodeInitializeResponse = Schema.decodeSync(AcpSchema.InitializeResponse);
const decodeSessionModelState = Schema.decodeSync(AcpSchema.SessionModelState);

const NPX_AGENT = resolveAcpAgentIdentity({ command: "npx", args: "-y\n@example/acp-agent" });

/** What the ACP runtime raises when the operating system refuses the spawn. */
const spawnFailure = (cause: unknown) => new Error("Failed to spawn the ACP agent.", { cause });

it("gives the agent its own words back, and names the command line it ran", () => {
  const message = buildAcpAgentProbeFailureMessage(
    NPX_AGENT,
    Cause.fail(new Error("no API key is configured for this agent")),
  );

  assert.include(message, "no API key is configured for this agent");
  // The argv, not just the command: `npx` on its own names nothing.
  assert.include(message, "npx -y @example/acp-agent");
});

it("separates a command that does not exist from an agent that went wrong", () => {
  // The spawn failure arrives wrapped, so the error that knows a file was not
  // found is one level down. Reading only the outer error would report every
  // typo as a broken agent.
  const message = buildAcpAgentProbeFailureMessage(
    NPX_AGENT,
    Cause.fail(
      spawnFailure(
        new ProviderCommandNotFoundError({
          binaryPath: "npx",
          exitCode: 9009,
          stdoutLength: 0,
          stderrLength: 0,
        }),
      ),
    ),
  );

  assert.include(message, "npx -y @example/acp-agent");
  assert.include(message, "installed and on PATH");
  assert.notInclude(message, "did not open an ACP session");
});

it("still names the agent when the failure carries no words of its own", () => {
  const identity = resolveAcpAgentIdentity({
    command: "example-acp-agent",
    workingDirectory: "C:/agents/one",
  });
  const message = buildAcpAgentProbeFailureMessage(identity, Cause.die("boom"));

  // A generic sentence is fine as long as it still points somewhere. The
  // working directory is part of that: the same command in another directory
  // is another agent.
  assert.include(message, "example-acp-agent (in C:/agents/one)");
  assert.include(message, "did not open an ACP session.");
});

it("takes the version from the agent's own report, and accepts none", () => {
  const withInfo = decodeInitializeResponse({
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: "example-acp-agent", version: " 1.4.0 " },
  });
  assert.equal(acpAgentVersionFromInitialize(withInfo), "1.4.0");

  // `agentInfo` is optional in ACP, so an agent may stay anonymous. That is no
  // version rather than a failed probe: it answered every request.
  assert.isNull(
    acpAgentVersionFromInitialize(
      decodeInitializeResponse({ protocolVersion: 1, agentCapabilities: {} }),
    ),
  );
  assert.isNull(
    acpAgentVersionFromInitialize(
      decodeInitializeResponse({
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "example-acp-agent", version: "   " },
      }),
    ),
  );
});

it("turns the session's model menu into the picker's list", () => {
  const models = buildAcpAgentDiscoveredModels(
    decodeSessionModelState({
      currentModelId: "default",
      availableModels: [
        { modelId: " default ", name: "Default" },
        // An agent is free to repeat itself, and to name a model nothing.
        { modelId: "default", name: "Default again" },
        { modelId: "fast", name: "   " },
        { modelId: "   ", name: "Nameless" },
      ],
    }),
  );

  assert.deepStrictEqual(
    models.map((model) => [model.slug, model.name]),
    [
      ["default", "Default"],
      ["fast", "fast"],
    ],
  );
  assert.isFalse(models.some((model) => model.isCustom));

  // No menu is not an empty menu: the fallback list from settings is used
  // instead, which the caller decides.
  assert.deepStrictEqual(buildAcpAgentDiscoveredModels(null), []);
  assert.deepStrictEqual(
    buildAcpAgentDiscoveredModels(
      decodeSessionModelState({ currentModelId: "default", availableModels: [] }),
    ),
    [],
  );
});

it.effect("tells a half-configured instance what it is missing", () =>
  Effect.gen(function* () {
    // A settings form offers a new instance before the user has typed
    // anything, so this is the state every instance starts in.
    const blank = yield* buildInitialAcpAgentProviderSnapshot(
      decodeAcpAgentSettings({ enabled: true }),
    );
    assert.equal(blank.status, "error");
    assert.equal(blank.message, "No command is configured for this ACP agent.");
    assert.isFalse(blank.installed);

    const disabled = yield* buildInitialAcpAgentProviderSnapshot(
      decodeAcpAgentSettings({ command: "example-acp-agent" }),
    );
    assert.equal(disabled.status, "disabled");

    const configured = yield* buildInitialAcpAgentProviderSnapshot(
      decodeAcpAgentSettings({ enabled: true, command: "example-acp-agent" }),
    );
    assert.equal(configured.status, "warning");
    assert.include(configured.message ?? "", "Checking");
    // Changing the model has to start a new session, and the user is told
    // before the conversation is gone rather than after.
    assert.isTrue(configured.requiresNewThreadForModelChange);
  }),
);

it.effect("carries custom models until the agent publishes its own", () =>
  Effect.gen(function* () {
    const snapshot = yield* buildInitialAcpAgentProviderSnapshot(
      decodeAcpAgentSettings({
        enabled: true,
        command: "example-acp-agent",
        customModels: ["house-model"],
      }),
    );

    assert.deepStrictEqual(
      snapshot.models.map((model) => model.slug),
      ["house-model"],
    );
  }),
);
