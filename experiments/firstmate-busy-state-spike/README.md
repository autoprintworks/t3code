# firstmate busy-state spike — which thread events mark a crewmate busy, waiting, or done

Spike for [#7](https://github.com/autoprintworks/t3code/issues/7).

**`orchestration.subscribeThread` carries every state firstmate needs, but not
in `session.status`.** Busy and waiting share the same status — `running` — so
`fm_backend_t3_busy_state` cannot be a status lookup the way
`fm_backend_claude_bg_busy_state` is a `state` field lookup. It has to be a
two-source read: `session.status` for the busy/idle/exited spine, plus a
running ledger of `approval.requested`/`user-input.requested` activities for
`blocked`.

Measured live against the installed desktop server (T3 `0.0.31`, bundled
`@anthropic-ai/claude-agent-sdk` `0.3.220`, `http://127.0.0.1:3773`, Windows 11)
on 2026-08-04, driving a throwaway project and thread through six scenarios.
Code references are to this checkout at `30c962280`. Raw transcript:
[`transcript.json`](./transcript.json); the run that produced it is
`--scenario 1,2,3,5,6`.

## The mapping

Target vocabulary is claude-bg's, since #1 makes fidelity to firstmate's
documented model the decider — `busy | blocked | idle | exited | unknown`
(`bin/backends/claude-bg.sh:168`).

| firstmate state | T3 signal |
| --- | --- |
| `busy` | `thread.session-set` with `session.status` of `starting` or `running`, and no unresolved request in the ledger |
| `blocked` | ledger non-empty: an `approval.requested` or `user-input.requested` activity with no matching `approval.resolved` / `user-input.resolved` |
| `idle` | `thread.session-set` with `session.status` of `ready` (clean turn end) or `idle` |
| `exited` | `thread.session-set` with `session.status` of `stopped`; also `error`, which is where an interrupt lands (see below) |
| `unknown` | no session yet — `session` is `null` in the snapshot until the first turn starts |

The ledger is the same accounting the server already does for its own shell
projection, `derivePendingUserInputCountFromActivities`
([ProjectionPipeline.ts:133](../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts)),
and it is worth copying rather than re-deriving: it also closes a request on a
`provider.user-input.respond.failed` activity whose detail says the request was
stale or unknown. Approvals are tracked separately, keyed on `requestId`, and
only `approval.requested` may open a row — other activity kinds carry a
`requestId` too and must not pollute the count (`ProjectionPipeline.ts:1499`).

### Observed sequences

Turn runs and completes, from `transcript.json` (offsets in ms from subscribe):

```
+   238  thread.message-sent
+   900  thread.session-set   status=starting  activeTurnId=null
+  2398  thread.session-set   status=running   activeTurnId=13db86e6-…
+  5015  thread.message-sent                            (assistant reply)
+  5036  thread.activity-appended  kind=context-window.updated
+  5764  thread.session-set   status=ready     activeTurnId=null
```

Awaiting approval — note the session never leaves `running`:

```
+ 11091  thread.activity-appended  kind=tool.started       "File change started"
+ 11918  thread.activity-appended  kind=approval.requested "File-change approval requested"
+ 15100  thread.activity-appended  kind=approval.resolved  "Approval resolved"
+ 15197  thread.session-set   status=running   activeTurnId=6d429cde-…
+ 17903  thread.session-set   status=ready     activeTurnId=null
```

The `approval.requested` payload carries everything the responder needs:

```json
{ "requestId": "afce9ffe-ea67-4724-8cf6-0b82d472038a",
  "requestKind": "file-change",
  "requestType": "file_change_approval",
  "detail": "Write: {\"file_path\":\"…\\\\probe.txt\",\"content\":\"firstmate-approval-probe\\n\"}" }
```

Awaiting user input, again with the session still `running`. The payload is the
`AskUserQuestion` tool input, so a supervisor can answer without a round trip:

```json
{ "requestId": "272535bd-c9b6-4fbb-ab10-402f11b7dff2",
  "questions": [ { "id": "Which colour do you prefer?", "header": "Colour",
                   "question": "Which colour do you prefer?",
                   "options": [ { "label": "Red", "description": "…" },
                                { "label": "Blue", "description": "…" } ],
                   "multiSelect": false } ] }
```

`requestId` from either payload is what `thread.approval.respond` and
`thread.user-input.respond` take — verified by responding to the approval and
watching the turn resume.

## What the stream cannot distinguish

Three gaps. The first is the one that shapes the backend.

**1. Busy and waiting are the same session status, by construction.** The
provider runtime layer *has* a distinct `waiting` state, and the orchestration
boundary deliberately folds it into `running`:

```ts
// apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:267
case "running":
case "waiting":
  return "running";
```

So this is not an oversight to route around — it is the contract.
`OrchestrationSessionStatus` has no `waiting` member at all
([orchestration.ts:262](../../packages/contracts/src/orchestration.ts)). The
consequence for firstmate is direct: claude-bg's `blocked` exists precisely
because "the watcher must escalate, NOT wait it out"
(`bin/backends/claude-bg.sh:175`), and a T3 backend that reads only
`session.status` would report `busy` for a crewmate parked on an approval and
let the watcher sleep through it forever. The activity ledger is mandatory, not
an optimisation.

A cheaper alternative exists if the backend can afford a second subscription:
`orchestration.subscribeShell` ships `hasPendingApprovals` and
`hasPendingUserInput` as precomputed booleans on every thread
([orchestration.ts:434](../../packages/contracts/src/orchestration.ts)), which
is the same ledger already maintained server-side. That trades per-thread event
bookkeeping for a whole-shell stream. For one supervisor watching N crewmates
the shell stream is probably the better buy; for a per-task backend arm it is
more than is needed.

**2. A deleted thread is indistinguishable from an idle one.** Scenario 6
deletes the thread while subscribed. The subscription **does not close, does not
error, and emits nothing** — it simply goes quiet:

```
=== scenario 6: thread deleted underneath the subscription ===
  -> stream still open; 0 further stream item(s) after delete
```

This lands squarely on the `target_exists` arm that #5 found is mandatory in
practice because its default means "gone". **The stream cannot implement
`target_exists`.** The backend needs a separate liveness check — the shell
snapshot (`orchestration.getArchivedShellSnapshot` or a `subscribeShell` read)
is the natural one, since a deleted thread drops out of it.

**3. An interrupt does not report as `interrupted`.** `thread.turn.interrupt`
against a plainly-running turn produced:

```
+  6482  thread.session-set   status=error  activeTurnId=e4aa351f-…
              lastError=[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null
+  6483  thread.activity-appended  kind=runtime.error
+  7172  thread.session-set   status=error  activeTurnId=null
```

`OrchestrationSessionStatus.interrupted` is a real contract member and the
adapter has a code path that would produce it — `handleStreamExit` calls
`completeTurn(context, "interrupted", …)` when `isClaudeInterruptedCause`
matches ([ClaudeAdapter.ts:3005](../../apps/server/src/provider/Layers/ClaudeAdapter.ts))
— but on the shipped build the interrupt did not match that predicate and fell
through to the error path. This corroborates #6's finding that an interrupt
arrives as a tool-use rejection rather than a turn end, and adds where it
surfaces. Practical effect: **a backend must treat `error` as "possibly a
deliberate interrupt", not as a crash.** `lastError` is the only discriminator
and it is a diagnostic string, not a code.

Caveat on this one: the `ede_diagnostic` prefix appears nowhere in this
checkout, so it comes from the shipped 0.0.31 bundle rather than from `main`.
The behaviour is what the installed desktop app does today; it may not be what
`main` does. That is the only finding here where the running build and the
checkout may have diverged.

**Not tested: a genuinely crashed provider.** Scenario 5 covers a *requested*
`thread.session.stop` (→ `stopped`). Killing the `claude` child process
mid-turn would be the real test of "session dead or crashed" and was not run.
Given gap 2, a supervisor needs the shell-snapshot fallback regardless, so this
does not change the backend's shape — but the exact status a crash produces is
unverified.

## Traps

- **`thread.session-set` is level-triggered, not edge-triggered.** A single turn
  emitted four consecutive `starting` events and three `running` events with
  identical status. Any state machine keyed on "a session-set arrived" will fire
  repeatedly for one transition; dedupe on `(status, activeTurnId)`.
- **Streaming RPCs stall without an `Ack`.** `RpcServer` holds one latch per
  request id and only refills it when the client answers a `Chunk` with
  `{"_tag":"Ack","requestId":…}`
  ([RpcServer.ts:190](../../.repos/effect-smol/packages/effect/src/unstable/rpc/RpcServer.ts)).
  Miss it and the subscription delivers exactly one chunk and then goes silent
  forever — which reads like "this thread emits no events", not like
  backpressure. The #3 spike never hit this because it only used
  request/response.
- **A clean turn end is `ready`, not `idle`.** Both settle a running turn to
  `completed` (`projector.ts:50`), but `idle` was never observed on this path —
  match on the set, not on `idle`.
- **`runtimeMode: "approval-required"` is not in the adapter's permission map.**
  `runtimeModeToPermission` covers only `auto-accept-edits`, `auto` and
  `full-access` ([ClaudeAdapter.ts:3512](../../apps/server/src/provider/Layers/ClaudeAdapter.ts)),
  so `approval-required` leaves `permissionMode` undefined and the SDK's own
  default decides. Observed consequence: a `Bash` `echo` ran with **no approval
  raised at all**, while a `Write` to the same directory did raise one. T3's
  `canUseTool` gates every non-`full-access` mode
  ([ClaudeAdapter.ts:3372](../../apps/server/src/provider/Layers/ClaudeAdapter.ts)),
  but it only ever runs when the SDK decides to ask. Do not assume
  `approval-required` means "approve everything" — the first scenario-2 attempt
  in this spike timed out waiting for an approval that never came.
- **Interrupting a turn parked on a pending user-input is a different path.**
  It resolves the request (`user-input.resolved`, summary "User input
  submitted") and *then* errors, with `stop_reason=tool_use` in `lastError`
  rather than `stop_reason=null`. Same for `thread.session.stop`: the pending
  request resolved and the session went `ready` before `stopped`. A supervisor
  must not read that `user-input.resolved` as "the human answered".
- **`session` is `null` until the first turn.** A freshly created thread has no
  session object, so there is no status to read — that is the `unknown` arm, and
  it is a normal state, not an error.
- **The Windows temp dir cannot be removed right after `project.delete`** — the
  server still holds a handle and `rmSync` throws `EBUSY`. Cosmetic here, but a
  backend cleaning up worktree leases will meet the same thing.

## Running it

```bash
T3_TOKEN=$(t3 auth session issue --ttl 30d --label firstmate-busy --token-only) \
  node experiments/firstmate-busy-state-spike/spike.mjs
```

`--scenario 1,2,3,5,6` selects scenarios, `--keep` leaves the project and thread
behind, `--out` sets the transcript path. Scenario 4 (interrupt) is excluded
from the default transcript run because it leaves the session in `error` and
that colours everything after it; run it as `--scenario 4` on its own.

Minting the token has the same two Windows constraints #3 recorded, and both
still bite: the desktop `.exe` is a GUI-subsystem binary that writes nothing to
an inherited console — `& $exe … > out.txt` produced a zero-byte file, while
`Start-Process -RedirectStandardOutput` worked — and under Git Bash the CLI
exits 0 and silent.
