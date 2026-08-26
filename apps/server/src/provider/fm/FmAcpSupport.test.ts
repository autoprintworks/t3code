/**
 * FORK DELTA (fm provider) - the spawn contract.
 *
 * The certification suite in `FmTranscript.test.ts` replaces the spawn with a
 * transcript-backed stub, so this file is where the argv the driver would hand
 * the operating system is pinned down. Between the two, every layer of the
 * shipping path is asserted.
 */
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { FmSettings } from "@t3tools/contracts";

import {
  buildFmAcpSpawnInput,
  FM_AUTH_METHOD_ID,
  FM_CLIENT_CAPABILITIES,
  FM_MCP_SERVERS,
  currentFmModelIdFromSessionSetup,
  resolveFmModelId,
} from "./FmAcpSupport.ts";

const decodeFmSettings = Schema.decodeSync(FmSettings);

it("spawns `fm-acp` with no `--home` when the instance serves the default home", () => {
  const spawn = buildFmAcpSpawnInput(decodeFmSettings({}), "C:/work/repo");

  assert.equal(spawn.command, "fm-acp");
  assert.deepStrictEqual(spawn.args, []);
  assert.equal(spawn.cwd, "C:/work/repo");
});

it("points a second mate's instance at its own home with `--home`", () => {
  const spawn = buildFmAcpSpawnInput(
    decodeFmSettings({ homePath: "C:/Users/captain/.firstmate/second" }),
    "C:/work/repo",
  );

  assert.deepStrictEqual(spawn.args, ["--home", "C:/Users/captain/.firstmate/second"]);
});

it("honours an explicit binaryPath and trims a padded home path", () => {
  const spawn = buildFmAcpSpawnInput(
    decodeFmSettings({
      binaryPath: "C:/Users/captain/.cargo/bin/fm-acp.exe",
      homePath: "  C:/homes/two  ",
    }),
    "C:/work/repo",
    { FM_V2_HOME: "C:/ignored" },
  );

  assert.equal(spawn.command, "C:/Users/captain/.cargo/bin/fm-acp.exe");
  assert.deepStrictEqual(spawn.args, ["--home", "C:/homes/two"]);
  assert.deepStrictEqual(spawn.env, { FM_V2_HOME: "C:/ignored" });
});

it("declares no filesystem and no terminal capability to the door", () => {
  // ID-10 host invariant. The supervisor conversation is text in, text out;
  // advertising either capability would invite a future door revision to use
  // it, and the golden transcripts would not catch that.
  assert.deepStrictEqual(FM_CLIENT_CAPABILITIES, {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  });
  assert.deepStrictEqual(FM_MCP_SERVERS, []);
  assert.equal(FM_AUTH_METHOD_ID, "none");
});

it("treats door model ids as opaque and invents none of its own", () => {
  assert.equal(resolveFmModelId(" opencode "), "opencode");
  // No fallback id: a model T3 Code names is a model the door never offered.
  assert.equal(resolveFmModelId(""), undefined);
  assert.equal(resolveFmModelId(undefined), undefined);

  assert.equal(
    currentFmModelIdFromSessionSetup({
      sessionId: "fm-1a2b3c4d5e6f7a8b",
      models: { availableModels: [{ modelId: "pi", name: "pi" }], currentModelId: "pi" },
    }),
    "pi",
  );
  // `daemon-not-there` answers `session/new` with no model list at all.
  assert.equal(currentFmModelIdFromSessionSetup({ sessionId: "fm-1a2b3c4d5e6f7a8b" }), undefined);
});
