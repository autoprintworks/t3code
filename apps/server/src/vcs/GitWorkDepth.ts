/**
 * GitWorkDepth - the one bound on the environment's own git work.
 *
 * Every `git` the environment runs for itself passes a permit from here: the
 * status subscriptions behind [VcsProcess.ts](./VcsProcess.ts), and the
 * repository identity resolution in
 * [RepositoryIdentityResolver.ts](../project/RepositoryIdentityResolver.ts).
 * Each spawn is a burst of filesystem work on the libuv threadpool (PATH
 * resolution alone walks dozens of directories on Windows), and once that queue
 * is deep every unrelated request behind it waits too. Depth, not the number of
 * open threads, is the lever: a hundred watched projects still cost at most
 * `depth` concurrent spawns.
 *
 * The default tracks the host's parallelism, clamped to 4..16, so ordinary
 * single-repo use never waits. `T3CODE_GIT_WORK_DEPTH` overrides it.
 *
 * `layer` hands out one gate for the whole process. The bound has to be
 * process-wide to mean anything - the threadpool it protects is - and the
 * layer is built in several places, including once per WebSocket connection,
 * so a per-build semaphore would let N clients cost N times the depth. A test
 * that wants its own bound uses `layerWith`.
 *
 * @module GitWorkDepth
 */
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/**
 * GitWorkDepth - Service tag for the shared git work bound.
 */
export class GitWorkDepth extends Context.Service<
  GitWorkDepth,
  {
    /** How many git subprocesses the environment may have in flight at once. */
    readonly depth: number;
    /** Runs `effect` holding one of the `depth` permits. */
    readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/vcs/GitWorkDepth") {}

/** Environment variable that overrides the derived default. */
export const GIT_WORK_DEPTH_ENV_VAR = "T3CODE_GIT_WORK_DEPTH";

/** An override outside this range is clamped into it; one permit is the floor. */
export const MIN_GIT_WORK_DEPTH = 1;
export const MAX_GIT_WORK_DEPTH = 64;

const DEFAULT_MIN_GIT_WORK_DEPTH = 4;
const DEFAULT_MAX_GIT_WORK_DEPTH = 16;

const clamp = (value: number) => Math.max(MIN_GIT_WORK_DEPTH, Math.min(MAX_GIT_WORK_DEPTH, value));

/**
 * Resolves the depth from an optional `T3CODE_GIT_WORK_DEPTH` value.
 *
 * A missing, non-numeric, or zero override falls back to the derived default,
 * so a typo widens nothing and closes nothing.
 */
export const resolveGitWorkDepth = (options?: {
  readonly override?: string | undefined;
  readonly availableParallelism?: number | undefined;
}): number => {
  const override = options?.override?.trim() ?? "";
  const parsed = /^\d+$/.test(override) ? Number(override) : 0;
  if (parsed > 0) {
    return clamp(parsed);
  }

  // The 4..16 default band sits inside MIN..MAX, so it needs no further clamp.
  const availableParallelism = options?.availableParallelism ?? NodeOS.availableParallelism();
  return Math.max(
    DEFAULT_MIN_GIT_WORK_DEPTH,
    Math.min(DEFAULT_MAX_GIT_WORK_DEPTH, availableParallelism),
  );
};

const makeUnsafe = (depth: number): GitWorkDepth["Service"] => {
  const semaphore = Semaphore.makeUnsafe(depth);
  return GitWorkDepth.of({ depth, withPermit: semaphore.withPermits(1) });
};

/** A gate of its own, isolated from every other. */
export const makeWith = (depth: number) => Effect.sync(() => makeUnsafe(depth));

let processGate: GitWorkDepth["Service"] | undefined;

/** The one gate this process shares, created on first use. */
export const make = Effect.sync(() => {
  processGate ??= makeUnsafe(
    resolveGitWorkDepth({ override: process.env[GIT_WORK_DEPTH_ENV_VAR] }),
  );
  return processGate;
});

export const layer = Layer.effect(GitWorkDepth, make);

/** A gate of an explicit depth, for tests and for stacks that want their own. */
export const layerWith = (depth: number) => Layer.effect(GitWorkDepth, makeWith(depth));
