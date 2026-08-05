# firstmate secondmate-home spike — one provider instance per `FM_HOME`

Spike for [#47](https://github.com/autoprintworks/t3code/issues/47).

**Route 1 is confirmed. A provider instance carries `FM_HOME` all the way into the agent's own
session process, on the session path and not just the status probe, with the full host environment
intact — `PATH` included.** Writing `settings.json` on a *running* server is a complete write path:
no UI, no RPC, no restart, and the registry has the new instance built and probing **224 ms** after
the write, without disturbing the instances that did not change. The `extendEnv` trap the issue
named is real in the source and dead in practice, because every driver merges the instance
environment over `process.env` before the adapter ever sees it
(`ProviderInstanceEnvironment.ts:3-16`) — so `options.environment` is never the bare `{FM_HOME}`
that would strip `PATH`.

Two findings cut against the plan, and neither kills it:

- **`enabled: false` is not a hiding place.** A disabled instance refuses to start a session
  outright (`ProviderService.ts:556-561`, measured). N secondmates therefore means N visible rails
  in the captain's model picker, and there is no other hide flag on the envelope
  (`providerInstance.ts:124-132`). The clutter is real and unavoidable; it is proportional to live
  secondmates, not to secondmates ever created.
- **A hand-written `settings.json` keeps a `sensitive: true` value in plaintext.** The
  secret-store migration runs on the `serverUpdateSettings` write path only
  (`serverSettings.ts:378-420`); the file-watch read path just materialises what it finds
  (`serverSettings.ts:316-357`). `FM_HOME` is a path so this does not bite route 1, but anything a
  secondmate instance carries that *is* a secret must go through the RPC or be accepted as
  plaintext on disk.

Measured 2026-08-05 against the installed desktop build (`t3` 0.0.31, the bundled server binary at
`resources/app.asar.unpacked/apps/server/dist/bin.mjs`), running **isolated** on
`http://127.0.0.1:3799` with its own base dir, pid 41428, Windows 11. The developer's live
`~/.t3/userdata` was never started against, written to, or opened read-write.

## Running it

Four scripts. All of them mutate only the rig's own scratch directory and its own `settings.json`;
none of them touch the developer's install.

```bash
node setup.mjs                      # rig: scratch repo, base dir, dump hook, two instances

# start the isolated server (its own base dir, its own port), then mint a token
node <bin.mjs> serve --base-dir <rig>/home --port 3799 --host 127.0.0.1 \
  --no-browser --auto-bootstrap-project-from-cwd        # run from <rig>/work
node <bin.mjs> auth session issue --base-dir <rig>/home --token-only > <rig>/token.txt

node probe-reconcile-latency.mjs    # sub-questions 1 and 2: write path, live reconcile
node probe-session-env.mjs          # sub-questions 3 and 4: the session spawn, the polled read
node probe-disabled-instance.mjs    # sub-question 5: what `enabled: false` actually does
node probe-sensitive-roundtrip.mjs  # sub-question 6: sensitive/valueRedacted
```

Origin and pid come from `<rig>/home/userdata/server-runtime.json`, the bearer token from
`<rig>/token.txt`. Override the rig location with `SPIKE_RIG`.

### The measurement trick

T3 has no way to ask a provider child what environment it received, so the rig asks the child. Both
instances are `driver: "codex"` with `config.binaryPath` pointed at `node.exe` instead of the real
codex binary, and both carry `NODE_OPTIONS=--require <rig>/dump-env.cjs` in the instance
environment. T3 spawns what it believes is codex, node runs the hook first, and the hook writes the
child's own `process.env` view to `<rig>/dumps/<tag>-<pid>.json` before the process dies. The turn
always fails — `node.exe` does not speak the codex app-server protocol — but the failure lands
*after* the spawn, which is the only part being measured.

The rig's first pass caught only the **status probe** spawn, which uses `extendEnv: true`
(`CodexProvider.ts:345`) and therefore proves nothing about the trap. The two spawns are told apart
by `cwd`: the probe inherits the server's cwd, the session gets the thread's `worktreePath`
(`checkpointing/Utils.ts:20-36`). Every session finding below comes from a dump whose `cwd` is the
thread worktree.

## 1. The write path is `settings.json`, and it is the only one

| candidate | verdict |
| --- | --- |
| `settings.json` on disk | **works** — watched with `fs.watch(settingsDir)`, 100 ms debounce (`serverSettings.ts:532-540`) |
| WebSocket RPC | exists — `serverUpdateSettings` (`ws.ts:1459`), needs a socket |
| HTTP route | **none** — `orchestration/http.ts` exposes no settings route |
| CLI subcommand | **none** — `apps/server/src/cli/config.ts` is flag definitions for `serve`, not a settings mutator |

So a shell backend that already has the bearer credential from
[#3](https://github.com/autoprintworks/t3code/issues/3)/[#28](https://github.com/autoprintworks/t3code/issues/28)
does **not** use it for this. Creating a secondmate instance is a local file write against
`<base-dir>/userdata/settings.json`, which is a different capability from the HTTP surface #28
settled, and one that only works when firstmate is on the same machine as the server.

Two rules the implementation ticket must carry:

- **Read-modify-write the whole document.** The file is one `ServerSettings` object. A writer that
  emits only `{"providerInstances": ...}` silently drops every other setting the captain has.
- **Explicit entries win.** `deriveProviderInstanceConfigMap` merges `providerInstances` over
  synthesised legacy `providers.<kind>` entries and skips the legacy mirror when an explicit entry
  claims the slot (`ProviderInstanceRegistryHydration.ts:76-101`). A secondmate instance under its
  own id never collides with the captain's default codex/claude instance.

## 2. Reconcile is live, and it is surgical

`spike_c` added to `settings.json` on the running server, timed from the write to the appearance of
that instance's own status-probe child:

| measured | value |
| --- | --- |
| write → new instance built and probing | **224 ms** |
| other instances rebuilt as a side effect | **none** |
| server restarts required | 0 |

The mechanism: a forked daemon subscribes to `ServerSettingsService.streamChanges` and calls
`reconcile` on every emission (`ProviderInstanceRegistryHydration.ts:117-132`);
`makeReconcile` closes the child scope of an instance only when its envelope fails a structural
`Equal.equals` compare (`ProviderInstanceRegistryLive.ts:94`, `:244`, `:301`). Adding, changing or
removing one secondmate instance therefore does not disturb the captain's running threads on other
instances.

Toggling `spike_b.enabled` took effect within the 6 s the probe waited, and removing `spike_c`
again was equally uneventful. Reverse states exist: add, change, disable, remove.

## 3. `FM_HOME` reaches the session process, with the environment intact

The thread was created with `modelSelection: {instanceId: "spike_a", model: "gpt-5.4"}` and a
`worktreePath` deliberately distinct from the server's cwd. Dump `a-10020.json`, `ppid` 41428
(the server itself):

| field | measured |
| --- | --- |
| `cwd` | `<rig>\sess-spike_a` — the thread's `worktreePath`, so this is the **session** spawn |
| `argv` | `node.exe`, `<worktree>\app-server`, `-c mcp_servers.t3-code.url=http://127.0.0.1:3799/mcp`, `-c mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"` |
| `FM_HOME` | `<rig>\fmhome-a` — the instance's value, verbatim |
| `hasPATH` | `true` |
| `pathLen` | 2019 |
| `envKeyCount` | 85 |
| host vars present | `USERPROFILE`, `APPDATA`, `SystemRoot`, `TEMP`, `COMSPEC` |

The `-c mcp_servers...` arguments are the tell that this is the session path and not the probe:
they are added only by `CodexAdapter.ts:1416-1427`, on the session branch. The probe child from the
same instance is `argv = [node.exe, <server cwd>\app-server]` with `envKeyCount` **84**; the session
adds exactly one key, `T3_MCP_BEARER_TOKEN`. Both counts are the host environment plus the
instance's four variables. Nothing is missing.

### The `extendEnv` trap: real in the source, neutralised one layer up

`CodexSessionRuntime.ts:736` really does read `const extendEnv = options.environment === undefined`,
so supplying an environment does set `extendEnv: false` and the child gets **only** what was
supplied (`shell.ts:580-586`). The reason that is harmless is that `options.environment` is never a
bare override map. Every driver builds it the same way:

```ts
const processEnv = mergeProviderInstanceEnvironment(environment);   // {...process.env, ...overrides}
```

| driver | merge call | passed to adapter as `environment` |
| --- | --- | --- |
| Claude | `ClaudeDriver.ts:128` | `:148` |
| Codex | `CodexDriver.ts:122` | `:160` |
| Cursor | `CursorDriver.ts:111` | `:129` |
| Grok | `GrokDriver.ts:92` | `:110` |
| OpenCode | `OpenCodeDriver.ts:122` | `:141` |

`mergeProviderInstanceEnvironment` returns `baseEnv` untouched when the instance carries no
variables and `{...baseEnv, ...overrides}` otherwise, with `baseEnv = process.env`
(`ProviderInstanceEnvironment.ts:3-16`). So the value that reaches every adapter is a full
environment either way, and replace-versus-extend stops mattering.

The five spawn sites do **not** agree on the flag, which is worth recording because a future change
to any driver's merge would break them differently:

| spawn site | semantics with an environment supplied |
| --- | --- |
| `CodexSessionRuntime.ts:736-748` | `extendEnv: false` — **replace** |
| `CodexProvider.ts:345-355` (status probe) | `extendEnv: true` — extend |
| `CursorProvider.ts:957` | `env` set, flag omitted — **replace** |
| `opencodeRuntime.ts:403`, `:466` | `env` set, `extendEnv: input.environment === undefined` — **replace** |
| `acp/AcpSessionRuntime.ts:335`, `:341` | `extendEnv: true` — extend |
| `processRunner.ts:293` | `extendEnv = input.env !== undefined` — extend |

**Measured on codex only.** This machine has codex and claudeAgent configured; cursor, grok and
opencode are not installed, so there is no runtime evidence for those three. The claim that route 1
works on all five rests on the shared `mergeProviderInstanceEnvironment` call site in each driver —
that is code evidence, not measurement, and the implementation ticket should treat a first run on
each of the other four as an open verification step rather than a formality.

### Empty values survive, which matters more than it looks

`bin/fm-spawn.sh:1878-1881` does not just set `FM_HOME`. A secondmate launch prefixes **six**
variables, five of which are deliberately empty:

```sh
FM_ROOT_OVERRIDE= FM_STATE_OVERRIDE= FM_DATA_OVERRIDE= FM_PROJECTS_OVERRIDE= \
FM_CONFIG_OVERRIDE= FM_PUBLIC_FOLLOWUP_PRIMARY_HOME=<primary home> FM_HOME=<home> <launch>
```

An instance can reproduce that exactly. `value` is `Schema.String` with a decoding default of `""`
(`providerInstance.ts:106`), and `mergeProviderInstanceEnvironment` assigns rather than deletes.
Measured on a third instance carrying `{name: "FM_ROOT_OVERRIDE", value: ""}`:

| field | measured |
| --- | --- |
| `"FM_ROOT_OVERRIDE" in process.env` | `true` |
| value | `""` |

Present-and-empty, which is what the shell prefix produces. The whole secondmate prefix is
expressible as one instance `environment` array of six entries.

## 4. The polled path is unaffected

The same run, polling `GET /api/orchestration/shell` at 500 ms:

| t | `session.status` | `session.providerInstanceId` | `modelSelection.instanceId` | `hasPendingApprovals` | `hasPendingUserInput` |
| --- | --- | --- | --- | --- | --- |
| 302 ms | *no session* | — | `spike_a` | `false` | `false` |
| 839 ms | `stopped` | `spike_a` | `spike_a` | `false` | `false` |

`session.providerInstanceId` reports the custom instance id verbatim, so
[#12](https://github.com/autoprintworks/t3code/issues/12)'s instance resolution and #28's shell
read both keep working against a secondmate instance with no change. `hasPendingApprovals` and
`hasPendingUserInput` are untouched by the instance choice, and the pre-session `session: null` gap
#28 recorded reproduces here exactly (302 ms in, before the spawn).

`session.status` went `null → stopped` rather than `starting → running → ready` because the fake
binary exits immediately; `lastError` carried
`ProviderAdapterProcessError ... Codex App Server process exited with code 1`, which is the
post-spawn failure the rig wants. The busy-state mapping #28 settled needs no amendment: the
vocabulary is the same and the instance id is orthogonal to it.

## 5. `enabled: false` blocks the session, so the picker clutter is unavoidable

`spike_b` flipped to `enabled: false` by file write, 6 s to reconcile, then driven the same way as
`spike_a`:

| step | result |
| --- | --- |
| `thread.create` pinned to the disabled instance | **`200`** — accepted |
| `thread.turn.start` | **`200`** — accepted (the dispatch receipt lies, as #28 warned) |
| `session.status` | `error` |
| `session.lastError` | `ProviderValidationError: Provider validation failed in ProviderService.startSession: Provider instance 'spike_b' is disabled in T3 Code settings.` |
| child processes spawned | **none** |

The guard is `ProviderService.ts:556-561`, on `startSession`, ahead of the driver — so it is
**driver-agnostic** and applies to all five equally. It is not the codex-specific disabled
early-return at `CodexProvider.ts:441` and `:527`, which only shapes the status snapshot.

Consequences for the captain's surfaces:

- The picker rail filters on `enabled` alone (`apps/web/src/providerInstances.ts:78-80`, consumed at
  `ModelPickerContent.tsx:251-252`), so every secondmate instance is visible, and `enabled: false`
  buys hiding at the cost of the instance being unusable. The envelope has no other flag —
  `driver`, `displayName`, `accentColor`, `environment`, `enabled`, `config`
  (`providerInstance.ts:124-132`).
- The clutter is one rail per **live** secondmate, and firstmate can delete the instance when the
  home is retired (removal reconciles as cleanly as addition, section 2). It is not one rail per
  secondmate ever created.
- `displayName` and `accentColor` are on the envelope, so the rails can at least be named after the
  secondmate and coloured as a group.

Not disqualifying, but it is a real cost and the captain should be told about it rather than
discovering N new entries in the picker.

## 6. `sensitive` is not in the way, and its absence is the interesting half

`FM_HOME` is non-sensitive and round-trips unredacted — that is what every dump in section 3 shows.
`redactProviderEnvironmentVariable` only strips the `valueRedacted` key for non-sensitive variables
and never touches `value` (`serverSettings.ts:86-98`); redaction applies to the **client** view
(`redactServerSettingsForClient`, `:100-112`), not to the child.

The reverse case, measured by adding `{name: "SPIKE_SECRET", value: "s3cret-value-0047",
sensitive: true}` to `spike_a` by direct file write:

| observation | measured |
| --- | --- |
| value in `settings.json` after reconcile | `"s3cret-value-0047"` — **unchanged, plaintext** |
| value seen by the session child | `s3cret-value-0047` |
| moved to the secret store | no |

Because the secret-store migration lives in `persistProviderEnvironmentSecrets`
(`serverSettings.ts:378-420`), which runs on the `serverUpdateSettings` write path. The file-watch
read path runs `materializeProviderEnvironmentSecrets` (`:316-357`), which only *reads* the secret
store, and only for variables already marked `sensitive: true` **and** `valueRedacted: true`. A
hand-written sensitive value with no `valueRedacted` is passed straight through.

Two notes for the ticket. If the captain later saves anything from the settings UI, that write path
runs across every instance and will migrate a `sensitive` secondmate variable into the secret store
and blank it in the file — the value keeps working, but firstmate's own copy of `settings.json`
stops being the source of truth for it. Non-sensitive variables are explicitly `remove`d from the
secret store and written verbatim (`serverSettings.ts:388-407`), so `FM_HOME` is stable under that
same write.

## 7. Where the secondmate home goes

`bin/fm-spawn.sh:1878-1881` sets `FM_HOME=$PROJ_ABS` — on the shell backends the secondmate's home
**is** its project directory. Copying that onto T3 would mean `FM_HOME == worktreePath`, and that
is the one arrangement to avoid:

- The session's `cwd` **is** the thread's `worktreePath` (measured, section 3;
  `checkpointing/Utils.ts:20-36`, falling back to the project's `workspaceRoot`).
- That same path is what checkpointing treats as the git working tree
  (`CheckpointReactor.ts:586-595`). Every turn ends with a checkpoint against it.

So a home placed *inside* `worktreePath` puts firstmate's state, tasks and secrets inside a tree T3
snapshots into hidden git refs after every turn, and inside the diff the captain reviews. The home
should sit **beside** the worktree — a sibling directory the instance names via `FM_HOME`, with the
thread's `worktreePath` pointing at the repo the secondmate works in, exactly as it does for a
crewmate. Nothing in T3 needs to know the home exists; only the instance environment mentions it.

This also means the two paths are independent knobs, which is the arrangement firstmate wants
anyway: one secondmate home can outlive any number of threads and worktrees.

## 8. The harness pin and the instance driver can diverge, silently

`config/secondmate-harness` resolves through a fallback chain — the file's first token, else
`config/crew-harness`, else the primary's own harness (`bin/fm-harness.sh:120-129` in
`C:\00_AI_Development\firstmate-claude-code`). The file is **absent** on this machine, so today the
pin defers to the crew harness.

On this backend the pin and the driver are two independent registries answering the same question:

| | names | read when |
| --- | --- | --- |
| `config/secondmate-harness` | a firstmate harness (`claude`, `codex`, `opencode`, `grok`, ...) | every spawn |
| `ProviderInstanceConfig.driver` | a T3 driver (`claude`, `codex`, `cursor`, `grok`, `opencode`) | instance creation, fixed thereafter |

They can diverge, and nothing catches it: the instance's driver is baked in at creation and
`ProviderService.startSession` validates only that the requested driver matches the *instance's*
driver, not that either matches any firstmate pin (`ProviderService.ts:542-550`). Change the pin
after a secondmate home exists and its threads keep launching the old driver.

The cheap fix, for the implementation ticket: derive the instance's `driver` from the resolved
secondmate harness at creation time, record the resolved harness alongside the home, and on every
spawn compare it to the instance's `driver` — rebuild the instance (224 ms, section 2) or refuse,
rather than launching a mismatch. Do not try to mutate the driver on a live instance.

## 9. Route 2 is ruled out: it is claude and nothing else

Confirmed as the issue read it. `ClaudeAdapter.ts:3529` passes
`settingSources: [...CLAUDE_SETTING_SOURCES]`, and that constant is
`["user", "project", "local"]` (`ClaudeAdapter.ts:884-888`) — the opt-in that makes a worktree-local
`.claude/settings.json` with an `env` block reach the agent.

`settingSources` appears in exactly four files in the server, all claude:
`ClaudeAdapter.ts`, `ClaudeProvider.ts` and their tests. `CodexAdapter.ts`, `CursorAdapter.ts`,
`GrokAdapter.ts` and `OpenCodeAdapter.ts` contain **zero** occurrences and have no analogous
opt-in — nothing in those four adapters reads a worktree-local settings file that sets the agent
process's own environment. Codex's nearest equivalent is `config.toml` under `CODEX_HOME`, which is
home-global rather than worktree-local, and which T3 already overwrites per instance
(`CodexSessionRuntime.ts:731-735`).

Route 2 would deliver `FM_HOME` on one provider out of five. The map's standing rule is every
provider, and route 1 clears that bar, so route 2 is not needed even as a fallback.

## 10. Route 3 is ruled out on cost: 26 sites and a migration, for nothing route 1 does not give

Costed, not built. A per-thread `env` on `thread.create` has to travel the same road `worktreePath`
travels, because `worktreePath` is the closest existing analogue — a per-thread string that reaches
the adapter's session start.

| layer | file | sites |
| --- | --- | --- |
| contract, command | `packages/contracts/src/orchestration.ts:554-568` | 1 |
| contract, event payload | `orchestration.ts:362` | 1 |
| contract, read models | `orchestration.ts:420`, `:666`, `:976` | 3 |
| contract, update shapes | `orchestration.ts:634`, `:1038` | 2 |
| contract, session start | `packages/contracts/src/provider.ts:53-64` | 1 |
| decider | `apps/server/src/orchestration/decider.ts:374`, `:685` | 2 |
| projector | `apps/server/src/orchestration/projector.ts:288`, `:410` | 2 |
| persistence | `persistence/Layers/ProjectionThreads.ts:41`, `:66`, `:91`, `:123`, `:157` | 5 |
| projection queries | `orchestration/Layers/ProjectionSnapshotQuery.ts:381`, `:415`, `:451`, `:864`, `:904`, `:1069` | 6 |
| **migration** | new `persistence/Migrations/036_*.ts` (latest today is `035_ProjectionThreadTitleRegeneration.ts`) | 1 file |
| reactor | `orchestration/Layers/ProviderCommandReactor.ts:559` | 1 |
| provider service | `provider/Layers/ProviderService.ts:522-606` | 1 |
| adapter session start ×5 | `ClaudeAdapter.ts:3139`, `CodexAdapter.ts:1377`, `CursorAdapter.ts:479`, `GrokAdapter.ts:530`, `OpenCodeAdapter.ts:1187` | 5 |
| spawn merge ×3 | `CodexSessionRuntime.ts:733`, `CursorProvider.ts:957`, `opencodeRuntime.ts:403` | 3 |
| client command builder | `packages/client-runtime/src/operations/commands.ts:124` | 1 |

**26 code sites plus one schema migration**, before tests, before the web and mobile surfaces that
would need a way to see and set the field, and before deciding what a per-thread `env` means for the
[#46](https://github.com/autoprintworks/t3code/issues/46) zero-change rule. The client cost is at
least low — `thread.create` is built in one place (`commands.ts:124`) for web and mobile both.

The issue was right that route 3 is *uniform* rather than five different patches, and it would be
the correct answer if route 1 had died. It did not. Route 3 buys one thing route 1 does not have —
a home per *thread* rather than per *instance* — and firstmate does not want that, because a
secondmate home is deliberately shared across all of that secondmate's threads.

## Verdict

| route | verdict |
| --- | --- |
| 1 — one provider instance per secondmate home | **confirmed**, measured end to end on the session path |
| 2 — worktree-local agent settings file with `env` | ruled out: claude-only, `settingSources` exists in no other adapter |
| 3 — per-thread `env` on `thread.create` | ruled out: 26 sites plus a migration, and the wrong granularity |

What the implementation ticket inherits:

- **Write path.** Read-modify-write `<base-dir>/userdata/settings.json`, add one
  `providerInstances.<id>` envelope per live secondmate home. No RPC, no HTTP, no CLI. Local only.
- **Reconcile.** Live, 224 ms, surgical — other instances are not rebuilt
  (`ProviderInstanceRegistryHydration.ts:117-132`, `ProviderInstanceRegistryLive.ts:301`).
- **`extendEnv`.** Do not supply a bare override map anywhere below the driver. The envelope's
  `environment` is safe because every driver merges it over `process.env` first
  (`ProviderInstanceEnvironment.ts:3-16`); the session spawn itself replaces rather than extends
  (`CodexSessionRuntime.ts:736`), as do cursor and opencode, so that merge is load-bearing.
- **The environment to set.** All six variables from `bin/fm-spawn.sh:1878-1881`, empty values
  included — empty round-trips as present-and-empty.
- **Home location.** Beside the worktree, never inside it: `worktreePath` is the session cwd and the
  checkpointed git tree.
- **Picker.** One visible rail per live secondmate. `enabled: false` is not a hiding place; it
  refuses `startSession` outright. Delete the instance when the home is retired.
- **Harness pin.** Compare the resolved `config/secondmate-harness` against the instance's `driver`
  at every spawn and rebuild or refuse; nothing in T3 catches the divergence.
- **Not measured.** cursor, grok and opencode are not installed on this machine. Their behaviour is
  read from the identical `mergeProviderInstanceEnvironment` call in each driver — code evidence,
  not runtime evidence.
