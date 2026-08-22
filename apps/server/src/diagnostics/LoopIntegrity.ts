// @effect-diagnostics globalTimers:off - the sampler must be a raw timer. It
// measures the loop that Effect's scheduler runs on, so scheduling it through
// that scheduler would hide the very blocks it exists to find.
/**
 * Event loop integrity guard.
 *
 * Samples event loop lag with a short timer and reports the worst single block,
 * the total blocked time, and how many blocks exceeded a frame budget. When
 * attribution is enabled it also names the call site that owned the loop, using
 * the `async_hooks` init stacks of the handles created while the loop was
 * stuck.
 *
 * The loop cannot be sampled from inside itself while it is blocked, so a block
 * is only ever observed after it ends. Attribution therefore works backwards:
 * a synchronous blocking call almost always creates a libuv handle at the
 * moment it blocks (`PROCESSWRAP` for `child_process.spawn`, `FSREQCALLBACK`
 * for filesystem work), and that handle's init stack names the offending line.
 *
 * Use {@link watchLoopIntegrity} around a suspect code path, then
 * {@link assertLoopIntegrity} to fail on it. `LoopIntegrityGuard.ts` wires the
 * same sampler into the running server.
 */
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodePerfHooks from "node:perf_hooks";

/** Default lag, in milliseconds, below which a tick is not counted as a block. */
export const DEFAULT_BLOCK_THRESHOLD_MS = 5;

/** One 60Hz frame. Blocks longer than this drop a frame in every client. */
export const DEFAULT_FRAME_BUDGET_MS = 16;

/** A single block longer than this is a defect, not jitter. */
export const DEFAULT_FAIL_OVER_MS = 50;

/**
 * Highest period the sampler will ever treat as "the timer working normally".
 * Windows clamps timers to the ~15.6 ms system tick, so the requested interval
 * is not the real one and lag has to be measured against the real one. The cap
 * keeps a block that lands on the very first tick from being adopted as the
 * baseline and hidden.
 */
const MAX_BASELINE_PERIOD_MS = 25;

/**
 * How many recent periods the baseline is taken over. The Windows timer period
 * is not constant: it drops towards 1 ms while the loop is busy and returns to
 * the ~15.6 ms system tick when it goes quiet. The baseline is the median of
 * this window, not its minimum, because a single fast tick would otherwise set
 * the baseline and turn every ordinary tick after it into a 14 ms "block".
 */
const BASELINE_WINDOW_SAMPLES = 32;

export interface LoopIntegrityOptions {
  /** How often the sampler wakes. Lower resolves shorter blocks and costs more. */
  readonly sampleIntervalMs?: number;
  /** Lag below this is treated as scheduler jitter and ignored. */
  readonly blockThresholdMs?: number;
  /** Blocks longer than this are counted in `blocksOverFrameBudget`. */
  readonly frameBudgetMs?: number;
  /**
   * Capture `async_hooks` init stacks so blocks can name their call site.
   * Costs a stack capture per async resource, so it is opt-in.
   */
  readonly attributeStacks?: boolean;
  /** How many attributed blocks to retain. Older blocks keep their timings only. */
  readonly retainBlocks?: number;
  /** Async resource types that are never worth attributing a block to. */
  readonly ignoredResourceTypes?: ReadonlyArray<string>;
  /**
   * Called as each block is recorded. Use it to report a block while it is
   * still fresh, instead of waiting for the watch to stop.
   */
  readonly onBlock?: (block: LoopBlock) => void;
}

/** Where a block came from, recovered from an async resource's init stack. */
export interface LoopBlockAttribution {
  /** libuv/Node resource type, e.g. `PROCESSWRAP`, `FSREQCALLBACK`. */
  readonly resourceType: string;
  /**
   * `during` means the resource was created while the loop was stuck, which is
   * the strong signal. `before` means it was the last thing scheduled before
   * the loop went quiet, which is the fallback for pure-CPU blocks.
   */
  readonly phase: "during" | "before";
  readonly stack: string;
}

export interface LoopBlock {
  /** Milliseconds from the start of the watch to the start of the block. */
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly attributions: ReadonlyArray<LoopBlockAttribution>;
}

