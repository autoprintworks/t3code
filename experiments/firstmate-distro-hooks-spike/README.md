# Do the firstmate distro's own hooks fire when a T3 thread opens on it?

Spike for [autoprintworks/t3code#31](https://github.com/autoprintworks/t3code/issues/31).
Measured 2026-08-05 against T3 Code (Alpha) `0.0.31` at `127.0.0.1:3773`,
Claude Code `2.1.222`, entrypoint `sdk-ts`, on Windows 11 / Git Bash
(`MINGW64_NT-10.0-26200`).

Target: `C:\00_AI_Development\firstmate-claude-code` at `ad4f4d1`, adopted T3
project `b95d23b1`, probe thread `f095479c-e91a-428e-973d-95cfd023f268`.

## Answer

**Every hook the distro registers fires, and every skill resolves. The distro's
own supervision does not run — for a reason that has nothing to do with T3.**

[#4](https://github.com/autoprintworks/t3code/issues/4) was retargeted to
`t3code` and answered the harness half only; [#6](https://github.com/autoprintworks/t3code/issues/6)
covered the Stop hook. This spike covers the rest of the surface, and the two
gaps #4 predicted turned out to be already fixed on this checkout.

### 1. Which hooks fire

All four registered in `.claude/settings.json`, plus the two Stop hooks
[#6](https://github.com/autoprintworks/t3code/issues/6) already measured. Every
one was executed through `"$CLAUDE_PROJECT_DIR"/bin/fm-*.sh` and resolved.

| Event | Script | Fired | Evidence |
| --- | --- | --- | --- |
| `SessionStart` (`startup`) | `fm-sessionstart-nudge.sh` | yes | `SessionStart:startup hook success` delivering the `FIRSTMATE_OP: v1 session-start` operational input verbatim |
| `PreToolUse` / `Bash` | `fm-arm-pretool-check.sh` | yes | `pkill -f fm-watch` denied `[broad-watcher-kill]` |
| `PreToolUse` / `Bash` | `fm-cd-pretool-check.sh` | yes | `cd projects/foo` denied `[persistent-cd]` |
| `PreToolUse` / `.*` | `fm-subagent-pretool-check.sh` | yes | the `Agent` tool denied `[subagent-dispatch]` |
| `Stop` | `fm-turnend-guard.sh`, `fm-claude-stop-autoarm.sh` | yes (#6) | — |

Verbatim deny payloads are in [`observed.md`](./observed.md).

**A silent hook is not a hook that fired.** Every one of the three scripts was
run by hand first, in the same checkout and shell, so its verdict in this
environment was known before the live run. That is what makes the table above a
measurement rather than an assumption — `fm-arm-pretool-check.sh` in particular
allows `bin/fm-watch.sh`, `bin/fm-watch-arm.sh` and a chained `&&` form on this
build, so the obvious probe would have produced an indistinguishable silence.
`pkill -f fm-watch` is the deny it does still carry.

`CLAUDE_PROJECT_DIR` is populated in the hook environment and **empty in the
Bash tool environment** of the same session — #6's correction reproduces exactly.

### 2. Does `.claude/skills` resolve

**Yes. All 19 firstmate skills were offered to the thread.** #4's Windows
symlink breakage is **not present on this checkout** and no `git restore` was
needed:

```
$ git ls-files -s CLAUDE.md .claude/skills
120000 47dc3e3d…  CLAUDE.md
120000 2b7a412b…  .claude/skills
$ ls -l CLAUDE.md .claude
lrwxrwxrwx  CLAUDE.md -> AGENTS.md
lrwxrwxrwx  skills -> ../.agents/skills/
$ git status --short      # clean
```

Both are real reparse points in the working tree. `AGENTS.md` loads into thread
context through the `CLAUDE.md` symlink — the thread quoted its first heading
(`# Firstmate`) and first sentence (`You are the first mate.`). So the ticket's
first instruction (restore `CLAUDE.md`, then measure) was already satisfied.

### 3. Can the first mate run its own session-start digest

**It runs to completion, exit 0 — and declares itself a READ-ONLY session.**

```
LOCK
error: cannot locate harness process in ancestry
●  READ-ONLY SESSION - FLEET LOCK OWNERSHIP WAS NOT VERIFIED
●  Skipping every mutating step: PR-check migration, stale Herdr child cleanup,
●  secondmate sync, X-mode artifacts, fleet sync, and wake-queue drain.
```

The digest itself is complete and useful — bootstrap diagnostics, context files,
fleet state, supervision instructions all render. What is missing is every
mutating step, and therefore supervision itself.

## The blocker, and why it is not T3's

`bin/fm-lock.sh:36` calls `fm_harness_ancestry_pid`
(`bin/fm-session-lock-lib.sh:29`), which walks up to 16 ancestors from `$$`.
Its first statement is:

```sh
comm=$(ps -o comm= -p "$pid" 2>/dev/null) || break
```

MSYS `ps` implements only `[-aefls] [-u UID] [-p PID]`. **There is no `-o`.** It
exits 1 on the first iteration, `break` ends the walk with `best` empty, and the
function returns 1. Independently, MSYS process ids stop at the MSYS boundary —
the thread's top-level bash reports `PPID=1` — so even a `-o`-capable `ps` could
not reach the harness. `bin/fm-session-lock-lib.sh` contains no MSYS, WINPID or
`-W` handling anywhere.

**This is a property of Git Bash, not of T3.** The shell that launched bash
cannot change which options `/usr/bin/ps` implements, so the resolver fails
identically under a terminal `claude`. It is the same shape as #4's two gaps:
found inside a T3 thread, caused by Windows.

The harness *is* in the real ancestry and *would* match `FM_HARNESS_RE`. A CIM
walk from the live bash WINPID returns the chain #4 predicted:

```
  22116  bash.exe
  25296  bash.exe
  45088  claude.exe          <- matches FM_HARNESS_RE
  16984  T3 Code (Alpha).exe
  67404  T3 Code (Alpha).exe
  57156  explorer.exe
```

So the fix is a Windows-aware ancestry mechanism in firstmate — no T3 patch.

### It reaches further than the digest

`bin/fm-claude-stop-autoarm.sh:80` gates on `fm_session_lock_owned_by_self`,
which calls the same resolver and **fails closed** on unresolvable ancestry
(`bin/fm-session-lock-lib.sh:94`). With no lock the script exits 0 silently
(reproduced by hand); with a lock it cannot match, falls to the recovery path,
and `fm-lock.sh` fails on the same call.

**So the Stop-owned auto-arm is structurally inert on Windows Git Bash.** This
sharpens rather than contradicts #6: #6 measured that the Stop hook *fires*, and
it does. What it does not do is arm. Zero-token supervision survives the move to
T3, as #6 found, and then stops at the Windows lock.

### Corroboration that this predates T3

- The distro's `state/` is empty and `data/` absent — this home has never
  successfully run.
- The captain's live firstmate is a **different repo**,
  `autoprintworks/firstmate-gui-agnostic` at `C:\AGOS\firstmate-gui-agnostic`,
  carrying the byte-identical `ps -o comm= -p` call. Its lock *is* held, as
  `v4:codex-desktop:17352:…`, alongside `.codex-desktop-session-admission.json`
  and `.codex-desktop-session-claim.lock`. The evidence is the lock file's own
  contents; the codex-desktop admission code path was not read, so treat "codex
  bypasses ancestry" as the reading the artifacts support, not a verified claim.

## Traps

- **`fm-arm-pretool-check.sh` allows more than the docs suggest on this build.**
  `bin/fm-watch.sh`, `./bin/fm-watch.sh`, `bin/fm-watch-arm.sh` and
  `echo hi && bin/fm-watch-arm.sh` all returned allow, though
  `docs/arm-pretool-check.md:76` describes a direct execution as always denying
  with `watcher-direct`. Only `pkill -f fm-watch` (`[broad-watcher-kill]`)
  denied. Anyone probing this hook with the documented case will read a live
  hook as a dead one.
- **The session-start nudge carries an invisible `U+2063`** before
  `FIRSTMATE_OP`. A probe grepping for a literal line start misses it.
- The thread reported the subagent guard blocking a tool named **`Agent`**, not
  `Task` — the guard's stem match (`agent`) covers it either way, but a fixed
  tool-name expectation would not.
- `ps -W` lists native Windows processes but reports `PPID` as `0` for all of
  them, so it is not a route to ancestry either.

## Consequence for the map

The destination's step 1 is a first mate that *lives* in a T3 thread and
supervises a crewmate. A read-only first mate cannot spawn, steer, merge or
drain, and its watcher never arms — so this blocks the destination, though not
[#29](https://github.com/autoprintworks/t3code/issues/29) itself: `t3.sh` can be
written and tested against a first mate driven by hand.

## Files

- `probe-distro-hooks.mjs` — creates the thread over HTTP alone (#28), runs the
  probe brief, captures the hydrated transcript.
- `observed.md` — written by the probe thread from inside the distro. The
  primary record.
- `thread-detail.json` — `GET /api/orchestration/threads/:id`.
- `probe-transcript.json` — dispatches and observed status transitions.
