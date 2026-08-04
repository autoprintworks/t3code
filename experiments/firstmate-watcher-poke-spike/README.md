# firstmate watcher poke spike — waking a sleeping mate over the websocket

Spike for [#10](https://github.com/autoprintworks/t3code/issues/10).

**Yes, and the watcher survives intact — but only because #6 already demoted it.
An external process wakes a T3-resident first mate in every state that matters,
never gets refused, and the mate keeps its full context across the wake. The one
state that swallows a poke is `archived`, and it swallows it *silently*.**

Measured live against the installed desktop server (T3 `0.0.31`,
`claude-fable-5`, `http://127.0.0.1:3773`, Windows 11) on 2026-08-04 in a single
run: one mate thread, six pokes from six separate OS processes, 15 transcript
rows ([`findings.json`](./findings.json), [`run.log`](./run.log)). Code
references are to this checkout and to firstmate at
`C:\00_AI_Development\firstmate-claude-code`.

## What was actually driven

[`watcher-poke.mjs`](./watcher-poke.mjs) is a **separate process** each time, and
that is the whole point: firstmate's watcher shares no connection, no memory and
no lifetime with the mate it wakes, so a poke sent down the spike's own
already-open socket would prove the wrong thing. Each poke reads the bearer
token off disk, buys its own `wsTicket`, opens its own socket, dispatches one
`thread.turn.start`, and exits. Six different PIDs, cold every time.

Each poke carries firstmate's real operational-input envelope
(`bin/fm-operational-input.sh:27-30`) around a real watcher wake reason, so the
transcript rows below are the bytes firstmate would actually inject:

```
⁣FIRSTMATE_OP: v1 watcher: WAKE stale:fm-crew-a1b2c3 idle 12m with an unclaimed check. …
```

The mate was told a watch word in its seed turn and instructed to append one
line to `WOKE.md` on every wake. That single line settles three things at once —
the turn was picked up, the mate acted on the filesystem, and it still knew who
it was.

| state | accepted | mate acted | kept context | rows added |
| --- | --- | --- | --- | --- |
| idle on station | yes | yes | yes | 3 |
| settled | yes | yes | yes | 3 |
| snoozed (1h out) | yes | yes | yes | 3 |
| **archived** | **yes** | **no** | — | **1** |
| session stopped | yes | yes | yes | 3 |
| mid-turn (busy) | yes | yes | yes | 5 |

Zero refusals across all six. Dispatch cost is trivial: 21-27 ms for the ticket,
36-62 ms cold-start to accepted receipt.

## The three questions

### 1. Is a poke identical to typing in the composer?

**Identical, and not by coincidence — it is the same command.** The composer
dispatches `thread.turn.start` through `startThreadTurn`
(`packages/client-runtime/src/operations/commands.ts:239`) and mints only
`commandId` and `createdAt` client-side. Everything else the watcher sends is
the same struct.

Measured rather than only read: the seed message and the poke messages come back
on the subscription with **identical key sets and no differing field** beyond
id, text and timestamps. There is nowhere for provenance to live —
`ThreadMessageSentPayload` (`packages/contracts/src/orchestration.ts:1056`) has
`threadId`, `messageId`, `role`, `text`, `attachments`, `turnId`, `streaming`
and two timestamps. No source, no origin, no actor. **The server cannot tell a
watcher from a captain, and neither can any client.**

One thing the watcher does *not* have to do: resolve a model. `modelSelection`
is optional on `thread.turn.start` and the poke omitted it entirely in all six
runs — the thread's own selection is used. #12's pre-flight burden is a
spawn-time cost, not a poke-time one.

### 2. What does the poke render as in the captain's transcript?

**A full user message, and the noise is worse than one row per poke.**

The U+2063 mark survives the round trip byte-for-byte into the read model — but
it is zero-width, so it buys nothing: it gives the client no field to branch on
and no glyph to render. What the captain sees is a normal user bubble reading
`FIRSTMATE_OP: v1 watcher: WAKE stale:…`, sitting exactly where their own typing
would sit. In a tmux pane that row scrolls away; in a T3 thread it is permanent
and it is *the artifact* — the transcript is what the captain reviews.

The measured cost on a deliberately light run — six pokes against two genuine
user messages:

- **75% of the captain's own side of the conversation was watcher traffic**
  (6 of 8 user rows).
- Each poke costs **3 transcript rows** (poke, assistant reply, and the reply's
  streaming partial) plus its activity entries; the busy case cost 5.
- **Every poke also becomes a minimap entry.**
  `deriveTimelineMinimapItems` (`apps/web/src/components/chat/MessagesTimeline.tsx:565-583`)
  pushes one item per user message, so the navigation rail the captain uses to
  find their own turns fills with machine wakes at the same rate.

A real watch runs hours, not minutes. This is the strongest evidence yet for the
map's standing "operational-input noise" concern, and it locates the fix
precisely: the wire needs somewhere to put provenance, because today there is no
field a client *could* filter on even if it wanted to.

Not covered: how it looks to a human eye in the desktop app. The row content,
the mark's survival and the minimap derivation are all measured; nobody has
photographed it. A captain glance would close that.

### 3. Settled, snoozed, archived?

**Settled and snoozed: works, and the poke spends the state.** The decider
treats a turn start as real activity and emits `thread.unsettled(reason:
"activity")` / `thread.unsnoozed(reason: "activity")` alongside the message
(`apps/server/src/orchestration/decider.ts:823-860`) — confirmed live, both
threads came back with `settledOverride: null` and `snoozedUntil: null`. So a
watcher poke doesn't just wake the *agent*, it drags the *thread* back into the
captain's inbox. Combined with the noise above: a snoozed mate cannot stay
snoozed while its watcher is running.

**Archived: the poke is accepted and then silently discarded.** This is the one
real trap in the ticket, and it is a black hole rather than an error:

- `thread.turn.start` is accepted — the decider never checks `archivedAt`.
- `thread.message-sent` fires, and the row lands permanently in the transcript.
- Then **nothing**. No session, no activity, no failure. Waited six minutes.
- `thread.unarchive` afterwards does **not** release it. The turn is gone; the
  user row stays behind unanswered forever.

The mechanism: `ProviderCommandReactor.processTurnStartRequested` resolves the
thread through `getThreadDetailById` → `getActiveThreadRowById`, whose SQL ends
`AND archived_at IS NULL` (`ProjectionSnapshotQuery.ts:900-904`). An archived
thread resolves to `undefined` and the reactor's `if (!thread) return`
(`ProviderCommandReactor.ts:1014-1017`) drops the turn with no failure activity.

For the backend this is unambiguous: **a T3 backend must treat `archivedAt != null`
as "target does not exist"**, because every signal a watcher could use says the
poke landed. It also matters for #5's `target_exists` arm — archived is a third
state alongside alive and deleted, and it lies in the same direction #7 found a
deleted thread lies (subscription stays open, un-errored and silent). Related:
`subscribeThread` served no snapshot at all for the archived thread, consistent
with the same active-row filter.

## Poking a busy mate

The mid-turn poke is the case firstmate's daemon guards hardest against
(`bin/fm-supervise-daemon.sh:1137-1141`, `pane_is_busy` → defer). In T3 it is
**safe but late**:

```
+435683ms  turn.start (count to 400)      turn b60c4205
+448052ms  POKE                           accepted, user row, turnId=null
+477130ms  assistant (…counting…)         turn b60c4205 completes IN FULL
+477884ms  session running
+480256ms                                 turn d85bc499 opens
+486817ms  assistant "Logged `busy …`"    turn d85bc499
```

The poke did not preempt, was not queued away, and was not refused. It went into
the live SDK loop as a steer (`ClaudeAdapter.ts:3729-3735`), the mate finished
its 400 lines, and answered the wake **38 seconds later as a new turn**. Two
consequences: firstmate's busy-guard is no longer *required* for safety, but
dropping it costs wake freshness, and T3 splits the exchange across two turns so
a supervisor counting turns will see one more than it caused.

The composer-guard has no analogue at all and needs none — there is no composer
to collide with, which is #5's reason for omitting `composer_state`, now
confirmed from the other direction.

## What this means for the watcher

#6 already found the Stop hook fires under T3's SDK-driven turn, which
**downgraded this poke path from load-bearing to a backstop for the interrupt
case**. That downgrade holds and matters more after this run: the poke *works*,
but every use of it costs a permanent transcript row and a minimap entry, and
un-snoozes the thread. Zero-token Stop-hook supervision stays the primary
mechanism; the poke is the escalation path, to be spent sparingly.

Nothing here needs a T3 patch to *function*. The archived black hole is a
backend-side guard. The noise is the thing worth a patch, and it now has a
measured size and a named cause.

## Traps

- **Archived swallows the poke silently.** Above. Accepted, rendered, dropped,
  unrecoverable by unarchiving.
- **A poke un-snoozes and un-settles the thread.** By design
  (`decider.ts:823-860`), and it means a watcher keeps its mate permanently in
  the inbox.
- **`subscribeThread` does not forward `thread.turn-start-requested`.** The
  stream carries only `thread.message-sent`, `thread.session-set` and
  `thread.activity-appended` (22/42/39 in this run). A supervisor watching for
  "the turn was accepted" must read the message row, not the request event.
- **A busy mate answers late, in a new turn**, ~38s behind here. Turn counts do
  not match poke counts.
- **`modelSelection` is optional on `thread.turn.start`** — omitting it is
  correct and simpler for a watcher. Only `thread.create` forces the #12
  resolution.

## Running it

Mint a token (PowerShell; the Electron-node requirement from #9):

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
Start-Process -FilePath "$env:LOCALAPPDATA\Programs\t3code\T3 Code (Alpha).exe" `
  -ArgumentList "$env:LOCALAPPDATA\Programs\t3code\resources\app.asar\apps\server\dist\bin.mjs", `
    'auth','session','issue','--token-only','--ttl','7d','--label','fm-watcher-poke-spike' `
  -Wait -NoNewWindow -RedirectStandardOutput "$env:TEMP\fm-poke-token.txt"
```

Then:

```bash
node spike.mjs --token-file "$TEMP/fm-poke-token.txt"
```

`--only ready,archived` runs a subset of the phases, `--gui-hold <seconds>`
holds before teardown so a captain can look at the transcript in the desktop
app, `--proj <path>` uses a real project instead of a scratch repo, `--keep`
leaves the thread and project in place.

Teardown deletes the thread and project. The scratch repo survives on Windows
(`EBUSY`) — as #7 and #9 also saw, the server holds a handle on the workspace
root after `project.delete`.
