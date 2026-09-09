import { assert, describe, it } from "vite-plus/test";
import * as NodePath from "node:path";

import {
  makeDevelopmentLauncherScript,
  resolveElectronBinaryPath,
  resolveMacLauncherIconPaths,
  resolveMacLauncherPaths,
} from "./electron-launcher.mjs";

describe("electron development launcher", () => {
  it("uses captured values only as fallbacks for a live runner environment", () => {
    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: "/repo/node_modules/electron/Electron",
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {
        VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
        T3CODE_PORT: "16566",
        T3CODE_HOME: "/tmp/t3",
      },
    });

    assert.include(
      script,
      "if [ -z \"${VITE_DEV_SERVER_URL:-}\" ]; then export VITE_DEV_SERVER_URL='http://127.0.0.1:8526'; fi",
    );
    assert.notInclude(script, "\nexport VITE_DEV_SERVER_URL=");
    assert.include(
      script,
      "exec '/repo/node_modules/electron/Electron' --t3code-dev-root='/repo/apps/desktop' '/repo/apps/desktop/dist-electron/main.cjs' \"$@\"",
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => {
        calls.push("ensure");
      },
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });

    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("keeps the native Electron executable name inside the branded macOS bundle", () => {
    const paths = resolveMacLauncherPaths(
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app",
      "T3 Code (Dev)",
    );

    // The bundle paths are joined with the host separator, so join here too. A
    // literal POSIX string would assert the machine running the suite.
    const executableDir = NodePath.join(
      "/repo/apps/desktop/.electron-runtime/T3 Code (Dev).app",
      "Contents",
      "MacOS",
    );
    assert.equal(paths.launcherExecutableName, "T3 Code (Dev) Launcher");
    assert.equal(paths.launcherBinaryPath, NodePath.join(executableDir, "T3 Code (Dev) Launcher"));
    assert.equal(paths.runtimeElectronBinaryPath, NodePath.join(executableDir, "Electron"));

    const script = makeDevelopmentLauncherScript({
      electronBinaryPath: paths.runtimeElectronBinaryPath,
      mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
      desktopRoot: "/repo/apps/desktop",
      environment: {},
    });
    assert.include(script, `exec '${NodePath.join(executableDir, "Electron")}'`);
    assert.notInclude(script, "node_modules/electron");
  });

  it("derives launcher icons from canonical development and production assets", () => {
    const development = resolveMacLauncherIconPaths("/runtime", true);
    const production = resolveMacLauncherIconPaths("/runtime", false);

    // Joined with the host separator, so build the expected tail the same way.
    assert.ok(
      development.sourceIconPath.endsWith(
        NodePath.join("assets", "dev", "blueprint-macos-1024.png"),
      ),
    );
    assert.equal(development.generatedIconPath, NodePath.join("/runtime", "icon-dev.icns"));
    assert.ok(
      production.sourceIconPath.endsWith(NodePath.join("assets", "prod", "black-macos-1024.png")),
    );
    assert.equal(production.generatedIconPath, NodePath.join("/runtime", "icon-prod.icns"));
  });
});
