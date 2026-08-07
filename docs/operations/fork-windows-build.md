# Fork Windows Build

> For maintainers of this fork. Using T3 Code? See [docs/user](../user/).

This fork never goes upstream ([#34](https://github.com/autoprintworks/t3code/issues/34)), so a fix
landed here only reaches the captain's desktop by building this repo's own installer and running it.
`.github/workflows/release.yml` cannot do that build: it needs runner infrastructure and Azure/Apple
signing secrets this fork does not have. The build described here is local, unsigned, NSIS-only.

## The command

```sh
vp run dist:desktop:win
```

That single command builds server, web, and desktop (`vp run build:desktop`), compiles the
resource-monitor helper, stages icons, and packages an unsigned NSIS installer to
`./release/T3-Code-<version>-x64.exe`. Nothing here is CI-only or secret-gated.

Prerequisites, beyond the usual [first checkout](../internals/scripts.md#first-checkout) (`vp i`):

- Rust, with the `x86_64-pc-windows-msvc` target, on `PATH` (`rustup target add
x86_64-pc-windows-msvc`). The resource-monitor helper is built with `cargo build --release`.
- MSVC build tools able to link that target (Visual Studio Build Tools, "Desktop development with
  C++" workload, or the standalone C++ build tools). Rust's `x86_64-pc-windows-msvc` target needs
  `link.exe`; without it the resource-monitor build fails before packaging starts.

Both are checked once, at the start of the run — cargo errors out immediately if either is missing,
before any packaging work happens.

Optional: `--arch arm64` for an arm64 installer (defaults to `x64`). `T3CODE_DESKTOP_WSL_PREBUILD` /
`--wsl-prebuild <path>` bundles a prebuilt Linux `pty.node` for the WSL backend; omitting it is a
warning, not a build failure — the packaged app just won't have a working WSL backend.

## The collision decision — read before running the installer

**This build installs beside the official release, not over it.** The original decision in
[#34](https://github.com/autoprintworks/t3code/issues/34) was to overwrite in place, on the theory that
there was only ever one T3 Code install and one database on this machine anyway. That held only until
this fork actually got its own installer built and run for the first time — at that point "we don't know
if anything will break yet" (an unproven local build touching the one real database) outweighed the
convenience of a shared thread list on day one. So the fork now gets its own identity end to end:

- **Different install location.** `scripts/build-desktop-artifact.ts` packages this fork under
  `appId: com.autoprintworks.t3code` and a staged package named `t3code-fork`, so electron-builder's
  default NSIS installer targets `%LOCALAPPDATA%\Programs\t3code-fork` — not
  `%LOCALAPPDATA%\Programs\t3code`, where an official release lives. Installing this build cannot
  replace or corrupt an official install's files.
- **Different app identity.** Product name (`T3 Code Fork`), Windows AppUserModelID
  (`com.autoprintworks.t3code`), and the custom URL scheme used for OAuth callbacks
  (`t3code-fork://` / `t3code-fork-dev://`, see `apps/desktop/src/electron/ElectronProtocol.ts`) are all
  distinct from the official build's. Two different OS-level protocol handlers can't fight over the same
  scheme.
- **Different database, by default.** T3 Code's state directory (threads, projects, settings — the
  "T3 home") is chosen by `DesktopEnvironment.ts`. This fork defaults to `~/.t3-fork` instead of `~/.t3`,
  so running it cannot read or write the official release's real `state.sqlite`. Set `T3CODE_HOME` to
  point the fork at `~/.t3/userdata` (or anywhere else) if you later want it to share the official
  release's thread list — that's a one-environment-variable change, not a rebuild. Doing that
  deliberately, once the fork is trusted, is still the way to reach the original
  [#46](https://github.com/autoprintworks/t3code/issues/46) goal: firstmate's crewmate threads landing
  in the same thread list the captain already uses.
- **No silent re-overwrite.** The packaged app ships no update feed — `resolveGitHubPublishConfig` in
  `scripts/build-desktop-artifact.ts` only sets one when `T3CODE_DESKTOP_UPDATE_REPOSITORY` or the
  CI-only `GITHUB_REPOSITORY` env var is set, and neither is set for a plain local run. So the installed
  fork will not auto-update itself from upstream's official releases (which would silently discard the
  fork's fixes) or from anywhere else. Shipping a change means re-running the command above and
  reinstalling by hand — the accepted trade for not running the release pipeline.

Because the install location, identity, and database are all separate, there is nothing to back up
before the first install — a bad build can misbehave, but it has no path to the official release's real
`~/.t3/userdata`. If you do point `T3CODE_HOME` at the shared database, back it up first the same way
you would before any risky local build: close T3 Code, then copy the whole `userdata` folder including
its `-wal`/`-shm` siblings — a plain file copy is only safe with the app closed.

```sh
robocopy "%USERPROFILE%\.t3\userdata" "%USERPROFILE%\.t3\userdata-backup-YYYYMMDD" /E
```

## Unsigned installer cost

This build has no code-signing story — that's explicitly out of scope, not an oversight. Azure Trusted
Signing is how the official release signs Windows artifacts (see [Release](./release.md#3-azure-trusted-signing-setup-windows)),
and this fork has none of those secrets. Running the installer trips Windows SmartScreen:
**"Windows protected your PC."** Click **More info**, then **Run anyway**. Every future local build hits
the same warning; there is nothing to fix here short of standing up a signing story, which is a
separate decision this ticket does not make.

## Reproducing this cold

1. `vp i` (first checkout only).
2. Install Rust with the `x86_64-pc-windows-msvc` target and MSVC build tools, if not already present.
3. `vp run dist:desktop:win`.
4. Run `./release/T3-Code-<version>-x64.exe`, click through the SmartScreen warning.
5. Confirm it installed to `%LOCALAPPDATA%\Programs\t3code-fork`, separate from any official install at
   `%LOCALAPPDATA%\Programs\t3code`, and that it opens with an empty `~/.t3-fork` database rather than
   the captain's real threads.