export interface LoopIntegrityReport {
  readonly watchedMs: number;
  readonly samples: number;
  /**
   * The sampler period the report calibrated against: the median of the recent
   * window, capped. On Windows this settles at the ~15.6 ms system tick
   * regardless of `sampleIntervalMs`, which is the resolution floor for every
   * block measurement in this report.
   */
  readonly baselinePeriodMs: number;
  readonly worstBlockMs: number;
  readonly totalBlockedMs: number;
  readonly blockCount: number;
  readonly blocksOverFrameBudget: number;
  readonly frameBudgetMs: number;
  readonly blocks: ReadonlyArray<LoopBlock>;
}

export interface LoopIntegrityWatch {
  /** Snapshot the report so far without stopping the sampler. */
  readonly report: () => LoopIntegrityReport;
  /** Stop sampling and return the final report. Safe to call more than once. */
  readonly stop: () => LoopIntegrityReport;
}

/**
 * Resource types that fire constantly and never name a blocking call. Timers
 * cover the sampler's own wakeups.
 */
const DEFAULT_IGNORED_RESOURCE_TYPES: ReadonlyArray<string> = [
  "TIMERWRAP",
  "Timeout",
  "Immediate",
  "TickObject",
  "PROMISE",
];

const EMPTY_REPORT_BLOCKS: ReadonlyArray<LoopBlock> = [];

/**
 * Resource types whose creation is itself a synchronous call that can block the
 * loop thread. `PROCESSWRAP` is `uv_spawn`, which runs `CreateProcessW` inline
 * on Windows; the filesystem and name-resolution request types block whenever
 * the underlying call has no asynchronous path.
 *
 * These are listed first in a block's attributions. Everything else created in
 * the same turn is retained but ranked below, because a socket write or an IPC
 * message is almost always the rest of the process getting on with its work
 * rather than the thing that stopped the loop.
 */
const BLOCKING_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "PROCESSWRAP",
  "FSREQCALLBACK",
  "FSREQPROMISE",
  "FSEVENTWRAP",
  "GETADDRINFOREQWRAP",
  "GETNAMEINFOREQWRAP",
  "STATWATCHER",
]);

interface ResourceInit {
  readonly atMs: number;
  readonly resourceType: string;
  readonly stack: string;
}

/**
 * Frames deep enough to reach past an Effect fiber step into the caller that
 * actually blocked. V8's default of 10 stops inside the runtime.
 */
const ATTRIBUTION_STACK_FRAMES = 40;

function captureStack(): string {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, captureStack);
  return holder.stack ?? "";
}

/**
 * Start sampling event loop lag. Always call `stop()`, including on failure —
 * the sampler holds a timer and, with `attributeStacks`, an async hook.
 */
