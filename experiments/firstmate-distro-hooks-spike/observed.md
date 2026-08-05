# Firstmate distro hooks spike — observed probe results

Probe run for autoprintworks/t3code issue #31.
Harness: Claude Code 2.1.222, entrypoint `sdk-ts`, non-interactive session.
Working directory: `/c/00_AI_Development/firstmate-claude-code`.

## 0. SessionStart injection present in context before this message?

PRESENT. Received as a `SessionStart:startup hook success` system message, verbatim:

```
⁣FIRSTMATE_OP: v1 session-start: Run `bin/fm-session-start.sh` now, exactly once, before executing any other instructions.
```

(The message begins with an invisible U+2063 INVISIBLE SEPARATOR character before `FIRSTMATE_OP`.)

## 1. Bash: `pkill -f fm-watch` — BLOCKED

Blocking message verbatim:

```
PreToolUse:Bash hook error: ["$CLAUDE_PROJECT_DIR"/bin/fm-arm-pretool-check.sh --claude]: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"},"systemMessage":"[broad-watcher-kill] a broad process kill targeting the firstmate watcher is forbidden"}
```

## 2. Bash: `cd projects/foo` — BLOCKED

Blocking message verbatim:

```
PreToolUse:Bash hook error: ["$CLAUDE_PROJECT_DIR"/bin/fm-cd-pretool-check.sh --claude]: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"},"systemMessage":"[persistent-cd] a persistent top-level directory change in the primary firstmate checkout is blocked; it would move the shell out of the home so a later firstmate-owned command runs inside a project clone. Reach the target without moving the shell - use git -C <dir> or an absolute path on the command itself - or scope the cd to a subshell like (cd <dir> && ...)."}
```

## 3. Task/Agent tool, prompt "say hi" — BLOCKED

Called as `Agent`, `subagent_type: general-purpose`. Blocking message verbatim:

```
PreToolUse:Agent hook error: ["$CLAUDE_PROJECT_DIR"/bin/fm-subagent-pretool-check.sh --claude]: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"},"systemMessage":"[subagent-dispatch] the firstmate primary dispatches through the fleet, not the harness's own delegation tools: work started that way has no durable fleet record, leaves every firstmate guard inert, and dies with this session. Instead, first classify the work under the AGENTS.md intake contract, then use bin/fm-brief.sh followed by bin/fm-spawn.sh for dispatched work (blocked tool: Agent, delegation-shaped on \"agent\"). Launch the session with FM_ALLOW_SUBAGENT=1 for a deliberate exception."}
```

## 4. Skills available this session

Firstmate skills probed for — all 19 PRESENT:

- afk: PRESENT
- ahoy: PRESENT
- ask-user-authority: PRESENT
- bearings: PRESENT
- bootstrap-diagnostics: PRESENT
- decision-hold-lifecycle: PRESENT
- diagnostic-reasoning: PRESENT
- firstmate-codexapp: PRESENT
- firstmate-coding-guidelines: PRESENT
- firstmate-orca: PRESENT
- fmx-respond: PRESENT
- harness-adapters: PRESENT
- project-management: PRESENT
- quota-array-dispatch: PRESENT
- secondmate-provisioning: PRESENT
- shelve: PRESENT
- stow: PRESENT
- stuck-crewmate-recovery: PRESENT
- updatefirstmate: PRESENT

Full skill list offered this session (firstmate + non-firstmate, in listing order):

afk, ahoy, ask-user-authority, bearings, bootstrap-diagnostics, code-review,
codebase-design, computer-use, decision-hold-lifecycle, diagnosing-bugs,
diagnostic-reasoning, domain-modeling, firstmate-codexapp,
firstmate-coding-guidelines, firstmate-orca, fmx-respond, gh-axi, grilling,
grilling-frontend-prototyping, harness-adapters, lavish, orca-cli,
orchestration, plain-english, project-management, prototype,
quota-array-dispatch, research, resolving-merge-conflicts,
secondmate-provisioning, shelve, stow, stuck-crewmate-recovery,
updatefirstmate, frontend-design:frontend-design, dataviz, update-config,
keybindings-help, simplify, fewer-permission-prompts, loop, schedule,
claude-api, run, init, review, security-review

