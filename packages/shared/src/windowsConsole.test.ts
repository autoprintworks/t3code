// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { hideWindowsConsoleWindows, windowsConsoleWindowsHidden } from "./windowsConsole.ts";

interface InternalSpawnOptions {
  readonly windowsHide?: boolean | undefined;
}

interface InternalChildProcessPrototype {
  spawn: (this: unknown, options: InternalSpawnOptions) => unknown;
}

const prototype = () =>
  NodeChildProcess.ChildProcess.prototype as unknown as InternalChildProcessPrototype;

/**
 * Installs the hook over a spy, so the assertions read the options the hook
 * actually hands to the real spawn, then restores the prototype. The spy
 * delegates, so the real Node code path runs; every command below names a file
 * that does not exist, so no process ever starts.
 */
const recordSpawnOptions = (spawn: () => void): Array<InternalSpawnOptions> => {
  const target = prototype();
  const original = target.spawn;
  const recorded: Array<InternalSpawnOptions> = [];
  target.spawn = function spy(this: unknown, options: InternalSpawnOptions) {
    recorded.push(options);
    return original.call(this, options);
  };
  try {
    hideWindowsConsoleWindows("win32");
    spawn();
  } finally {
    target.spawn = original;
  }
  return recorded;
};

const missingCommand = "t3code-windows-console-test-missing";

const swallow = (child: NodeChildProcess.ChildProcess) => {
  child.on("error", () => {});
  return child;
};

afterEach(() => {
  expect(windowsConsoleWindowsHidden()).toBe(false);
});

describe("hideWindowsConsoleWindows", () => {
  it("forces windowsHide on child_process.spawn", () => {
    const recorded = recordSpawnOptions(() => {
      swallow(NodeChildProcess.spawn(missingCommand, ["--version"]));
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.windowsHide).toBe(true);
  });

  it("forces windowsHide on the exec, execFile and fork spawn paths", () => {
    const recorded = recordSpawnOptions(() => {
      NodeChildProcess.exec(missingCommand, () => {});
      NodeChildProcess.execFile(missingCommand, () => {});
      swallow(NodeChildProcess.fork("missing.js", { execPath: missingCommand }));
    });
    expect(recorded).toHaveLength(3);
    for (const options of recorded) {
      expect(options.windowsHide).toBe(true);
    }
  });

  it("overrides an explicit windowsHide: false, so no call site can opt back in", () => {
    const recorded = recordSpawnOptions(() => {
      swallow(NodeChildProcess.spawn(missingCommand, [], { windowsHide: false }));
    });
    expect(recorded[0]?.windowsHide).toBe(true);
  });

  it("installs once, however many times it is called", () => {
    const target = prototype();
    const original = target.spawn;
    try {
      expect(hideWindowsConsoleWindows("win32")).toBe(true);
      const installed = target.spawn;
      expect(hideWindowsConsoleWindows("win32")).toBe(false);
      expect(target.spawn).toBe(installed);
      expect(windowsConsoleWindowsHidden()).toBe(true);
    } finally {
      target.spawn = original;
    }
  });

  it("does nothing away from Windows", () => {
    const target = prototype();
    const original = target.spawn;
    expect(hideWindowsConsoleWindows("darwin")).toBe(false);
    expect(hideWindowsConsoleWindows("linux")).toBe(false);
    expect(target.spawn).toBe(original);
  });
});
