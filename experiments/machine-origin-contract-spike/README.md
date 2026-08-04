# machine-origin contract spike — where provenance goes, and what it buys

Spike for [#20](https://github.com/autoprintworks/t3code/issues/20).

**Yes to the field, no to the sketch around it. One optional field on the message
is the right seam and it costs eleven sites, none of them in a client dispatch
path. But #20's two stated choices are both wrong: a closed literal union is a
one-way door on the vocabulary, and the field alone cannot clean a transcript —
it hides 40% of the rows and orphans 56% of what is left, because a user message
carries `turnId: null` forever and no client can link a poke to its reply.**

Two probes, both runnable, both against real data. [`compat-probe.mjs`](./compat-probe.mjs)
decodes every mixed-fleet combination through Effect Schema at the version
`packages/contracts` pins (`4.0.0-beta.102`), output in
[`findings.json`](./findings.json). [`noise-model.mjs`](./noise-model.mjs)
replays the actual 15-row transcript the #10 spike captured
(`../firstmate-watcher-poke-spike/findings.json`) through three candidate client
policies, output in [`noise-model.json`](./noise-model.json). Code references
are to this checkout at `df674abaa`.

## The compatibility claim, run

#20 asserts optional is enough "per the precedent already set by
`snoozedUntil`/`snoozedAt`". That holds, and one direction is stronger than the
issue claims — but two of the six cases probed do not behave the way the sketch
assumes.

| direction                                          | what happens                                          |
| -------------------------------------------------- | ----------------------------------------------------- |
| new client → old server, field top-level           | **decodes, field dropped**                            |
| new client → old server, field nested in `message` | **decodes, field dropped**                            |
| old server → new client, `Schema.optional`         | decodes, key absent                                   |
| old server → new client, `withDecodingDefault`     | decodes, key present as `"user"`                      |
| replay of a pre-change event                       | same as above — this one cannot be avoided            |
| encode with the field unset                        | key does not materialise; old clients see nothing new |

**Excess properties are dropped, not rejected.** `Schema.Struct` at this version
is non-strict, so a poke from an updated client is accepted by an un-updated
server and simply loses its provenance. That is the good news and the trap in
one: the rollout is safe, and a supervisor **cannot tell whether its marking took
effect**, because a dropped field and an unmarked message are the same bytes on
the way back. Anything that depends on the mark having landed has to read the
message back and check, not assume.

### `Schema.optional` vs `withDecodingDefault` is not a style choice

`Schema.optional` leaves the key absent, so every consumer — projector, three
clients, the minimap derivation — carries its own `?? "user"`. Miss one and it
branches wrong. `withDecodingDefault(Effect.succeed("user"))` materialises
`"user"` at the decode boundary, so downstream code sees one value and never a
gap. The existing precedents split on exactly this line: `snoozedUntil` is bare
`optional` because absent and null mean different things there; `archivedAt`,
`settledOverride` and `proposedPlans` all take a decoding default because they
have one obvious zero value. Origin has an obvious zero value. **Use the
decoding default**, and note that #20's cited precedent is the weaker of the two
already in the file.

### The vocabulary is a one-way door if it is a closed union

Nobody asked what happens the day a third origin ships. The answer is bad:

```
closed union meets an unknown origin value            FAIL  Expected "user" | "machine", got "cron"
closed union + decoding default, unknown value        FAIL  Expected "user" | "machine", got "cron"
open string meets an unknown origin value             ok    origin="cron"
```

A decoding default rescues a **missing** field, not an **out-of-range** one. So
`Schema.Literals(["user", "machine"])` means that adding `"cron"` later is a
breaking change for every peer on the old version — and it does not fail
gracefully, it fails the decode of the **entire message payload**, so the row
does not render at all. Given #20's own framing ("watchers, CI hooks,
cron-driven agents, a second agent supervising a first"), a third value is not
hypothetical; it is the stated roadmap. Either accept a closed union and accept
that the vocabulary is frozen until every client updates, or take an open string
and have clients treat anything they do not recognise as machine. This is the
single highest-leverage decision in the ticket and #20 does not raise it.

### `null` is not the same as absent

`origin: null` fails against `Schema.optional(Schema.Literals([...]))`. The
entire audience for this field is external processes hand-writing JSON —
firstmate's poke builds its command literally
(`experiments/firstmate-watcher-poke-spike/watcher-poke.mjs`) — and a script
that sets `origin: null` to mean "unset" gets its whole command refused. Either
wrap in `NullOr` or document omission as the only spelling. Explicitly-undefined
is fine in both encodings.

## The cost map

Traced, not estimated. Every site the field must cross:

| #   | site                                                                         | what changes                                                        |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | `packages/contracts/src/orchestration.ts:706` `ClientThreadTurnStartCommand` | wire in                                                             |
| 2   | `orchestration.ts:685` `ThreadTurnStartCommand`                              | post-normalize                                                      |
| 3   | `orchestration.ts:1056` `ThreadMessageSentPayload`                           | the durable event                                                   |
| 4   | `orchestration.ts:229` `OrchestrationMessage`                                | read-model row                                                      |
| 5   | `apps/server/src/orchestration/decider.ts:781-800`                           | command → event                                                     |
| 6   | `apps/server/src/persistence/Migrations/036_*`                               | new column, template at `007_ProjectionThreadMessageAttachments.ts` |
| 7   | `persistence/Services/ProjectionThreadMessages.ts:24`                        | row schema                                                          |
| 8   | `persistence/Layers/ProjectionThreadMessages.ts`                             | INSERT, ON CONFLICT, two SELECTs                                    |
| 9   | `orchestration/Layers/ProjectionPipeline.ts:916`                             | upsert call                                                         |
| 10  | `orchestration/Layers/ProjectionSnapshotQuery.ts:482,919`                    | two SELECTs                                                         |
| 11  | `orchestration/projector.ts:457`                                             | in-memory projector decode                                          |

**Nothing in a client dispatch path changes.** Measured rather than assumed:
`startThreadTurn` (`packages/client-runtime/src/operations/commands.ts:233`)
forwards `...input`, and the server's `normalizeDispatchCommand`
(`apps/server/src/orchestration/Normalizer.ts`) spreads both the command and
`command.message`, so a new field rides through both for free — only the input
_type_ changes. The five composer dispatch sites in `apps/web/src/components/ChatView.tsx`
and the two in mobile need no edit at all, provided absent decodes to `"user"`.
That is the concrete argument for the decoding default over a required field,
and it is what makes the server half genuinely small.

**Where it should sit: nested in `message`, not top-level.** Both survive an old
server identically, so the tiebreak is meaning. The command's top level already
describes the _turn_ (`modelSelection`, `titleSeed`, `runtimeMode`); `message` is
the sub-struct that maps one-to-one onto the row that gets rendered, and origin
is a property of the message. Open question left for the implementer:
`ThreadTurnStartRequestedPayload` may want a copy anyway, because reactors — push
notifications, `AgentAwarenessRelay` — plausibly want to branch on it and they
read the turn request, not the message.

## What the field actually buys a reader

This is the half #20 leaves open, and the numbers say the field alone is not
enough. Replaying #10's real 15-row transcript (12,195 chars, 8 user rows of
which 6 were pokes):

