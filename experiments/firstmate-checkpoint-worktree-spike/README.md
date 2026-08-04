# Does a treehouse-leased worktree survive T3's checkpointing?

Answers [autoprintworks/t3code#14](https://github.com/autoprintworks/t3code/issues/14) (part of #1).

**Yes.** A worktree T3 did not create survives a full turn with checkpointing
active, branch-drift following agrees with the worktree instead of fighting it,
and `treehouse return --force` still succeeds afterwards. The pooled worktree
comes back to the next task byte-clean.

What does *not* survive is the shared repo's hygiene. T3 writes its checkpoint
refs into the **common** ref store — the primary checkout's, not the worktree's —
and never deletes them, not even on `thread.delete`. Every crewmate leaves
`turns + 1` permanent refs behind in the project repo, each one pinning a commit
that contains the crewmate's entire working tree, including files it never
committed. That is a leak firstmate has to clean up, because nothing else will.

---

## What was run

Nothing touched `~/.t3/userdata`. Two throwaway servers, one throwaway repo:

| | |
| --- | --- |
| scratch project | `%TEMP%/fm14-lab/proj`, a fresh `git init`, `treehouse.toml` with `max_trees = 1` so the pool must hand the same worktree back |
| scratch server A | `t3@0.0.31` (the current release), `--base-dir %TEMP%/fm14-lab/t3home`, port 37731 |
| scratch server B | `t3@0.0.32-nightly.20260804.993`, `--base-dir %TEMP%/fm14-lab/nightly/t3home`, port 37732 |
| provider | `claudeAgent` / `claude-fable-5`, `runtimeMode: full-access` |

Two servers because **branch-drift following is not in the current release**.
`followWorktreeBranchDrift` landed in `0ad91b6e7` on 2026-07-31; v0.0.31 was cut
on 2026-07-29. `grep -c followWorktreeBranchDrift` over the shipped bundle
returns `0` for 0.0.31 and `2` for the nightly. The drift bullet of the ticket
can only be answered against a build that contains the code, so it was answered
against both and the difference is reported below.

- `spike.mjs` — the full lifecycle: lease → thread → turn → drift → teardown →
  re-lease the pooled worktree → second thread → return. Snapshots the git state
  at every stage boundary into `findings.json`.
- `drift-probe.mjs` — a controlled two-arm comparison of drift-following, one
  arm on a treehouse lease and one on a plain `git worktree add`, to separate
  "treehouse worktrees are special" from "this build has no drift-following".

Reproduce:

```bash
LAB=/tmp/fm14-lab
mkdir -p "$LAB/proj" && cd "$LAB/proj" && git init -b main
printf 'max_trees = 1\nroot = "./"\n' > treehouse.toml
git add -A && git commit -m "scratch project"

npm i t3@0.0.32-nightly.20260804.993 --prefix "$LAB/cli"
node "$LAB/cli/node_modules/t3/dist/bin.mjs" serve --base-dir "$LAB/t3home" --port 37732 "$LAB/proj" &
node "$LAB/cli/node_modules/t3/dist/bin.mjs" auth session issue --token-only --ttl 1d \
  --base-dir "$LAB/t3home" | tail -1 > "$LAB/token.txt"

node spike.mjs --lab "$LAB"
node drift-probe.mjs --lab "$LAB"
```

Two Windows-only snags worth writing down, because they will bite the next
person who tries this here:

- The published `bin.mjs` guards its entry point with `if (import.meta.main)`,
  which is `undefined` before Node 24. On Node 22 the CLI **exits 0 and prints
  nothing** — no error, no help, no server. It looks like a broken install.
- The server needs `node:sqlite` APIs from Node >= 22.16. The lab uses a
  portable Node 24.4.1 unpacked into the lab directory rather than touching the
  developer's toolchain.

---

## The four questions

### 1. Does a leased worktree survive a full turn with checkpointing active?

Yes, with no sign of strain.

The lease lands on a detached HEAD, exactly as #18 found, so the crewmate names
its own branch as its first instruction. `thread.create` carries
`branch: "fm/<id>"` — a branch that does not exist yet — and `worktreePath` as
the absolute path treehouse printed. T3 stores both verbatim; the snapshot reads
back the path character-for-character, backslashes and all:

```
sent     = C:\Users\Glyn\AppData\Local\Temp\fm14-lab\proj\.treehouse\proj-196e6c\1\proj
recorded = C:\Users\Glyn\AppData\Local\Temp\fm14-lab\proj\.treehouse\proj-196e6c\1\proj
```

The crewmate ran `git checkout -b`, wrote a file and committed it. Two turns
produced three checkpoint refs (a turn-0 baseline plus one per turn) and zero
warnings. Capture uses an isolated `GIT_INDEX_FILE`, so the crewmate's own index
is never disturbed, and the temp index is removed on the way out — the stray
`t3-checkpoint-index-*` count was `0` at every one of the eleven stage
boundaries.

### 2. Does branch-drift following fight treehouse for the branch?

No. It cannot: **treehouse does not own the branch.** A lease hands over a
detached HEAD, so the only branch in play is the one the crewmate created, and
drift-following adopting it is T3 agreeing with the worktree, not overruling it.

On the nightly, the drift is followed in both arms:

| arm | worktree checked out | T3 recorded after the turn | followed |
| --- | --- | --- | --- |
| treehouse lease | `drift/6fc472c9` | `drift/6fc472c9` | yes |
| plain `git worktree add` | `drift/3ab4fe91` | `drift/3ab4fe91` | yes |

On v0.0.31, neither arm follows — the recorded branch stays `start/<id>` — which
is the missing code, not a treehouse effect. That both arms move together is the
point: the leased worktree is not treated differently from one T3 made itself.

One consequence lands on firstmate rather than on T3. `fm-teardown.sh:1267-1271`
detaches HEAD and deletes **the branch that is currently checked out**. If the
crewmate ends on a branch other than the one it created, that is the only branch
teardown drops:

```
branchAtTeardown : drifted/93d8937d
branch -D        : Deleted branch drifted/93d8937d (was b7c80b0).
branches left    : fm/93d8937d, main        <- the crewmate's real branch, orphaned
```

The work is not lost, which is the safe direction to fail in, but the shared
repo keeps a branch teardown meant to remove. This is firstmate's single-branch
assumption meeting a crewmate that made two, and it exists with or without T3.

### 3. Does `treehouse return --force` still succeed with checkpoint refs left behind?

Yes, both times, exit status 0 with empty stderr — once after the fm-teardown
dance (detach, `branch -D`, return) and once with the thread deleted first.
Checkpoint refs live under `refs/t3/checkpoints/…`, which is not one of git's
per-worktree ref namespaces, so they are simply refs in the shared store. They
neither pin the worktree nor block a branch deletion, and `treehouse return`
never looks at them.

The return is also a real reset. Worktree A held `CREWMATE-A.md` on a branch;
after the return the directory was back to the three tracked files, HEAD
detached, `git status --porcelain` empty.

### 4. Does a pooled worktree carry anything over to the next task?

**On the filesystem, nothing.** With `max_trees = 1` the second lease returned
the identical path, and the inventory taken before thread B started anything
shows a pristine tree. The crewmate's own report agrees:

```
ls -a                     -> . .. .git NOTES.md README.md treehouse.toml
git status --porcelain    -> (no output — clean)
git log --oneline -3      -> the three base commits, nothing from crewmate A
```

**In the repository, quite a lot.** Five checkpoint refs survived both threads
and both returns:

```
refs/t3/checkpoints/OTNkODkzN2Qt…/turn/0   thread A baseline
refs/t3/checkpoints/OTNkODkzN2Qt…/turn/1   thread A turn 1
refs/t3/checkpoints/OTNkODkzN2Qt…/turn/2   thread A turn 2
refs/t3/checkpoints/YmIyZjk2M2Ut…/turn/0   thread B baseline
refs/t3/checkpoints/YmIyZjk2M2Ut…/turn/1   thread B turn 1
```

They do not collide — the path segment is the base64url of the thread id, and
T3 burns thread ids permanently — so a later task is never confused by an
earlier one's refs. The problem is that they never go away. `thread.delete` does
not remove them; the only caller of `deleteCheckpointRefs` in the whole server
is the checkpoint-revert path, dropping refs newer than the revert target. That
was tested in both orders and neither cleans up:

| order | refs before | refs after |
| --- | --- | --- |
| A: `treehouse return`, then `thread.delete` (worktree already gone) | 3 | 3 |
| B: `thread.delete`, then `treehouse return` (worktree still alive) | 5 | 5 |

And these refs are not empty markers. Each points at a commit of the crewmate's
**entire working tree at that moment**, produced by `git add -A` into a scratch
index — so it includes files the crewmate never committed and never intended to
share. After the worktree is wiped and returned to the pool, the next task's
crewmate, working in that same directory, can still read all of it:

```
$ git show refs/t3/checkpoints/OTNkODkzN2Qt…/turn/2:CREWMATE-A.md
branch: fm/93d8937d
directory: C:\Users\Glyn\...\.treehouse\proj-196e6c\1\proj
```

For a firstmate fleet this compounds on every task, forever, in the repo every
crewmate shares.

---

## What firstmate must do differently

Dedicated non-pooled worktrees are **not** required — pooling is clean, and the
return path already resets the tree. What is required is one cleanup step.

1. **Delete the thread's checkpoint refs during teardown.** T3 will not, and the
   refs outlive both the thread and the worktree. The ref prefix is derivable
   from the task id, because firstmate mints the id and reuses it as the thread
   id (#8), so no bookkeeping is needed:

   ```bash
   PREFIX="refs/t3/checkpoints/$(printf %s "$ID" | base64 | tr '+/' '-_' | tr -d '=')"
   git -C "$PROJ" for-each-ref --format='delete %(refname)' "$PREFIX" \
     | git -C "$PROJ" update-ref --stdin
   ```

   Run it from `$PROJ`, not `$WT`, and run it **before** `treehouse return` only
   for tidiness — it works either way, since the refs live in the shared store
   and the worktree is irrelevant to them.

2. **Delete every `fm/<id>`-shaped branch for the task, not just the checked-out
   one.** `fm-teardown.sh` drops the current branch; a crewmate that moved off
   its own branch leaves that branch behind. Enumerate by task id instead of
   trusting HEAD.

3. **Do not treat a leased worktree as needing special handling in T3.** No
   patch to T3 is required for the binding itself. The unvalidated
   `worktreePath` is stored and used exactly as given, checkpointing is happy in
   a foreign worktree, and drift-following is a feature here rather than a
   hazard: it keeps T3's idea of the branch matched to whatever the crewmate
   actually did.

The one thing worth raising upstream is separate from firstmate: T3 leaks
checkpoint refs on `thread.delete` for *every* user with a worktree-backed
thread, not just for us. Worth its own issue.

---

## Files

- `spike.mjs` / `run.log` / `findings.json` — the full lifecycle run against the nightly.
- `drift-probe.mjs` — the two-arm drift comparison.
- `drift-findings-nightly.json` / `drift-run-nightly.log` — drift followed in both arms.
- `drift-findings-0.0.31.json` / `drift-run-0.0.31.log` — the same probe on the release, where the code does not exist.
- `server-drift-log-excerpt.txt` — the server's own `thread branch followed worktree checkout` lines.

Model: Claude Opus 5, harness: Claude Code.
