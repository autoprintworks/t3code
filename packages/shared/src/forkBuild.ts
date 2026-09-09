/**
 * The single seam that says what this build calls itself.
 *
 * This fork never goes upstream (#34) and installs beside an official T3 Code
 * release, so it has to look different in the taskbar and in the sidebar (#59).
 * Every surface that shows fork identity reads it from here, so an upstream
 * merge has one place to conflict.
 *
 * The signal is the fork's own application id. Every artifact this repository
 * builds carries `com.autoprintworks.t3code`, on every channel: the desktop
 * build stamps it as the electron-builder `appId` and as the Windows app user
 * model id, and the same constant is compiled into the desktop main bundle and
 * into the web bundle. This repository never produces an official build, so the
 * identity does not vary and nothing at runtime can lose it. A nightly keeps it:
 * the nightly channel only rewrites the version string
 * (`scripts/resolve-nightly-release.ts`), which is why the version is not the
 * signal.
 */

/** The application id every artifact this repository builds carries. */
export const FORK_APP_ID = "com.autoprintworks.t3code";

const FORK_APP_BASE_NAME = "T3 Code Fork";
const FORK_TAG_LABEL = "FORK";

export interface ForkBuildIdentity {
  /** The `appId` of every artifact built here, and the signal this seam reads. */
  readonly appId: string;
  /** Product name for the window title, the About panel and the app name. */
  readonly appBaseName: string;
  /** Short tag the wordmark carries on every client. */
  readonly tagLabel: string;
}

const FORK_BUILD_IDENTITY: ForkBuildIdentity = {
  appId: FORK_APP_ID,
  appBaseName: FORK_APP_BASE_NAME,
  tagLabel: FORK_TAG_LABEL,
};

export function resolveForkBuildIdentity(): ForkBuildIdentity {
  return FORK_BUILD_IDENTITY;
}
