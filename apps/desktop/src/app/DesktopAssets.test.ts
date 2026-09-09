import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const environmentLayer = DesktopEnvironment.layer({
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
}).pipe(
  // `Path.layer` is the POSIX implementation. The fixtures here are POSIX
  // paths, so pin it over the host path service or the assertions read the
  // separator of the machine running the suite.
  Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}), Path.layer)),
);

describe("DesktopAssets", () => {
  it.effect("uses canonical source-tree icons for unpackaged development", () =>
    Effect.gen(function* () {
      // The layer under test resolves paths through NodeServices, so the
      // expectations here need the host separator, not the POSIX default above.
      const path = yield* Effect.provide(Path.Path, NodeServices.layer);
      const developmentEnvironmentLayer = DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/dist-electron",
        homeDirectory: "/Users/alice",
        platform: "linux",
        processArch: "x64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: false,
        resourcesPath: "/repo/apps/desktop/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            DesktopConfig.layerTest({ VITE_DEV_SERVER_URL: "http://localhost:5733" }),
          ),
        ),
      );
      // Candidates are joined with the host separator, so match on that.
      const developmentAssetsSegment = path.join("assets", "dev") + path.sep;
      const fileSystemLayer = FileSystem.layerNoop({
        exists: (candidate) => Effect.succeed(String(candidate).includes(developmentAssetsSegment)),
      });
      const assets = yield* DesktopAssets.DesktopAssets.pipe(
        Effect.provide(
          DesktopAssets.layer.pipe(
            Layer.provide(Layer.merge(fileSystemLayer, developmentEnvironmentLayer)),
          ),
        ),
      );

      const icons = yield* assets.iconPaths;

      assert.ok(
        Option.getOrThrow(icons.ico).endsWith(path.join("assets", "dev", "blueprint-windows.ico")),
      );
      assert.ok(
        Option.getOrThrow(icons.png).endsWith(
          path.join("assets", "dev", "blueprint-universal-1024.png"),
        ),
      );
      assert.isTrue(Option.isNone(icons.icns));
    }),
  );

  it.effect("preserves the failed asset candidate and filesystem cause", () =>
    Effect.gen(function* () {
      const fileName = "custom.bin";
      const candidatePath = "/repo/apps/desktop/resources/custom.bin";
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "exists",
        pathOrDescriptor: candidatePath,
        description: "private filesystem diagnostic",
      });
      const fileSystemLayer = FileSystem.layerNoop({
        exists: (path) => (path === candidatePath ? Effect.fail(cause) : Effect.succeed(false)),
      });
      const assetsLayer = DesktopAssets.layer.pipe(
        Layer.provide(Layer.merge(fileSystemLayer, environmentLayer)),
      );
      const assets = yield* DesktopAssets.DesktopAssets.pipe(Effect.provide(assetsLayer));

      const error = yield* assets.resolveResourcePath(fileName).pipe(Effect.flip);

      assert.instanceOf(error, DesktopAssets.DesktopAssetProbeError);
      assert.equal(error.fileName, fileName);
      assert.equal(error.candidatePath, candidatePath);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to probe desktop asset "${fileName}" at ${candidatePath}.`,
      );
      assert.notInclude(error.message, "private filesystem diagnostic");
    }),
  );
});
