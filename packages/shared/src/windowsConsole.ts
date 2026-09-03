// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Windows gives every console-subsystem process a console. A child that has no
 * console to inherit gets a brand new one, and Windows draws it: a black window
 * that appears and disappears. T3 Code's hosts are GUI processes with no console
 * of their own - Electron main, and the backend Electron runs as node - so every
 * `powershell.exe`, `git`, or provider CLI they spawn flashes a window. The
 * terminal subprocess poll spawns one every couple of seconds, which is what
 * turns a flash into a strobe.
 *
 * Node's answer is the `windowsHide` spawn option, which defaults to `false` and
 * which `effect`'s `ChildProcess` API does not expose. Rather than thread it
 * through the twenty-odd `spawner.spawn` call sites - where the next new one
 * would forget it - install it once here, on the single function every
 * asynchronous spawn in the process funnels into.
 *
 * ## What `windowsHide` actually does
 *
 * It is two things, not one. Node maps it to libuv's `UV_PROCESS_WINDOWS_HIDE`,
 * which is `UV_PROCESS_WINDOWS_HIDE_CONSOLE | UV_PROCESS_WINDOWS_HIDE_GUI`:
 *
 * - `HIDE_CONSOLE` adds `CREATE_NO_WINDOW` to the creation flags, so a console
 *   process gets no console window. This is the part we want.
 * - `HIDE_GUI` sets `STARTF_USESHOWWINDOW` with `wShowWindow = SW_HIDE`, so a
 *   *graphical* process starts with its main window hidden. Measured: spawning
 *   `charmap.exe` with `windowsHide` gives `MainWindowHandle = 0` and no window
 *   on screen, against a real handle and a visible window without it.
 *
 * Node exposes no way to ask for only the first, so forcing `windowsHide` on
 * every spawn would silently hide the editor windows `externalLauncher` opens,
 * `explorer.exe`, and an `electron-updater` NSIS installer. That is why the hook
 * decides per target: it reads the executable's PE header and applies
 * `windowsHide` only when the subsystem is `IMAGE_SUBSYSTEM_WINDOWS_CUI`. A
 * graphical executable is passed through byte for byte.
 *
 * ## Reach
 *
 * The suppression is inherited in practice. A hidden console child that goes on
 * to spawn its own children with Node's defaults does not produce a window
 * either: it has no console window for the grandchild to inherit and no visible
 * one is created. Measured with a three-level probe - level 3 reported
 * `hwnd=0 visible=False` when level 2 was hidden, and a real visible handle when
 * it was not.
 *
 * It does not reach `execFileSync`/`execSync`/`spawnSync`, which bypass
 * `ChildProcess.prototype.spawn` entirely; those call sites pass `windowsHide`
 * by hand (see `shell.ts`). It also does not reach `node-pty`, which creates
 * processes from native code; on Windows 10 build 18309 and later node-pty uses
 * ConPTY, whose console host is headless, so terminals do not flash either.
 *
 * A child of a process that already owns a console still inherits it, so
 * `npx t3` in a terminal keeps its console and no extra console host appears.
 */

/**
 * Set this on a `child_process` options bag to keep the hook's hands off that
 * one spawn. Needed because Node normalises `windowsHide` to a boolean before
 * the hook sees it, so an explicit `windowsHide: false` is indistinguishable
 * from not passing it at all.
 */
export const allowConsoleWindow: unique symbol = Symbol.for(
  "@t3tools/shared/windowsConsole/allowConsoleWindow",
);

/**
 * Shape of the internal `ChildProcess.prototype.spawn` options bag. Node builds
 * it in `child_process.spawn`, `exec`, `execFile`, and `fork`, so it is the one
 * place all four meet. `@types/node` does not describe it.
 *
 * `file` is the executable as the caller named it, *not* resolved against
 * `PATH`. For `shell: true` Node has already rewritten it to `cmd.exe`.
 */
interface InternalSpawnOptions {
  readonly file?: string | undefined;
  readonly cwd?: string | undefined;
  readonly windowsHide?: boolean | undefined;
  readonly [allowConsoleWindow]?: boolean | undefined;
}

