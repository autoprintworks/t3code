# The `fm` provider: a fork delta

This document is the inventory of one thing: everything the `autoprintworks`
fork adds to T3 Code so that **First Mate** appears as a provider. It exists so
a future merge from upstream can see, in one place, exactly which lines are
ours.

Nothing here is upstream. If you are reading this in a repository that is not
the fork, the whole feature should be absent.

## What the provider is

`fm` drives the **ACP door**, `fm-acp`, a Rust binary in the First Mate
repository. The door speaks the Agent Client Protocol over stdio: ndjson
JSON-RPC 2.0, protocol version 1.

The mapping is deliberately narrow:

- One provider connection is one **First Mate home**.
- Opening the `fm` provider on a home shows that home's **first mate** as a
  thread. The thread _is_ the home's supervisor conversation.
- A second mate is the same mechanism pointed at a second-mate home. There is
  no special case for it: a different home path means a different provider
  instance, which means a different door process.
- The ACP session id is derived from the home path, so a Desktop restart
  reattaches with `session/load` rather than starting a second first mate.

The door serves exactly one home per process, chosen with `--home <dir>`, and
defaults to `FM_V2_HOME`, then `~/.firstmate/v2`.

## Where the code lives

Almost all of it is in one directory, on purpose.

### New: `apps/server/src/provider/fm/`

