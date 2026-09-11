import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  getForkUpdatePillLabel,
  getForkUpdateStatusLine,
  supportsForkAutomaticUpdates,
} from "./forkAutomaticUpdates.logic";

/** Fork only (#113). Fails to compile on plain upstream: upstream has no
    forkAutomaticUpdates.logic module and no automaticUpdates on the state. */

const baseState: DesktopUpdateState = {
  enabled: true,
  automaticUpdates: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("fork update pill label", () => {
  it("names the version while a downloaded update waits", () => {
    expect(
      getForkUpdatePillLabel({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "0.0.41-ap.1",
      }),
    ).toBe("v0.0.41-ap.1 ready");
  });

  it("stays hidden in every other state", () => {
    expect(getForkUpdatePillLabel(null)).toBeNull();
    expect(getForkUpdatePillLabel(baseState)).toBeNull();
    expect(
      getForkUpdatePillLabel({ ...baseState, status: "available", availableVersion: "0.0.41" }),
    ).toBeNull();
    expect(
      getForkUpdatePillLabel({ ...baseState, status: "downloading", downloadPercent: 40 }),
    ).toBeNull();
  });

  it("stays hidden when the setting is off, because the download was a click", () => {
    expect(
      getForkUpdatePillLabel({
        ...baseState,
        automaticUpdates: false,
        status: "downloaded",
        downloadedVersion: "0.0.41",
      }),
    ).toBeNull();
  });
});

describe("fork update status line", () => {
  it("says what the updater is doing", () => {
    expect(getForkUpdateStatusLine({ ...baseState, status: "checking" })).toBe(
      "Checking for updates.",
    );
    expect(
      getForkUpdateStatusLine({
        ...baseState,
        status: "downloading",
        availableVersion: "0.0.41",
        downloadPercent: 42.7,
      }),
    ).toBe("Downloading v0.0.41 (42%).");
    expect(
      getForkUpdateStatusLine({
        ...baseState,
        status: "downloaded",
        downloadedVersion: "0.0.41",
      }),
    ).toBe("v0.0.41 is ready. It installs when you quit. Restart to get it now.");
    expect(getForkUpdateStatusLine({ ...baseState, status: "up-to-date" })).toBe("Up to date.");
  });

  it("says nothing before the first check", () => {
    // "Up to date." on a fresh window would be a claim nothing has checked.
    expect(getForkUpdateStatusLine({ ...baseState, status: "idle" })).toBeNull();
  });

  it("describes upstream's flow when the setting is off", () => {
    expect(
      getForkUpdateStatusLine({
        ...baseState,
        automaticUpdates: false,
        status: "downloaded",
        downloadedVersion: "0.0.41",
      }),
    ).toBe("v0.0.41 is ready. Restart to install it.");
    expect(
      getForkUpdateStatusLine({
        ...baseState,
        automaticUpdates: false,
        status: "available",
        availableVersion: "0.0.41",
      }),
    ).toBe("v0.0.41 found. Download it.");
  });

  it("reports a build without updates", () => {
    expect(getForkUpdateStatusLine(null)).toBe("Updates are off in this build.");
    expect(getForkUpdateStatusLine({ ...baseState, enabled: false, status: "disabled" })).toBe(
      "Updates are off in this build.",
    );
  });
});

describe("fork automatic updates support", () => {
  it("is absent on a build without the fork's automatic updates", () => {
    expect(supportsForkAutomaticUpdates(undefined)).toBe(false);
    expect(supportsForkAutomaticUpdates({} as DesktopBridge)).toBe(false);
  });

  it("is present when the bridge carries the setter", () => {
    const bridge = {
      setAutomaticUpdates: () => Promise.resolve(baseState),
    } as unknown as DesktopBridge;
    expect(supportsForkAutomaticUpdates(bridge)).toBe(true);
  });
});
