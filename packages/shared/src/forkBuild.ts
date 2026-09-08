/**
 * The single seam that answers "is this build the fork?".
 *
 * This fork never goes upstream (#34) and installs beside an official T3 Code
 * release, so it has to look different in the taskbar and in the sidebar
 * (#59). Every surface that shows fork identity reads it from here, so an
 * upstream merge has one place to conflict.
 *
 * The signal is the fork's own release tag: this repo versions its packages
 * `<upstream version>-ap.<n>` (see `docs/operations/fork-windows-build.md`),
 * a marker upstream never publishes. Both surfaces can already see that version
 * without a new build flag: the desktop through `Electron.app.getVersion()`,
 * the web through `import.meta.env.APP_VERSION`, which Vite bakes in from
 * `apps/web/package.json`.
 */

const FORK_PRERELEASE_TAG_PATTERN = /-ap\.\d+(?:\+[\w.-]+)?$/;

export const UPSTREAM_APP_BASE_NAME = "T3 Code";
export const FORK_APP_BASE_NAME = "T3 Code Fork";
export const FORK_TAG_LABEL = "FORK";

export interface ForkBuildIdentity {
  readonly isFork: boolean;
  /** Product name for the window title, the About panel and the app name. */
  readonly appBaseName: string;
  /** Short tag for the sidebar wordmark, or `null` on a non-fork build. */
  readonly tagLabel: string | null;
}

export function resolveForkBuildIdentity(
  appVersion: string | null | undefined,
): ForkBuildIdentity {
  const isFork =
    typeof appVersion === "string" && FORK_PRERELEASE_TAG_PATTERN.test(appVersion.trim());

  return {
    isFork,
    appBaseName: isFork ? FORK_APP_BASE_NAME : UPSTREAM_APP_BASE_NAME,
    tagLabel: isFork ? FORK_TAG_LABEL : null,
  };
}
