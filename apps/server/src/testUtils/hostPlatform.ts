/**
 * Host limits that make a test unrunnable on Windows, named once so a reader does not have to
 * rediscover the reason in every suite that skips.
 *
 * `it.skipIf` decides before any Effect layer exists, and the fixture builders these suites use
 * are plain async functions, so `HostProcessPlatform` cannot answer for them. This module reads
 * the real host once and is the only place in the server test suites that does.
 *
 * @module testUtils/hostPlatform
 */

// oxlint-disable-next-line t3code/no-global-process-runtime -- skip predicates and plain fixture builders run outside any Effect
export const isWindowsHost = process.platform === "win32";

/**
 * Windows cannot execute a file with a `#!` line, and these suites point a provider CLI at a
 * shell-script stub. Suites whose stub has a `.cmd` twin do not need this.
 */
export const skipPosixShellStub = isWindowsHost;

/**
 * `resolveSpawnCommand` runs a `.cmd` stub through cmd.exe, so the tree is cmd.exe -> node.
 * Windows does not kill a child when its parent dies, so an assertion that the ACP child exits
 * cannot hold against a batch stub.
 */
export const skipBatchStubChildExit = isWindowsHost;

/** Windows has no `mkfifo`; its named pipes are a different API and cannot be opened by path. */
export const skipPosixFifo = isWindowsHost;

/**
 * Windows has no directory fsync: the handle opens but `sync` on it fails with EPERM. A suite
 * that simulates a Linux host while writing to the real filesystem still meets that limit.
 */
export const skipDirectoryFsync = isWindowsHost;

/** Windows has no execute bit, so a resolver that looks for one has nothing to find. */
export const skipPosixExecuteBit = isWindowsHost;

/** `chmod` carries no write-deny meaning on Windows, so a read-only directory cannot be staged. */
export const skipPosixDirectoryMode = isWindowsHost;

/** Windows forbids a newline in a path component, so such a directory cannot be created. */
export const skipNewlineInPath = isWindowsHost;
