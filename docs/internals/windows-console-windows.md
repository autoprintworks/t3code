# Windows console windows

> For maintainers. Using T3 Code? See [docs/user](../user/).

Windows gives every console-subsystem process a console. A child with no console to inherit
gets a brand new one, and Windows draws it: a black window that appears and disappears. T3
Code's hosts are graphical processes with no console of their own - Electron main, and the
backend Electron runs as node - so every `powershell.exe`, `git`, or provider CLI they start
used to flash a window. The terminal subprocess poll starts one every second per running
terminal, which turned a flash into a strobe.

## The invariant

**A process T3 Code starts never draws a console window. A process that is meant to show a
window still shows it.**

This is enforced once, at each process entry point, not at call sites:

| Entry point                          | How                                                     |
| ------------------------------------ | ------------------------------------------------------- |
| `apps/desktop/src/main.ts`           | `hideWindowsConsoleWindows()`, first statement          |
| `apps/server/src/bin.ts`             | `hideWindowsConsoleWindows()`, under `import.meta.main` |
| `apps/server/src/serviceLauncher.ts` | `windowsHide: true` by hand on its one spawn            |

`packages/shared/src/windowsConsole.ts` owns the mechanism. It patches
`ChildProcess.prototype.spawn`, the single internal function `child_process.spawn`, `exec`,
`execFile`, and `fork` all funnel into. A new `spawner.spawn` call site is therefore covered by
default, and so is any dependency that spawns asynchronously.

## Why it is not just `windowsHide: true` everywhere

Node's `windowsHide` is two libuv flags, not one. It maps to `UV_PROCESS_WINDOWS_HIDE`, which is
`UV_PROCESS_WINDOWS_HIDE_CONSOLE | UV_PROCESS_WINDOWS_HIDE_GUI`:

- `HIDE_CONSOLE` adds `CREATE_NO_WINDOW`, so a console program gets no console window.
- `HIDE_GUI` sets `STARTF_USESHOWWINDOW` with `wShowWindow = SW_HIDE`, so a **graphical**
  program starts with its main window hidden.

Node exposes no way to ask for only the first. Forcing the flag everywhere would silently hide
the editor windows `externalLauncher.ts` opens, `explorer.exe`, and an `electron-updater` NSIS
installer - none of which pass any spawn options of their own, so none of which could opt out.

So the hook decides per target. It resolves the executable the way `CreateProcess` would
(`PATH`, then `PATHEXT`), reads the `Subsystem` field out of the PE optional header, and applies
`windowsHide` only for `IMAGE_SUBSYSTEM_WINDOWS_CUI`. Anything graphical, or anything it cannot
parse, is passed through untouched. Results are cached per resolved path.

There is also an explicit opt-out for a console program that genuinely wants a window:

```ts
import { allowConsoleWindow } from "@t3tools/shared/windowsConsole";

NodeChildProcess.spawn(command, args, { [allowConsoleWindow]: true });
```

It exists because Node normalises `windowsHide` to a boolean before the hook sees the options,
so an explicit `windowsHide: false` is indistinguishable from not passing it.

## Reach, and what is outside it

**Grandchildren are covered.** A hidden console child that spawns its own children with Node's
defaults - which is what every provider CLI does when it shells out to `git` - does not produce a
window either. Measured with a three-level probe: level 3 reported `hwnd=0 visible=False` when
level 2 was hidden, and a real visible handle when it was not.

**Synchronous spawns are not covered.** `spawnSync`, `execSync`, and `execFileSync` go through
`internal/child_process.spawnSync` and never reach the hook. `packages/shared/src/shell.ts` is
the only shipped user; it guards itself by making `windowsHide: true` a required field of its
own injected-exec type, so a new probe cannot forget it.

**node-pty is not covered, and does not need to be above Windows build 18309.** node-pty creates
processes from native code. On build 18309 and later it uses ConPTY, whose console host is
headless. Below that it falls back to winpty and starts `winpty-agent.exe` from native code,
which the hook cannot see. Windows 10 1809 (build 17763, LTSC) is below the threshold. Fixing
that would mean patching or vendoring node-pty's winpty path, which is out of proportion to the
remaining audience.

**Development tooling is not covered.** `scripts/dev-runner.ts`, `apps/server/scripts/cli.ts`,
and the generator scripts under `packages/effect-acp` and `packages/effect-codex-app-server`
spawn without installing the hook. They are not shipped paths.

## Checking it

```bash
node apps/server/scripts/windows-console-probe.ts
```

Run on Windows. The probe relaunches itself detached and hidden, so the measuring process has no
console - the situation Electron main is in. It then spawns a console program and a graphical
program, twice, with the hook off and on. Expected:

```
hook=off console: hwnd=<non-zero> visible=True   gui: handle=<non-zero>
hook=on  console: hwnd=0 visible=False           gui: handle=<non-zero>
```

The second line is the whole fix: the console window is gone and the graphical window is not.

Unit coverage is `packages/shared/src/windowsConsole.test.ts` (the mechanism, with synthetic PE
fixtures so it runs on any platform), plus `windowsConsoleInstall.test.ts` in `apps/server` and
`apps/desktop` (the wiring).
