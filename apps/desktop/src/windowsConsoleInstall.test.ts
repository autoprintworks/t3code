// @effect-diagnostics nodeBuiltinImport:off - reads its own source.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

/**
 * Electron main is where the flashing was worst, and `main.ts` cannot be
 * imported in a test: it builds the whole desktop runtime at module scope. This
 * is a source check, and it turns red if the install is deleted. See
 * `packages/shared/src/windowsConsole.test.ts` for the mechanism itself.
 */
it("main.ts installs Windows console suppression", () => {
  const source = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "main.ts"), "utf8");
  expect(source).toContain(
    'import { hideWindowsConsoleWindows } from "@t3tools/shared/windowsConsole"',
  );
  expect(source).toContain("hideWindowsConsoleWindows();");
});
