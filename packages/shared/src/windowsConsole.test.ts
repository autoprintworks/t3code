// @effect-diagnostics nodeBuiltinImport:off - the subject patches node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  allowConsoleWindow,
  clearWindowsSubsystemCache,
  hideWindowsConsoleWindows,
  isWindowsConsoleHookInstalled,
  restoreWindowsConsoleWindows,
  windowsExecutableSubsystem,
} from "./windowsConsole.ts";

/** Mirrors the private options bag the hook sees. */
interface InternalSpawnOptions {
  readonly file?: string | undefined;
  readonly windowsHide?: boolean | undefined;
  readonly [allowConsoleWindow]?: boolean | undefined;
}
interface InternalChildProcessPrototype {
  spawn: (this: unknown, options: InternalSpawnOptions) => unknown;
}
const prototype = (): InternalChildProcessPrototype =>
  NodeChildProcess.ChildProcess.prototype as unknown as InternalChildProcessPrototype;

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

/**
 * Smallest file the reader accepts: an `MZ` stub whose `e_lfanew` points at a
 * `PE\0\0` signature, a zeroed COFF header, and an optional header carrying only
 * the magic and the subsystem. Using a fixture rather than a system binary keeps
 * the test honest about what it asserts, and keeps it running off Windows.
 */
const writePeImage = (path: string, subsystem: number, magic = 0x10b): void => {
  const image = Buffer.alloc(160);
  image.write("MZ", 0, "latin1");
  image.writeUInt32LE(64, 0x3c);
  image.writeUInt32LE(0x0000_4550, 64);
  image.writeUInt16LE(magic, 64 + 24);
  image.writeUInt16LE(subsystem, 64 + 24 + 68);
  NodeFS.writeFileSync(path, image);
};

let fixtures: string;
let consoleExe: string;
let guiExe: string;
let notAnImage: string;

beforeEach(() => {
  fixtures = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-windows-console-"));
  consoleExe = NodePath.join(fixtures, "t3-console-fixture.exe");
  guiExe = NodePath.join(fixtures, "t3-gui-fixture.exe");
  notAnImage = NodePath.join(fixtures, "t3-text-fixture.exe");
  writePeImage(consoleExe, IMAGE_SUBSYSTEM_WINDOWS_CUI);
  writePeImage(guiExe, IMAGE_SUBSYSTEM_WINDOWS_GUI);
  NodeFS.writeFileSync(notAnImage, "#!/bin/sh\nexit 0\n");
  clearWindowsSubsystemCache();
});

afterEach(() => {
  NodeFS.rmSync(fixtures, { recursive: true, force: true });
  clearWindowsSubsystemCache();
  // Every test restores the prototype, so a leak here would poison the run.
  expect(isWindowsConsoleHookInstalled()).toBe(false);
});

/**
 * Installs the hook over a stub that records what it is handed and returns
 * without doing anything. No process is created by any test in this file: the
 * real `ChildProcess.prototype.spawn` is never reached.
 */
const captureSpawn = (spawn: () => void): Array<InternalSpawnOptions> => {
  const target = prototype();
  const original = target.spawn;
  const recorded: Array<InternalSpawnOptions> = [];
  target.spawn = function stub(this: unknown, options: InternalSpawnOptions) {
    recorded.push(options);
    return undefined;
  };
  try {
    hideWindowsConsoleWindows("win32");
    spawn();
  } finally {
    target.spawn = original;
  }
  return recorded;
};

const spawnOptionsFor = (
  file: string,
  options: NodeChildProcess.SpawnOptions = {},
): InternalSpawnOptions => {
  const recorded = captureSpawn(() => {
    NodeChildProcess.spawn(file, [], { stdio: "ignore", ...options });
  });
  expect(recorded).toHaveLength(1);
  return recorded[0] as InternalSpawnOptions;
};

