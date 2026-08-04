# firstmate HTTP-surface spike — confirming `/api/orchestration/*` live

Spike for [#28](https://github.com/autoprintworks/t3code/issues/28).

**The HTTP surface behaves as [#15](https://github.com/autoprintworks/t3code/issues/15) read it,
and it goes further than #15 claimed: the *whole* crewmate lifecycle is drivable over HTTP alone.**
Seven commands dispatched, seven accepted, no websocket anywhere. `bin/backends/t3.sh` can be a
plain synchronous shell script over `curl` and `jq`, with no bridge process and no socket.

One finding cuts the other way, and it lands on
[#13](https://github.com/autoprintworks/t3code/issues/13): **an invariant rejection arrives over
HTTP as a bare `500` with no reason.** The rejection detail is written to the database but is not
in the response. #13's instruction to "read the invariant rejection receipt as success" is
therefore not implementable as written on this surface.

Measured 2026-08-04 against the installed desktop build (`t3` 0.0.31,
`http://127.0.0.1:3773`, pid 16984, Windows 11).

## Running it

Two scripts. `probe-read.mjs` and `probe-filter.mjs` mutate nothing.
`probe-lifecycle.mjs` creates a scratch git repo, a T3 project and a thread, then removes all
three.

```bash
node probe-read.mjs        # credential, shape, snapshot, threads/:id
node probe-filter.mjs      # what shell filters out, and latency
node probe-lifecycle.mjs   # a whole crewmate over HTTP only
```

Each reads the bearer token from `%TEMP%\fm-shim-token.txt` and the server origin from
`~/.t3/userdata/server-runtime.json`. Mint a fresh token per
[#3](https://github.com/autoprintworks/t3code/issues/3) if the stored one has expired.

`probe-filter.mjs` opens `state.sqlite` **read-only** to pick real archived and deleted thread ids.
It never writes.

## 1. The credential is a bearer header, and nothing else

| request | result |
| --- | --- |
| no credential | `401 auth_invalid` / `reason: missing_credential` |
| `Bearer <garbage>` | `401 auth_invalid` / `reason: invalid_credential` |
| `?token=<valid token>` in the query string | **`401`** |
| `Authorization: Bearer <valid token>` | `200` |

The `?token=` query form does not work. `/ws` has `?wsTicket=` because Node's built-in WebSocket
cannot set headers; the HTTP routes have no equivalent and need none, because `curl` can set a
header. The token minted by `t3 auth session issue --token-only` carries
`orchestration:read` and `orchestration:operate`, which is exactly what these four routes require
(`http.ts:33`, `:53`, `:66`, `:85`) — so **one credential covers reads and commands**.

## 2. `GET /api/orchestration/shell` — one read answers three questions

The response is **not** a bare thread array. It is:

```json
{ "snapshotSequence": 15717, "projects": [...], "threads": [...], "updatedAt": "..." }
```

A thread entry carries, measured verbatim:

```
id  projectId  title  modelSelection  runtimeMode  interactionMode  branch  worktreePath
latestTurn  createdAt  updatedAt  archivedAt  settledOverride  settledAt  snoozedUntil
snoozedAt  session  latestUserMessageAt  hasPendingApprovals  hasPendingUserInput
hasActionableProposedPlan
```

and `session` is `{threadId, status, providerName, providerInstanceId, runtimeMode,
activeTurnId, lastError, updatedAt}`.

Three consequences for `t3.sh` ([#29](https://github.com/autoprintworks/t3code/issues/29)):

- **`target_exists`, `busy_state` and the #15 identity check are one GET**, as #15 predicted —
  `title` for the rename check, `worktreePath` for the drift check, `session.status` plus
  `hasPendingApprovals`/`hasPendingUserInput` for busy.
- **The same GET also carries `projects`**, so
  [#11](https://github.com/autoprintworks/t3code/issues/11)'s derive-the-binding read needs no
  second call. This matters — see the latency table below.
- **The key is `id`, not `threadId`.** `threadId` exists only inside the nested `session` object.
  A `jq` selector written from #15's prose (`.threads[] | select(.threadId == ...)`) silently
  matches nothing.

### Trap: `snapshot` is 22× more expensive than `shell`

| route | 5 consecutive runs |
| --- | --- |
| `GET /api/orchestration/shell` | 116, 161, 154, 108, 148 ms |
| `GET /api/orchestration/snapshot` | 4935, 2931, 2812, 2900, 2798 ms |

`busy_state` is polled. It must use `shell`. The source explains the gap and warns about it in
place: `snapshot` serves "the lightweight command read model" precisely because hydrating
everything "has OOM-killed servers", and its "only consumer (the project CLI) reads projects
alone" (`apps/server/src/orchestration/http.ts:35-40`).

The two also disagree on content, which is the actual reason to prefer `shell`:

- `snapshot` returned **28 projects**, including soft-deleted ones (every entry carries a
  `deletedAt` field).
- `shell` returned **3 projects** — the active set, which is what #11's
  `$PROJ_ABS` → active-project resolution wants.

## 3. Absence is the `target_exists` signal, and it is exact

The live database held 47 threads: 1 active, 26 archived, 23 deleted (the classes overlap).
`shell` returned **exactly the 1 active thread**.

Sampling three real threads from each class:

| class | in `shell` | `GET /api/orchestration/threads/<id>` |
| --- | --- | --- |
| active | yes | `200` |
| archived | no | `404 not_found` / `reason: thread_not_found` |
| deleted | no | `404 not_found` / `reason: thread_not_found` |

Archived and deleted are **indistinguishable** over HTTP — matching #15's reading, and matching
what [#7](https://github.com/autoprintworks/t3code/issues/7) and
[#10](https://github.com/autoprintworks/t3code/issues/10) found on the socket. A backend reads
both as *gone*, which is the correct answer for both, because #10 established that an archived
thread swallows turns silently.

An unknown thread id returns the same `404 thread_not_found`, so `target_exists` is one status
code with no body parsing.

## 4. `session.status` over HTTP matches what #7 measured over the socket

The scratch crewmate, polled at 500 ms through one turn. Timings are from process start:

```
   552ms  session=null        latestTurn=null      (thread created, no turn yet)
  1548ms  starting            latestTurn=null
  2938ms  running             latestTurn=running
  6926ms  ready               latestTurn=null      (clean turn end)
  7734ms  stopped             latestTurn=null      (after thread.session.stop)
  7916ms  ABSENT                                   (after thread.archive)
```

Identical to #7's socket vocabulary, so the `busy_state` mapping it settled transfers unchanged:
`starting`/`running` → busy, `ready`/`idle` → idle, `stopped` → exited, `session: null` → unknown.
A clean end is `ready`, never `idle` — #7's trap reproduces here.

Two things this adds:

- **A fresh thread has `session: null` until its first turn.** The thread is present in `shell`,
  so `target_exists` says yes while `busy_state` has nothing to read. #7 mapped `session: null` to
  *unknown*; this is the state that actually produces it, and a spawn passes through it every
  time.
- **`latestTurn` is a live-turn indicator, not turn history.** It is populated only while a turn
  is in flight and returns to `null` at a clean end — so `latestTurn != null` is a second busy
  signal, independent of `session.status`. Do not read it as "the last turn".

`runtimeMode: "full-access"` round-tripped into the session object unchanged, and `worktreePath`
came back as the verbatim Windows `C:\...` string that was sent — confirming
[#18](https://github.com/autoprintworks/t3code/issues/18)'s instruction to canonicalise the leased
path once with `cygpath -m` before it is ever sent.

## 5. The whole lifecycle runs over `POST /api/orchestration/dispatch`

Seven commands, all `200`, no socket:

`project.create` → `thread.create` → `thread.turn.start` → `thread.session.stop` →
`thread.archive` → `thread.delete` → `project.delete`

The route runs the **same normalizer** as the websocket path
(`normalizeDispatchCommand`, `http.ts:86`), so command payloads are identical to the ones
[#9](https://github.com/autoprintworks/t3code/issues/9) and #10 established. The response body is
the receipt, `{"sequence": <n>}` — the same value the socket returns.

**This is the finding that decides `t3.sh`'s shape.** #7 worried that a ledger-based `busy_state`
would force firstmate's first backend to add a long-lived process. #15 corrected that for reads.
This closes it for writes as well: every arm is a `curl`, and `t3.sh` is a script like every other
backend.

### Trap: an invariant rejection is an opaque `500`

Archiving the already-archived thread:

```
POST /api/orchestration/dispatch  {"type":"thread.archive", ...}
-> 500 {"_tag":"EnvironmentInternalError","code":"internal_error",
        "reason":"orchestration_dispatch_failed","traceId":"d96c21c0..."}
```

The database records the real reason:

```
rejected  15821  Orchestration command invariant failed (thread.archive):
                 Thread '285d23ca-...' is already archived and cannot handle command 'thread.archive'.
```

The response carries none of it. `failEnvironmentInternal("orchestration_dispatch_failed")`
(`http.ts:92-94`) flattens every dispatch failure into one `500`, so **a backend cannot tell a
benign "already archived" from a genuine server fault by status code**.

#13 decided the backend "must read an invariant rejection receipt as success". Over HTTP there is
no receipt to read. The implementable rule is instead: **verify by read, not by status.** After a
non-2xx on `thread.archive`, GET the thread — a `404` means archived, which is the intended end
state, and anything else is a real failure. This is the same absence check `target_exists` already
performs, so it costs one extra call and no new machinery.

Confirms #11's related point in passing: the rejected receipt is persisted permanently against
that `commandId` (4 rejected receipts against 15,649 accepted in this database), so a retry needs
a fresh `commandId`.

### Trap: `accepted` does not mean `effective` — and this one is version-dependent

`thread.turn.start` against the archived thread returned **`200`** with an accepted receipt
(sequence 15823), and nothing happened. #10 measured this black hole over the socket; it is
identical over HTTP, and the HTTP response is *more* misleading, because a `200` reads as success.

**But that is the shipped 0.0.31 build, not current `main`.** `720bea4a7` ("archived threads
refuse turn starts instead of dropping them", #26) routes `thread.turn.start` through
`requireThreadNotArchived`. On a server carrying that fix the same call becomes an invariant
rejection — which, by the previous section, reaches an HTTP caller as the **opaque `500`**.

So `t3.sh` must handle both, and the rule that covers both is the same one: **verify by read.** A
poke that must land is guarded by an existence check beforehand, and its outcome is confirmed by
reading the thread afterwards — never inferred from the dispatch status, which says `200` on the
old build and `500` on the new one for the identical mistake.

This also widens the previous section's scope. Invariant rejections are not a `thread.archive`
curiosity; `requireThreadNotArchived` already guards `settle`, `unsettle`, `snooze`, `unsnooze`
and now `turn.start`, so any of them can produce a reasonless `500`.

## What this leaves for #29

Everything `t3.sh` needs is now measured rather than inferred:

| backend op | implementation |
| --- | --- |
| `target_exists` | `GET .../threads/<id>` → `200`/`404`, or absence from `shell` |
| `busy_state` | `shell` → `session.status` + `hasPendingApprovals`/`hasPendingUserInput` |
| `send_text_submit` | `POST .../dispatch` `thread.turn.start` (guarded by an existence check) |
| `kill` | `POST .../dispatch` `thread.session.stop`, then `thread.archive`, verified by read |
| `send_key` | no analogue — the sanctioned way out from #5 |

The one thing still unmeasured on this surface is the identity check under a live rename, which
#15 settled by source and which `shell`'s `title` field is now confirmed to carry.