export const watchLoopIntegrity = (options: LoopIntegrityOptions = {}): LoopIntegrityWatch => {
  const sampleIntervalMs = options.sampleIntervalMs ?? 5;
  const blockThresholdMs = options.blockThresholdMs ?? DEFAULT_BLOCK_THRESHOLD_MS;
  const frameBudgetMs = options.frameBudgetMs ?? DEFAULT_FRAME_BUDGET_MS;
  const retainBlocks = options.retainBlocks ?? 32;
  const ignoredResourceTypes = new Set(
    options.ignoredResourceTypes ?? DEFAULT_IGNORED_RESOURCE_TYPES,
  );
  const onBlock = options.onBlock;

  const startedAt = NodePerfHooks.performance.now();
  let previousTickAt = startedAt;
  const recentPeriods = new Float64Array(BASELINE_WINDOW_SAMPLES);
  const sortedPeriods = new Float64Array(BASELINE_WINDOW_SAMPLES);
  let recentPeriodCount = 0;
  let recentPeriodIndex = 0;
  let baselinePeriodMs = MAX_BASELINE_PERIOD_MS;
  let samples = 0;
  let worstBlockMs = 0;
  let totalBlockedMs = 0;
  let blockCount = 0;
  let blocksOverFrameBudget = 0;
  let stoppedAt: number | undefined;

  const blocks: Array<LoopBlock> = [];
  const inits: Array<ResourceInit> = [];
  const initsCapacity = 512;

  const attributeStacks = options.attributeStacks === true;

  const hook = attributeStacks
    ? NodeAsyncHooks.createHook({
        init(_asyncId, type) {
          if (ignoredResourceTypes.has(type)) {
            return;
          }
          if (inits.length >= initsCapacity) {
            inits.splice(0, inits.length - initsCapacity + 1);
          }
          inits.push({
            atMs: NodePerfHooks.performance.now(),
            resourceType: type,
            stack: captureStack(),
          });
        },
      })
    : undefined;

  /**
   * `windowStart` is the previous tick, not the computed block start: a
   * blocking call usually creates its handle in the same turn that then stops
   * responding, which is a hair before the loop is measurably late.
   */
  const attribute = (
    windowStart: number,
    blockEndedAt: number,
  ): ReadonlyArray<LoopBlockAttribution> => {
    if (!attributeStacks || inits.length === 0) {
      return [];
    }
    const during = inits
      .filter((entry) => entry.atMs > windowStart && entry.atMs <= blockEndedAt)
      .map(
        (entry): LoopBlockAttribution => ({
          resourceType: entry.resourceType,
          phase: "during",
          stack: entry.stack,
        }),
      );
    if (during.length > 0) {
      // Distinct call sites only: a burst of spawns repeats one stack.
      const seen = new Set<string>();
      const distinct = during.filter((entry) => {
        if (seen.has(entry.stack)) {
          return false;
        }
        seen.add(entry.stack);
        return true;
      });
      // Stable, so equally ranked resources stay in the order they were created.
      return [
        ...distinct.filter((entry) => BLOCKING_RESOURCE_TYPES.has(entry.resourceType)),
        ...distinct.filter((entry) => !BLOCKING_RESOURCE_TYPES.has(entry.resourceType)),
      ];
    }
    for (let index = inits.length - 1; index >= 0; index -= 1) {
      const entry = inits[index]!;
      if (entry.atMs <= windowStart) {
        return [{ resourceType: entry.resourceType, phase: "before", stack: entry.stack }];
      }
    }
    return [];
  };

  const timer = setInterval(() => {
    const now = NodePerfHooks.performance.now();
    const periodMs = now - previousTickAt;
    samples += 1;
    // Calibrate against the period this sampler is actually achieving, never
    // against the requested interval, which the platform may not honour.
    recentPeriods[recentPeriodIndex] = periodMs;
    recentPeriodIndex = (recentPeriodIndex + 1) % BASELINE_WINDOW_SAMPLES;
    if (recentPeriodCount < BASELINE_WINDOW_SAMPLES) {
      recentPeriodCount += 1;
    }
    sortedPeriods.set(recentPeriods.subarray(0, recentPeriodCount));
    const window = sortedPeriods.subarray(0, recentPeriodCount);
    window.sort();
    // Capped, so a run of blocked ticks can never hide the blocks that follow.
    baselinePeriodMs = Math.min(window[recentPeriodCount >> 1]!, MAX_BASELINE_PERIOD_MS);
    const lagMs = periodMs - baselinePeriodMs;
    if (lagMs >= blockThresholdMs) {
      blockCount += 1;
      totalBlockedMs += lagMs;
      if (lagMs > worstBlockMs) {
        worstBlockMs = lagMs;
      }
      if (lagMs > frameBudgetMs) {
        blocksOverFrameBudget += 1;
      }
      const block: LoopBlock = {
        startedAtMs: previousTickAt + sampleIntervalMs - startedAt,
        durationMs: lagMs,
        attributions: attribute(previousTickAt, now),
      };
      blocks.push(block);
      if (blocks.length > retainBlocks) {
        // Keep the worst blocks, not the first ones.
        blocks.sort((left, right) => right.durationMs - left.durationMs);
        blocks.length = retainBlocks;
      }
      onBlock?.(block);
    }
    previousTickAt = now;
    if (attributeStacks) {
      // Init records older than the last tick can never attribute a future block.
      const cutoff = now - sampleIntervalMs * 4;
      let drop = 0;
      while (drop < inits.length && inits[drop]!.atMs < cutoff) {
        drop += 1;
      }
      if (drop > 0) {
        inits.splice(0, drop);
      }
    }
  }, sampleIntervalMs);
  timer.unref();

  let previousStackTraceLimit: number | undefined;
  if (hook !== undefined) {
    previousStackTraceLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = Math.max(previousStackTraceLimit, ATTRIBUTION_STACK_FRAMES);
    hook.enable();
  }

  const buildReport = (): LoopIntegrityReport => ({
    watchedMs: (stoppedAt ?? NodePerfHooks.performance.now()) - startedAt,
    samples,
    baselinePeriodMs,
    worstBlockMs,
    totalBlockedMs,
    blockCount,
    blocksOverFrameBudget,
    frameBudgetMs,
    blocks:
      blocks.length === 0
        ? EMPTY_REPORT_BLOCKS
        : [...blocks].sort((left, right) => right.durationMs - left.durationMs),
  });

  return {
    report: buildReport,
    stop: () => {
      if (stoppedAt === undefined) {
        stoppedAt = NodePerfHooks.performance.now();
        clearInterval(timer);
        hook?.disable();
        if (previousStackTraceLimit !== undefined) {
          Error.stackTraceLimit = previousStackTraceLimit;
        }
      }
      return buildReport();
    },
  };
};

