/**
 * RepositoryIdentityReactor - Repository identity resolution reactor interface.
 *
 * Owns the only background worker allowed to run `git` for a project's
 * repository identity, so read paths can serve a stored column instead.
 *
 * @module RepositoryIdentityReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * RepositoryIdentityReactorShape - Service API for identity resolution.
 */
export interface RepositoryIdentityReactorShape {
  /**
   * Resolve identities for projects that need one, then keep reacting to
   * project domain events.
   *
   * The returned effect must be run in a scope so the worker fiber can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * RepositoryIdentityReactor - Service tag for identity resolution workers.
 */
export class RepositoryIdentityReactor extends Context.Service<
  RepositoryIdentityReactor,
  RepositoryIdentityReactorShape
>()("t3/orchestration/Services/RepositoryIdentityReactor") {}
