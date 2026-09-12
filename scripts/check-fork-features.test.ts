import { assert, describe, it } from "@effect/vitest";

import {
  ForkFeatureManifestError,
  collectClaimedPaths,
  findMissingPaths,
  parseForkFeatures,
  planTestRuns,
  type ForkFeature,
} from "./check-fork-features.ts";

const feature = (overrides: Partial<ForkFeature> = {}): ForkFeature => ({
  name: "fork-app-identity",
  description: "The fork installs beside official T3 Code.",
  keep: "Our app id and product name replace upstream's; everything else takes upstream.",
  files: ["apps/desktop/src/app/DesktopEnvironment.ts"],
  test: "apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts",
  patchesUpstream: true,
  ...overrides,
});

describe("check-fork-features", () => {
  it("parses a well-formed manifest", () => {
    const features = parseForkFeatures(JSON.stringify({ features: [feature()] }));

    assert.equal(features.length, 1);
    assert.equal(features[0]?.name, "fork-app-identity");
    assert.equal(features[0]?.patchesUpstream, true);
  });

  it("reports every shape problem at once", () => {
    const source = JSON.stringify({
      features: [{ name: "half-written", files: [], test: 7 }],
    });

    assert.throws(() => parseForkFeatures(source), ForkFeatureManifestError);
    try {
      parseForkFeatures(source);
    } catch (error) {
      const problems = (error as ForkFeatureManifestError).problems;
      assert.equal(problems.length, 5);
      assert.include(problems.join("\n"), `half-written: "description" must be a string`);
      assert.include(problems.join("\n"), `half-written: "keep" must say what of ours survives`);
      assert.include(problems.join("\n"), `half-written: "files" must be a non-empty array`);
      assert.include(problems.join("\n"), `half-written: "test" must be a test file path`);
      assert.include(problems.join("\n"), `half-written: "patchesUpstream" must be a boolean`);
    }
  });

  it("rejects a feature with no keep line", () => {
    const source = JSON.stringify({ features: [{ ...feature(), keep: "  " }] });

    assert.throws(() => parseForkFeatures(source), /"keep" must say what of ours survives/);
  });

  it("rejects a keep line that never says what takes upstream", () => {
    const source = JSON.stringify({
      features: [{ ...feature(), keep: "Our app id and product name are ours." }],
    });

    assert.throws(() => parseForkFeatures(source), /"keep" must say what of ours survives/);
  });

  it("rejects a duplicate feature name", () => {
    const source = JSON.stringify({ features: [feature(), feature()] });

    assert.throws(() => parseForkFeatures(source), /duplicate "name"/);
  });

  it("rejects a manifest with no features", () => {
    assert.throws(() => parseForkFeatures(JSON.stringify({ features: [] })), /non-empty/);
    assert.throws(() => parseForkFeatures("{"), /not valid JSON/);
  });

  it("claims every listed file and the test file", () => {
    const claimed = collectClaimedPaths([feature({ files: ["a.ts", "b.ts"], test: "a.test.ts" })]);

    assert.deepEqual(
      claimed.map((entry) => entry.path),
      ["a.ts", "b.ts", "a.test.ts"],
    );
    assert.deepEqual(
      claimed.map((entry) => entry.kind),
      ["file", "file", "test"],
    );
  });

  it("names the feature that lost a path", () => {
    const missing = findMissingPaths(
      [feature({ name: "terminal-poll", files: ["gone.ts"], test: "kept.test.ts" })],
      (path) => path === "kept.test.ts",
    );

    assert.deepEqual(missing, [`terminal-poll: file "gone.ts" does not exist`]);
  });

  it("batches unnamed tests into one run and gives each named test its own", () => {
    const runs = planTestRuns([
      feature({ name: "one", test: "one.test.ts" }),
      feature({ name: "two", test: "two.test.ts" }),
      feature({ name: "three", test: "three.test.ts", testName: "keeps the fork home" }),
    ]);

    assert.deepEqual(runs, [
      ["one.test.ts", "two.test.ts"],
      ["three.test.ts", "-t", "keeps the fork home"],
    ]);
  });

  it("does not repeat a test file two features share", () => {
    const runs = planTestRuns([
      feature({ name: "one", test: "shared.test.ts" }),
      feature({ name: "two", test: "shared.test.ts" }),
    ]);

    assert.deepEqual(runs, [["shared.test.ts"]]);
  });
});
