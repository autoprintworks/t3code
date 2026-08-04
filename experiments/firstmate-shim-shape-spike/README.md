# firstmate shim shape spike — what bash actually dispatches through

Spike for [#16](https://github.com/autoprintworks/t3code/issues/16).

**Neither arm of the ticket's question. The helper needs no daemon and no
WebSocket: the environment HTTP API answers every hot-path call with one bearer
header, and a cold one-shot costs 79 ms — 53 ms of which is node itself.** A
daemon cannot win that back, because bash still pays a process to talk to it.
The websocket stays for exactly two things: `server.getConfig` at spawn time,
and an optional mirror if poll pressure ever justifies it.

Measured live against the installed desktop server (T3 `0.0.31`,
`claude-fable-5`, `http://127.0.0.1:3773`, Windows 11, node v22.15.0) on
2026-08-04. [`shim.mjs`](./shim.mjs) is both the prototype helper and its own
benchmark — `bench` spawns it as a cold child process, so the numbers are what
bash pays, not what an already-warm interpreter pays.
[`findings.json`](./findings.json), [`run.log`](./run.log),
[`live-threads.json`](./live-threads.json). Code references are to this checkout
and to firstmate at `C:\00_AI_Development\firstmate-claude-code`.

## The thing #3 did not look at

`/ws` is not the only way in. `EnvironmentHttpApi` exposes the same orchestration
surface over ordinary HTTP with the same bearer token
([environmentHttp.ts:460-490](../../packages/contracts/src/environmentHttp.ts)):

| Route | Serves |
| --- | --- |
| `GET /api/orchestration/threads/:threadId` | `capture`, `busy_state`, `target_exists`, `agent_state` |
| `POST /api/orchestration/dispatch` | `send_text_submit`, `send_key`, `kill`, `create_task` |
| `GET /api/orchestration/shell` | fleet-wide liveness |

No ticket, no upgrade, no `Ack` bookkeeping, no stream to keep alive. The whole
spawn sequence #9 drove over the websocket — `project.create`, `thread.create`,
`thread.turn.start` — went over `POST /api/orchestration/dispatch` in this run
unchanged. The one call with no HTTP route is `server.getConfig`, which is #12's
model resolution and a spawn-time cost only.

## What it costs

Medians, cold child process unless stated, n=10:

| Path | Median | What it is |
| --- | --- | --- |
| `node noop` | **53.1 ms** | the floor: process startup, before any work |
| capture over HTTP | **79.3 ms** | GET, render, exit |
| capture over the websocket | **84.5 ms** | ticket + upgrade + subscribe + snapshot + close |
| capture with `curl` (no node) | **26.9 ms** | the transport alone |
| `tail -n 40` on a mirror file | **23.6 ms** | `tail`'s own process cost |
| send (turn.start) over HTTP | 92.0 ms | n=3 |
| warm GET, socket already open | 1.9 ms | n=20 |
| warm dispatch: HTTP 4.1 ms / ws 5.2 ms | | n=5 each |
| `server.getConfig` (ws only) | **2069 ms** | spawn-time, n=5 |

Read that top block in the right order. **The ticket's premise — that connect +
ticket + upgrade is the thing to avoid — is worth about 5 ms.** HTTP beats the
websocket by 5.2 ms cold, which is noise next to the 53 ms node charges for
existing. A daemon holding the socket open removes the 26 ms of transport and
none of the 53 ms of process, so from bash it saves at most a third of a call it
still has to make. That is not worth a pidfile, a restart story and a stale-lock
failure mode.

The only shape that removes the process is one where bash calls no helper at
all: a long-lived subscriber mirroring the thread to disk, so `capture` is
`tail`. That is what claude-bg already does — its capture reads a JSONL file and
calls nothing (`bin/backends/claude-bg.sh:113-162`). It is 56 ms cheaper per
call, and it costs one supervised process per crewmate.

**`server.getConfig` at 2.1 s is the number that should worry a backend
author**, not any of the above. It is unavoidable at spawn (#12 forces a concrete
`{instanceId, model}`) and it is 25× the whole capture path. Cache it.

## The payload, which is the real hot-path cost

`getThreadDetailById` hydrates **every** message and **every** activity for the
thread with no `LIMIT`
([ProjectionSnapshotQuery.ts:908-927](../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts)),
so a capture that wants the last 40 lines pulls the entire transcript. Two turns
on a fresh thread took it from 2,157 to 6,669 bytes. Six real threads on this
machine (`probe-live`, read-only):

```
204,435 bytes  17.8ms   14 messages / 506 activities
140,303 bytes  14.0ms    7 messages / 361 activities
108,797 bytes  10.7ms    7 messages / 268 activities
```

**Activities outnumber messages 36:1 on a working thread**, and they are what
grows. A watcher polling `capture` every few seconds against a day-old crewmate
is moving a couple of hundred kilobytes per poll to read forty lines. Latency
stays fine — 17.8 ms for the 204 KB one — so this is a bandwidth and allocation
argument, not a stall, but it is the argument that eventually forces the mirror.

## The four decisions

### 1. Process model — one-shot, over HTTP, no daemon

`bin/fm-t3` runs once per call: read token, one request, print, exit. No socket,
no lifecycle, no pidfile, nothing to restart, nothing to leave stale. Every
mandatory primitive in #5's grading list is one HTTP call.

Adopt the mirror later, if and when the poll loop's byte cost bites — it is a
strictly additive change. `bin/fm-t3 mirror <thread-id> --out <file>` is
implemented here and its output was verified against the one-shot capture
(40 lines vs 40 lines, last line byte-identical). If it is adopted, the mirror
files belong in `$STATE/tmp/fm-<id>` alongside the other per-task state (#5's
step L), and the mirror becomes a supervised process firstmate must reap in
teardown — which is precisely the lifecycle a daemon would have imposed, only
deferred until something measurable pays for it.

### 2. Result marshalling — exit codes cross the boundary, bash prints the words

The helper prints data. It never prints firstmate's vocabulary. `capture` prints
rendered lines; `busy` prints one word; `send` prints nothing and exits 0 or 1.
The bash arm translates:

```sh
fm_backend_t3_send_text_submit() {  # <target> <text> <retries> <enter-sleep> <settle>
  if fm_backend_t3_helper send "$1" "$2" >/dev/null 2>&1; then
    printf 'empty'          # the literal word — bin/fm-send.sh:305
  else
    printf 'send-failed'
  fi
}
```

This is the shape that avoids codex-app's live bug (`printf ''` where `empty` is
required, `bin/backends/codex-app.sh:74`): the word never travels, so it cannot
be lost in transit. Exit codes carry the only thing bash needs to branch on:

