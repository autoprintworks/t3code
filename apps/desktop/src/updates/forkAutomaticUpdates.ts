import type { DesktopUpdateState } from "@t3tools/contracts";

/**
 * The fork's automatic update decisions, kept in one fork-only module so an
 * upstream merge touches as little of DesktopUpdates.ts as possible. Upstream
 * makes a user download and restart by hand; every fork release is the update
 * pipeline's own output, so the fork downloads it and installs it on the next
 * quit instead. Issue #113.
 */

/** On for the fork. The setting exists to get upstream's two-click flow back. */
export const DEFAULT_FORK_AUTOMATIC_UPDATES = true;

/**
 * True when a found update should start downloading with no click. Read after
 * the update-available handler has applied the channel filter, so a release on
 * another channel never reaches it.
 */
export function shouldAutoDownloadDesktopUpdate(args: {
  readonly automaticUpdates: boolean;
  readonly status: DesktopUpdateState["status"];
}): boolean {
  return args.automaticUpdates && args.status === "available";
}
