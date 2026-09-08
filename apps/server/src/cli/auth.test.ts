import {
  AuthAdministrativeScopes,
  AuthFleetScopes,
  AuthFleetSubject,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { FleetSubjectScopeError, resolveIssuedScopes } from "./auth.ts";

/**
 * The token the First Mate daemon runs on is the one the server trusts to
 * create a thread the user cannot prompt, so what it may do besides that is
 * worth keeping small. These pin the pinning: the subject decides the scope
 * set, not the caller.
 */
it.effect("issues the fleet scope set for the fleet subject", () =>
  Effect.gen(function* () {
    const fleetSubject = Option.some(AuthFleetSubject);

    assert.deepStrictEqual(
      yield* resolveIssuedScopes(Option.none(), fleetSubject),
      AuthFleetScopes,
    );
    assert.deepStrictEqual(
      yield* resolveIssuedScopes(Option.some("fleet"), fleetSubject),
      AuthFleetScopes,
    );
  }),
);

it.effect("refuses a wider scope set under the fleet subject", () =>
  Effect.gen(function* () {
    // Refused rather than quietly narrowed, so a caller that wanted an admin
    // token learns it did not get one.
    const error = yield* resolveIssuedScopes(
      Option.some("administrative"),
      Option.some(AuthFleetSubject),
    ).pipe(Effect.flip);

    assert.instanceOf(error, FleetSubjectScopeError);
    assert.include(error.message, AuthFleetSubject);
  }),
);

it.effect("leaves every other subject on the administrative default", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* resolveIssuedScopes(Option.none(), Option.some("headless-admin")),
      AuthAdministrativeScopes,
    );
    assert.deepStrictEqual(
      yield* resolveIssuedScopes(Option.none(), Option.none()),
      AuthAdministrativeScopes,
    );
  }),
);

it.effect("honours an explicit scope set for an ordinary subject", () =>
  Effect.gen(function* () {
    const ordinarySubject = Option.some("headless-admin");

    assert.deepStrictEqual(
      yield* resolveIssuedScopes(Option.some("client"), ordinarySubject),
      AuthStandardClientScopes,
    );
    assert.deepStrictEqual(
      yield* resolveIssuedScopes(Option.some("fleet"), ordinarySubject),
      AuthFleetScopes,
    );
  }),
);