describe("windowsExecutableSubsystem", () => {
  it("reads the console subsystem out of a PE32 header", () => {
    expect(windowsExecutableSubsystem(consoleExe)).toBe("console");
  });

  it("reads the graphical subsystem out of a PE32+ header", () => {
    const wide = NodePath.join(fixtures, "t3-gui-wide.exe");
    writePeImage(wide, IMAGE_SUBSYSTEM_WINDOWS_GUI, 0x20b);
    expect(windowsExecutableSubsystem(wide)).toBe("gui");
  });

  it("reports unknown for a file that is not a PE image", () => {
    expect(windowsExecutableSubsystem(notAnImage)).toBe("unknown");
  });

  it("reports unknown for a name that resolves to nothing", () => {
    expect(windowsExecutableSubsystem(NodePath.join(fixtures, "absent.exe"))).toBe("unknown");
  });

  it("finds a bare name on PATH", () => {
    const environment = { PATH: fixtures, PATHEXT: ".EXE" };
    expect(windowsExecutableSubsystem("t3-console-fixture", undefined, environment)).toBe(
      "console",
    );
  });

  it("resolves a relative name against the working directory", () => {
    expect(windowsExecutableSubsystem("./t3-gui-fixture.exe", fixtures)).toBe("gui");
  });

  it("treats a batch script as console, because cmd.exe runs it", () => {
    const script = NodePath.join(fixtures, "t3-fixture.cmd");
    NodeFS.writeFileSync(script, "@echo off\n");
    expect(windowsExecutableSubsystem(script)).toBe("console");
  });
});

describe("hideWindowsConsoleWindows", () => {
  it("hides the console window of a console-subsystem child", () => {
    expect(spawnOptionsFor(consoleExe).windowsHide).toBe(true);
  });

  it("leaves a graphical child untouched, so its window still appears", () => {
    // The whole point of reading the header. `windowsHide` is two libuv flags,
    // and the second one hides GUI windows: forcing it here would make an editor
    // opened by `externalLauncher` start invisible.
    expect(spawnOptionsFor(guiExe).windowsHide).toBe(false);
  });

  it("leaves a child it cannot classify untouched", () => {
    expect(spawnOptionsFor(notAnImage).windowsHide).toBe(false);
    expect(spawnOptionsFor(NodePath.join(fixtures, "absent.exe")).windowsHide).toBe(false);
  });

  it("keeps an explicit windowsHide: true, whatever the subsystem", () => {
    expect(spawnOptionsFor(guiExe, { windowsHide: true }).windowsHide).toBe(true);
  });

  it("honours the allowConsoleWindow opt-out for a console child", () => {
    const options = { [allowConsoleWindow]: true } as unknown as NodeChildProcess.SpawnOptions;
    expect(spawnOptionsFor(consoleExe, options).windowsHide).toBe(false);
  });

  it("covers execFile and fork, because every async spawn funnels through one method", () => {
    const recorded = captureSpawn(() => {
      NodeChildProcess.execFile(consoleExe, [], () => {});
      NodeChildProcess.fork(consoleExe, [], {
        execPath: consoleExe,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    });
    expect(recorded).toHaveLength(2);
    expect(recorded.map((options) => options.windowsHide)).toEqual([true, true]);
  });

  it("installs once, and comes back off again", () => {
    const target = prototype();
    const original = target.spawn;
    try {
      expect(isWindowsConsoleHookInstalled()).toBe(false);
      expect(hideWindowsConsoleWindows("win32")).toBe(true);
      expect(hideWindowsConsoleWindows("win32")).toBe(false);
      expect(isWindowsConsoleHookInstalled()).toBe(true);
      expect(target.spawn).not.toBe(original);
      expect(restoreWindowsConsoleWindows()).toBe(true);
      expect(target.spawn).toBe(original);
      expect(restoreWindowsConsoleWindows()).toBe(false);
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

  it("defaults to the host platform when no platform is given", () => {
    const target = prototype();
    const original = target.spawn;
    try {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- the default is under test
      const expected = process.platform === "win32";
      expect(hideWindowsConsoleWindows()).toBe(expected);
      expect(isWindowsConsoleHookInstalled()).toBe(expected);
    } finally {
      target.spawn = original;
    }
  });
});
