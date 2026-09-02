# ACP golden transcripts

One recorded connection per file. `AcpAgentTranscript.test.ts` replays each one at the real `acpAgent` driver through a `ChildProcessSpawner` stub, so what is certified is the driver against a fixed recording of the protocol, not against a mock somebody wrote to agree with it.

Everything above the spawn is the shipping code path: ndjson framing, `AcpJsonRpcConnection`, `AcpSessionRuntime`, `AcpAgentAdapter`. Only the subprocess is replaced. The argv the driver would have handed the operating system is asserted separately in `AcpAgentSupport.test.ts`.

## These exchanges are written, not captured

No file here came off a running agent.

The `host` array is written from the ACP schema and from what this driver actually calls. The `agent` array is written from the same schema, as a plausible agent's answers. A capture off one real agent would be worse evidence: it would carry that agent's build, that machine's paths and that moment's model list, and nobody could re-record it without installing that agent.

The driver has to work against any ACP agent, so the fixtures describe the protocol rather than a product.

## The shape of a file

```jsonc
{
  "why": "what breaks in the world if this recording stops matching",
  "session": "the session id the recording uses",
  "awaits_interrupt": true, // optional; see below
  "host": [ /* what a client sends, in order */ ],
  "agent": [ /* what the agent answers, in order */ ]
}
```

`host` and `agent` are joined by JSON-RPC request id, so each recorded answer is keyed by the method that earned it. Notifications keep their recorded position and are written immediately before the answer they preceded, which is what makes streamed chunks arrive before the stop reason, and `session/load` replay arrive before the load result.

`awaits_interrupt` makes the fake withhold a `session/prompt` answer until a real `session/cancel` line arrives. Without it, a cancel test could pass by racing a prompt that had already finished.

## The files

- `model-discovery-probe.json` - T3 Code's fifteen-second probe: open a session, read the model list, close. The probe never prompts, and the test asserts it sent nothing but `initialize` and `session/new`.
- `first-prompt-opens-a-session.json` - the ordinary first conversation, streamed in pieces.
- `reattach-after-restart.json` - `session/load` with the id the client kept, replayed far enough back to read.
- `reattach-unknown-session.json` - `session/load` with an id this agent does not know, refused by name.
- `cancel-mid-prompt.json` - a cancel that arrives while the prompt is still waiting, answered `cancelled` rather than as an error.
- `cancel-as-a-request.json` - the same cancel recorded as a request rather than a notification. This driver sends the notification ACP specifies, so the recorded acknowledgement has nowhere to go; the prompt's own `cancelled` answer settles the turn either way.
- `set-model-then-prompt.json` - a model chosen before the first word, which must reach the prompt and not only the answer to `session/set_model`.
- `set-model-refused-mid-turn.json` - the same choice refused, with the refusal reaching the user verbatim.
- `backend-unavailable.json` - the service behind the agent is down: `session/new` answers without a model list, `session/load` fails loudly.
- `protocol-refusals.json` - everything an agent says no to, in the words a person reads in the client's window.

## Two rules

1. **Every fixture is named by the `CASES` table** in `AcpAgentTranscript.test.ts`, and a test asserts the table and this directory agree. A fixture no test names proves nothing, and a fixture added without a test fails that assertion until it is driven.
2. **A case that cannot be driven end to end says so** with `proof: "partial"` and the reason, rather than being dropped or asserted at half strength. Some recorded exchanges are refused by the driver before they reach the wire; those refusals are asserted in `AcpAgentAdapter.test.ts` instead.

## Adding one

Write the file, add its row to `CASES` with one line saying what it proves, and write the test that drives it. `why` is not decoration: it is what a person reads when the transcript fails, and it should say what breaks in the world if that recording stops matching.
