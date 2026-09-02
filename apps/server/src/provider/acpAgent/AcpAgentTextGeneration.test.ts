/**
 * The refusal, and the reason it never costs anybody anything.
 *
 * This is the one driver that cannot write a commit message, so the refusal has
 * to name the way out. It also has to be unreachable by accident: the text
 * generation fallback walks `ServerSettings.providers` and takes the first
 * enabled entry, and this driver deliberately has no entry there
 * (`packages/contracts/src/settings.ts`). That absence is what keeps the
 * fallback on a provider that can actually answer, so it is asserted rather
 * than assumed.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProviderInstanceId } from "@t3tools/contracts";

import { layerTest, ServerSettingsService } from "../../serverSettings.ts";
import { makeAcpAgentTextGeneration } from "./AcpAgentTextGeneration.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("acp-agent-one"),
  model: "default",
} as const;

it.effect("refuses every generated-text operation, and names the way out", () =>
  Effect.gen(function* () {
    const textGeneration = yield* makeAcpAgentTextGeneration();

    const failures = [
      yield* Effect.flip(
        textGeneration.generateCommitMessage({
          cwd: "C:/work/repo",
          branch: "main",
          stagedSummary: "",
          stagedPatch: "",
          modelSelection,
        }),
      ),
      yield* Effect.flip(
        textGeneration.generatePrContent({
          cwd: "C:/work/repo",
          baseBranch: "main",
          headBranch: "topic",
          commitSummary: "",
          diffSummary: "",
          diffPatch: "",
          modelSelection,
        }),
      ),
      yield* Effect.flip(
        textGeneration.generateBranchName({
          cwd: "C:/work/repo",
          message: "add a thing",
          modelSelection,
        }),
      ),
      yield* Effect.flip(
        textGeneration.generateThreadTitle({
          cwd: "C:/work/repo",
          message: "add a thing",
          modelSelection,
        }),
      ),
    ];

    assert.deepStrictEqual(
      failures.map((failure) => failure.operation),
      ["generateCommitMessage", "generatePrContent", "generateBranchName", "generateThreadTitle"],
    );
    for (const failure of failures) {
      // A refusal is only acceptable because it points somewhere else.
      assert.ok(failure.detail.includes("Pick another provider"));
    }
  }),
);

it.effect("is never what the text generation fallback picks", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;

    // No legacy `providers` entry means the fallback cannot reach this driver
    // however many instances of it a user configures.
    assert.ok(!Object.keys(settings.providers).includes("acpAgent"));
    assert.equal(settings.textGenerationModelSelection.instanceId, "opencode");
  }).pipe(
    Effect.provide(
      layerTest({
        providers: {
          // The default selection points at codex, so disabling it is what
          // sends the resolver looking for a fallback.
          codex: { enabled: false },
          claudeAgent: { enabled: false },
          cursor: { enabled: false },
          grok: { enabled: false },
          opencode: { enabled: true },
        },
      }),
    ),
  ),
);
