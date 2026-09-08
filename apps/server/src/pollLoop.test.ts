import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";

import * as PollLoop from "./pollLoop.ts";

/** The terminal poll's own configuration: 2 s, doubling, capped at 16 s. */
const terminalConfig = {
  basePeriod: Duration.seconds(2),
  factor: 2,
  maxMultiplier: 8,
} satisfies PollLoop.BackoffPollConfig;

/** The gaps between consecutive round starts, in milliseconds. */
const gapsOf = (starts: ReadonlyArray<number>): ReadonlyArray<number> =>
  starts.slice(1).map((start, index) => start - (starts[index] ?? 0));

/**
 * Forks `poll.run` on a round that only records the clock, and hands the
 * recording back. The fork is interrupted when the test effect ends.
 */
const recordRoundStarts = Effect.fn("pollLoop.test.recordRoundStarts")(function* (
  poll: PollLoop.BackoffPoll,
) {
  const starts: Array<number> = [];
  const fiber = yield* Effect.forkChild(
    poll.run(
      Effect.gen(function* () {
        starts.push(yield* Clock.currentTimeMillis);
      }),
    ),
    { startImmediately: true },
  );
  yield* Effect.addFinalizer(() => Fiber.interrupt(fiber));
  return starts;
});

/** Advances the test clock by `stepMs` at a time, `steps` times. */
const stepClock = (steps: number, stepMs: number) =>
  Effect.forEach(
    Array.from({ length: steps }, (_, index) => index),
    () => TestClock.adjust(Duration.millis(stepMs)),
    { discard: true },
  );

it.effect("runs the first round at the base period, then backs off by the factor", () =>
  Effect.gen(function* () {
    const poll = yield* PollLoop.makeBackoffPoll(terminalConfig);
    const starts = yield* recordRoundStarts(poll);

    // 46 s is far enough to see the cap hold for two rounds after 2, 4, 8, 16.
    yield* stepClock(92, 500);

    assert.deepStrictEqual(starts, [0, 2_000, 6_000, 14_000, 30_000, 46_000]);
    assert.deepStrictEqual(gapsOf(starts), [2_000, 4_000, 8_000, 16_000, 16_000]);
  }),
);

it.effect("never lets the back-off pass the configured multiple of the base period", () =>
  Effect.gen(function* () {
    const poll = yield* PollLoop.makeBackoffPoll(terminalConfig);
    const starts = yield* recordRoundStarts(poll);

    yield* stepClock(240, 500);

    const gaps = gapsOf(starts);
    expect(gaps.length).toBeGreaterThan(5);
    assert.equal(Math.max(...gaps), 16_000);
  }),
);

it.effect("a wake puts the next round back on the base period", () =>
  Effect.gen(function* () {
    const poll = yield* PollLoop.makeBackoffPoll(terminalConfig);
    const starts = yield* recordRoundStarts(poll);

    // Rounds at 0, 2000, 6000 and 14000. The round at 14000 is waiting out 16 s.
    yield* stepClock(28, 500);
    assert.deepStrictEqual(starts, [0, 2_000, 6_000, 14_000]);

    poll.wakeUnsafe();
    yield* stepClock(12, 500);

    // The wake is served once the base period is up, and the round it triggers
    // is followed by another base period, not by the 16 s it had backed off to.
    assert.deepStrictEqual(gapsOf(starts).slice(-2), [2_000, 2_000]);
  }),
);

it.effect("a wake cannot drive a round faster than the base period", () =>
  Effect.gen(function* () {
    const poll = yield* PollLoop.makeBackoffPoll(terminalConfig);
    const starts = yield* recordRoundStarts(poll);

    // A host that is chatty on every tick: wake far more often than the period.
    for (let step = 0; step < 120; step += 1) {
      poll.wakeUnsafe();
      yield* TestClock.adjust(Duration.millis(250));
    }

    const gaps = gapsOf(starts);
    expect(gaps.length).toBeGreaterThan(10);
    assert.equal(Math.min(...gaps), 2_000);
    assert.equal(Math.max(...gaps), 2_000);
  }),
);

it.effect("a round that dies is the caller's problem, so the loop does not survive it", () =>
  Effect.gen(function* () {
    const poll = yield* PollLoop.makeBackoffPoll(terminalConfig);
    let rounds = 0;
    const fiber = yield* Effect.forkChild(
      poll.run(
        Effect.sync(() => {
          rounds += 1;
        }).pipe(Effect.andThen(Effect.die(new Error("probe blew up")))),
      ),
      { startImmediately: true },
    );

    yield* stepClock(20, 500);

    // One round, then the loop is gone: `pollLoop` deliberately does not catch,
    // so each caller wraps its own round and logs its own defect.
    assert.equal(rounds, 1);
    const exit = yield* Fiber.await(fiber);
    expect(exit._tag).toBe("Failure");
  }),
);