| File                             | What it is                                                                                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FmDriver.ts`                    | The `ProviderDriver` registration. This is the file `builtInDrivers.ts` imports.                                                                                                                                        |
| `FmAdapter.ts`                   | The adapter: sessions, turns, cancel, resume, model selection, notification fan-out.                                                                                                                                    |
| `FmAcpSupport.ts`                | The spawn contract and the small pure helpers around it (argv, client capabilities, model id resolution), plus the door-exit handle the adapter watches.                                                                |
| `FmHome.ts`                      | Which home this instance serves: the door's own resolution order, `~` expanded, and a normalised key for the claim below.                                                                                               |
| `FmProvider.ts`                  | Provider status and model discovery, including `checkFmProviderStatus`.                                                                                                                                                 |
| `FmTextGeneration.ts`            | Refuses commit messages, PR text, branch names and thread titles. See below.                                                                                                                                            |
| `FmWorkerSessions.ts`            | Worker sessions, pure: thread ids, titles, message ids, and the reconcile that turns one `session/list` roster into appeared/disappeared.                                                                               |
| `FmWorkerThreadReactor.ts`       | Turns those observations into orchestration commands: create the read-only thread, write its text, archive it when the worker is gone.                                                                                  |
| `FmWorkerThreadQuery.ts`         | The two narrow reads the reactor needs, both with a `LIMIT`: this home's live worker thread ids, and the assistant message ids a thread already holds.                                                                  |
| `FmTranscriptDoor.ts`            | Test-only. A fake door built from a golden transcript, served over a `ChildProcessSpawner` stub. Also hosts `watchProviderEvents`, shared by both suites. `silentMethods` makes it accept a method and never answer it. |
| `FmAcpSupport.test.ts`           | The spawn contract: the argv the driver would hand the operating system.                                                                                                                                                |
| `FmAdapter.test.ts`              | Behaviour the transcripts cannot record: local refusals, the idle-cancel guard, the `session/load` replay guard, and the three session-end paths.                                                                       |
| `FmHome.test.ts`                 | Home resolution, including the tilde a user is invited to type into the settings placeholder.                                                                                                                           |
| `FmDriver.test.ts`               | The one-instance-per-home claim, and that a fleet of mates on separate homes is still allowed.                                                                                                                          |
| `FmProvider.test.ts`             | What a failed discovery probe tells the user: the door's own words, and the home it tried.                                                                                                                              |
| `FmTextGeneration.test.ts`       | The four refusals, and the declaration-order invariant that keeps `fm` the fallback of last resort.                                                                                                                     |
| `FmTranscript.test.ts`           | The certification suite. One test per golden transcript.                                                                                                                                                                |
| `FmWorkerSessions.test.ts`       | The pure layer: id shaping, title fallback, reconcile against a known set rather than the previous poll.                                                                                                                |
| `FmWorkerThreadReactor.test.ts`  | Thread lifecycle: create, adopt, unarchive, the startup sweep, the terminal load failure, and that a replay writes nothing twice.                                                                                       |
| `FmWorkerDoor.test.ts`           | The poll against a real fake door: a hung `session/load` does not stop the pump, a worker can vanish mid-load, and nothing is asked while nobody watches.                                                               |
| `fixtures/acp-transcript/*.json` | The ten golden transcripts, vendored **verbatim** from the First Mate repository, plus `DOOR-README.md`.                                                                                                                |

### Modified: small, marked edits elsewhere

Every one of these carries a `FORK DELTA (fm provider)` comment at the edit
site, so `grep -rn "FORK DELTA (fm provider)"` finds the complete set.

| File                                                     | Edit                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/server/src/provider/builtInDrivers.ts`             | Registers `FmDriver` and adds `FmDriverEnv` to the env union.                    |
| `packages/contracts/src/settings.ts`                     | Adds `FmSettings`.                                                               |
| `packages/contracts/src/model.ts`                        | Adds the driver kind's default model (`claude`) and display name (`First Mate`). |
| `apps/web/src/components/Icons.tsx`                      | The `fm` icon.                                                                   |
| `apps/web/src/components/chat/providerIconUtils.ts`      | Maps the driver kind to that icon.                                               |
| `apps/web/src/components/settings/providerDriverMeta.ts` | The Settings entry.                                                              |
| `apps/web/src/session-logic.ts`                          | Includes `fm` in the agent picker.                                               |
| `apps/mobile/src/components/ProviderIcon.tsx`            | The mobile icon.                                                                 |

Worker threads (see [fm-worker-threads.md](./fm-worker-threads.md)) add a
second, larger set. All of it hangs off one field, `readOnly` on a thread.

| File                                                                          | Edit                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/orchestration.ts`                                     | `readOnly` on the thread, the shell and `ThreadCreatedPayload`; splits `ClientThreadCreateCommand` off so a client cannot send it.                      |
| `apps/server/src/orchestration/commandInvariants.ts`                          | `requireThreadPromptable`.                                                                                                                              |
| `apps/server/src/orchestration/decider.ts`                                    | Uses it for `thread.turn.start` and `thread.checkpoint.revert`, and carries `readOnly` into the created event.                                          |
| `apps/server/src/orchestration/projector.ts`                                  | Carries `readOnly` onto the in-memory thread.                                                                                                           |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`                  | Writes it as 0/1.                                                                                                                                       |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`             | Selects `read_only` and maps it back to a boolean.                                                                                                      |
| `apps/server/src/persistence/ForkMigrations.ts`                               | Registers fork migration 5.                                                                                                                             |
| `apps/server/src/persistence/ForkMigrations/005_ProjectionThreadsReadOnly.ts` | The column, `NOT NULL DEFAULT 0`.                                                                                                                       |
| `apps/server/src/persistence/Layers/ProjectionThreads.ts`                     | `read_only` in the insert, the conflict update and the selects.                                                                                         |
| `apps/server/src/persistence/Services/ProjectionThreads.ts`                   | `readOnly` on the row schema.                                                                                                                           |
| `apps/server/src/server.ts`                                                   | Wires `FmWorkerThreadQueryLive` and the worker-thread reactor.                                                                                          |
| `apps/web/src/components/ChatView.tsx`                                        | One prop on the composer overlay, and the measurement reset when it goes.                                                                               |
| `apps/web/src/components/chat/ChatComposerOverlay.tsx`                        | New. The composer's positioning shell, extracted so the read-only case is one prop rather than a conditional wrapped around 180 lines of unchanged JSX. |
| `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`                     | The same decision on mobile, plus the inset the missing composer frees.                                                                                 |
| `apps/server/scripts/bench-fm-worker-poll.ts`                                 | New. The real-clock measurement harness for the poll.                                                                                                   |
| `apps/server/scripts/fm-worker-poll-door.mjs`                                 | New. A dependency-free stand-in door for that harness.                                                                                                  |

Three test files change by one fixture line each and carry no marker, because
there is no edit there to find, only a new field on an existing expectation:
`ProjectionSnapshotQuery.test.ts`, `ForkMigrations.test.ts` and
`ProjectionRepositories.test.ts`.

### New: peer sessions, in the shared ACP layer

Two files sit in `apps/server/src/provider/acp/` rather than `provider/fm/`,
because what they implement is a protocol feature rather than a First Mate one:
ACP allows several sessions on one connection, and `session/list` is how a
client learns about the ones it did not open. They are still marked as fork
delta - nothing upstream asks for them, and `fm` is the only caller.

| File                                                   | Edit                                                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/provider/acp/AcpPeerSessions.ts`      | New. Pure: capability reading, dropping the connection's own session, diffing two answers.                   |
| `apps/server/src/provider/acp/AcpPeerSessions.test.ts` | New. Those rules, asserted with no door.                                                                     |
| `apps/server/src/provider/acp/AcpSessionRuntime.ts`    | The opt-in `peerSessions` option, the latch-gated poll fiber, `subscribePeerSessions` and `loadPeerSession`. |

The gate is the part worth knowing. The poll parks on a `Latch` that the first
subscriber opens and the last subscriber's scope closes, so a runtime nobody is
watching sends no `session/list` at all, whatever the door advertises.

### Modified: shared ACP layer, not marked as fork delta

Two edits in `packages/effect-acp/src/protocol.ts` are **not** marked as fork
delta, because they are not fork-specific. They are defects in the shared ACP
transport that only a real, non-Effect ACP agent exposes. Every ACP-backed
provider in this repository benefits from them.

1. **A plain JSON-RPC error arrived as a defect.** Effect's ndjson JSON-RPC
   decoder only recognises a failure it encoded itself, which carries
   `_tag: "Cause"` beside the code and the message. A conforming agent answers
   with the `{code, message, data}` that JSON-RPC 2.0 specifies, and the
   decoder filed that under `Die`. The agent's own refusal then reached callers
   as a defect and `AcpRequestError` was never built.
   `normalizeProtocolFailure` rewrites an unrecognised `Die` back into a `Fail`
   wherever it sits in the decoded cause. Two tests in `protocol.test.ts` cover
   it: one for the plain error a non-Effect agent sends, one for an error
   buried in a cause of more than one entry.

2. **Notifications were written with an `id`.** The transport uses `id: ""` as
   its internal sentinel for a notification, but Effect's encoder has no notion
   of one and wrote `"id": ""` on the wire. A strict agent reads that as a
   request, owes an answer for it, and may act on the message a second time.
   `offerOutgoing` now encodes a notification by hand, with no `id` field at
   all, which is what JSON-RPC 2.0 says a notification is.

The second one is not cosmetic. The door reads stdin on its own thread and
flips a cancel switch in wire order; its main loop deliberately drops
notifications, because acting on one again there would be a second writer. A
`session/cancel` carrying an `id` is dispatched twice, and the second dispatch
lands in the queue behind the live prompt, where it would stop the _next_
prompt. The door's own suite guards against exactly that, in a test named
`a_cancel_left_in_the_queue_cannot_stop_the_prompt_that_followed_it`.

The repository's own mock ACP agent hid both defects, because it is built on
`effect-acp` and so speaks the encoder's dialect back at it.

## Decisions worth knowing

### Workers are read-only threads

A First Mate delegates, and each crewmate is another live session on the same
door. Those sessions are projected as read-only threads so a user can watch
them. The design, the identity rules, and the wall-clock measurements that
prove the poll does not slow the editor are in
[fm-worker-threads.md](./fm-worker-threads.md).

### Text generation is refused, not faked

Every other driver writes commit messages and thread titles by prompting its
own agent, which is cheap because that agent is stateless. The door is not.
One provider connection is one home's supervisor conversation, and
`session/prompt` is what allocates it. Asking the first mate to name a branch
would put "write me a commit message" into the user's real supervisor history,
and it would take a place in the single-prompt-at-a-time queue that the user's
actual turn is waiting in.

So `FmTextGeneration.ts` fails these four operations with a message that names
the alternative: pick another provider for generated text in Settings.

That interacts with one piece of upstream behaviour. When no text generation
model is selected, `fallbackTextGenerationProvider` in
`apps/server/src/serverSettings.ts` takes the **first enabled** provider in the
declaration order of `ServerSettings.providers`. So `fm` is declared last in
that struct. Any other enabled provider is a better fallback than one that
refuses. A user whose only enabled provider is `fm` still gets the refusal, and
the refusal says what to do about it.

### `fm` ships disabled

`FmSettings.enabled` decodes to `false` when absent, unlike `opencode`, which
defaults to on. The door is not something a typical T3 Code user has
installed, and a provider that appears in the picker and then fails to spawn is
worse than one the user turns on deliberately.

### No filesystem, no terminal

`FM_CLIENT_CAPABILITIES` declares `fs.readTextFile`, `fs.writeTextFile` and
`terminal` all false, and `FM_MCP_SERVERS` is empty. The supervisor
conversation is text in, text out. Advertising a capability would invite a
future door revision to use it, and the golden transcripts would not catch
that. `FmAcpSupport.test.ts` pins this as an invariant rather than leaving it
implied.

### Model ids are opaque

The driver never interprets a model id. It reads the door's menu from
`session/new`, sends the id back unchanged, and lets the door refuse an unknown
one with its own words and its own menu. A home's model list is that home's
business.

That is why the driver ships **no** built-in model list and **no** fallback
model id. `resolveFmModelId` trims and answers `undefined` rather than naming a
model the door never offered, and the snapshot's built-in list is empty, the
way `OpenCodeProvider` ships its own. Until the discovery probe answers, the
snapshot's "Checking the First Mate ACP door..." message is the discovering
state; when the probe fails the snapshot is `error`, and there is no session to
pick a model for anyway.

One placeholder does survive, in `DEFAULT_MODEL_BY_PROVIDER`. That table is the
composer's starting point for a driver kind, and its miss case is Codex's
default model, which the door would certainly refuse. `claude` is at least the
model a fresh First Mate home runs on.

### One instance per home

`supportsMultipleInstances` is `true`, and that is about homes: one instance per
home is exactly how a fleet of mates is expressed. Two instances on the **same**
home is the one shape that is refused, in `claimFmHome` in `FmDriver.ts`.

The refusal belongs on this side. First Mate's own turn runner stops the
existing process tree only when the unit has no live turn, and takes no lock
against a second concurrent `POST /turns`, so two doors prompting one home start
two harnesses against one conversation. Nothing on the First Mate side refuses
that. Two empty configs both resolve to the same default home, so this is not a
theoretical shape.

The claim is at instance level, not session level. Two concurrent sessions from
one instance on one home are legitimate, and the `daemon-not-there` certification
case depends on it.

### A door that exits on its own

Nothing else notices. The ACP runtime keeps the child handle to itself and its
event queue is not shut down when the process dies, so before this the session
sat `ready` forever and a live turn spun with no terminal event.
`makeFmAcpRuntime` wraps the injected `ChildProcessSpawner` to capture the
handle on the way through, exposes `awaitDoorExit`, and the adapter forks a
watcher on it. An unexpected exit settles the live turn `failed`, emits
`runtime.error`, and emits `session.exited` with `exitKind: "error"`.

The watcher is forked into the **adapter** scope, not the session scope, because
its job is to close the session scope; forked into it, it would interrupt itself
half way through the teardown.

## Certification

`FmTranscript.test.ts` is the certification suite, and it is automated: `vp
test run apps/server/src/provider/fm`.

The transcripts are the door's specification _and_ its own regression suite,
vendored byte for byte. The recorded `door` array is replayed at the real
`FmAdapter` through a `ChildProcessSpawner` stub, so what is certified is this
driver against the door's recording, not against a mock written to agree with
it. The spawn is the only layer the stub replaces, and `FmAcpSupport.test.ts`
covers that.

Two rules are borrowed from the door's own `tests/transcript.rs`:

1. Every fixture must be named by the suite's `CASES` table, and a test asserts
   that the table and the directory agree. A fixture nothing drives certifies
   nothing, and a transcript added upstream fails that test until it is driven.
2. A case that cannot be driven end to end is marked `proof: "partial"` with
   the reason in the table. That is not a softer pass: it names the exchange
   the driver cannot provoke, and everything else in the file is still driven.

Two cases are currently partial, both because the driver is _more_ conformant
than the recording it is being checked against:

- `cancel-as-a-request` records the cancel sent as a request. This driver sends
  the notification that ACP specifies, so the recorded acknowledgement is
  consumed without a reply. The cancelled prompt answer is still driven.
- `protocol-refusals` records ten probes. Seven cannot leave this driver at
  all: a bare integer, a request with no method, protocol version 0, a
  `session/new` before `initialize`, an MCP server, an image prompt and a
  whitespace prompt are refused or unrepresentable before the wire. The three
  the driver can send are driven here; the local refusals are asserted in
  `FmAdapter.test.ts`.

Cancel is driven against a prompt that is genuinely still in flight. A fixture
whose supervisor sets `awaits_interrupt` makes the fake door withhold the
prompt answer until a real `session/cancel` line arrives, and the test waits
for the door's first streamed chunk before interrupting. A cancel test that
fires before the prompt is really running proves nothing.

## Keeping the fixtures honest

The fixtures are a copy. If the First Mate repository blesses new door
behaviour, the copy goes stale silently.

The suite can be told. Point `FM_ACP_FIXTURES_DIR` at a First Mate checkout's
`fixtures/acp-transcript` directory and `matches the door's own fixtures when a
checkout is pointed at` compares the two byte for byte, ignoring line endings,
and names every file that differs:

```
FM_ACP_FIXTURES_DIR=/path/to/firstmate/fixtures/acp-transcript \
  vp test run apps/server/src/provider/fm
```

Unset, that test is a no-op. Most machines have no First Mate checkout, and a
suite that required one could not run in CI. Re-vendor the directory verbatim
when it reports drift; the `names every golden transcript` test then fails
until every new file is named in `CASES` and driven.

Do not edit a fixture to make a test pass. A transcript that disagrees with
this driver means one of the two is wrong, and the door is the specification.
