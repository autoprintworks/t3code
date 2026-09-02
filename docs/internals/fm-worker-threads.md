# First Mate worker threads

> Fork only. Part of [the `fm` fork delta](./fm-provider-fork-delta.md).

A First Mate delegates to crewmates. Each crewmate is a live ACP session on the
same door process as the supervisor, so the door's connection carries more than
one session. This document is how those sessions become threads, and - more
important - why doing it cannot make the editor slow.

## The shape

```
fm-acp (one door, one home)
  session/list  ->  supervisor session + N worker sessions
                        |
                        v
  AcpSessionRuntime     poll -> AcpPeerSessions.diff -> PubSub
                        |
                        v
  FmAdapter             FmWorkerObservation stream
                        |
                        v
  FmWorkerThreadReactor thread.create (readOnly) / message deltas / archive
```

- **[AcpPeerSessions.ts](../../apps/server/src/provider/acp/AcpPeerSessions.ts)**
  is pure: read the capability, drop the connection's own session from the
  answer, diff two answers.
- **[AcpSessionRuntime.ts](../../apps/server/src/provider/acp/AcpSessionRuntime.ts)**
  owns the poll fiber, the timeouts and the publish.
- **[FmWorkerSessions.ts](../../apps/server/src/provider/fm/FmWorkerSessions.ts)**
  is the fm-specific pure layer: thread ids, titles, message ids, and the
  reconcile that turns a roster into "appeared" and "disappeared".
- **[FmWorkerThreadReactor.ts](../../apps/server/src/provider/fm/FmWorkerThreadReactor.ts)**
  dispatches the orchestration commands.

## Why polling

ACP has `session/list`, and it has no agent-to-client notification for a
session appearing. Polling that method is the protocol's own answer, not a
workaround. What makes it safe is that it is gated, bounded and cheap:

- **Gated.** The poll parks on a `Latch` that the first
  `subscribePeerSessions` opens and the last subscriber's scope closes. A
  runtime nobody is watching sends no `session/list` at all, whatever the door
  advertises. `FmWorkerDoor.test.ts` asserts a started runtime with no
  subscriber has only sent `initialize` and `session/new`.
- **Bounded.** `session/list` has a 10 s timeout, a peer `session/load` has
  60 s, and neither retries. `Schedule.spaced` means the interval is measured
  from the end of the previous attempt, so a slow door throttles the poll
  rather than stacking requests on it. The answer itself has a ceiling too:
  `MAX_PEER_SESSIONS` is 500, and a door listing more is cut to it with one
  `acp.peer-sessions.ceiling` warning per poll. The length of the door's answer
  is the door's choice, and everything downstream of it is per-session work.
- **Scoped.** The fiber is forked into the session scope, so closing the
  connection interrupts it. A poll that outlives its connection is the bug this
  design is built to avoid.
- **Off the request path.** Nothing in the loop spawns a process, calls `git`,
  or walks the filesystem. Creating a worker thread is one indexed project
  lookup and one dispatch; adopting an existing one is a second indexed lookup,
  both through [FmWorkerThreadQuery.ts](../../apps/server/src/provider/fm/FmWorkerThreadQuery.ts),
  both with a `LIMIT`.

## Identity, and what survives a restart

**Thread id.** `fm-worker.<homeSessionId>.<workerSessionId>`, each segment
sanitised and truncated to 64 characters with a short hash appended when it is
cut. It is keyed on the **home**, not on the supervisor thread, so two
supervisor threads open on one home adopt the same worker thread instead of
creating two.

**Message id.** The door's own item id, passed through unchanged. A restart
replays the worker's transcript through `session/load`, and the reactor asks
`listThreadAssistantMessageIds` (capped at 2,000) which ids the thread already
holds, so a replay writes nothing twice. Only when the door gives no item id
does the reactor synthesise one, `<workerSessionId>#<n>`, and that case is
per-connection by construction.