| policy                                                 | rows removed | rows left | orphaned replies            | minimap |
| ------------------------------------------------------ | ------------ | --------- | --------------------------- | ------- |
| **A** hide machine user rows — _all one field enables_ | 6/15 (40%)   | 9         | **5 (56% of what remains)** | 8 → 2   |
| **B** hide machine rows _and their replies_            | 11/15 (73%)  | 4         | 0                           | 8 → 2   |
| **C** minimap only, keep every row                     | 0            | 15        | 0                           | 8 → 2   |

Policy A — the one that follows directly from "an optional field on the message"
— **makes the transcript worse**. It removes the poke and leaves the reply, so
five of the nine remaining rows are an agent answering a question the reader
cannot see. A reader scrolling that sees `Logged 'settled kittiwake-6a5852' to
WOKE.md; standing by.` with no prompt above it.

Policy B is what a reader wants and it needs a link from a reply back to its
prompt. **That link does not exist in the read model.** Every user message is
emitted with `turnId: null` (`decider.ts:795`) and nothing ever backfills it —
only assistant messages carry a turn (`decider.ts:1051`, `:1078`), and
`ProjectionPipeline` writes `event.payload.turnId` straight through. The server
does know the pairing: `ProjectionTurn.pendingMessageId`
(`persistence/Services/ProjectionTurns.ts:39`) records the originating message.
But it is server-only — it appears nowhere in `packages/contracts` — and it is
cleared to `null` when the turn resolves (`ProjectionPipeline.ts:1283`, `:1320`,
`:1375`). So it is neither durable nor visible.

