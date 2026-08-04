# What happens when the captain touches a crewmate thread in the GUI?

Research for [#15](https://github.com/autoprintworks/t3code/issues/15) (part of
[#1](https://github.com/autoprintworks/t3code/issues/1)). Source-only, read at
`t3code@66abec659` and `firstmate@ad4f4d1`, on two checkouts on this machine —

- `t3code` → `C:\00_AI_Development\t3code` (paths below are repo-relative)
- `firstmate` → `C:\00_AI_Development\firstmate-claude-code` (paths prefixed `firstmate/`)

**The short answer.** The ticket's premise is wrong twice over, and both corrections point the
same way.

1. **firstmate does have a precedent for a human mutating an endpoint's identity mid-task** —
   several, and they already form a coherent doctrine (§1). The doctrine sorts endpoints by
   *whether the name is the address*. Where it is (cmux, zellij), a label mismatch means the
   target does not exist and every op refuses. Where a stable id exists (tmux, herdr), firstmate
   addresses by the id, **pins the name so a captain cannot drift it**, and a rename breaks
   nothing. T3 is squarely the second case: `threadId` is stable, immutable, and the sole
   address on every RPC. So a rename must break **no** operation.
2. **T3 will not rename a firstmate thread on its own** (§2). `canReplaceThreadTitle`
   (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:165-174`) refuses to replace
   any title that is neither the literal `"New thread"` nor the caller's own `titleSeed`, and
   `titleSeed` is optional on `thread.turn.start`. Omit it and `fm-<ID>` is permanent. That makes
   `t3_thread_title=fm-<ID>` a **sound** detector: it changes only when a human changes it.

So: **check it, warn, never gate on it.** The gate is existence, not identity. Concretely —
`target_exists` reads presence in the shell snapshot (an archived or deleted thread is simply
absent, §4); the title comparison is reported by the session-start digest and by nothing else
(§5); `agent_state` ships `unverified`, so no recovery is licensed (§6); and no operation
refuses because a thread got renamed (§5).

**And the finding that outruns the ticket.** #7 concluded that "`/ws` is the only orchestration
surface — there is no HTTP read", and #1 records the open decision that follows from it: whether
`busy_state` needs "a long-lived bridge process holding one websocket". **That is wrong.**
`GET /api/orchestration/shell` (`packages/contracts/src/environmentHttp.ts:468`) returns every
live thread's `title`, `worktreePath`, `branch`, `session`, `hasPendingApprovals` and
`hasPendingUserInput` in one authenticated request, and `POST /api/orchestration/dispatch`
(`:484`) accepts commands. One cheap GET answers *target_exists, busy_state and the identity
check at once* — see §3. `t3.sh` stays a script.

---

## 1. firstmate's existing posture on a human mutating an endpoint

The ticket says firstmate "has no precedent for a human mutating a backend endpoint's identity
mid-task". It has four, and they are consistent.

**(a) Prevent the drift where the backend lets you.** `firstmate/bin/backends/tmux.sh:80-93`:

> PIN the window name by disabling automatic-rename and allow-rename on the new window: **the
> captain's tmux may rename the window away from fm-<id>** once treehouse cd's into the
> worktree, which would break name-based targeting.

```sh
tmux set-window-option -t "$wid" automatic-rename off 2>/dev/null || true
tmux set-window-option -t "$wid" allow-rename off 2>/dev/null || true
```

The captain renaming a firstmate endpoint is not a new hazard. It is a named, mitigated one.

**(b) Address by a stable id so a rename cannot break an op.** The same function returns the
window id, not the name: "The returned window id lets callers target the window **even if its
name is ever lost**" (`tmux.sh:83-84`), and `firstmate/bin/fm-spawn.sh:1266` calls it "its
rename-safe stable window id". herdr does the same with workspace/tab/pane ids.

**(c) Where the name *is* the address, a mismatch means the target does not exist.** cmux and
zellij have no stable-across-restart id (`firstmate/bin/backends/cmux.sh:71-79`: "Workspace ids
do NOT survive an app relaunch … Recovery therefore uses scoped-title matching"). Both thread an
`[expected-label]` through every op and verify it before acting.
`firstmate/bin/backends/cmux.sh:410-424` is the clearest statement:

| live title | verdict |
| --- | --- |
| equals the expected scoped title | proceed |
| **exists but differs** | `return 1` — treated exactly as "gone" |
| empty (workspace vanished) | re-resolve the id by label |

Note the asymmetry: firstmate will chase a *moved* endpoint by label, but a *renamed* one it
declares gone. It never adopts what a human has relabelled.

**(d) Never adopt, reuse, or repair in response to a mismatch.**
`firstmate/docs/herdr-backend.md:96`:

> Firstmate does not retry, adopt, reuse, close, delete, or rename anything in response to an
> unavailable method, lock contention, ambiguous socket, lost response, failed move, or
> **verification mismatch**.

and `:134`: "Crashes, lost responses, failed exact-pane cleanup, or **human renames** can leave
quarantined spaces". Quarantined, not repaired. `firstmate/bin/backends/herdr.sh:1041` re-checks
a label before a destructive close specifically because "a human could have renamed or
repurposed it in the interim".

**The one warn-and-continue case, and why it is different.**
`firstmate/bin/backends/herdr.sh:1666` emits `warning: herdr presentation binding for $id has an
ambiguous, renamed, foreign, or non-nested live shape; spawning flat` and returns 2 — degrade,
do not refuse. That binding is *presentational* (where the pane is nested for the captain's
benefit), not addressing. **This is the arm T3's title falls under**, because nothing in T3's
RPC surface addresses a thread by title (§5).

## 2. Does T3 rename a firstmate thread by itself?

**No, provided `t3.sh` omits `titleSeed`.** Two rename paths exist and both are gated on the same
predicate.

`ProviderCommandReactor.ts:165-174`:

```ts
function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) return true;   // "New thread"
  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}
```

With `title: "fm-<ID>"` and no `titleSeed`, both branches are false.

- **First-turn auto-title.** `ProviderCommandReactor.ts:1054` gates
  `maybeGenerateThreadTitleForFirstTurn` on it, and `:814` re-checks it after the LLM returns
  (so a rename racing the generation still wins). `titleSeed` is `Schema.optional` on
  `thread.turn.start` and its bootstrap (`packages/contracts/src/orchestration.ts:696`, `:717`,
  `:1072`) — the web client passes one, firstmate simply does not.
- **Explicit regeneration.** `thread.meta.update { regenerateTitle: true }` is dispatched only
  from the sidebar's own menu (`apps/web/src/components/SidebarV2.tsx:2182`, `:2408`) — a
  deliberate captain action, which is exactly the case this ticket is about. It too is
  clobber-safe: `ThreadMetaUpdatedPayload.previousTitle` is documented as "Title at request time,
  used to avoid overwriting a later manual rename" (`orchestration.ts:1025-1027`) and
  `ProviderCommandReactor.ts:855` and `:881` both bail when the title moved underneath.

**One narrow race worth naming.** `apps/web/src/components/ChatView.tsx:4659` computes
`isFirstMessage = !isServerThread || activeThread.messages.length === 0`, and `:4808` renames the
thread to a truncation of that message. A firstmate spawn is two dispatches — `thread.create`
then `thread.turn.start` (#9) — and between them the thread is visible in the sidebar with zero
messages. A captain who types into it in that window renames it. Real, tiny, and it lands in the
same "captain renamed it" bucket as any other rename, so it needs no separate handling.

## 3. The identity read is one HTTP GET — no websocket, no bridge process

`apps/server/src/orchestration/http.ts` registers four routes, paths in
`packages/contracts/src/environmentHttp.ts:459-489`:

| route | path | scope |
| --- | --- | --- |
| `snapshot` | `GET /api/orchestration/snapshot` | `orchestration:read` |
| `shellSnapshot` | `GET /api/orchestration/shell` | `orchestration:read` |
| `threadSnapshot` | `GET /api/orchestration/threads/:threadId` | `orchestration:read` |
| `dispatch` | `POST /api/orchestration/dispatch` | `orchestration:operate` |

`OrchestrationShellSnapshot` (`packages/contracts/src/orchestration.ts:440-445`) is
`{ snapshotSequence, projects[], threads[], updatedAt }`, and each `OrchestrationThreadShell`
(`:410-437`) carries everything this ticket and #5/#7 need:

`id`, `projectId`, **`title`**, `branch`, **`worktreePath`**, `archivedAt`, **`session`**,
`latestTurn`, **`hasPendingApprovals`**, **`hasPendingUserInput`**, `snoozedUntil`, `settledAt`.

#3 established that the CLI-minted bearer token grants `AuthAdministrativeScopes`, and
`packages/contracts/src/auth.ts:88,105-109` confirms that set contains `orchestration:read`. So
one `Authorization: Bearer` GET, from a cold process, with no ticket-mint and no socket, answers:

- **does the thread exist** — present in `threads[]` (§4)
- **is it still mine** — `title === "fm-<ID>"`, `worktreePath === <lease>`
- **is it busy** — `session.status` plus the two pending flags, exactly #7's classifier, with the
  precomputed booleans #7 already noted `subscribeShell` carries

**This corrects #7 and closes the decision #1 lists as preceding `t3.sh`.** #7's "`/ws` is the
only orchestration surface — there is no HTTP read" led to "a ledger-based `busy_state` is either
a long-lived bridge process holding one socket or a ticket-mint-plus-connect per poll", recorded
in #1 as the one open question blocking the backend. Neither is required. `t3.sh` stays a
synchronous shell script like every other backend arm, and `/ws` is needed only where firstmate
genuinely wants a stream.

**Not verified live** — read from source at the two SHAs above. One `curl` against the running
desktop server would settle it; that needs a bearer token, which per #3 means writing into
`~/.t3/userdata/state.sqlite`, so it is left for whoever implements §7.

## 4. What archived and deleted read as

**Both read as "the target does not exist", and firstmate cannot tell them apart over HTTP.**

`listThreadRows`, the shell snapshot's thread query
(`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:429-430`), ends:

```sql
WHERE deleted_at IS NULL
  AND archived_at IS NULL
```

so an archived thread and a deleted thread are equally absent from `threads[]`.
`GET /api/orchestration/threads/:threadId` is no better: it resolves through
`getActiveThreadRowById` (`:2097`), whose `WHERE` carries the same two clauses (`:902-903`), and
returns `thread_not_found`. Archived threads are reachable only through the separate
`listArchivedThreadRows` path (`:466`), surfaced on `/ws` alone.

That is fine, because the two states mean the same thing to firstmate:

- **Archived** — #10: a turn dispatched at an archived thread is accepted, the row lands
  permanently, and nothing else ever happens, because the reactor also resolves through
  `getActiveThreadRowById`. #10's own conclusion: a backend must read `archivedAt != null` as
  *target does not exist*.
- **Deleted** — #7: the subscription stays open, un-errored and silent, so `target_exists` has to
  come from a snapshot rather than the stream. It now does.

So `fm_backend_t3_target_exists` is "is `$T` in `threads[]`", and #5's mandatory `target_exists`
arm is satisfied by the same GET as everything else. The digest prints `endpoint: dead`
(`firstmate/bin/fm-session-start.sh:365`) either way. Distinguishing the two would buy a nicer
digest line at the cost of a websocket; not worth it for v1, and it is a real limitation to
record rather than a gap to close.

## 5. Which operations check, and what a mismatch does

**Gate on existence, on every op. Report identity, in the digest only. Refuse nothing because of
a rename.**

The existence gate is not optional and not new: cmux, zellij and herdr all call their
`target_ready` first in every op (`firstmate/bin/backends/zellij.sh:433,457,471`,
`cmux.sh:476,498,521`), and `firstmate/bin/fm-send.sh:236-240` states the division of labour —

> Do not add a separate passive liveness preflight here. **Active send paths own backend
> readiness** … zellij verifies pane labels in its send implementation. A failed backend send is
> still surfaced below as a hard error with the attempted resolution attached.

— which `:294-300` turns into `error: text not sent to $T (...)` and `exit 1`. `t3.sh` inherits
this unchanged: every op resolves the thread from the shell snapshot first, and a thread that is
absent fails the op, loudly, at the caller.

**The title is not part of that gate**, for one reason: in T3 the title is not the address.
`threadId` is, on `thread.turn.start`, `thread.session.stop`, `thread.archive`,
`thread.meta.update` and every other command, and it is immutable — #8 established T3 burns
thread ids permanently. So a renamed thread is still perfectly addressable, and refusing a send
because the captain relabelled it would refuse an operation that would have worked. That is the
tmux case from §1(b), not the cmux case from §1(c), and firstmate's tmux arm does not refuse on a
renamed window either — it targets the stable id and carries on.

**Why check at all, then.** Because it is free. The title arrives in the same GET that already
answers existence and busy-state, so the comparison costs zero calls. And it is the only signal
that separates *"the captain has taken this thread over"* from *"the crewmate is slow"* — which is
precisely the kind of thing firstmate's session-start digest exists to put in front of a human.

**Where it surfaces.** The digest, and nowhere else. `firstmate/bin/fm-session-start.sh:351-377`
already prints one identity line per task and is the one place firstmate reports endpoint
identity to a person. The watcher polls every few seconds
(`firstmate/bin/fm-watch.sh:881`), so a per-op stderr warning would repeat the same line for
hours. Concretely, the digest arm should print alongside the existing `endpoint:` line:

```
endpoint: alive (backend=t3 window=<threadId>)
endpoint: alive, RENAMED by hand (backend=t3 window=<threadId> title='<live>' expected='fm-<ID>')
```

Signature-wise, `t3.sh`'s ops still take `[expected-label]` as their last argument for conformance
with `fm_backend_capture`/`send_key`/`send_text_submit`
(`firstmate/bin/fm-backend.sh:778,796,816`), which already thread `EXPECTED_LABEL` from every
call site. `t3.sh` accepts it and uses it for the report, not the gate — the same shape as the
backends that report `unknown` for `composer_state` rather than inventing one
(`fm-backend.sh:904-916`).

**A second identity field deserves the same line, and it is the dangerous one.**
`worktreePath` is mutable from the GUI and its mutation is *destructive*, unlike a rename.
`apps/web/src/components/BranchToolbarBranchSelector.tsx:155-171`: when the captain picks a
different branch in the toolbar, the client first
`stopThreadSession({ threadId })` if the worktree path changed, then dispatches
`thread.meta.update { branch, worktreePath }`. That kills the crewmate's provider session and
re-points the thread out of its treehouse lease in one gesture.
`apps/web/src/components/ChatView.tsx:4135` can set `worktreePath: null` outright after a checkout
switch. A `worktreePath` that no longer equals the lease is the strongest available evidence that
the thread is no longer firstmate's, and it should be reported the same way — it is the same GET,
the same line.

## 6. `agent_state`: `unverified`, so no recovery

`firstmate/bin/fm-backend.sh:981-1005` is explicit that only `dead` and `missing` license
recovery, that the classifier is per-backend, and that a backend without a validated recovery
path reports `unverified` — zellij's stated reason being that "its secondmate ghost-tab and
agent-process recovery path has not been empirically validated". `fm_backend_agent_state`'s `case`
has arms for tmux, herdr and codex-app only; everything else falls to `*) printf 'unverified'`.

**t3 ships with no arm**, i.e. `unverified`. Fidelity says so (nothing about T3 recovery has been
validated), and T3 adds a reason the other backends do not have: recovery would act on a thread
the captain may have archived *deliberately*, and #10 showed an archived thread swallows work
silently. `unverified` keeps `fm_backend_agent_alive` at `unknown`
(`fm-backend.sh:1010-1016`), which is the conservative answer everywhere it is consumed. The
digest still says `dead`, a human still repairs — firstmate's existing answer to reconciliation,
unchanged.

## 7. Recommendation for `bin/backends/t3.sh`

1. **One helper, one GET.** `fm_backend_t3_shell` fetches `GET /api/orchestration/shell` with the
   bearer token from #3 and caches nothing. Every op below reads it.
2. **`target_exists`** — thread id present in `threads[]`. Absent = gone, covering archived,
   deleted and never-existed alike (§4). This is #5's mandatory arm.
3. **`busy_state`** — `session.status` + `hasPendingApprovals`/`hasPendingUserInput` off the same
   payload, per #7's classifier. No bridge process (§3).
4. **`agent_state`** — no arm; `unverified` (§6).
5. **Identity report** — compare `title` to `fm-<ID>` and `worktreePath` to the recorded lease;
   surface both on the session-start digest's `endpoint:` line and nowhere else (§5).
6. **Spawn** — `thread.create { title: "fm-<ID>" }` and `thread.turn.start` **without
   `titleSeed`**, so T3 never renames it (§2). Record `t3_thread_title=fm-<ID>` and
   `worktree_lease=1` in `state/<id>.meta` per #8.
7. **Gate nothing on the title.** Ops address `threadId` and succeed on a renamed thread (§5).

## 8. Open questions and contradictions

1. **§3 is unverified live.** The four HTTP routes, their scopes and the shell payload are read
   from source. A single authenticated `curl` would confirm it, and it changes a decision #1
   currently lists as blocking `t3.sh`, so it is worth doing before the code is written. It needs
   a bearer token, which per #3 means writing a row into the live `~/.t3/userdata/state.sqlite` —
   sanctioned by #3 but not something this research did unprompted.
2. **Does #7's stream-based `busy_state` still have a job?** If §3 holds, polling one GET is
   simpler than holding a socket, but it is a poll: the watcher's latency becomes its interval.
   #10 measured a cold-process socket round trip at 36-62 ms, so the two are closer in cost than
   expected. Genuinely open, and now a performance question rather than an architectural one.
3. **Should firstmate report a rename at all, or act on it?** §5 says report. The argument for
   acting — refusing further sends once the captain has adopted a thread, so two supervisors do
   not drive one crewmate — is not absurd, and #9's "neither surface owns the thread" cuts both
   ways. Fidelity decides it for v1 (firstmate's tmux arm does not refuse on a renamed window),
   but if the captain-adoption case turns out to be common in practice this is the first thing to
   revisit.
4. **`fm_backend_kill`'s signature does not carry `[expected-label]`**
   (`firstmate/bin/fm-backend.sh:836`), yet `fm-teardown.sh:1264,1336` passes four arguments and
   cmux's kill reads `${3:-}` as the label (`cmux.sh:639-642`). The extra arguments reach the
   adapter through `"$@"`, so it works, but the dispatcher's comment is stale. Not this ticket's
   problem; flagged for whoever adds the t3 arm and reads that signature.
5. **Archived vs deleted is indistinguishable over HTTP** (§4). Both mean gone, so v1 does not
   care, but a digest that could say "the captain archived this" instead of "dead" would be
   kinder, and that needs the `/ws` archived-shell subscription.
6. **Nothing here prevents the captain re-pointing a thread mid-turn** (§5, the
   `BranchToolbarBranchSelector` path). Detection after the fact is all firstmate gets; T3 offers
   no lock, and asking for one would be the invention the fidelity rule exists to prevent.
