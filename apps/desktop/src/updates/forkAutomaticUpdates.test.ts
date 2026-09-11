import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import {
  DEFAULT_FORK_AUTOMATIC_UPDATES,
  shouldAutoDownloadDesktopUpdate,
} from "./forkAutomaticUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

/** Fork only (#113). This file fails to compile on plain upstream: upstream has
    no forkAutomaticUpdates module, no automaticUpdates setting and no
    DesktopUpdates.setAutomaticUpdates. The harness runs in mock update mode, so
    the feed points at the desktop mock update server. */

describe("fork automatic updates", () => {
  it("defaults to on for the fork", () => {
    assert.equal(DEFAULT_FORK_AUTOMATIC_UPDATES, true);
    assert.equal(
      DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.automaticUpdates,
      DEFAULT_FORK_AUTOMATIC_UPDATES,
    );
  });

  it("only downloads without a click for an update on the selected channel", () => {
    assert.isTrue(shouldAutoDownloadDesktopUpdate({ automaticUpdates: true, status: "available" }));
    assert.isFalse(
      shouldAutoDownloadDesktopUpdate({ automaticUpdates: true, status: "up-to-date" }),
    );
    assert.isFalse(
      shouldAutoDownloadDesktopUpdate({ automaticUpdates: false, status: "available" }),
    );
  });

  it.effect("downloads a found update with no click and installs it on the next quit", () => {
    const harness = makeHarness({ automaticUpdates: true });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        // Install on quit is armed at configure time, so a user who never
        // presses "Restart to install" still gets the update.
        assert.deepEqual(harness.autoInstallOnAppQuitValues(), [true]);
        assert.deepEqual(harness.autoDownloadValues(), [false]);

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.equal(harness.downloadCount(), 1);
        const state = yield* updates.getState;
        assert.equal(state.automaticUpdates, true);
        assert.equal(state.status, "downloading");
        assert.equal(state.availableVersion, "1.2.4");

        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const downloaded = yield* updates.getState;
        assert.equal(downloaded.status, "downloaded");
        assert.equal(downloaded.downloadedVersion, "1.2.4");
        // Nothing quit the app. The restart stays the user's choice.
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("leaves upstream's two-click flow in place when the setting is off", () => {
    const harness = makeHarness({ automaticUpdates: false });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        assert.deepEqual(harness.autoInstallOnAppQuitValues(), [false]);

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.equal(harness.downloadCount(), 0);
        const available = yield* updates.getState;
        assert.equal(available.automaticUpdates, false);
        assert.equal(available.status, "available");

        // The sidebar button still drives the download by hand.
        const result = yield* updates.download;
        assert.isTrue(result.accepted);
        assert.equal(harness.downloadCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("turning the setting off stops the automatic download and the quit install", () => {
    const harness = makeHarness({ automaticUpdates: true });

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const off = yield* updates.setAutomaticUpdates(false);
        assert.equal(off.automaticUpdates, false);
        assert.equal((yield* settings.get).automaticUpdates, false);
        assert.deepEqual(harness.autoInstallOnAppQuitValues(), [true, false]);

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.equal(harness.downloadCount(), 0);
        assert.equal((yield* updates.getState).status, "available");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("turning the setting back on downloads an update that is already waiting", () => {
    const harness = makeHarness({ automaticUpdates: false });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal(harness.downloadCount(), 0);

        const on = yield* updates.setAutomaticUpdates(true);
        assert.equal(on.automaticUpdates, true);
        assert.deepEqual(harness.autoInstallOnAppQuitValues(), [false, true]);
        assert.equal(harness.downloadCount(), 1);
        assert.equal((yield* updates.getState).status, "downloading");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
