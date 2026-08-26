/**
 * FORK DELTA (fm provider) - home resolution.
 *
 * The settings placeholder for the home path is `~/.firstmate/v2`, so a tilde
 * is the value users are actively invited to type. Nothing expands it for a
 * spawned process, and on Windows nothing expands it at all, so a raw
 * pass-through would hand the door a literal directory named `~`.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { FmSettings } from "@t3tools/contracts";

import { buildFmAcpSpawnInput } from "./FmAcpSupport.ts";
import { describeFmHome, FM_HOME_ENV_VAR, fmHomeKey, resolveFmHome } from "./FmHome.ts";

const decodeFmSettings = Schema.decodeSync(FmSettings);

it("expands a tilde home path before the door ever sees it", () => {
  const expected = NodePath.join(NodeOS.homedir(), ".firstmate", "v2");

  const home = resolveFmHome(decodeFmSettings({ homePath: "~/.firstmate/v2" }));
  assert.equal(home.path, expected);
  assert.equal(home.source, "setting");

  // The argv is the thing that actually reaches the operating system.
  const spawn = buildFmAcpSpawnInput(
    decodeFmSettings({ homePath: "  ~/.firstmate/v2  " }),
    "C:/work/repo",
  );
  assert.deepStrictEqual(spawn.args, ["--home", expected]);

  // A bare `~` is a home path too, and `~\` is how a Windows user types it.
  assert.equal(resolveFmHome({ homePath: "~" }).path, NodeOS.homedir());
  assert.equal(
    resolveFmHome({ homePath: String.raw`~\firstmate` }).path,
    NodePath.join(NodeOS.homedir(), "firstmate"),
  );
});

it("follows the door's own resolution order", () => {
  // Setting beats environment beats default, which is what `fm-acp --home`
  // documents. Getting this order wrong would claim one home and serve another.
  assert.equal(
    resolveFmHome({ homePath: "C:/homes/one" }, { [FM_HOME_ENV_VAR]: "C:/homes/two" }).path,
    "C:/homes/one",
  );

  const fromEnvironment = resolveFmHome(decodeFmSettings({}), {
    [FM_HOME_ENV_VAR]: "C:/homes/two",
  });
  assert.equal(fromEnvironment.path, "C:/homes/two");
  assert.equal(fromEnvironment.source, "environment");

  const fallback = resolveFmHome(decodeFmSettings({}), {});
  assert.equal(fallback.path, NodePath.join(NodeOS.homedir(), ".firstmate", "v2"));
  assert.equal(fallback.source, "default");
});

it("gives two spellings of one home the same claim key", () => {
  // The door derives its session identity from the normalised home path, so
  // two instances spelt differently are still one conversation.
  const one = resolveFmHome({ homePath: "C:/homes/one" });
  const two = resolveFmHome({ homePath: "C:/homes/one/" });
  assert.equal(fmHomeKey(one, "win32"), fmHomeKey(two, "win32"));

  assert.notEqual(
    fmHomeKey(one, "win32"),
    fmHomeKey(resolveFmHome({ homePath: "C:/homes/two" }), "win32"),
  );

  // Case folds where the filesystem does, and only there.
  const shouted = resolveFmHome({ homePath: "C:/Homes/One" });
  assert.equal(fmHomeKey(one, "win32"), fmHomeKey(shouted, "win32"));
  assert.equal(fmHomeKey(one, "darwin"), fmHomeKey(shouted, "darwin"));
  assert.notEqual(fmHomeKey(one, "linux"), fmHomeKey(shouted, "linux"));
});

it("names where the home came from, so a failed probe can say it", () => {
  assert.include(describeFmHome(resolveFmHome({ homePath: "C:/homes/one" })), "C:/homes/one");
  assert.include(
    describeFmHome(resolveFmHome(undefined, { [FM_HOME_ENV_VAR]: "C:/homes/two" })),
    FM_HOME_ENV_VAR,
  );
});
