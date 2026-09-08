/**
 * The one back-off poll engine on the server.
 *
 * Two subsystems watch the host on a timer: the terminal subprocess check
 * (`terminal/Manager.ts`) and the preview port scanner (`preview/PortScanner.ts`).
 * Both want the same policy, so the policy lives here once and each caller
 * passes a `BackoffPollConfig` rather than keeping its own constant triple.
 *
 * The policy, in one place:
 *
 * - The period is the gap between round *starts*, not the gap after a round.
 *   A round that takes 500 ms out of a 2000 ms period is followed by a 1500 ms
 *   wait, so the configured period is the cadence you actually observe.
 * - A round that changes nothing backs the period off geometrically, by
 *   `factor` each time, capped at `maxMultiplier` times the base.
 * - `wakeUnsafe()` says "something changed". The round that a wake triggers
 *   runs at the base period: the wake is read and consumed before the round is
 *   run, so it is the round's own cadence that resets, not merely the tail of
 *   the sleep that the wake interrupted.
 * - A wake never cuts the base period short. Only the backed-off remainder is
 *   raced against the wake, so a chatty host restores the base cadence at once
 *   without being able to drive the poll faster than its configured rate.
 *
 * Mutual exclusion is deliberately not here. A caller that can genuinely
 * re-enter its round wants a `Semaphore`, and what it should do when it finds
 * one in flight (skip, coalesce, or queue) is a question about that caller, not
 * about back-off.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Ref from "effect/Ref";

export interface BackoffPollConfig {
  /** Names the loop in its debug logs. */
  readonly label: string;
  /** The cadence when something is happening, and the floor a wake resets to. */
  readonly basePeriod: Duration.Duration;
  /** Multiplier applied to the period after each round that changed nothing. */
  readonly factor: number;
  /** Ceiling on the back-off, as a multiple of `basePeriod`. */
  readonly maxMultiplier: number;
}

export interface BackoffPoll {
  /**
   * Signals that something changed, so the next round runs at the base period.
   * Allocation-free, so it is safe on a hot path such as terminal output.
   */
  readonly wakeUnsafe: () => void;
  /** `wakeUnsafe` for call sites that are already in an Effect. */
  readonly wake: Effect.Effect<void>;
  /** Runs `round` forever on the configured cadence. Fork it. */
  readonly run: (round: Effect.Effect<void>) => Effect.Effect<never>;
  /** The period the next round will use. Exposed for tests. */
  readonly currentPeriodMs: Effect.Effect<number>;
}

/**
 * Floor on the gap between two round starts, for a round that overran its
 * period. Every caller sizes its probe timeouts strictly under its base period,
 * so a round should never reach this; it is here so that a round which somehow
 * does overrun cannot turn the loop into a spin. It never raises the gap above
 * the configured base period, so a caller that asks for a short period (a test,
 * usually) still gets the cadence it asked for.
 */
const MIN_ROUND_GAP_MS = 50;

export const makeBackoffPoll = Effect.fn("pollLoop.makeBackoffPoll")(function* (
  config: BackoffPollConfig,
) {
  const wakeLatch = yield* Latch.make(false);
  const basePeriodMs = Duration.toMillis(config.basePeriod);
  const maxPeriodMs = basePeriodMs * config.maxMultiplier;
  const periodRef = yield* Ref.make(basePeriodMs);

  const run = (round: Effect.Effect<void>): Effect.Effect<never> =>
    Effect.forever(
      Effect.gen(function* () {
        // Read and consume the wake before the round, not after: this is what
        // makes the round that a wake triggers run at the base period. An event
        // that lands during the round reopens the latch and is picked up by the
        // next iteration, so nothing is dropped.
        const woken = Latch.isOpen(wakeLatch);
        if (woken) yield* Latch.close(wakeLatch);
        const periodMs = yield* Ref.updateAndGet(periodRef, (current) =>
          woken ? basePeriodMs : Math.min(current * config.factor, maxPeriodMs),
        );

        const startedAt = yield* Clock.currentTimeMillis;
        yield* round;
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;

        const baseWaitMs = Math.max(
          basePeriodMs - elapsedMs,
          Math.min(MIN_ROUND_GAP_MS, basePeriodMs),
        );
        yield* Effect.sleep(Duration.millis(baseWaitMs));
        const remainderMs = periodMs - basePeriodMs;
        if (remainderMs > 0) {
          yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(remainderMs)),
            Latch.await(wakeLatch),
          );
        }
      }),
    );

  return {
    wakeUnsafe: () => {
      Latch.openUnsafe(wakeLatch);
    },
    wake: Effect.sync(() => {
      Latch.openUnsafe(wakeLatch);
    }),
    run,
    currentPeriodMs: Ref.get(periodRef),
  } satisfies BackoffPoll;
});