/** Thrown when a single event loop block exceeded its budget. */
export class LoopBlockedError extends Error {
  override readonly name = "LoopBlockedError";
  readonly report: LoopIntegrityReport;
  readonly block: LoopBlock;

  constructor(message: string, report: LoopIntegrityReport, block: LoopBlock, stack: string) {
    super(message);
    this.report = report;
    this.block = block;
    this.stack = stack;
  }
}

const roundMs = (value: number): number => Math.round(value * 10) / 10;

/** One line summarising a report, suitable for a log or an assertion message. */
export const formatLoopIntegrityReport = (report: LoopIntegrityReport): string =>
  `loop blocked ${roundMs(report.totalBlockedMs)} ms of ${roundMs(report.watchedMs)} ms ` +
  `(sampler resolution ${roundMs(report.baselinePeriodMs)} ms), ` +
  `worst single block ${roundMs(report.worstBlockMs)} ms, ` +
  `blocks over ${report.frameBudgetMs} ms: ${report.blocksOverFrameBudget}` +
  (report.blocks.length === 0
    ? ""
    : `, longest blocks ms: ${report.blocks.map((block) => roundMs(block.durationMs)).join(", ")}`);

/**
 * Render a block as a stack trace. The first attributed call site becomes the
 * error's own stack, so a test failure points at the offending line.
 */
export const formatLoopBlock = (block: LoopBlock, label: string): string => {
  const header = `${label}: event loop blocked for ${roundMs(block.durationMs)} ms`;
  if (block.attributions.length === 0) {
    return `${header}\n    at <no async resource was created during the block; the blocking code is pure CPU work>`;
  }
  const rendered = block.attributions
    .slice(0, 3)
    .map((attribution) => {
      const origin =
        attribution.phase === "during"
          ? `created during the block by`
          : `last scheduled before the block by`;
      return `  ${attribution.resourceType} ${origin}:\n${indentStack(attribution.stack)}`;
    })
    .join("\n");
  return `${header}\n${rendered}`;
};

/**
 * Trim the sampler's own frames and Node's async-hook plumbing so the first
 * line shown is the caller that created the handle.
 */
const indentStack = (stack: string): string =>
  stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .filter(
      (line) => !line.includes("LoopIntegrity.ts") && !line.includes("node:internal/async_hooks"),
    )
    .slice(0, 12)
    .map((line) => `    ${line}`)
    .join("\n");

export interface LoopIntegrityAssertion {
  /** A single block longer than this fails. Defaults to {@link DEFAULT_FAIL_OVER_MS}. */
  readonly failOverMs?: number;
  /** Prefix for the failure message, e.g. the name of the code path under test. */
  readonly label?: string;
}

/**
 * Throw {@link LoopBlockedError} if any single block exceeded the budget. The
 * thrown error's stack is the blocking call site, not this function.
 */
export const assertLoopIntegrity = (
  report: LoopIntegrityReport,
  options: LoopIntegrityAssertion = {},
): void => {
  const failOverMs = options.failOverMs ?? DEFAULT_FAIL_OVER_MS;
  const label = options.label ?? "loop integrity";
  const worst = report.blocks[0];
  if (worst === undefined || worst.durationMs <= failOverMs) {
    return;
  }
  const message =
    `${label}: event loop blocked for ${roundMs(worst.durationMs)} ms ` +
    `(budget ${failOverMs} ms). ${formatLoopIntegrityReport(report)}`;
  throw new LoopBlockedError(
    message,
    report,
    worst,
    `LoopBlockedError: ${message}
${formatLoopBlock(worst, label)}`,
  );
};