**Startup sweep.** A crash leaves worker threads live for workers that no
longer exist. On the first roster after connecting, any live thread under this
home's prefix that the roster does not name is archived. The sweep reads at
most 500 thread ids per home, and it is prefix-bounded on the primary key
rather than a scan.

**Gone versus finished.** These are different states and the code says which:

| Situation                                    | Reason     | What happens                |
| -------------------------------------------- | ---------- | --------------------------- |
| The door answered `session/list` without it  | `finished` | The thread is archived      |
| The watch itself ended (shutdown, door exit) | `unknown`  | The thread is left alone    |
| `session/load` failed or timed out           | -          | One activity line, no retry |

A watch that ends is not evidence about the worker, so it must not archive
anything. A load that fails is terminal for that worker: the thread gets a
`fm.worker.transcript-unavailable` activity with an `error` tone, and nothing
tries again.

## Writes are buffered

The event store is SQLite behind a synchronous driver on the Node event loop
thread, so one write per ACP chunk is one synchronous write per chunk. Worker
text is coalesced per message and flushed on a 120 ms timer, at 8,000 buffered
characters, and on completion - the same shape
`ProviderRuntimeIngestion.ts` uses for every other provider.

## Read-only is a rule, not a rendering

`readOnly` is set once when the thread is created and never cleared. It is
enforced in [the decider](../../apps/server/src/orchestration/decider.ts) by
`requireThreadPromptable`, which refuses `thread.turn.start` and
`thread.checkpoint.revert` on a read-only thread. Hiding the composer in the
web and mobile clients is presentation; the refusal is what makes it true for
an old client build, a script, and a bare `POST /api/orchestration/dispatch`
alike.

`readOnly` is also absent from `ClientThreadCreateCommand`, so nothing arriving
over the wire can mint a read-only thread in the first place.

## The measurements

Unit tests here run on `@effect/vitest`'s virtual clock, which proves ordering
and proves nothing about wall-clock cost. `scripts/bench-fm-worker-poll.ts`
runs the shipping `AcpSessionRuntime` against `scripts/fm-worker-poll-door.mjs`,
a real spawned subprocess over a real pipe:

```
node apps/server/scripts/bench-fm-worker-poll.ts --workers 0,50,200,500
```

Results on node v24.13.1, Windows_NT 10.0.26200, 200 ms poll interval, 15 s per
run:

| Run              | Polls | `session/list` p50 | p99     | Loop delay p99 | Loop max |
| ---------------- | ----- | ------------------ | ------- | -------------- | -------- |
| control, no poll | -     | -                  | -       | 16.45 ms       | 16.99 ms |
| 0 workers        | 74    | 0.74 ms            | 1.37 ms | 16.52 ms       | 16.78 ms |
| 50 workers       | 74    | 0.83 ms            | 1.23 ms | 16.46 ms       | 16.75 ms |
| 200 workers      | 74    | 1.00 ms            | 1.50 ms | 16.42 ms       | 16.74 ms |
| 500 workers      | 73    | 1.37 ms            | 2.15 ms | 16.38 ms       | 16.62 ms |

The ~16.4 ms loop-delay floor is the Windows timer granularity. It is the same
in the control as in every poll run - the poll runs sit at or below the control,
not above it - which is the evidence that the poll does not block the loop.

Cost does grow with worker count, but sub-linearly and from a very low base:
500 workers is 1.37 ms per poll against 0.74 ms for none, so 500 extra sessions
cost 0.63 ms once every 200 ms. `rosters 1` in every run is the diff working:
an unchanged roster is polled but not republished.

Two failure shapes, same harness:

- **The door accepts `session/load` and never answers.** The load failed after
  60,003.92 ms - the 60 s timeout - and 294 polls completed while it waited.
  The pump does not stop for a hung load.
- **The session disappears while its load is in flight.** Reported gone after
  407.84 ms, with exactly one `session/load` sent. "Gone" is decided by the
  door answering `session/list` without it, not by the load ever coming back.