type InternalSpawn = (this: unknown, options: InternalSpawnOptions) => unknown;

interface InternalChildProcessPrototype {
  spawn: InternalSpawn;
}

/** Marks an already-installed hook so repeated installs do not stack wrappers. */
const installedMarker = Symbol.for("@t3tools/shared/windowsConsole/installed");
/** Carries the function the hook wrapped, so the patch can be taken back off. */
const innerMarker = Symbol.for("@t3tools/shared/windowsConsole/inner");

interface HookedSpawn extends InternalSpawn {
  readonly [installedMarker]?: true;
  readonly [innerMarker]?: InternalSpawn;
}

const prototype = (): InternalChildProcessPrototype | undefined =>
  NodeChildProcess.ChildProcess?.prototype as unknown as InternalChildProcessPrototype | undefined;

/** What kind of window, if any, an executable is built to own. */
export type WindowsSubsystem = "console" | "gui" | "unknown";

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

/** Scripts that only ever run under `cmd.exe`, which is a console program. */
const CONSOLE_EXTENSIONS = new Set([".bat", ".cmd", ".com"]);

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Reads the PE optional header's `Subsystem` field.
 *
 * Layout: the DOS header holds `e_lfanew` at 0x3C, a uint32 pointing at the
 * `PE\0\0` signature. Four signature bytes then a 20-byte COFF header put the
 * optional header at `e_lfanew + 24`, and `Subsystem` is a uint16 at offset 68
 * within it - the same offset in PE32 and PE32+.
 */
const readSubsystemField = (path: string): number | undefined => {
  let descriptor: number | undefined;
  try {
    descriptor = NodeFS.openSync(path, "r");
    const dosHeader = Buffer.allocUnsafe(64);
    if (NodeFS.readSync(descriptor, dosHeader, 0, 64, 0) < 64) return undefined;
    if (dosHeader.readUInt16LE(0) !== 0x5a4d) return undefined; // "MZ"
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.allocUnsafe(96);
    if (NodeFS.readSync(descriptor, peHeader, 0, 96, peOffset) < 96) return undefined;
    if (peHeader.readUInt32LE(0) !== 0x0000_4550) return undefined; // "PE\0\0"
    const magic = peHeader.readUInt16LE(24);
    if (magic !== 0x10b && magic !== 0x20b) return undefined; // not PE32 or PE32+
    return peHeader.readUInt16LE(24 + 68);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        NodeFS.closeSync(descriptor);
      } catch {
        // Nothing useful to do; the spawn still has to go ahead.
      }
    }
  }
};

const isFile = (path: string): boolean => {
  try {
    return NodeFS.statSync(path).isFile();
  } catch {
    return false;
  }
};

const hasPathSeparator = (file: string): boolean => file.includes("/") || file.includes("\\");

/**
 * Repeats the `PATH`/`PATHEXT` search Windows does inside `CreateProcess`, so
 * the header can be read from the same file that is about to be executed.
 */
const resolveExecutable = (
  file: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): string | undefined => {
  const suffixes =
    NodePath.extname(file) === ""
      ? (environment["PATHEXT"] ?? DEFAULT_PATHEXT).split(";").filter((value) => value !== "")
      : [""];
  const candidates = suffixes.map((suffix) => file + suffix);

  if (NodePath.isAbsolute(file) || hasPathSeparator(file)) {
    const base = cwd ?? ".";
    for (const candidate of candidates) {
      const resolved = NodePath.resolve(base, candidate);
      if (isFile(resolved)) return resolved;
    }
    return undefined;
  }

  // Windows searches the working directory before `PATH`.
  for (const directory of [cwd ?? ".", ...(environment["PATH"] ?? "").split(NodePath.delimiter)]) {
    if (directory === "") continue;
    for (const candidate of candidates) {
      const resolved = NodePath.resolve(directory, candidate);
      if (isFile(resolved)) return resolved;
    }
  }
  return undefined;
};

/**
 * Bounded so a process that spawns endlessly many distinct executables cannot
 * grow it without limit. Real hosts see a handful of entries.
 */
const subsystemCache = new Map<string, WindowsSubsystem>();
const SUBSYSTEM_CACHE_LIMIT = 256;

