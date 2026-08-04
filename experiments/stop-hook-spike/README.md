# Stop-hook spike — does `Stop` fire under T3's SDK-driven turn?

Spike for [#6](https://github.com/autoprintworks/t3code/issues/6).

**Yes — on clean turn completion, once per turn, with `asyncRewake` honoured.
No on interrupt.** firstmate's zero-token supervision survives the move to T3
for the ordinary path; the one hole is the captain interrupting a crewmate.

Verified live on 2026-08-04 against the running desktop server
(`http://127.0.0.1:3773`, pid 38972, Windows 11), SDK `0.3.220`, Claude Code
`2.1.221`, model `claude-haiku-4-5`, `runtimeMode: "full-access"`.

## What was measured

Three standalone probes, each standing up a throwaway T3 project on a scratch
temp directory whose `.claude/settings.json` registers a recorder
([record.mjs](record.mjs)) that appends its stdin payload and environment as one
JSON line per invocation. Turns are driven over the orchestration websocket; the
auth plumbing is inherited from the [#3 spike](../firstmate-auth-spike/README.md).

| Probe | Boundary | Result |
| --- | --- | --- |
| [spike.mjs](spike.mjs) | two clean turns | `Stop` fired **twice**, once each |
| [spike.mjs](spike.mjs) | `thread.session.stop` | `SessionEnd`, **no** `Stop` |
| [interrupt-probe.mjs](interrupt-probe.mjs) | `thread.turn.interrupt` mid-tool | **no hook at all** |
| [async-rewake-probe.mjs](async-rewake-probe.mjs) | `asyncRewake: true`, `timeout: 28800` | fires normally |

## The payload

```jsonc
{
  "session_id": "ec97111d-e7d0-433f-a361-bd4068512ba7",
  "transcript_path": "C:\\Users\\Glyn\\.claude\\projects\\C--Users-Glyn-AppData-Local-Temp-stophook-MkNeMS\\ec97111d-….jsonl",
  "cwd": "C:\\Users\\Glyn\\AppData\\Local\\Temp\\stophook-MkNeMS",
  "prompt_id": "44662d2f-6393-4004-bb10-d0bbb4b600dd",
  "permission_mode": "bypassPermissions",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "One",
  "background_tasks": [],
  "session_crons": []
}
```

Hook environment (`SessionStart` additionally carries `CLAUDE_ENV_FILE`):

```
CLAUDE_AGENT_SDK_VERSION=0.3.220
CLAUDE_CODE_CHILD_SESSION=1
CLAUDE_CODE_ENTRYPOINT=sdk-ts
CLAUDE_CODE_SESSION_ID=ec97111d-e7d0-433f-a361-bd4068512ba7
CLAUDE_CONFIG_DIR=C:\Users\Glyn\.claude
CLAUDE_PID=63464
CLAUDE_PROJECT_DIR=C:/Users/Glyn/AppData/Local/Temp/stophook-MkNeMS
```

`permission_mode: "bypassPermissions"` is first-hand confirmation of the
`full-access` → `bypassPermissions` mapping the map records from source.

## The identification problem

**Nothing in the payload or the environment carries the T3 thread id.** In the
main run the thread was `01d1b482-c06f-40db-bdef-185d01239fda` while
`session_id` was `ec97111d-e7d0-433f-a361-bd4068512ba7` — the Claude session id,
which T3 mints separately and which also appears as `CLAUDE_CODE_SESSION_ID`.
There is no field relating the two.

So a `Stop` hook cannot answer "which crewmate am I?" from T3 at all. It has to
answer it from firstmate's own side, and the available handle is the working
directory: `cwd` / `CLAUDE_PROJECT_DIR`. Under the treehouse model every
crewmate is pinned to its own worktree, so worktree path is a unique key, and
[#8](https://github.com/autoprintworks/t3code/issues/8) already has firstmate
minting the thread id itself and recording it in `state/<id>.meta`. The reverse
lookup is worktree → task id over `state/*.meta`, which is firstmate-local and
needs no T3 patch.

This spike ran with `worktreePath: null`, so `cwd` was the project workspace
root. That worktree-pinned `cwd` is an inference from the thread contract, not
something measured here.

## Traps

- **`CLAUDE_PROJECT_DIR` is forward-slashed** (`C:/Users/…`) while the payload's
  `cwd` is backslashed (`C:\Users\…`), in the same invocation. Any hook keying
  off a path must normalise before comparing, or the worktree lookup above
  silently misses on Windows.
- **An interrupt is delivered as a tool-use rejection**, not a turn abort. The
  transcript records `The user doesn't want to proceed with this tool use`
  followed by `[Request interrupted by user for tool use]`. That is why no
  `Stop` fires: from the session's point of view the turn never ended.
- **A fast turn will fake an interrupt result.** The first attempt asked for a
  one-word refusal and interrupted six seconds later; the turn had already
  completed and its ordinary `Stop` looked like an interrupt `Stop`.
  `interrupt-probe.mjs` therefore refuses to interrupt until it has seen a
  `tool_use` in the transcript and confirmed no `Stop` has fired yet.
- **`npx t3` is not the installed server.** It resolved to a cached `t3`
  v0.0.11 whose root command is the server itself, so `auth session issue` was
  parsed as root flags and the "token" captured was a help screen. Use the
  desktop bundle: `"%LOCALAPPDATA%\Programs\t3code\T3 Code (Alpha).exe"` with
  `ELECTRON_RUN_AS_NODE=1` running
  `resources\app.asar.unpacked\apps\server\dist\bin.mjs`. Running that same
  bundle under plain `node` exits 0 and silent — it must be the Electron binary.
- **Provider models are keyed `slug`**, not `id`/`model`
  (`claude-haiku-4-5`, `claude-opus-5`, …), under
  `providers[].models[].slug` from `server.getConfig`.

## Left open

`orchestration.subscribeThread` produced **no** values through this client — the
event counter came back empty on every run, so both spikes fall back to polling
the hook log and the transcript. That is a defect in this client's handling of
the streamed `Chunk` envelope, not evidence about what T3 emits; it is
[#7](https://github.com/autoprintworks/t3code/issues/7) and
[#9](https://github.com/autoprintworks/t3code/issues/9)'s ground to cover.

## Running them

```bash
T3_TOKEN=<bearer> node spike.mjs            # ~7 min: two clean turns, then session stop
T3_TOKEN=<bearer> node interrupt-probe.mjs  # ~1 min
T3_TOKEN=<bearer> node async-rewake-probe.mjs
```

Each retains its scratch directory and leaves its T3 project in place; the
scratch path is printed on exit.
