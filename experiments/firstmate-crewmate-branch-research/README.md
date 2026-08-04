# What branch does a crewmate hand back from a detached treehouse worktree?

Research for [#18](https://github.com/autoprintworks/t3code/issues/18) (part of
[#1](https://github.com/autoprintworks/t3code/issues/1)). Source-only: every claim below
is cited to a file and line in one of two checkouts on this machine —

- `t3code` → `C:\00_AI_Development\t3code` (paths below are repo-relative)
- `firstmate` → `C:\00_AI_Development\firstmate-claude-code` (paths prefixed `firstmate/`)

**The short answer.** firstmate already has an answer and it is not "the backend does it".
The crewmate creates `fm/<id>` itself, as the literal first instruction of its brief
(`firstmate/bin/fm-brief.sh:380`), and that line is the *only* thing in all of `firstmate/bin`
that creates a task branch. The brief is backend-agnostic — `fm-brief.sh` never reads
`BACKEND` — so `claude-bg`, the existing pane-less backend, gets exactly this instruction and
nothing more. `bin/backends/t3.sh` should therefore create no branch and pass
`branch: "fm/<id>"` to `thread.create` as **metadata that predicts what the crewmate is about
to do**, because that is the one value of the field that makes T3's own branch bookkeeping
end up correct.

That branch existing as a real, predictably-named ref is also what unlocks the destination #18
is aimed at: T3's own commit → push → create-PR flow is a `cwd`-addressed RPC, not a UI-only
button, but it refuses to run from a detached HEAD (§7). Two adjacent questions surfaced and are
deliberately *not* answered here — whether the PR should be handed back through T3 or gh-axi,
and whether the T3 backend should use T3's worktree management instead of treehouse (§8, §9).

---

## 1. Is the detached HEAD a `--lease` property, or a property of every treehouse worktree?

**Every treehouse worktree.** The lease flag changes reservation and I/O, not checkout state.

Treehouse's own `get --help` (binary at `C:\Users\Glyn\AppData\Local\treehouse\treehouse`,
reporting `v2.0.0`) describes `--lease` entirely in terms of reservation, subshell, and stdout:

> Pass --lease for a non-interactive, durable acquire: treehouse reserves the worktree, marks
> it leased in its persistent state, and prints only the worktree's absolute path to stdout
> (all banners go to stderr). A leased worktree is never handed out by a later get and never
> removed by prune, even with no process running inside it, until you release it with
> 'treehouse return <path>'.

Nothing about refs or branches. And firstmate documents the detached HEAD as universal, in
places that have nothing to do with leasing:

- `firstmate/docs/architecture.md:140` — "The primary checkout is healthy on its default
  branch, and **linked worktrees or secondmate homes are healthy at detached HEAD**." That
  sentence covers all crewmate worktrees, whatever the backend.
- `firstmate/bin/fm-brief.sh:266` (scout) and `:374` (ship) — "You are in a disposable git
  worktree of $REPO, **at a detached HEAD on a clean default branch**." Both briefs are
  emitted with no knowledge of the backend (`fm-brief.sh` contains no `BACKEND` reference at
  all; it branches only on `KIND` at `:256`/`:137` and on delivery `MODE` at `:311`), so this
  sentence is told to a tmux crewmate and a `claude-bg` crewmate alike.
- `firstmate/bin/fm-crew-state.sh:383-385` — "CREW_BRANCH is empty at detached HEAD (**a
  just-spawned crew**, or a scout's scratch worktree)". `fm-crew-state.sh` is backend-neutral;
  "a just-spawned crew" is the terminal-backend state too.
- `firstmate/bin/fm-ff-lib.sh:23-25` — "Homes are leased at a detached HEAD on the default
  branch, so the fast-forward advances HEAD only and never moves the shared default branch or
  any other worktree's checkout." This is the *reason*: it is structural, not a lease
  artefact.

The structural reason is confirmed independently at `firstmate/bin/fm-fleet-sync.sh:247-254`,
which names the exact git constraint: a worktree cannot attach to `$DEFAULT` when another
worktree already has it checked out, and `stuck_state` at `:273` renders that condition as
`"detached HEAD ($DEFAULT checked out in another worktree)"`. The pool's parent repo always
has `main` checked out in the primary, so a pool worktree of the same repo **must** be
detached. `--lease` is irrelevant to that.

**Confirmed empirically.** The stale local pool blocked a direct read
(`~/.treehouse/firstmate-7bab20/1/firstmate` points at `gitdir: C:/AGOS/firstmate/.git/...`,
which no longer exists), so this was run in a throwaway scratch repo instead — #9's pattern,
and nowhere near the developer's live pool or `~/.t3/userdata`. treehouse `v2.0.0`, a fresh
`git init -b main` repo with one commit, `root = "./"`:

```
$ printf 'git rev-parse --abbrev-ref HEAD; git status -sb | head -1; exit\n' | treehouse get
🌳 Entered worktree at …\.treehouse\scratch-08c732\1\scratch. Type 'exit' to return.
HEAD
## HEAD (no branch)

$ git worktree list
…/scratch                                  3c42110 [main]
…/scratch/.treehouse/scratch-08c732/1/scratch  3c42110 (detached HEAD)
```

The same pool slot via the lease path reports identically (`HEAD`, `## HEAD (no branch)`,
`(detached HEAD)`). So plain `treehouse get` and `treehouse get --lease` land on the same
detached checkout; the flag changes only who holds the reservation. This matches #9's lease-path
capture at `experiments/firstmate-crewmate-spawn-spike/README.md:106-110` and `findings.json:71`
(`"branch": "HEAD"`), and settles what was previously an inference from help text plus docs.

## 2. What do the terminal backends end up on after a pane types `treehouse get`?

**The same detached HEAD.** `firstmate/bin/fm-spawn.sh:1375-1376` sends the literal line
`treehouse get` into the pane for every backend except `secondmate` kind, `orca`, `codex-app`,
and `claude-bg`; `:1398-1416` then discovers the worktree purely by polling the pane's cwd.
Nothing in that block, or anywhere else in `fm-spawn.sh`, runs `git checkout`, `git switch`,
or `git branch`. The pane lands in a detached worktree and stays there until the crewmate
reads its brief.

Two downstream call sites treat a still-detached crew worktree as a normal, expected state:

- `firstmate/bin/fm-teardown.sh:1267-1272` reads `git rev-parse --abbrev-ref HEAD` and only
  deletes a branch `if [ "$branch" != "HEAD" ]` — i.e. `HEAD` (detached) is a valid outcome.
  This is the generic (non-orca, non-codex-app) arm, so it covers tmux/wezterm/zellij/cmux/
  herdr **and** claude-bg.
- `firstmate/bin/fm-review-diff.sh:70-75` falls back from `fm/$ID` to `symbolic-ref HEAD` and
  fails loudly with "branch fm/$ID does not exist and worktree $WT is detached" — a first-class
  error path, which only exists because a detached crew worktree is a real thing to hit.

**Verdict on the lead:** confirmed. The detached head is not a `--lease` property. Both
acquisition paths (`fm-spawn.sh:1368` leased, `:1376` pane-typed) start detached.

## 3. How does `claude-bg` get from a leased worktree to something mergeable today?

**The crewmate does it, in its first action. No script creates the branch.**

Exhaustive check: a grep for branch-creating git verbs (`checkout -b`, `switch -c`,
`git branch `, `branch -f`) across all of `firstmate/bin/` returns exactly one hit —

```
firstmate/bin/fm-brief.sh:380:1. First action: create your branch: \`git checkout -b fm/$ID\`$SETUP2
```

That is prose inside a heredoc: an instruction to the agent, not an executed command. So:

- **Not the backend.** `firstmate/bin/backends/claude-bg.sh` (read in full, 330 lines) has no
  git call anywhere. Its `fm_backend_claude_bg_create_task` (`:256-275`) only `cd`s into the
  already-existing worktree and launches `claude --bg` with the brief as `argv`. Its header
  at `:246-252` states the two divergences from the terminal backends — the worktree must
  already exist, and creation and first prompt are one call — and neither involves a branch.
- **Not the spawner.** `firstmate/bin/fm-spawn.sh:1367-1373` leases the worktree, validates
  it, and stops; `:1765-1771` launches `claude --bg` with the brief *contents* so that "a
  crewmate on either backend starts from byte-identical instructions" (`:1763-1765`).
- **Not teardown.** `firstmate/bin/fm-teardown.sh:1247` is explicitly the *destructive* side —
  "Best-effort: drop the local task branch so the shared repo does not accumulate refs" — and
  `:1267-1272` detaches and `branch -D`s whatever branch it finds. Teardown consumes a branch;
  it never produces one.
- **Not the PR flow.** `firstmate/bin/fm-pr-check.sh` only records `pr=`/`pr_head=` from an
  already-open PR (`:73-102`); `firstmate/bin/fm-pr-lib.sh:214-217` validates a 40/64-hex head
  sha. Neither creates a ref. The PR itself is opened *by the crewmate*, per the direct-PR
  definition of done at `fm-brief.sh:317-320` ("push your branch and open a PR"), or by the
  no-mistakes pipeline the crewmate drives (`:339-356`).

The consumers all assume `fm/<id>` exists by the time they run:

| Consumer | Line | Assumption |
| --- | --- | --- |
| `fm-merge-local.sh` | `:44-45` | `refs/heads/fm/$ID` must exist **in `$PROJ`** — hard error otherwise. (Worktrees share the ref store, so a branch created in the worktree is visible from the primary.) Then `:59-66` fast-forwards `main` onto it. |
| `fm-review-diff.sh` | `:70-75` | prefers `fm/$ID`, falls back to the checked-out branch, errors on detached |
| `fm-teardown.sh` | `:392-395` | `pr_number_from_branch` refuses when `branch = HEAD` — a detached crew worktree can never resolve its PR |
| `fm-teardown.sh` | `:819-830` | the fail-closed unpushed-work check reads `rev-parse --abbrev-ref HEAD` and asks the forge whether that branch landed |
| `fm-promote.sh` | `:29` | the scout→ship promotion message tells the crewmate to "create branch fm/$ID" — again, an instruction to the agent |
| `fm-bearings-snapshot.sh` | `:242` | maps a PR back to a task by stripping the `fm/` prefix off `headRefName` |

So the whole merge/PR authority chain is keyed on `fm/<id>` and every link expects the
*crewmate* to have made it.

## 4. Does firstmate's brief tell crewmates to branch, or is it assumed from the pane?

**It tells them, explicitly, and it is the first numbered setup step.** `fm-brief.sh:380`:

```
1. First action: create your branch: `git checkout -b fm/$ID`
```

It is guarded, too. `:376-378` makes the crewmate prove isolation first — `pwd -P` and
`git rev-parse --show-toplevel` must resolve to the disposable worktree — and instructs
"If the top-level path is the primary checkout or not the worktree you were launched in,
STOP — **do not branch or commit here**". `firstmate/docs/architecture.md:146` states the same
contract from the doc side: "Ship briefs also tell the crewmate to verify `pwd -P` and
`git rev-parse --show-toplevel` before creating `fm/<id>`".

The name is then repeated to the crewmate in every delivery mode, so it is not incidental:
`:314` (direct-PR: "push only your `fm/<id>` branch"), `:325`/`:329`/`:331` (local-only:
"Work only on your `fm/$ID` branch", "done: ready in branch fm/$ID").

**Scouts are the deliberate exception.** The scout brief (`:257-299`) has no branch
instruction at all — its deliverable is a report (`:267`, `:294`), the worktree is
"your laboratory … all of it is discarded at teardown" (`:268`), and teardown skips the
safety gate for scouts (`fm-teardown.sh:772-774`). A scout legitimately stays detached, which
is why `fm-crew-state.sh:383-384` lists "a scout's scratch worktree" alongside a just-spawned
crew as the two normal detached cases.

## 5. What does T3 actually do with `thread.create`'s `branch`?

**It stores it. It never materialises it.** But it is not inert — one reactor reads it.

- Schema: `packages/contracts/src/orchestration.ts:565` — `branch: Schema.NullOr(TrimmedNonEmptyString)`.
  Nullable, any non-empty trimmed string; no ref-name validation, which is why #9's
  `branch: "HEAD"` was accepted without complaint (`experiments/firstmate-crewmate-spawn-spike/spike.mjs:392`,
  value captured at `:190`; recorded in `findings.json:71`).
- Decider: `apps/server/src/orchestration/decider.ts:373` copies `command.branch` straight
  into the `thread.created` payload. No git call.
- The **only** branch-materialising path in the server is `bootstrap.prepareWorktree`
  (`apps/server/src/ws.ts:908-936`): it calls `gitWorkflow.createWorktree({ newRefName:
  bootstrap.prepareWorktree.branch, … })` at `:921-926` and then writes the *resulting*
  ref back with a `thread.meta.update` at `:929-935`. That is a **separate** bootstrap field
  from `createThread.branch` (dispatched at `:891-903`), and it also creates its own worktree —
  which a firstmate spawn does not want, because treehouse already leased one.

Three consumers of `thread.branch` matter to this decision:

**(a) `CheckpointReactor.followWorktreeBranchDrift`**
(`apps/server/src/orchestration/Layers/CheckpointReactor.ts:559-616`, landed in `0ad91b6e7`
"follow branch drift in dedicated worktrees so PRs link to their thread"). After every turn it
reads the worktree's actual `refName` and adopts it as the thread's branch. It returns early
when:

- the checkout is detached — `checkedOutBranch === null` (`:574`);
- `thread.branch === null` (`:584`) — **a thread created with `branch: null` never adopts a
  branch, ever**;
- `thread.branch === checkedOutBranch` (`:585`) — already correct, no-op;
- `thread.worktreePath === null` or `!== input.cwd` (`:586-587`) — so `worktreePath` **must**
  be set at `thread.create` for drift-following to work at all;
- the worktree is shared with another thread (`:596-601`).

The header comment at `:559-566` explains why this matters downstream: "Since #4460 the client
only attributes PR state to a thread when the checked-out branch equals the recorded one, so
stale metadata silently orphans the thread's PR." That is precisely #18's failure mode.

The update is a compare-and-swap (`expectedBranch`, `:609`), implemented in
`decider.ts:640-644`: if the recorded branch moved between read and dispatch, the stale write
is dropped.

**(b) `ProviderCommandReactor.maybeGenerateAndRenameWorktreeBranchForFirstTurn`**
(`:730-765`). On the first turn, if `thread.branch` matches T3's own temporary pattern it
LLM-generates a new name and **renames the branch in the worktree**. The pattern is
`^t3code/(?:[0-9a-f]{8}|<uuid-v4>)$` (`packages/shared/src/git.ts:12-21`). `fm/<id>` and
`HEAD` and `null` all fall outside it (`:741-743` / `:738-740` return early), so firstmate is
never at risk of T3 renaming its task branch — worth stating explicitly, since a naming scheme
of `t3code/<8hex>` would have been.

**(c) `GitManager.runStackedAction`** (`apps/server/src/git/GitManager.ts:1936-2045`) reads the
*worktree's* status, not `thread.branch`, and hard-refuses from a detached HEAD:

```
:1975  if (!input.featureBranch && wantsPush && !initialStatus.branch)  → "Cannot push from detached HEAD."
:1982  if (!input.featureBranch && wantsPr  && !initialStatus.branch)  → "Cannot create a pull request from detached HEAD."
```

### Is `featureBranch` a viable alternative to the crewmate branching?

**No.** `featureBranch` is a plain boolean (`packages/contracts/src/git.ts:117`) — it carries no
name. It routes to `runFeatureBranchStep` (`GitManager.ts:1892-1926`), which calls the LLM
(`resolveCommitAndBranchSuggestion` → `textGeneration.generateCommitMessage({ includeBranch:
true })`, `:1414-1422`), sanitises the answer through `sanitizeFeatureBranchName`, and forces a
`feature/…` prefix (`packages/shared/src/git.ts:47-55`), de-duplicating with a numeric suffix
(`:60-80`). It is also gated to commit actions only (`GitManager.ts:1948-1954`) and errors when
the tree is clean (`:1908-1913`).

So `featureBranch: true` yields something like `feature/add-widget-2`. Every firstmate consumer
in §3 keys on the literal string `fm/<id>` — `fm-merge-local.sh:44` hard-errors on anything
else, and `fm-bearings-snapshot.sh:242` cannot map the PR back to a task. `featureBranch` is
firmly the wrong instrument.

## 6. Consequences of `null` vs `"HEAD"` vs `"fm/<id>"`

Assume the crewmate obeys its brief and runs `git checkout -b fm/<id>` as its first action, and
that `worktreePath` is set to the leased path (as #9 did, `spike.mjs:393`; it is required by
`CheckpointReactor.ts:586-587` in any case).

| `branch` at `thread.create` | After the crewmate branches | End state |
| --- | --- | --- |
| `null` | drift-follow bails at `CheckpointReactor.ts:584` | **Permanently wrong.** `thread.branch` stays `null` forever. PR attribution never links (`:559-566`). |
| `"HEAD"` (#9's value) | drift-follow fires — `"HEAD" !== "fm/<id>"`, not temporary, worktree unshared — and CASes to `fm/<id>` at `:604-614` | **Eventually correct**, but only after the first turn *completes*. Between `thread.create` and the first checkpoint, `thread.branch` is the literal string `"HEAD"`, which is not a ref name. Any consumer reading it in that window (git status attribution, PR lookup) is reading a lie. |
| `"fm/<id>"` | drift-follow no-ops at `:585` (already equal) | **Correct from t=0**, and correct again after every subsequent turn. |

`"fm/<id>"` is also self-healing in the failure case: if the crewmate never branches, the
thread's recorded branch is a name that does not exist, but drift-follow will not clobber it
with garbage (detached → early return at `:574`), and `fm-review-diff.sh:71-75` /
`fm-merge-local.sh:45` will surface the miss with their existing, well-worded errors. That is
firstmate's existing detection, unchanged.

## 7. What a real `fm/<id>` unlocks: T3's native commit → push → PR

#18 frames the branch question as blocking "the first mate hands back a PR". T3 already has that
flow, and it is not UI-only — `git.runStackedAction` is a first-class RPC method
(`packages/contracts/src/rpc.ts:194` maps it, `:506` types the payload as
`GitRunStackedActionInput`), so firstmate can drive it over the same websocket it uses for
`thread.create`. The web UI's commit / push / create-PR controls are just callers
(`apps/web/src/state/sourceControlActions.ts:202,234`, surfaced by
`apps/web/src/components/GitActionsControl.tsx:156`).

Two properties make it directly usable by a backend:

- **It is addressed by `cwd`, not `threadId`** (`packages/contracts/src/git.ts:112-121`). So it
  operates on the leased treehouse worktree as-is. Actions are `commit`, `push`, `create_pr`
  (`git.ts:11-17`), with optional `commitMessage` and `filePaths`.
- **It refuses to run from a detached HEAD.** `GitManager.ts:1975-1980` fails push with "Cannot
  push from detached HEAD" and `:1982-1986` fails PR creation the same way, in both cases only
  when `featureBranch` is absent.

That is the sharp edge, and it is the reason the branch question is load-bearing rather than
cosmetic. From a detached HEAD the *only* native route to a PR is `featureBranch: true`, which
mints an LLM-generated `feature/…` name (§5) that firstmate cannot predict and that no `fm/`
consumer recognises. With the crewmate already on `fm/<id>`, `action: "create_pr"` with
`featureBranch` omitted just works, and the PR's head branch **is** `fm/<id>` — the ref
`fm-teardown.sh:392-395` and `fm-pr-*` already look for.

So a real, predictably-named branch is what lets the T3 backend hand back a PR through T3 itself
rather than through `gh-axi`. Whether it *should* — versus keeping firstmate's existing gh-axi PR
flow for uniformity with other backends — is a separate decision this research does not settle;
it is noted here because it is the strongest argument for `fm/<id>` existing as a real ref, and
because the `cwd`-addressed RPC surface is not obvious from the UI code.

## 8. Recommendation for `bin/backends/t3.sh`

> **Decided (2026-08-04).** Maintainer chose the treehouse route below, on the condition that it
> runs reliably on Windows under T3 — see §8.1 for what that costs. Customising t3code to suit
> firstmate is explicitly on the table if the treehouse route needs it; §8.1 concludes it does
> not, and lists what would have to change if that turns out to be wrong.

**Do not create the branch in the backend. Do not use `bootstrap.prepareWorktree`. Do not use
`featureBranch`. Pass `branch: "fm/<id>"` and `worktreePath: <leased path>` to `thread.create`,
and let the crewmate's brief create the branch as it does on every other backend.**

Concretely, the T3 arm should mirror `claude-bg` exactly:

1. Lease as `claude-bg` does — `TREEHOUSE_LEASE_HOLDER="fm-$ID" treehouse get --lease
   --lease-holder "fm-$ID"` (`firstmate/bin/fm-spawn.sh:1368`), then `validate_spawn_worktree`
   (`:1372`). Reuse the existing block; do not add a second acquisition path.
2. `project.create` with `workspaceRoot = $PROJ_ABS` (#8; recorded at
   `experiments/firstmate-crewmate-spawn-spike/README.md` "The shape a T3 spawn takes").
3. `thread.create` with `threadId = <firstmate task uuid>`, `worktreePath = <leased path>`,
   `runtimeMode: "full-access"`, and **`branch: "fm/<id>"`**.
4. `thread.turn.start` with the brief *contents* as `message.text` — byte-identical to what
   `claude-bg` passes as `argv` (`fm-spawn.sh:1763-1770`). That text already contains
   `fm-brief.sh:380`, so the crewmate branches on its own first action and the value passed in
   step 3 becomes true within seconds.
5. Teardown unchanged: `thread.delete`, `project.delete`, then the existing
   `teardown_treehouse_return` path (`fm-teardown.sh:1284`), which already handles the
   branch-delete-then-return sequence at `:1267-1272` for every non-orca, non-codex-app
   backend.

### 8.1 Does this run reliably on Windows under T3?

Yes, with one convention to hold. No t3code change is required.

**treehouse itself works on Windows.** Verified live: the `v2.0.0` binary at
`C:\Users\Glyn\AppData\Local\treehouse\treehouse` created a pool, leased a worktree, and returned
it, all from Git Bash (§1). Caveat for CI only: `firstmate/bin/fm-install-treehouse.sh:28-52`
carries assets for `Linux-x86_64`, `Linux-aarch64`, `Darwin-arm64`, `Darwin-x86_64` and calls
`die "unsupported platform"` for anything else — so the pinned-install helper cannot provision
treehouse on a Windows runner. Local dev is unaffected (the binary is already installed by other
means); a Windows CI lane for the t3 backend would need that script extended.

**The path format is the thing to get right.** Three formats are in play at once: treehouse
prints a backslash Windows path on stdout (`C:\Users\…\1\scratch`, observed in §1), Git Bash
sees `/c/Users/…`, and the T3 server is a native Windows node process. firstmate already has the
convention — `cygpath -m` (`firstmate/bin/fm-git-lib.sh:62-63`,
`firstmate/bin/backends/wezterm.sh:42-43`), producing mixed `C:/Users/…`, which node accepts as a
spawn cwd and git accepts as `-C`. **`t3.sh` should `cygpath -m` the leased path once, at
acquisition, and pass that one form to `project.create`, `thread.create`, and every later
`cwd`-addressed RPC.**

**Why consistency matters more than which format.** T3 stores `worktreePath` verbatim and reuses
it as the provider session's cwd — `resolveThreadWorkspaceCwd` returns
`thread.worktreePath` unchanged (`apps/server/src/checkpointing/Utils.ts:22-24`), and
`ProviderCommandReactor.ts:550,563` passes it straight to `startSession`. This looked like a
Windows hazard, because the drift-follow compares with raw string equality
(`CheckpointReactor.ts:587`, `thread.worktreePath !== input.cwd`) and `C:\x` ≠ `C:/x` ≠ `/c/x`.
**It is not a hazard, because both sides originate from the same stored string**, so the compare
is a string against itself whatever format was stored. The same holds for the shared-worktree
check at `:595`. But it does mean a *second* path spelled differently — e.g. a `git.runStackedAction`
call (§7) built from a POSIX path while the thread was created with a Windows one — would address
a cwd T3 does not associate with the thread. Hence: canonicalise once, at the point of leasing.

**If this turns out to be wrong**, the t3code-side fix is small and worth naming now: normalise
`worktreePath` on ingest (`ws.ts` `thread.create` / `thread.meta.update`) with
`path.normalize(path.resolve(...))`, the pattern `GitVcsDriverCore.ts:1118` and `:2343` already
use for exactly this reason. That is the "customise t3code to suit firstmate" lever for this
question, and it is a few lines. Nothing found in this research calls for it yet.

Why not the alternatives:

- **Backend creates the branch after leasing.** It would work mechanically, but it forks the
  crewmate contract: on t3 the branch would pre-exist and `fm-brief.sh:380`'s "first action"
  would fail with `fatal: a branch named 'fm/<id>' already exists`, so the brief would need a
  backend-specific variant. `fm-brief.sh` has zero backend awareness today, and #1's standing
  rule is to use firstmate's existing model. This is the invention to avoid.
- **`bootstrap.prepareWorktree`** — T3's "setup worktree" UI toggle
  (`apps/web/src/components/ChatView.tsx:4863-4870`), which sends `prepareWorktree` plus
  `runSetupScript: true` and is handled at `ws.ts:908-936`. This is the one alternative that is
  *architecturally* attractive rather than merely workable, so it deserves more than a
  one-liner:

  **For it.** T3 creates the worktree *and* a real branch in a single call, so there is no
  detached HEAD at any point and no dependency on the crewmate obeying its brief's first action.
  It also runs the project's setup script. Note that `prepareWorktree.branch` is **optional**
  (`packages/contracts/src/orchestration.ts:672`) and need not be the temporary name the UI
  passes: hand it `"fm/<id>"` directly and the LLM rename never fires, because the
  `isTemporaryWorktreeBranch` gate at `ProviderCommandReactor.ts:742` only matches
  `t3code/<8hex>` (`packages/shared/src/git.ts:13-21`). That yields worktree + correctly-named
  branch in one step. This is not discoverable from the UI code, which always passes
  `buildTemporaryWorktreeBranchName(randomHex)` (`ChatView.tsx:4866`).

  **Against it.** It changes *worktree ownership*, not just branch creation, and that is a
  much larger blast radius than #18's question. treehouse's pool is pre-warmed and
  lease-tracked; `fm-teardown.sh:1284` releases with `treehouse return`; `fm-fleet-sync.sh` and
  the prune/GC paths all assume pool membership. A T3-created worktree sits outside all of it,
  so every one of those paths needs a second branch. Taking the UI's default temp name would be
  worse still — `ProviderCommandReactor.ts:730-775` renames it on the first turn to an
  LLM-generated semantic name that firstmate cannot predict, breaking `fm-review-diff.sh:70-75`
  and `fm-merge-local.sh:44-45`.

  **Verdict.** Out of scope for #18, and it should not ride in on a branch-naming decision.
  Worth its own issue: *should the T3 backend use T3's worktree management instead of
  treehouse?* If that is ever taken up, `prepareWorktree.branch: "fm/<id>"` is the shape that
  keeps every existing `fm/` consumer working.
- **`featureBranch`.** LLM-named, `feature/`-prefixed, commit-gated. Breaks every `fm/`
  consumer. See §5.

## 9. Open questions and contradictions

1. **Should the T3 backend hand back its PR through T3 or through gh-axi?** §7 establishes that
   `git.runStackedAction` makes the native route available once `fm/<id>` exists, but not that it
   is the right one. Every other backend goes through firstmate's gh-axi bridge
   (`fm-brief.sh` rule 3, `fm-pr-*`), and uniformity has value. Genuinely open; it is the next
   question down the #1 map from this one.
2. ~~**Should the T3 backend use T3's worktree management instead of treehouse?**~~ **Closed
   2026-08-04: treehouse.** The maintainer's call, matching this document's recommendation. The
   `prepareWorktree` alternative and the `branch: "fm/<id>"` shape that would make it work are
   kept in §8 in case the decision is ever revisited — not as a live option.
3. **Installed treehouse is `v2.0.0`, but `fm-install-treehouse.sh` pins `v2.0.1`**
   (`firstmate/bin/fm-install-treehouse.sh:20-21` sets the CI repo/version and `:85-89` hard-fails
   on any mismatch with the exact pin). The local binary's `--version` prints `v2.0.0`. Not
   material to this question — nothing here depends on a 2.0.0→2.0.1 behaviour change — but
   the developer's machine is one patch behind what CI installs.
4. **`bin/backends/t3.sh` does not exist yet** — confirmed; `firstmate/bin/backends/` holds
   `claude-bg.sh`, `cmux.sh`, `codex-app.sh`, `herdr.sh`, `orca.sh`, `tmux.sh`, `wezterm.sh`,
   `zellij.sh` (plus two herdr `.py` helpers). So §8 is a design recommendation with no
   existing implementation to reconcile against.
5. **`fm-spawn.sh:1375`'s exclusion list is a growing literal.** The pane-typing guard is
   `[ "$KIND" != secondmate ] && [ "$BACKEND" != orca ] && [ "$BACKEND" != codex-app ] &&
   [ "$BACKEND" != claude-bg ]`. Adding t3 means a fifth clause. Worth flagging to whoever
   implements §8 — this is the third pane-less backend and the condition is now arguably
   "backends that create their own worktree", but restructuring it is out of scope here.
6. **The lease + T3 checkpoint interaction is unexamined here.** #9 observed T3 checkpointing
   a treehouse-leased worktree successfully (`experiments/firstmate-crewmate-spawn-spike/README.md`),
   but that was against a detached HEAD. Whether T3's hidden checkpoint refs interact with
   `treehouse return --force`'s reset (`fm-teardown.sh:698`, `:723`, `:750`) once a real
   `fm/<id>` branch exists in the worktree was not tested and is not answerable from source.
   The teardown order already deletes the branch *before* returning (`:1267-1272` then `:1284`),
   which is the fragile-looking part.