/**
 * Classifies the executable `file` names, resolving it the way `CreateProcess`
 * would. Returns `"unknown"` when it cannot be resolved or parsed, which callers
 * must treat as "leave this spawn alone".
 */
export const windowsExecutableSubsystem = (
  file: string,
  cwd?: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): WindowsSubsystem => {
  // `PATH` is part of the key because it decides which file `file` resolves to.
  const key = `${environment["PATH"] ?? ""}\u0000${cwd ?? ""}\u0000${file}`;
  const cached = subsystemCache.get(key);
  if (cached !== undefined) return cached;

  const resolved = resolveExecutable(file, cwd, environment);
  let subsystem: WindowsSubsystem = "unknown";
  if (resolved !== undefined) {
    if (CONSOLE_EXTENSIONS.has(NodePath.extname(resolved).toLowerCase())) {
      subsystem = "console";
    } else {
      const field = readSubsystemField(resolved);
      subsystem =
        field === IMAGE_SUBSYSTEM_WINDOWS_CUI
          ? "console"
          : field === IMAGE_SUBSYSTEM_WINDOWS_GUI
            ? "gui"
            : "unknown";
    }
  }

  if (subsystemCache.size >= SUBSYSTEM_CACHE_LIMIT) subsystemCache.clear();
  subsystemCache.set(key, subsystem);
  return subsystem;
};

/** Test seam: forgets what has been read, so a fixture path can be reused. */
export const clearWindowsSubsystemCache = (): void => {
  subsystemCache.clear();
};

/**
 * Stops asynchronous child processes drawing a console window on Windows, by
 * setting `windowsHide` on the ones that would draw one. Graphical executables
 * are left exactly as the caller wrote them, because `windowsHide` would hide
 * their windows too. Pass `[allowConsoleWindow]: true` in a spawn's options to
 * opt a single call site out.
 *
 * Safe to call more than once, and a no-op away from Windows. Call it from a
 * process entry point; it patches a prototype rather than a module export, so it
 * does not care whether `node:child_process` was imported before or after.
 *
 * Returns `true` when it installed the hook.
 */
export const hideWindowsConsoleWindows = (
  // Runs at a process entry point, before any Effect runtime exists. The
  // parameter is the test seam.
  // oxlint-disable-next-line t3code/no-global-process-runtime -- no runtime yet
  platform: NodeJS.Platform = process.platform,
): boolean => {
  if (platform !== "win32") return false;
  const target = prototype();
  // Absent under runtimes that reimplement `node:child_process`, such as Bun.
  if (target === undefined || typeof target.spawn !== "function") return false;
  if ((target.spawn as HookedSpawn)[installedMarker] === true) return false;

  const inner = target.spawn;
  const hooked: HookedSpawn = Object.defineProperties(
    function spawnWithHiddenConsole(this: unknown, options: InternalSpawnOptions) {
      if (options.windowsHide === true) return inner.call(this, options);
      if (options[allowConsoleWindow] === true) return inner.call(this, options);
      if (typeof options.file !== "string") return inner.call(this, options);
      if (windowsExecutableSubsystem(options.file, options.cwd) !== "console") {
        return inner.call(this, options);
      }
      return inner.call(this, { ...options, windowsHide: true });
    },
    {
      [installedMarker]: { value: true },
      [innerMarker]: { value: inner },
    },
  );
  target.spawn = hooked;
  return true;
};

/**
 * Takes the hook back off, restoring the function it wrapped. Returns `false`
 * when the hook is not the outermost patch, because unwinding it then would
 * throw away someone else's wrapper. Exists so a test can undo the install, and
 * so the install is not a one-way door.
 */
export const restoreWindowsConsoleWindows = (): boolean => {
  const target = prototype();
  if (target === undefined) return false;
  const inner = (target.spawn as HookedSpawn)[innerMarker];
  if (inner === undefined) return false;
  target.spawn = inner;
  return true;
};

/** Whether {@link hideWindowsConsoleWindows} is currently installed. */
export const isWindowsConsoleHookInstalled = (): boolean =>
  (prototype()?.spawn as HookedSpawn | undefined)?.[installedMarker] === true;
