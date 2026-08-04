# firstmate auth spike — how a local script authenticates to a running T3 server

Spike for [#3](https://github.com/autoprintworks/t3code/issues/3).

**No T3 patch is needed.** A shipped CLI command mints a long-lived bearer
token straight into the server's state directory, and `/ws` already accepts it.

Verified end to end against a live desktop server (`t3` 0.0.31,
`http://127.0.0.1:3773`, Windows 11). Verbatim transcript of the re-run on
2026-08-03T23:32Z:

```
[discover] C:\Users\Glyn\.t3\userdata\server-runtime.json -> http://127.0.0.1:3773 (pid 38972)
[token] subject=cli-issued-session scopes=orchestration:read,orchestration:operate,terminal:operate,review:write,relay:read,access:read,access:write,relay:write expires=2026-09-02T23:31:37.953Z
[ticket] expires=2026-08-03T23:37:31.946Z
[ws] connected and authenticated
[dispatch] project.create receipt: {"sequence":356}
[dispatch] project.delete receipt: {"sequence":357}
[done] authenticated, dispatched, received receipts
```

The token expiry above is 30 days out, matching `--ttl 30d`. An earlier draft of
this file recorded a same-day expiry, which no code path produces — treat that
sample as unfaithful and this one as the transcript.

## The mechanism

`t3 auth session issue` ([apps/server/src/cli/auth.ts:162](../../apps/server/src/cli/auth.ts)).
It does not talk to the running server at all — it opens the same SQLite state
directory and writes a session row, exactly the way `t3 pair` mints a pairing
grant ([apps/server/src/cli/pair.ts:435](../../apps/server/src/cli/pair.ts)).
The only prerequisite is filesystem access to the T3 home the server uses. No
browser, no existing session, no bootstrap token.

```bash
npx t3 auth session issue --ttl 30d --label firstmate --token-only
```

It grants `AuthAdministrativeScopes` — standard client scopes plus
`access:read`/`access:write`/`relay:write`
([packages/contracts/src/auth.ts:105](../../packages/contracts/src/auth.ts)).
`orchestration:operate` is included, which is what `dispatchCommand` needs.

The two-step alternative, when you want ordinary client scopes rather than
administrative ones: `t3 auth pairing create` (or `t3 pair`, on `main` but not
in 0.0.31) mints a one-time pairing credential, then
`POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
exchanges it for the same kind of bearer token
([apps/server/src/auth/http.ts:254](../../apps/server/src/auth/http.ts)).
The pairing credential defaults to a 5-minute TTL
([PairingGrantStore.ts:241](../../apps/server/src/auth/PairingGrantStore.ts)),
so it is a handoff, not a stored credential.

## Where the credential is read from, and how long it lives

**Nothing is written to disk for you.** The CLI prints the token once; the
server stores only the session row, and the token itself is a signed envelope
(HMAC keyed from `<T3 home>/userdata/secrets`) that is never persisted. The
helper owns persistence — an env var, a mode-0600 file, an OS keychain.

- Session row: `<T3 home>/userdata/state.sqlite`. `T3 home` is `$T3CODE_HOME`
  or `~/.t3`.
- Server origin: `<T3 home>/userdata/server-runtime.json` — `pid`, `port`,
  `origin`, written on startup and cleared on shutdown. This is how the spike
  discovers the port rather than assuming 3773.
- Default lifetime: **30 days** (`DEFAULT_SESSION_TTL`,
  [SessionStore.ts:403](../../apps/server/src/auth/SessionStore.ts)), settable
  with `--ttl`.

**It survives both a T3 restart and a machine reboot.** The row is in SQLite
and validity is a signature check plus a not-revoked/not-expired lookup, with
no server-memory component. Evidence beyond reading the code: `t3 auth session
list`, run from a process that is not the server, shows desktop sessions issued
on 2026-08-02 still active on 2026-08-03 across several desktop restarts.
Revoke with `t3 auth session revoke <sessionId>`.

## Getting the token onto the WebSocket

`/ws` authenticates via
[`authenticateWebSocketUpgrade`](../../apps/server/src/auth/EnvironmentAuth.ts):
`?wsTicket=`, else session cookie, else `Authorization: Bearer`, else
`Authorization: DPoP`.

There is no `?token=` mechanism — issue #3 says there is, but the only
`?token=` in the codebase is the pairing-URL parameter the mobile client reads
([apps/mobile/src/features/connection/pairing.ts:61](../../apps/mobile/src/features/connection/pairing.ts)),
which is a pairing credential for the `/pair` page, not a WebSocket credential.

A Python or Node helper whose WebSocket client supports request headers should
just send `Authorization: Bearer <token>` and skip the ticket. Node's built-in
`WebSocket` cannot set headers — the same constraint a browser has, and the
reason the ticket endpoint exists — so this spike uses the ticket path:

```
POST /api/auth/websocket-ticket   Authorization: Bearer <token>
  -> { ticket, expiresAt }        # 5-minute TTL, single connection
GET  /ws?wsTicket=<ticket>
```

## Wire format

`RpcSerialization.layerJson`: one JSON message per WebSocket frame, no framing
of its own. Requests and responses are Effect RPC envelopes.

```jsonc
// client -> server
{"_tag":"Request","id":"1","tag":"orchestration.dispatchCommand","payload":{…},"headers":[]}
// server -> client
{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success","value":{"sequence":51}}}
```

A frame may carry a bare object or an array of them, so decode defensively.
Failures come back as `{"_tag":"Failure","cause":[…]}` inside the same `Exit`.

## Running it

```bash
T3_TOKEN=$(npx t3 auth session issue --ttl 30d --label firstmate --token-only) \
  node experiments/firstmate-auth-spike/spike.mjs
```

The spike creates a throwaway project and deletes it, printing the dispatch
receipt for each.

### Traps

- **One active project per workspace root.** `project.create` against a root
  that already has an active project fails with
  `OrchestrationCommandInvariantError`, *after* a successful authentication —
  so it reads like an auth failure and is not one. The spike originally passed
  `process.cwd()` and broke as soon as this repo was opened in the GUI; it now
  mints a fresh temp dir. A firstmate backend binding one T3 project per
  firstmate project (issue #8) has to treat "already exists" as success and
  reuse the existing project, not as an error.
- **`--label` is the client name**, not a separate field: the session shows up
  in `t3 auth session list` as `client: firstmate-reverify | bot`.
- `last connected` is maintained per session, so the store is a usable liveness
  signal for reconciliation.
- The desktop process is named **`T3 Code (Alpha)`**, not `t3code` —
  `Get-Process -Name t3code` finds nothing while the server is running fine.
  Prefer `server-runtime.json` plus a port check over process-name matching.

### Windows notes

Two things cost real time here and will cost the firstmate backend the same:

- The desktop install ships the server bundle, so no npm is needed:
  `%LOCALAPPDATA%\Programs\t3code\resources\app.asar.unpacked\apps\server\dist\bin.mjs`
  run under `ELECTRON_RUN_AS_NODE=1` with the app's own `.exe`. But that `.exe`
  is a GUI-subsystem binary: it writes nothing to an inherited console.
  Redirect stdout to a file (`Start-Process -RedirectStandardOutput`) and read
  it back.
- Under Git Bash the CLI produces no output at all, whether piped or redirected
  — every invocation exits 0 and silent, including `--help`. PowerShell works.
  Do not conclude a command failed because Git Bash showed nothing.