**And the obvious client-side workaround does not work.** The heuristic a client
would reach for — an assistant row replies to the nearest preceding user row —
misattributes **1 of 7** replies in this run, and it is precisely the mid-turn
case #10 flagged: rows 11 (a genuine 400-line request) and 12 (a poke) are
adjacent user rows, and the 10,204-char reply at row 13 belongs to 11, not 12.
Adjacency would hide the reader's own longest answer as machine noise. That is
the worst possible failure for this feature, and it is reproducible, not
theoretical.

Policy C — leave the transcript alone and only clean the minimap — is the one
policy that is fully purchased by one field, costs nothing on mobile or desktop,
and cannot misfire. It recovers the whole navigation rail (8 entries → 2, the
reader's own two turns) which is what #10 measured as filling "at the same rate".
**If the client half has to ship in one step, C is the step**; A is a regression
and B needs a second contract change.

## What this means for #20

The field is right and it is cheap. The shape around it needs three corrections
before it is written down:

1. **Decoding default, not bare optional.** One value downstream instead of a
   `?? "user"` at every consumer, and it keeps all seven composer dispatch sites
   untouched.
2. **Decide the vocabulary's door now.** A closed union freezes it; an open
   string keeps it open at the cost of clients needing an unknown-value rule.
   Adding a value later to a closed union breaks the whole payload decode on
   older peers, and a decoding default does not save it.
3. **Split the client half off, and land the minimap first.** Hiding machine
   rows is not deliverable on this contract change alone — it orphans more rows
   than it removes, and the adjacency workaround misattributes the reader's own
   turns. Excluding them from the minimap is deliverable, is the full payoff for
   the navigation complaint, and is a decision each surface can make
   independently.

The prompt-to-reply link is a separate ticket. It is a prerequisite for any
collapse or hide UI, it is not free (the pairing exists server-side but is
transient and unexported), and it is worth noting that it would also fix the
mid-turn ambiguity #10 found for reasons that have nothing to do with machine
traffic.

## Not covered

Still nobody has looked at a poke-heavy transcript in the desktop app with human
eyes — #20's own "Not covered" survives this spike intact. The numbers above say
what filtering would _remove_; they do not say whether the unfiltered thing is
annoying enough to be worth the three surfaces. A maintainer glance would settle
whether policy C is sufficient or merely first.

Nothing here was run against a live server. This spike is schema semantics plus
a replay of committed data; the eleven-site cost map is traced by reading, and
an implementation may find a twelfth.

## Traps

- **A dropped field is indistinguishable from an unmarked message.** Old servers
  accept and discard. A supervisor that needs to know its marking landed must
  read the message back.
- **A decoding default rescues a missing field, not an out-of-range one.** It
  does not make a closed union forward-compatible.
- **`origin: null` is refused** by `Schema.optional`, and hand-written JSON is
  this feature's entire audience.
- **User messages carry `turnId: null` forever.** Not a rendering detail — it is
  what makes policy B impossible and policy A harmful.
- **`pendingMessageId` looks like the link and is not.** Server-only, and nulled
  when the turn resolves.
- **Adjacency misattributes the busy case**, which is the same case #10 found
  splits an exchange across two turns.

## Running it

`noise-model.mjs` is stdlib-only and reads committed data:

```bash
node experiments/machine-origin-contract-spike/noise-model.mjs
```

`compat-probe.mjs` needs the pinned Effect. It cannot be installed inside the
repo — npm walks up to the workspace root and chokes on the `catalog:` protocol
— so give it a scratch directory outside the tree:

```bash
mkdir -p "$TMPDIR/t3-origin-spike-deps" && cd "$TMPDIR/t3-origin-spike-deps"
npm init -y && npm install effect@4.0.0-beta.102
cp <repo>/experiments/machine-origin-contract-spike/compat-probe.mjs .
node compat-probe.mjs --json <repo>/experiments/machine-origin-contract-spike/findings.json
```

Both take `--json <path>`. Neither starts a server, touches `~/.t3`, or writes
anywhere but the path you pass.
