#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a standalone Windows probe.
/**
 * Reproduces, and then checks, the Windows console-window defect by eye-free
 * measurement. Run it on Windows:
 *
 *   node apps/server/scripts/windows-console-probe.ts
 *
 * It relaunches itself once, detached and hidden, so the measuring process has
 * no console of its own - the situation Electron main and the desktop-hosted
 * backend are in. In that child it spawns two probes twice, once with the hook
 * installed and once without, and prints what it saw:
 *
 * - a console program (`powershell.exe`) reports its own console window through
 *   `GetConsoleWindow` and `IsWindowVisible`. It must be hidden with the hook.
 * - a graphical program (`charmap.exe`) is asked for its `MainWindowHandle`. It
 *   must still have one with the hook, because `windowsHide` hides GUI windows
 *   as well as console windows and the hook must not apply it here.
 *
 * Expected output on a fixed build:
 *
 *   hook=off console: hwnd=<non-zero> visible=True     gui: handle=<non-zero>
 *   hook=on  console: hwnd=0 visible=False             gui: handle=<non-zero>
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  hideWindowsConsoleWindows,
  restoreWindowsConsoleWindows,
} from "@t3tools/shared/windowsConsole";

const CONSOLE_PROBE = `
Add-Type -Namespace T3 -Name Win -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
'@
$h = [T3.Win]::GetConsoleWindow()
$visible = if ($h -ne [System.IntPtr]::Zero) { [T3.Win]::IsWindowVisible($h) } else { $false }
Add-Content -Path $env:T3_REPORT -Value ("hwnd={0} visible={1}" -f $h, $visible)
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const mainWindowHandle = (pid: number): string =>
  NodeChildProcess.execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { "$($p.MainWindowHandle)" } else { "gone" }`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim();

const runRound = async (workingDirectory: string, hook: boolean): Promise<string> => {
  if (hook) hideWindowsConsoleWindows();
  else restoreWindowsConsoleWindows();

  const scriptPath = NodePath.join(workingDirectory, "console-probe.ps1");
  const reportPath = NodePath.join(workingDirectory, `report-${String(hook)}.txt`);
  NodeFS.writeFileSync(scriptPath, CONSOLE_PROBE);
  NodeFS.writeFileSync(reportPath, "");

  const consoleChild = NodeChildProcess.spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
    { stdio: "ignore", env: { ...process.env, T3_REPORT: reportPath } },
  );
  await new Promise((resolve) => consoleChild.on("exit", resolve));

  const guiChild = NodeChildProcess.spawn("charmap.exe", [], { stdio: "ignore" });
  await sleep(2500);
  const guiHandle = mainWindowHandle(guiChild.pid ?? 0);
  try {
    guiChild.kill();
  } catch {
    // Already gone; nothing to report.
  }

  const consoleResult = NodeFS.readFileSync(reportPath, "utf8").trim();
  return `hook=${hook ? "on " : "off"} console: ${consoleResult}   gui: handle=${guiHandle}`;
};

const main = async (): Promise<void> => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- a standalone script, no runtime
  if (process.platform !== "win32") {
    process.stdout.write("This probe only means anything on Windows.\n");
    return;
  }

  // The parent of the measurement must own no console, or every child inherits
  // one and nothing is being tested. Relaunch once, hidden and detached.
  if (process.env["T3_CONSOLE_PROBE_CHILD"] !== "1") {
    const workingDirectory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3-console-probe-"),
    );
    const outputPath = NodePath.join(workingDirectory, "output.txt");
    const child = NodeChildProcess.spawn(
      process.execPath,
      [process.argv[1] ?? "", workingDirectory],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", NodeFS.openSync(outputPath, "w"), "inherit"],
        env: { ...process.env, T3_CONSOLE_PROBE_CHILD: "1" },
      },
    );
    await new Promise((resolve) => child.on("exit", resolve));
    process.stdout.write(NodeFS.readFileSync(outputPath, "utf8"));
    NodeFS.rmSync(workingDirectory, { recursive: true, force: true });
    return;
  }

  const workingDirectory = process.argv[2] ?? NodeOS.tmpdir();
  process.stdout.write(`${await runRound(workingDirectory, false)}\n`);
  process.stdout.write(`${await runRound(workingDirectory, true)}\n`);
};

await main();
