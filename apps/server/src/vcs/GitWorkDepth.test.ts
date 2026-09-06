/**
 * GitWorkDepth is the one bound on the environment's own git work.
 *
 * These tests state the two things callers rely on: how the depth is chosen,
 * and that `layer` hands every consumer the same gate, so the bound survives a
 * layer being built more than once.
 */
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as GitWorkDepth from "./GitWorkDepth.ts";

describe("resolveGitWorkDepth", () => {
  it("tracks the host's parallelism between 4 and 16", () => {
    expect(GitWorkDepth.resolveGitWorkDepth({ availableParallelism: 2 })).toBe(4);
    expect(GitWorkDepth.resolveGitWorkDepth({ availableParallelism: 8 })).toBe(8);
    expect(GitWorkDepth.resolveGitWorkDepth({ availableParallelism: 128 })).toBe(16);
  });

  it("takes a numeric override, clamped to the allowed range", () => {
    expect(GitWorkDepth.resolveGitWorkDepth({ override: "3", availableParallelism: 8 })).toBe(3);
    expect(GitWorkDepth.resolveGitWorkDepth({ override: " 32 ", availableParallelism: 8 })).toBe(
      32,
    );
    expect(GitWorkDepth.resolveGitWorkDepth({ override: "9999", availableParallelism: 8 })).toBe(
      GitWorkDepth.MAX_GIT_WORK_DEPTH,
    );
  });

  it("falls back to the default for an override that is not a positive count", () => {
    for (const override of [undefined, "", "   ", "0", "-4", "eight", "4.5"]) {
      expect(GitWorkDepth.resolveGitWorkDepth({ override, availableParallelism: 8 })).toBe(8);
    }
  });
});

describe("GitWorkDepth.layer", () => {
  it.effect("hands every build of the layer the same process-wide gate", () =>
    Effect.gen(function* () {
      const first = yield* GitWorkDepth.GitWorkDepth.pipe(Effect.provide(GitWorkDepth.layer));
      const second = yield* GitWorkDepth.GitWorkDepth.pipe(Effect.provide(GitWorkDepth.layer));

      expect(second).toBe(first);
    }),
  );

  it.effect("gives an explicit depth its own gate", () =>
    Effect.gen(function* () {
      const gate = yield* GitWorkDepth.GitWorkDepth.pipe(Effect.provide(GitWorkDepth.layerWith(2)));
      const other = yield* GitWorkDepth.GitWorkDepth.pipe(
        Effect.provide(GitWorkDepth.layerWith(2)),
      );

      expect(gate.depth).toBe(2);
      expect(other).not.toBe(gate);
    }),
  );
});