| Exit | Meaning | Measured |
| --- | --- | --- |
| 0 | done | |
| 1 | transport or credential failure | tampered bearer → HTTP 401 → exit 1 |
| 3 | **target gone** — deleted or archived | both → HTTP 404 → exit 3 |
| 4 | credential expired (pre-flight, no call made) | |

Exit 3 is what `fm_backend_target_exists` and `fm_backend_t3_agent_state` read.
It folds in #10's archived black hole for free: an archived thread 404s exactly
like a deleted one, so the backend cannot mistake a thread that silently
swallows pokes for a live one.

Three output properties the grading list asks for, all verified against a real
204 KB thread:

- **SIGPIPE-safe.** `capture | head -c 200` exits 0 with empty stderr — what
  `bin/fm-fleet-snapshot.sh:979` requires.
- **Zero ANSI bytes, zero CR bytes** in the rendered output.
- **Interleaved by `createdAt`.** Rendering all messages then all activities
  looks fine on a two-turn thread and is useless on a real one — with 506
  activities to 14 messages the tail would be permanently tool noise and never
  the recent reply. This spike's first render made exactly that mistake.

### 3. Credentials — one token file, expiry read for free, and no mode bits on Windows

The token is `base64url(JSON claims).signature`
([SessionStore.ts:647](../../apps/server/src/auth/SessionStore.ts)), so the
helper reads its own expiry, session id and scopes **with no call to anything** —
no server, no CLI, no `state.sqlite`:

```
$ node shim.mjs token-info
session_id=381a8bac-2999-4f7f-85cd-3fc38b7fc296
subject=cli-issued-session
expires_at=2026-09-03T05:36:11.524Z
expires_in_days=30.00
scopes=orchestration:read,orchestration:operate,…
```

That makes the failure mode #16 names — silent expiry mid-run — a solved problem
rather than a design risk: every invocation pre-flights the claim at zero cost
and exits 4 with a renewal instruction before it makes a request. `t3 auth
session list` is not needed for liveness, and `sid` is in hand for
`t3 auth session revoke` without a lookup.

