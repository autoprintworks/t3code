/**
 * FORK DELTA (fm provider) - what a failed probe tells the user.
 *
 * The failure a misconfigured user actually hits is "no daemon is serving that
 * home". The door says so in its own words, and the home path is the one thing
 * the user can go and check, so both have to survive the trip to the settings
 * card.
 */
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import { FmSettings } from "@t3tools/contracts";

import { FM_HOME_ENV_VAR, resolveFmHome } from "./FmHome.ts";
import { buildFmDiscoveryFailureMessage } from "./FmProvider.ts";

const decodeFmSettings = Schema.decodeSync(FmSettings);

class DoorRefused extends Error {}

it("gives the door its own words back, and names the home it tried", () => {
  const home = resolveFmHome(decodeFmSettings({ homePath: "D:/mates/atlas" }), {});
  const message = buildFmDiscoveryFailureMessage(
    home,
    Cause.fail(new DoorRefused("no daemon is listening on D:/mates/atlas/daemon.sock")),
  );

  assert.ok(message.includes("no daemon is listening on D:/mates/atlas/daemon.sock"));
  assert.ok(message.includes(home.path));
  assert.ok(message.includes("First Mate home path setting"));
});

it("still names the home when the failure carries no words of its own", () => {
  const home = resolveFmHome(decodeFmSettings({}), { [FM_HOME_ENV_VAR]: "D:/mates/atlas" });
  const message = buildFmDiscoveryFailureMessage(home, Cause.die("boom"));

  assert.ok(message.includes(home.path));
  assert.ok(message.includes(FM_HOME_ENV_VAR));
  // A generic sentence is fine as long as it still points somewhere.
  assert.ok(message.includes("Check that a First Mate daemon is serving this home"));
});
