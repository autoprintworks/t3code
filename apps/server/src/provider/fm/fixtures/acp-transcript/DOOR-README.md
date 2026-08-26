# ACP golden transcripts

One recorded connection per file, replayed through `fm-acp`'s real dispatch to prove the door still speaks the protocol a host expects.
Every one of them is a diff: if either side of the protocol drifts, a committed line stops matching and the suite says which one.

## These exchanges are written, not captured

None of these files came off a running t3code Desktop.
The `host` array is hand-written from the ACP schema (v0.11.3) and from what t3code actually calls, and the `door` array is what `fm-acp` answered when the fixture was last recorded.

A capture off a live Desktop would be better evidence of what a host sends and worse evidence of anything else: it would carry one build's ids, one machine's paths, and one moment's model list, and it could not be re-recorded on a host that does not have Desktop installed.
What is recorded here instead is the half that is ours to keep stable.

No daemon runs during these tests either.
The `supervisor` object scripts what the daemon would have answered, so a transcript exercises the whole door - dispatch, session identity, streaming, stop reasons, refusal wording - without an engine, a store, or a harness.
`../../crates/fm-acp/tests/daemon.rs` covers the other half: the same door over the real typed client, against a local API served in-process.

## The files

- `model-discovery-probe.json` - t3code's fifteen-second probe: open a session, read the model list, close.
  Nothing in it may allocate, and the test asserts that nothing did.
  A replay is not a timing measurement, so the fifteen seconds are proved instead by `a_daemon_that_stops_answering_cannot_hold_the_probe_open`, against a supervisor that never answers.
- `first-prompt-allocates.json` - the ordinary first conversation, and the one call that is allowed to allocate.
- `reattach-after-restart.json` - `session/load` with the id the Desktop kept, replayed far enough back to read.
- `reattach-another-home.json` - `session/load` with another home's id, refused by name.
- `cancel-mid-prompt.json` - a cancel that arrives while the prompt is still waiting, answered `cancelled` rather than as an error.
- `cancel-as-a-request.json` - the same cancel sent as a request rather than a notification, acknowledged by name instead of refused as unknown.
- `set-model-then-prompt.json` - a model chosen before the first word, which must reach the launch and not only the answer.
- `set-model-while-live.json` - the same choice while a conversation is running, refused with what to end.
- `daemon-not-there.json` - the daemon down: `session/new` answers without a model list, `session/load` fails.
- `protocol-refusals.json` - everything the door says no to, in the words a person reads in the host's window.

`../../crates/fm-acp/tests/transcript.rs` names every file above and refuses to run if this directory and that table disagree.
A fixture no test names is a fixture that proves nothing.

## Re-recording

When a change to the door is meant to change what it writes, re-record rather than hand-editing the `door` array:

```
FM_ACP_BLESS=1 cargo test -p fm-acp --test transcript
```

That rewrites the `door` array in every fixture and then fails on purpose, because a green blessing run is indistinguishable from a green check.
Run the suite again without the variable, read `git diff`, and commit the recording only once you have read every changed line.
The `host` array, `why`, `session`, `allocates`, `derives_session`, and `supervisor` are never rewritten: those are what the fixture asks, and only the answer is recorded.
`derives_session` is optional and off by default; a fixture that sets it is replayed under an id the real `session::identity` derived from a scratch home, and the recorded id is put back before the comparison so the file still reads the same on every machine.

## Adding one

Write the fixture, add its row to the `CASES` table in `tests/transcript.rs` with one line saying what it proves, record it, and commit both.
`why` is not decoration - it is what a person reads when the transcript fails, and it should say what breaks in the world if that recording stops matching.