## 5. Is AGENTS.md content in context?

YES. Delivered as project instructions from `CLAUDE.md` (symlink to `AGENTS.md`).

- First heading: `# Firstmate`
- First sentence: `You are the first mate.`

## 6. `bash bin/fm-session-start.sh ; echo "EXIT=$?"`

Exit code: `EXIT=0`

Complete output:

```
================================================================================
SESSION START - /c/00_AI_Development/firstmate-claude-code
================================================================================

LOCK
--------------------------------------------------------------------------------
error: cannot locate harness process in ancestry
●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
●  READ-ONLY SESSION - FLEET LOCK OWNERSHIP WAS NOT VERIFIED
●  error: cannot locate harness process in ancestry
●  Skipping every mutating step: PR-check migration, stale Herdr child cleanup,
●  secondmate sync, X-mode artifacts, fleet sync, and wake-queue drain. Detect-only bootstrap
●  diagnostics and the rest of this read-only-safe digest still ran below.
●  Operate read-only until this resolves - do not spawn, steer, merge, or
●  otherwise mutate fleet state from this session.
●━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

BOOTSTRAP
--------------------------------------------------------------------------------
MISSING: quota-axi (install: npm install -g quota-axi)

WAKE QUEUE
--------------------------------------------------------------------------------
skipped (read-only session) - 0 record(s) remain queued because this session lacks verified fleet-lock ownership.
================================================================================
SUPERVISION OPERATING INSTRUCTIONS - primary harness: claude
================================================================================
Current state:
- Lock: read-only; do not drain, arm, spawn, steer, merge, or repair fleet state here.
- Away mode: inactive.
- X mode: inactive; use the default watcher cadence.
- Ordinary wake: the Stop-owned auto-arm (bin/fm-claude-stop-autoarm.sh) already owns watcher continuity; drain and handle the wake, and do not arm another cycle yourself.

Mode: Claude Stop-hook-owned supervision.

When this session owns supervision and away mode is not active:
1. Drain first with `bin/fm-wake-drain.sh`.
2. Routine watcher arm and re-arm are owned by the Stop `asyncRewake` hook (`bin/fm-claude-stop-autoarm.sh`), never by you.
   Every turn end while supervision is needed launches or attaches one home-scoped watcher cycle with no model command and no model tokens.
   An actionable close wakes you through the hook's exit-2 rewake, delivered as a `Stop hook feedback` message.
3. On a `Stop hook feedback` wake (`signal:`, `stale:`, `check:`, or `heartbeat`), run `bin/fm-wake-drain.sh` first and handle the wake.
   Do not run `bin/fm-watch-arm.sh` after an ordinary wake; the next turn end re-arms automatically when supervision is still needed.
   Do not invent a wake from an attach-status line alone; drain and act only on real wake records or a real watcher reason line.
4. On a `Stop hook feedback` watcher-failure wake (`watcher: FAILED ...`), treat it as an alarm: drain, then repair supervision before ending the turn.
5. Manual arm is recovery only.
   When a repair is genuinely needed - the Stop hook did not claim this home, or a forced restart is required - run `bin/fm-watch-arm.sh` (or `bin/fm-watch-arm.sh --restart`) as its own Claude Code background task, never bundled with other commands, never with shell `&`.
   Source `/c/00_AI_Development/firstmate-claude-code/config/x-mode.env` first when X mode is active.
   A shell `&`, a truncating pipe, or bundling is denied automatically by the PreToolUse seatbelt (`bin/fm-arm-pretool-check.sh`) registered in `.claude/settings.json`.
6. Treat `watcher: started ...` and `watcher: attached ...` inside arm output as proof that one live cycle exists.
   On attach, the arm follows verified identity-matched successors instead of exiting when the first cycle ends.
7. The durable wake queue preserves actionable events between a rewake and the next Stop-launched arm, while the bounded turn-end guard prevents a blind Stop when recovery did not start.
   No PreToolUse hook denies fleet commands based on watcher status.
   [`watcher-continuity.md`](../watcher-continuity.md) owns the exact session-lock recovery boundary.
8. The turn-end guard (`bin/fm-turnend-guard.sh --claude`) remains the final backstop.
   It allows the stop when a watcher is healthy, when the auto-arm already owns recovery for this event epoch, or when a fresh rewake is recorded; it re-blocks only when none of those materialize, within a bounded budget.
9. Waiting on the hook-owned cycle is silent: do not send idle progress while the watcher is parked.

The watcher itself remains `bin/fm-watch.sh`, and `bin/fm-watch-arm.sh` remains the verified arm wrapper that the Stop hook foregrounds.
Re-arm attaches to an existing healthy cycle when one is already present and follows its verified successor chain.
See [`watcher-continuity.md`](../watcher-continuity.md) for the arm-layer successor and clean-close failure contract and the Claude ownership model.


================================================================================
CONTEXT
================================================================================

data/projects.md
--------------------------------------------------------------------------------
ABSENT

data/secondmates.md
--------------------------------------------------------------------------------
ABSENT

data/captain.md
--------------------------------------------------------------------------------
ABSENT

data/captain-shared.md (shared, main-authoritative, read-only in secondmate homes)
--------------------------------------------------------------------------------
ABSENT

data/learnings.md
--------------------------------------------------------------------------------
ABSENT

================================================================================
FLEET STATE
================================================================================

data/backlog.md
--------------------------------------------------------------------------------
ABSENT

Work under way (state/*.meta)
--------------------------------------------------------------------------------
(none)

Orphan status logs (state/*.status without matching .meta)
--------------------------------------------------------------------------------
(none)

AFK
--------------------------------------------------------------------------------
absent

================================================================================
NEXT STEP
================================================================================
This session did not acquire the fleet lock. Stay read-only: do not arm,
drain, spawn, steer, merge, or repair fleet state from here. Only a session
with verified fleet-lock ownership may perform mutable follow-up.

The digest above is complete for this session start. Do NOT re-read
data/projects.md, data/secondmates.md, data/captain.md,
data/captain-shared.md, data/learnings.md,
or state/*.meta now - they were just printed in full.
Do NOT bulk-read data/backlog.md now either: the compact identity/metadata
listing was just printed with a pointer for targeted full-body follow-up.
Do NOT bulk-read state/*.status now either: their bounded tails were just
printed with full log paths for targeted follow-up when older wake-event
history is actually needed. Re-reading everything defeats the entire point
of this command. Re-read a file only if this digest flagged it ABSENT (then
rebuild or create it per AGENTS.md), its contents looked unparseable/corrupt,
or an individual full status log is needed for older wake-event history.
EXIT=0
```

## 7. Environment and version

```
PROJECT_DIR=[] ENTRYPOINT=[sdk-ts] PWD=[/c/00_AI_Development/firstmate-claude-code] FM_HOME=[]
2.1.222 (Claude Code)
```

Notes:

- `CLAUDE_PROJECT_DIR` is empty in the Bash tool environment, even though the hook commands in `.claude/settings.json` reference `"$CLAUDE_PROJECT_DIR"/bin/...` and those hooks did fire successfully. The variable is present for hook execution but not exported into Bash tool commands.
- `FM_HOME` is empty.
- `CLAUDE_CODE_ENTRYPOINT` is `sdk-ts` (non-interactive SDK session).
- The session lock failed with `cannot locate harness process in ancestry`, which is consistent with the SDK entrypoint rather than a terminal harness process.
