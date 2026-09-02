// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

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
 * `windowsHide` only suppresses creating a *new* console. A child of a process
 * that already owns one still inherits it, so `npx t3` in a terminal is
 * unaffected and no extra console host is created.
 */

/**
 * Shape of the internal `ChildProcess.prototype.spawn` options bag. Node builds
 * it in `child_process.spawn`, `exec`, `execFile`, and `fork`, so it is the one
 * place all four meet. `@types/node` does not describe it.
 */
interface InternalSpawnOptions {
  readonly windowsHide?: boolean | undefined;
}

type InternalSpawn = (this: unknown, options: InternalSpawnOptions) => unknown;

interface InternalChildProcessPrototype {
  spawn: InternalSpawn;
}

/** Marks an already-installed hook so repeated installs do not stack wrappers. */
const installedMarker = Symbol.for("@t3tools/shared/windowsConsole/installed");

interface HookedSpawn extends InternalSpawn {
  readonly [installedMarker]?: true;
}

const prototype = (): InternalChildProcessPrototype =>
  NodeChildProcess.ChildProcess.prototype as unknown as InternalChildProcessPrototype;

/**
 * Forces `windowsHide` on every asynchronous child process this process starts,
 * so none of them can draw a console window. Safe to call more than once, and a
 * no-op away from Windows. Call it from a process entry point; it patches a
 * prototype rather than a module export, so it does not care whether
 * `node:child_process` was imported before or after.
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
  if ((target.spawn as HookedSpawn)[installedMarker] === true) return false;

  const inner = target.spawn;
  const hooked: HookedSpawn = Object.defineProperty(
    function spawnWithHiddenConsole(this: unknown, options: InternalSpawnOptions) {
      return inner.call(this, { ...options, windowsHide: true });
    },
    installedMarker,
    { value: true },
  );
  target.spawn = hooked;
  return true;
};

/** Whether {@link hideWindowsConsoleWindows} is currently installed. */
export const windowsConsoleWindowsHidden = (): boolean =>
  (prototype().spawn as HookedSpawn)[installedMarker] === true;
