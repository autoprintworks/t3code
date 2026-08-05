# How does firstmate's session lock acquire on Windows Git Bash?

Spike for [autoprintworks/t3code#43](https://github.com/autoprintworks/t3code/issues/43).
Measured 2026-08-05 on Windows 11 / Git Bash (`MINGW64_NT-10.0-26200`, MSYS
`3.6.7`), inside a T3 Code (Alpha) `0.0.31` thread, Claude Code `2.1.222`,
entrypoint `sdk-ts`.

## Answer

**Nothing needs to be walked. Claude Code already hands the harness pid over in
`CLAUDE_PID`, and it is exactly the pid an ancestry walk would find.**

[#31](https://github.com/autoprintworks/t3code/issues/31) established the
failure: `fm_harness_ancestry_pid` (`bin/fm-session-lock-lib.sh:29`) opens with
`ps -o comm= -p`, MSYS `ps` has no `-o`, the walk dies on its first iteration,
and every mutating step of the first mate is skipped. It proposed a CIM walk
seeded from the bash WINPID as the obvious candidate. That candidate is real and
works, but it is not needed for the claude harness.

Measured in this session:

```
$ cat /proc/$$/winpid              # 28744
$ python win_ancestry.py --start 28744 --chain
  28744  bash.exe
  30948  bash.exe
  19556  claude.exe
  16984  T3 Code (Alpha).exe
  67404  T3 Code (Alpha).exe
  57156  explorer.exe
$ echo "$CLAUDE_PID"
19556
```

The env var and the native walk agree. `CLAUDE_PID` is set by the claude CLI
itself — the literal appears 9 times in `C:\Users\Glyn\.local\bin\claude.exe`,
inside its own bundled `pkill` guard (`[ -r "/proc/${CLAUDE_PID}/comm" ]`) — and
not in the agent SDK. So it is a property of the harness, not of T3's SDK
entrypoint.

**It is present in the Stop hook environment.** Not inferred: the
[#6](https://github.com/autoprintworks/t3code/issues/6) spike captured the hook
environment verbatim, and `CLAUDE_PID=63464` is in that record
(`experiments/stop-hook-spike/README.md:53`). That is the environment
`fm-claude-stop-autoarm.sh` runs in, so the auto-arm gate can read it.

## The three things that are not free

### 1. `CLAUDE_PID` is a native pid, so `kill -0` and `/proc` both miss it

MSYS keeps its own pid namespace. This session is MSYS pid `568`, native pid
`28744`. Measured:

```
$ kill -0 19556
bash: kill: (19556) - No such process
$ ps | awk '$1==19556'      # nothing: no MSYS pid collision either
```

So `fm_harness_pid_alive` (`bin/fm-session-lock-lib.sh:68`) fails on a correct
pid. Its `kill -0` and its `ps -o comm=` both need a Windows arm. `ps -W` is the
route: it lists native processes with a `WINPID` column and a full image path,
at ~120 ms.

Note the asymmetry with Linux, where Claude Code's own guard reads
`/proc/${CLAUDE_PID}/comm` directly. `CLAUDE_PID` is a native OS pid on every
platform; MSYS is the one place where the shell's own namespace is a different
one.

### 2. Claude Desktop ships its own `claude.exe`, and `FM_HARNESS_RE` matches it

This machine runs about twenty of them:

```
C:\Program Files\WindowsApps\Claude_1.24012.11.0_..._x64\app\claude.exe   (~20 live)
C:\Users\Glyn\.local\bin\claude.exe                                      (6 live: 3 T3, 3 Orca)
```

`FM_HARNESS_RE` matches on basename, so every one of those Desktop processes
reads as a verified harness. A lock left behind by a dead session whose pid is
later reused by a Claude Desktop process would read as *held by a live harness*
forever, and `fm-lock.sh:69` would refuse acquisition permanently. The distro
would sit read-only with no diagnosable cause.

The fix that is available today: match the **full image path**, not the
basename. `ps -W` supplies it and `CLAUDE_CODE_EXECPATH` supplies the expected
value. Demonstrated in `prototype-lib.sh`: a basename match accepts Desktop pid
`20804`; the full-path match rejects it.

This hazard is not created by any of this. It is latent in the current lib and
would bite the first Windows session that acquired a lock.

### 3. Resolve must stay spawn-free, and can

`fm_session_lock_owned_by_self` runs on every Stop. It reads the lock, resolves
its own identity, and compares — it never calls the liveness predicate on the
happy path. So the liveness cost lands only on the recovery path. Measured:

| Path | Cost |
| --- | --- |
| measurement floor (empty subshell) | 19 ms |
| resolve from `CLAUDE_PID`, no liveness check | 40 ms |
| resolve **with** a liveness check (`ps -W`) | 247-375 ms |
| `python win_ancestry.py` native walk | 114-155 ms |
| `powershell.exe -NoProfile` CIM walk | 734-1010 ms |

Two consequences. Resolve must not verify its own pid — it is trivially alive,
being this process's ancestor — which keeps the Stop path spawn-free. And the
CIM walk #43 proposed is the **worst** of the three mechanisms: 6-8x the python
helper and 20x the env read.

## What the CIM walk is still for

`win_ancestry.py` in this directory is a working generalisation of
`firstmate-gui-agnostic`'s `codex_desktop_ancestry.py` — a Toolhelp32 snapshot
via `ctypes`, no console helper, matching any image name rather than a
hard-coded `codex.exe`. It is what proved `CLAUDE_PID` correct, and it is the
fallback if a harness turns out not to export its own pid. `firstmate-claude-code`
already ships python (`firstmate_gui_agnostic/`, `bin/backends/herdr-eventwait.py`),
so it adds no dependency.

## The precedent already exists, in another repo

`C:\AGOS\firstmate-gui-agnostic` (the captain's live firstmate) has an unmerged
worktree, `.tmp/worktrees/final-standards-127`, that already solved this shape
for Codex Desktop — a GUI app whose harness is also unreachable by ancestry. Its
`bin/fm-session-lock-lib.sh` is worth reading in full before writing this. What
it did:

- Kept `fm_harness_ancestry_pid` intact and put the native route **in front** of
  it, with a three-valued return: `0` resolved, `1` applicable but unprovable,
  `2` not applicable — so non-Windows falls through untouched.
- Replaced the lock's bare pid with an **opaque identity string** owned by a new
  `fm_harness_identity`: `v1:pid:<pid>` for every ordinary harness,
  `v4:codex-desktop:<native-pid>:<creation-time>:<thread>:<turn>:<generation>`
  for the Desktop case. The live lock at `state/.lock` is in that v4 form.
- Included the process **creation time** in the identity, which is the general
  answer to pid reuse — a strictly better version of the image-path check in §2.
- Left `fm_codex_desktop_thread_lease_query` returning 1 with a comment saying
  it stops safely until Desktop exposes a lease primitive. The identity got
  richer than the platform could verify.

Note the divergence: that code is in `autoprintworks/firstmate-gui-agnostic`,
whereas this map lands code in `autoprintworks/firstmate-claude-code`. The two
repos' `bin/fm-session-lock-lib.sh` are byte-identical today, so the v4 work has
not crossed over.

## Prototype

`prototype-lib.sh` — runnable, not a patch. `fm_win_harness_pid` and
`fm_win_pid_alive`, with the applicability arm and the full-image-path check.
Verified in this session: resolves `19556`, agrees with the native walk, rejects
a dead pid, rejects a Claude Desktop `claude.exe`.

## Traps

- **`ps -W`'s `COMMAND` column contains spaces** (`C:\Program Files\...`), so
  `$8` truncates it. Take fields 8..NF.
- **`ps -W` reports `PPID` as `0` for every native process**, so it is a
  liveness and image source only, never an ancestry source. (#31 found this.)
- **`uname` is a process spawn** and dominated the spawn-free path (40 ms of
  which ~20 ms is the floor). Use `$OSTYPE` (`msys`) or cache it.
- **`/proc/<pid>/winpid` exists** and is the cheap MSYS→native bridge, if a walk
  is ever needed. `/proc/<pid>/ppid` likewise.
- **No nested-claude chain appears on Windows.** All six live CLI claudes are
  single-level (`claude.exe <- T3 Code (Alpha).exe`, or
  `claude.exe <- powershell.exe <- orca-terminal-daemon.exe`). The lib's
  outermost-consecutive-claude rule, written for the bg-spare hook worker chain,
  has nothing to bite on here — so it neither helps nor hurts.

## Files

- `prototype-lib.sh` — the proposed Windows arm, runnable.
- `win_ancestry.py` — Toolhelp32 native ancestry walk, generalised from the
  codex-desktop helper. Proved `CLAUDE_PID` correct; the fallback mechanism.
