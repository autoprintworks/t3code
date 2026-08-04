# firstmate crewmate spawn spike — the whole lifecycle over the websocket

Spike for [#9](https://github.com/autoprintworks/t3code/issues/9).

**The entire crewmate lifecycle is drivable over `/ws` with nothing refused —
7 dispatches, 7 accepted, 0 refusals, twice.** And the thread a script spawns is
an ordinary thread in the desktop GUI: the captain watched it work, typed into
it, and got a reply, while the spawning script held its own socket on the same
thread and observed every message. That last property is the whole reason this
backend beats `claude-bg` on Windows, and it is now measured rather than assumed.

Measured live against the installed desktop server (T3 `0.0.31`, model
`claude-fable-5`, `http://127.0.0.1:3773`, Windows 11) on 2026-08-04, in two
runs: a full lifecycle with a 4-minute captain hold
([`findings.json`](./findings.json), 112 stream items) and a focused
interrupt-mid-turn pass ([`findings-interrupt.json`](./findings-interrupt.json),
20 items). Code references are to this checkout and to firstmate at
`C:\00_AI_Development\firstmate-claude-code`.

## The shape a T3 spawn takes

`fm-spawn.sh`'s **claude-bg** arm is the precedent, not the terminal backends.
It is the only existing backend with no pane to type into, so the brief becomes
the agent's first prompt rather than a line sent to a shell
(`fm-spawn.sh:1760-1770`), and it acquires its worktree through treehouse's
non-interactive durable lease rather than by typing `treehouse get` into a pane
and polling the pane's cwd (`fm-spawn.sh:1362-1372`). A T3 crewmate has no pane
either, so it inherits both choices unchanged.

| Step | Command | Notes |
| --- | --- | --- |
| lease | `treehouse get --lease --lease-holder fm-<ID>` | path on stdout, decoration on stderr |
| project | `project.create` | `workspaceRoot = $PROJ_ABS` (#8) |
| thread | `thread.create` | `threadId = <firstmate task UUID>`, `worktreePath`, `runtimeMode: "full-access"` |
| watch | `orchestration.subscribeThread` | must `Ack` every `Chunk` (#7) |
| launch | `thread.turn.start` | brief **contents** as `message.text` |
| stop | `thread.turn.interrupt` → `thread.session.stop` | |
| teardown | `thread.delete`, `project.delete`, `treehouse return <path>` | |

## What the run proves

**The #8 identity mapping holds end to end.** firstmate minted
`2d973bd6-b1e7-42a2-a2e0-d5e7154716d8` before anything existed in T3; T3 took it
verbatim as the thread id, and the captain confirmed that same id in the GUI. No
id translation layer, and because `commandId` is a receipt key a retried
`thread.create` is idempotent.

**`worktreePath` genuinely relocates the agent, not just the UI.** Asked who it
was, the crewmate answered from inside
`C:\Users\Glyn\.treehouse\fm-crew-1cYi7V-c379d9\1\fm-crew-1cYi7V`, having written
`CREWMATE.md`, appended to `NOTES.md` and committed `dcbbceb`
(`crewmate: report for duty`) there. The pinning is real.

**`full-access` needs no approval plumbing for v1.** The crewmate ran `Write`,
`Bash` and several sub-agent `Task` cycles with not one `approval.requested` in
112 stream items — consistent with #1's `full-access` → `bypassPermissions`
mapping and with #7's finding that under `full-access` only `AskUserQuestion` and
`ExitPlanMode` escape the allow-all.

**T3 checkpointed a treehouse-leased worktree** — `thread.turn-diff-completed`
then `checkpoint.captured` fired on every turn, against a git worktree T3 did not
create. Direct evidence for
[#14](https://github.com/autoprintworks/t3code/issues/14), which that ticket
should still confirm properly.

### The GUI half

The captain typed `who are you` into the desktop app during the hold. The
spawning script's subscription saw it:

```
+188965ms  thread.message-sent   role=user   "who are you"
+189043ms  thread.session-set    starting
+190699ms  thread.session-set    running   activeTurnId=0a5d7f55-…
+197266ms  thread.message-sent   role=assistant
+198180ms  thread.session-set    ready
+200098ms  thread.turn-diff-completed
```

Two consequences for the backend. **Neither surface owns the thread** — the GUI
and a script are peers on it, which is what makes a T3 crewmate supervisable in a
way a headless `claude-bg` crewmate is not. And **captain intervention is not a
special case**: it arrives as an ordinary turn in the stream, so a supervisor
needs no separate channel to notice it — though it does mean a crewmate's
transcript can advance for reasons the backend did not cause.

## Fields firstmate has no natural value for

Three, all on `thread.create`:

- **`title`** — T3 requires a non-empty title; firstmate has no title concept.
  #8's `fm-<ID>` convention supplies one, and it is what the GUI renders.
- **`interactionMode`** — a T3-only axis with no firstmate analogue. `"default"`
  stands.
- **`modelSelection`** — must be a concrete `{instanceId, model}`. firstmate's
  `model=default` / `effort=default` are absence markers, not a request for a
  default, and `project.defaultModelSelection` cannot be deferred to (#12).

Resolved via `server.getConfig` → the instance whose `driver` is `claudeAgent`
→ `models[0].slug`, per #12's harness → *driver kind* → instance rule. **One
correction to #12's pre-flight advice:** `availability` came back **`undefined`**
on the shipped build, not a value — a pre-flight that requires it will reject a
perfectly good instance. Check the field's presence before trusting it.

## Traps

- **`treehouse` leases a DETACHED HEAD.** `git rev-parse --abbrev-ref HEAD`
  reports `HEAD` and `git worktree list` says `(detached HEAD)`. `thread.create`
  accepts `branch: "HEAD"` without complaint and everything works — but the
  crewmate's commits are then reachable from no branch, which is a problem for
  any flow that ends in a PR. Verified twice, in a clean scratch repo.
- **The message event is flat; the command is nested.**
  `thread.turn.start` takes `message: {messageId, role, text, attachments}`, but
  the `thread.message-sent` **event** carries `role`/`text`/`turnId` directly on
  `payload` with no `message` wrapper. Reading `payload.message.role` yields
  `undefined` silently and a supervisor concludes nobody spoke. This spike's
  first run made exactly that mistake.
- **Assistant messages re-emit while streaming.** 12 `thread.message-sent`
  events carried only 7 distinct `messageId`s; `payload.streaming` is `true` on
  the partials and `false` on the final. Dedupe on `messageId` and settle on
  `streaming: false`.
- **`treehouse return` takes the worktree PATH**, not `--lease-holder`.
  Relevant to `fm-teardown.sh`, which is the caller.
- **The bundled `t3` CLI only runs under Electron's node.** Correcting #3's
  trap, which attributes the silence to Git Bash: the real requirement is
  `ELECTRON_RUN_AS_NODE=1` plus the entry point **inside** `app.asar`. Running
  the unpacked `apps/server/dist/bin.mjs` under plain `node` exits **0 with no
  output and no stderr** — in PowerShell as well as Git Bash — and launching the
  `.exe` with CLI args while the desktop app is already running just re-focuses
  the app and logs its lifecycle. The working invocation is in "Running it".
- **An interrupt is still `error`, never `interrupted`**, on a worktree-pinned
  `full-access` crewmate with a genuinely running turn — `lastError` is
  byte-identical to what #7 recorded:
  `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null`.
  Interrupting an already-settled session, by contrast, is accepted and does
  nothing (session stays `ready`), which is why the first run produced no
  interrupt evidence at all and needed the `--probe-interrupt` pass.

## Running it

Mint a token (PowerShell; the Electron-node requirement above):

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
Start-Process -FilePath "$env:LOCALAPPDATA\Programs\t3code\T3 Code (Alpha).exe" `
  -ArgumentList "$env:LOCALAPPDATA\Programs\t3code\resources\app.asar\apps\server\dist\bin.mjs", `
    'auth','session','issue','--token-only','--ttl','30d','--label','fm-crewmate-spike' `
  -Wait -NoNewWindow -RedirectStandardOutput "$env:TEMP\fm-crew-token.txt"
```

Then:

```bash
node spike.mjs --token-file "$TEMP/fm-crew-token.txt" --hold 240
node spike.mjs --token-file "$TEMP/fm-crew-token.txt" --probe-interrupt
```

`--hold <seconds>` sets the captain window, `--probe-interrupt` swaps in a brief
the crewmate cannot finish quickly and cuts the hold to 12s so the interrupt
lands mid-turn, `--proj <path>` uses a real project instead of a scratch repo,
`--keep` leaves the thread, project and lease in place.

Teardown deletes the thread and project and returns the lease. The scratch repo
may survive on Windows — as #7 also saw, the server holds a handle on the
workspace root after `project.delete`.
