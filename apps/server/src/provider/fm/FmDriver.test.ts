/**
 * FORK DELTA (fm provider) - one home, one instance.
 *
 * `supportsMultipleInstances` is about homes, not about doors on one home. The
 * First Mate side does not refuse the second door: `fm_engine::turn::start`
 * only stops the existing process tree when the unit has no live turn, and
 * takes no lock against a second concurrent turn, so two instances prompting
 * one home start two harnesses against one conversation. The refusal has to be
 * here.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { ProviderInstanceId } from "@t3tools/contracts";

import { claimFmHome, resetFmHomeClaims } from "./FmDriver.ts";
import { resolveFmHome } from "./FmHome.ts";

const instance = (id: string) => ProviderInstanceId.make(id);

const withFreshClaims = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    resetFmHomeClaims();
    return yield* body;
  }).pipe(Effect.scoped, Effect.ensuring(Effect.sync(resetFmHomeClaims)));

it.effect("refuses a second instance pointed at a home another one already serves", () =>
  withFreshClaims(
    Effect.gen(function* () {
      const first = resolveFmHome({ homePath: "C:/homes/one" });
      yield* claimFmHome({ home: first, instanceId: instance("fm-one") });

      // A trailing separator is the same home, and the door would derive the
      // same session identity from it.
      const second = resolveFmHome({ homePath: "C:/homes/one/" });
      const error = yield* claimFmHome({
        home: second,
        instanceId: instance("fm-two"),
      }).pipe(Effect.flip);

      assert.equal(error._tag, "ProviderDriverError");
      assert.include(error.detail, "fm-one");
      assert.include(error.detail, "C:/homes/one");
    }),
  ),
);

it.effect("lets a fleet of mates run, one instance per home", () =>
  withFreshClaims(
    Effect.gen(function* () {
      yield* claimFmHome({
        home: resolveFmHome({ homePath: "C:/homes/one" }),
        instanceId: instance("fm-one"),
      });
      yield* claimFmHome({
        home: resolveFmHome({ homePath: "C:/homes/two" }),
        instanceId: instance("fm-two"),
      });
      // Reloading an instance re-claims the home it already holds, rather than
      // locking itself out of it.
      yield* claimFmHome({
        home: resolveFmHome({ homePath: "C:/homes/one" }),
        instanceId: instance("fm-one"),
      });
    }),
  ),
);

it.effect("releases the home when the instance that claimed it is torn down", () =>
  withFreshClaims(
    Effect.gen(function* () {
      const home = resolveFmHome({ homePath: "C:/homes/one" });
      const scope = yield* Scope.make("sequential");
      yield* claimFmHome({ home, instanceId: instance("fm-one") }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );

      yield* Scope.close(scope, Exit.void);

      // Removing an instance and adding one on the same home is an ordinary
      // thing to do; a claim that outlived its owner would be a one-way door.
      yield* claimFmHome({ home, instanceId: instance("fm-two") });
    }),
  ),
);

it.effect("treats two empty configs as the same default home", () =>
  withFreshClaims(
    Effect.gen(function* () {
      // The shape a user actually reaches by accident: add a second First Mate
      // provider, leave the home path blank, and both doors serve the same
      // supervisor conversation.
      const home = resolveFmHome({}, {});
      yield* claimFmHome({ home, instanceId: instance("fm-one") });
      const error = yield* claimFmHome({
        home: resolveFmHome({}, {}),
        instanceId: instance("fm-two"),
      }).pipe(Effect.flip);

      assert.equal(error._tag, "ProviderDriverError");
    }),
  ),
);
