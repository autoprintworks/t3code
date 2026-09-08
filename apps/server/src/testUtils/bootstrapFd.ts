// @effect-diagnostics nodeBuiltinImport:off - closes a raw descriptor the test itself opened.
/**
 * Shared teardown for a bootstrap file descriptor handed to `readBootstrapEnvelope`.
 *
 * @module testUtils/bootstrapFd
 */

import * as NodeFS from "node:fs";

import { isWindowsHost } from "./hostPlatform.ts";

/**
 * `readBootstrapEnvelope` reads through a duplicate of this descriptor on POSIX and leaves
 * closing to the caller. Windows has no `/proc` equivalent to duplicate through, so it reads the
 * caller's descriptor directly and closes it as the stream tears down; closing again from the
 * test would race that close.
 */
export const releaseBootstrapFd = (fd: number): void => {
  if (isWindowsHost) return;
  NodeFS.closeSync(fd);
};
