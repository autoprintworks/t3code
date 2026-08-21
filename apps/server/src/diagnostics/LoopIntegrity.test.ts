// @effect-diagnostics nodeBuiltinImport:off - the point of these tests is that
// a raw `child_process.spawn` blocks the loop thread and is named by its stack.
// @effect-diagnostics globalTimers:off - the sampler measures wall clock, so
// the tests must idle on the real clock too.
import * as NodeChildProcess from "node:child_process";
import * as NodePerfHooks from "node:perf_hooks";
import { describe, expect, it } from "@effect/vitest";

import {
  LoopBlockedError,
  assertLoopIntegrity,
  formatLoopIntegrityReport,
  watchLoopIntegrity,
} from "./LoopIntegrity.ts";

const busyWait = (durationMs: number): void => {
  const until = NodePerfHooks.performance.now() + durationMs;
  while (NodePerfHooks.performance.now() < until) {
    // Own the loop on purpose.
  }
};

const idle = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

/**
 * Creates a real child process on the loop thread, then blocks. The spawn is
 * what the guard must name; the busy wait only makes the block long enough to
 * exceed the budget on every platform, not just Windows.
 */
const spawnThenBlockOnLoopThread = (): void => {
  const child = NodeChildProcess.spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  child.unref();
  busyWait(200);
};

describe("LoopIntegrity", () => {
  it("reports the worst block, the total blocked time, and blocks over the frame budget", async () => {
    const watch = watchLoopIntegrity({ sampleIntervalMs: 2, frameBudgetMs: 16 });
    await idle(20);
    busyWait(120);
    await idle(20);
    busyWait(60);
    await idle(20);
    const report = watch.stop();

    expect(report.worstBlockMs).toBeGreaterThan(100);
    // 180 ms of busy waiting, less one baseline period per block, so the
    // bound sits below 180 by roughly two Windows timer ticks.
    expect(report.totalBlockedMs).toBeGreaterThan(140);
    expect(report.blocksOverFrameBudget).toBeGreaterThanOrEqual(2);
    expect(report.blocks[0]!.durationMs).toBe(report.worstBlockMs);
    expect(formatLoopIntegrityReport(report)).toContain("worst single block");
  });

  it("stays quiet when the loop is never blocked", async () => {
    const watch = watchLoopIntegrity({ sampleIntervalMs: 2 });
    await idle(300);
    const report = watch.stop();

    // Windows clamps timers to ~15.6 ms, so this counts ticks, not milliseconds.
    expect(report.samples).toBeGreaterThanOrEqual(5);
    expect(report.blocksOverFrameBudget).toBe(0);
    expect(() => assertLoopIntegrity(report, { failOverMs: 50 })).not.toThrow();
  });

  it("fails with a stack that names the call site that blocked the loop", async () => {
    const watch = watchLoopIntegrity({ sampleIntervalMs: 2, attributeStacks: true });
    await idle(20);
    spawnThenBlockOnLoopThread();
    await idle(40);
    const report = watch.stop();

    let thrown: unknown;
    try {
      assertLoopIntegrity(report, { failOverMs: 50, label: "shell read" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(LoopBlockedError);
    // The spawn is ranked above whatever else the process did in the same turn.
    expect(report.blocks[0]!.attributions[0]!.resourceType).toBe("PROCESSWRAP");
    const stack = (thrown as LoopBlockedError).stack ?? "";
    expect(stack).toContain("LoopBlockedError: shell read: event loop blocked");
    expect(stack).toContain("PROCESSWRAP");
    expect(stack).toContain("spawnThenBlockOnLoopThread");
    expect(stack).toContain("LoopIntegrity.test.ts");
  });

  it("costs nothing when attribution is off", async () => {
    const watch = watchLoopIntegrity({ sampleIntervalMs: 2, attributeStacks: false });
    await idle(20);
    busyWait(80);
    await idle(20);
    const report = watch.stop();

    expect(report.worstBlockMs).toBeGreaterThan(50);
    expect(report.blocks[0]!.attributions).toHaveLength(0);
  });
});
