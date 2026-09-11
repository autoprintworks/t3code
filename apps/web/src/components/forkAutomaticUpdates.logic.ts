import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";

import { getDesktopUpdateDownloadedVersion } from "./desktopUpdate.logic";

/**
 * Fork only (#113). The words the fork's automatic updates put on screen, kept
 * in one fork-only module so an upstream merge touches as little of the shared
 * update UI as possible.
 */

type ForkAutomaticUpdatesBridge = DesktopBridge & {
  setAutomaticUpdates: (enabled: boolean) => Promise<DesktopUpdateState>;
};

/** False on a build without the fork's automatic updates. Hide the control then. */
export function supportsForkAutomaticUpdates(
  bridge: DesktopBridge | undefined,
): bridge is ForkAutomaticUpdatesBridge {
  return typeof bridge?.setAutomaticUpdates === "function";
}

/**
 * The update pill label. One short label with the version, shown only while a
 * downloaded update waits. Null means show nothing. The fork downloads without
 * a click, so this replaces the toast that a hand-started download raises.
 */
export function getForkUpdatePillLabel(state: DesktopUpdateState | null): string | null {
  if (!state || !state.automaticUpdates || state.status !== "downloaded") return null;
  const version = getDesktopUpdateDownloadedVersion(state);
  return version ? `v${version} ready` : "Update ready";
}

/** Settings shows the state in plain words. Null means say nothing, so a fresh
    window does not claim "Up to date." before the first check has run. */
export function getForkUpdateStatusLine(state: DesktopUpdateState | null): string | null {
  if (!state || !state.enabled) return "Updates are off in this build.";

  switch (state.status) {
    case "checking":
      return "Checking for updates.";
    case "downloading": {
      const version = state.availableVersion ? ` v${state.availableVersion}` : "";
      const percent =
        typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
      return `Downloading${version}${percent}.`;
    }
    case "downloaded": {
      const version = getDesktopUpdateDownloadedVersion(state);
      const name = version ? `v${version}` : "An update";
      return state.automaticUpdates
        ? `${name} is ready. It installs when you quit. Restart to get it now.`
        : `${name} is ready. Restart to install it.`;
    }
    case "available": {
      const version = state.availableVersion ? `v${state.availableVersion}` : "An update";
      return state.automaticUpdates ? `${version} found.` : `${version} found. Download it.`;
    }
    case "up-to-date":
      return "Up to date.";
    case "error":
      return state.message ?? "The last update attempt failed.";
    case "disabled":
      return "Updates are off in this build.";
    default:
      return null;
  }
}

/** The Settings switch label. */
export const FORK_AUTOMATIC_UPDATES_TITLE = "Automatic updates";

export const FORK_AUTOMATIC_UPDATES_DESCRIPTION =
  "Download a new version as soon as it is found. It installs when you quit. Turn this off to download and restart by hand.";
