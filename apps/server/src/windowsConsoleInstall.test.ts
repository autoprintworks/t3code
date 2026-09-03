// @effect-diagnostics nodeBuiltinImport:off - reads its own sources.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Guards the wiring rather than the mechanism. `windowsConsole.test.ts` proves
 * the hook does the right thing; nothing proved the hook was actually installed,
 * so deleting the call left the suite green and the defect back.
 *
 * These are source checks. Both subjects only run their install at a process
 * entry point - `bin.ts` behind `import.meta.main`, `serviceLauncher.ts` inside
 * a spawn - and importing either to observe it would start a CLI or a service.
 * A source check is the cheapest thing that still turns red when the line goes.
 */
const read = (relative: string): string =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, relative), "utf8");

describe("Windows console suppression is wired into the server entry points", () => {
  it("bin.ts installs the hook when it runs as a program", () => {
    const source = read("bin.ts");
    expect(source).toContain(
      'import { hideWindowsConsoleWindows } from "@t3tools/shared/windowsConsole"',
    );
    const main = source.slice(source.indexOf("if (import.meta.main) {"));
    expect(main).toContain("hideWindowsConsoleWindows();");
  });

  it("serviceLauncher.ts hides the console of the server child it spawns", () => {
    const source = read("serviceLauncher.ts");
    // The launcher ships as a standalone bundle limited to Node built-ins, so it
    // sets the flag by hand instead of installing the shared hook. Its one spawn
    // targets `process.execPath`, which is console-subsystem, so the flag is the
    // same decision the hook would make.
    const spawn = source.slice(source.indexOf("NodeChildProcess.spawn(process.execPath"));
    expect(spawn.slice(0, 800)).toContain("windowsHide: true");
  });
});
