/**
 * FORK DELTA (fm provider) - the refusal, and the ordering that keeps it rare.
 *
 * `fm` is the one provider that cannot write a commit message, so the refusal
 * has to name the way out. It also has to be the last resort: the text
 * generation fallback walks `ServerSettings.providers` in declaration order and
 * takes the first enabled entry, and `fm` is declared last there on purpose
 * (`packages/contracts/src/settings.ts`). That is a positional invariant with
 * nothing but a comment holding it, so it is asserted here.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ProviderInstanceId } from "@t3tools/contracts";

import { layerTest, ServerSettingsService } from "../../serverSettings.ts";
import { makeFmTextGeneration } from "./FmTextGeneration.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("fm"),
  model: "claude",
} as const;

it.effect("refuses every generated-text operation, and names the way out", () =>
  Effect.gen(function* () {
    const textGeneration = yield* makeFmTextGeneration();

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

it.effect("is the last provider the text generation fallback would ever pick", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const settings = yield* serverSettings.getSettings;

    // Declaration order is the fallback order, so `fm` last means any other
    // enabled provider wins.
    assert.equal(Object.keys(settings.providers).at(-1), "fm");
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
          fm: { enabled: true },
        },
      }),
    ),
  ),
);
