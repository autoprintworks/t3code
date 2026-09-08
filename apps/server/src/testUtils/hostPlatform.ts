/**
 * Host limits that make a test unrunnable on Windows, named once so a reader does not have to
 * rediscover the reason in every suite that skips.
 *
 * `it.skipIf` decides before any Effect layer exists, so `HostProcessPlatform` cannot answer
 * here. These constants read the real host directly, and they are the only place in the server
 * test suites that does.
 *
 * @module testUtils/hostPlatform
 */

// oxlint-disable-next-line t3code/no-global-process-runtime -- it.skipIf runs before any layer exists
const isWindows = process.platform === "win32";

/**
 * Windows cannot execute a file with a `#!` line, and these suites point a provider CLI at a
 * shell-script stub. Suites whose stub has a `.cmd` twin do not need this.
 */
export const skipPosixShellStub = isWindows;

/**
 * `resolveSpawnCommand` runs a `.cmd` stub through cmd.exe, so the tree is cmd.exe -> node.
 * Windows does not kill a child when its parent dies, so an assertion that the ACP child exits
 * cannot hold against a batch stub.
 */
export const skipBatchStubChildExit = isWindows;

/** Windows has no `mkfifo`; its named pipes are a different API and cannot be opened by path. */
export const skipPosixFifo = isWindows;

/**
 * Windows has no directory fsync: the handle opens but `sync` on it fails with EPERM. A suite
 * that simulates a Linux host while writing to the real filesystem still meets that limit.
 */
export const skipDirectoryFsync = isWindows;
