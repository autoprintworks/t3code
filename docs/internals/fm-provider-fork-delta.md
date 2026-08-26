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

| File                             | What it is                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FmDriver.ts`                    | The `ProviderDriver` registration. This is the file `builtInDrivers.ts` imports.                                                                          |
| `FmAdapter.ts`                   | The adapter: sessions, turns, cancel, resume, model selection, notification fan-out.                                                                      |
| `FmAcpSupport.ts`                | The spawn contract and the small pure helpers around it (argv, client capabilities, model id resolution).                                                 |
| `FmProvider.ts`                  | Provider status and model discovery, including `checkFmProviderStatus`.                                                                                   |
| `FmTextGeneration.ts`            | Refuses commit messages, PR text, branch names and thread titles. See below.                                                                              |
| `FmTranscriptDoor.ts`            | Test-only. A fake door built from a golden transcript, served over a `ChildProcessSpawner` stub. Also hosts `watchProviderEvents`, shared by both suites. |
| `FmAcpSupport.test.ts`           | The spawn contract: the argv the driver would hand the operating system.                                                                                  |
| `FmAdapter.test.ts`              | Behaviour the transcripts cannot record: local refusals, the idle-cancel guard, the `session/load` replay guard.                                          |
| `FmTranscript.test.ts`           | The certification suite. One test per golden transcript.                                                                                                  |
| `fixtures/acp-transcript/*.json` | The ten golden transcripts, vendored **verbatim** from the First Mate repository, plus `DOOR-README.md`.                                                  |

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
   `normalizeProtocolFailure` rewrites the single unrecognised `Die` back into
   a `Fail`.

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