**The mode-0600 file the ticket proposes does not exist on Windows.** Measured:
`chmod 0600` under Git Bash leaves the file `-rw-r--r--` and does not touch the
NTFS ACL. Worse, firstmate's own `state/` directory grants
`BUILTIN\Users:(RX)` and `NT AUTHORITY\Authenticated Users:(M)`, so a token
dropped there is readable by every local account. `~/.t3/userdata` is tighter
(owner, SYSTEM, Administrators). So: **keep the token beside T3's own state, not
in firstmate's `state/`**, and if confinement matters, set the ACL explicitly
with `icacls /inheritance:r` rather than believing `chmod`. The honest posture
for v1 is that the credential has the same protection T3's own database has,
which is the same trust boundary firstmate already lives inside — plus a 30-day
TTL and a one-command revoke.

### 4. Subscription — nobody owns it

`fm_backend_t3_busy_state` needs no stream. #7's whole mapping, `blocked`
included, is derivable from the same snapshot GET that serves `capture`: the
approval / user-input ledger is just the activity list, and the activity list is
already in the payload. Measured agreement mid-turn: the one-shot and the mirror
both reported `busy`.

So the subscription is not a component of the backend. It is an option with two
independent buyers:

- **The mirror**, if the byte cost above ever justifies it — one subscriber per
  crewmate, or several on one socket (two concurrent `subscribeThread` streams
  on a single connection both delivered their snapshots).
- **Push supervision**, which #6 and #10 already settled in favour of the Stop
  hook. #5's step 17 says leave `fm_backend_has_push` alone; nothing here
  changes that.

Note the honest gap: `blocked` is derived from #7's mapping and re-implemented
here, but this run raised no approval (a `full-access` crewmate does not), so the
`blocked` arm is reasoned, not re-measured.

## Traps

- **A settling assistant message carries EMPTY text.** The text arrives on the
  `streaming: true` partials; the `streaming: false` event that marks the message
  final has `len=0`. Evidence in [`probe-events.mjs`](./probe-events.mjs):
  `role=assistant streaming=true len=410` then
  `role=assistant streaming=false len=0`. #9's "dedupe on `messageId` and settle
  on `streaming: false`" is right about identity and a trap about content — a
  mirror that appends only settled events mirrors an empty transcript. The rule
  is last-non-empty-text-wins per `messageId`. The snapshot is unaffected; it
  carries the full text with `streaming: false`.
- **HTTP dispatch has three different 400/500 failures and they look alike.**
  `400` with an **empty body** is a schema decode failure; `400` with a JSON
  `invalid_command` body is the normalizer (e.g. a `workspaceRoot` that does not
  exist); `500 orchestration_dispatch_failed` means the shape was fine and the
  engine refused (e.g. unknown thread). A backend that reports "400" without
  distinguishing them will send someone hunting the wrong bug.
- **`thread.create` requires `branch` and `worktreePath`.** They are nullable,
  not optional; omitting either is a bodyless 400.
- **`thread.turn.start` requires `runtimeMode` and `interactionMode`.**
  Refining #10, which correctly noted `modelSelection` is optional — the two mode
  fields are not, and omitting them is the same silent 400.
- **`server.getConfig` costs ~2 s** and has no HTTP route. Resolve the model
  once per spawn, never per call.
- **An archived thread and a deleted thread are both 404** on the thread
  snapshot route — which is the desirable answer for `target_exists`, and worth
  knowing before someone treats 404 as "deleted, clean up the meta".
- **The Windows temp dir survives teardown** (`EBUSY`), as #7, #9 and #10 all
  saw: the server still holds a handle after `project.delete`.

## Running it

Mint a token (PowerShell; the Electron-node requirement from #9):

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
Start-Process -FilePath "$env:LOCALAPPDATA\Programs\t3code\T3 Code (Alpha).exe" `
  -ArgumentList "$env:LOCALAPPDATA\Programs\t3code\resources\app.asar\apps\server\dist\bin.mjs", `
    'auth','session','issue','--token-only','--ttl','30d','--label','fm-shim-shape-spike' `
  -Wait -NoNewWindow -RedirectStandardOutput "$env:TEMP\fm-shim-token.txt"
```

Then:

```bash
node shim.mjs bench --token-file "$TEMP/fm-shim-token.txt" --samples 10
node shim.mjs probe-live --token-file "$TEMP/fm-shim-token.txt"   # read-only
node shim.mjs capture <thread-id> 40 --token-file …
node shim.mjs busy <thread-id> --token-file …
node shim.mjs token-info --token-file …
```

`bench` creates a throwaway project and thread, drives two turns through them and
deletes both; `--keep` leaves them in place, `--samples` sets the sample count.
`probe-live` only reads: it lists threads from the shell snapshot and GETs each
one, touching nothing.
