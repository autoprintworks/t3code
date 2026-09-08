import type { DesktopAppBranding } from "@t3tools/contracts";
import { resolveForkBuildIdentity } from "@t3tools/shared/forkBuild";

import { formatAppDisplayName } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
export const APP_BASE_NAME =
  injectedDesktopAppBranding?.baseName ?? resolveForkBuildIdentity().appBaseName;
export const APP_STAGE_LABEL =
  injectedDesktopAppBranding?.stageLabel ??
  HOSTED_APP_CHANNEL_LABEL ??
  (import.meta.env.DEV ? "Dev" : "Alpha");
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";

/**
 * The tag the wordmark carries. Every bundle built from this repository is the
 * fork, so it holds on every surface the web app runs on: desktop, a locally
 * hosted `npx t3`, and a hosted deploy alike.
 */
export const APP_FORK_TAG_LABEL = resolveForkBuildIdentity().tagLabel;
