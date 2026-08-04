#!/usr/bin/env node
/**
 * The compatibility half of the spike for autoprintworks/t3code#20.
 *
 * #20 sketches "one optional field on the message" and asserts that optional is
 * enough for old servers and old clients to keep decoding, citing the
 * `snoozedUntil`/`snoozedAt` precedent. That assertion is the load-bearing part
 * of the whole design and nobody had run it. This probe runs it.
 *
 * It rebuilds the three schemas the field would have to cross — the wire
 * command (`ClientThreadTurnStartCommand`), the durable event payload
 * (`ThreadMessageSentPayload`) and the read-model row (`OrchestrationMessage`)
 * — in an "old" shape without the field and a "new" shape with it, then decodes
 * every combination that a mixed fleet actually produces. It also probes the
 * question #20 does not ask: whether the field's *value* should be a closed
 * literal union or an open string, which decides whether a third origin can
 * ever be added without breaking older peers.
 *
 * Zero repo imports on purpose — the point is to characterise Effect Schema's
 * behaviour at the version the contracts package pins, not to test our wrappers.
 *
 * Usage:
 *   npm install effect@4.0.0-beta.102   # into any scratch dir
 *   NODE_PATH=<that dir>/node_modules node compat-probe.mjs [--json <path>]
 */
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const { values: flags } = parseArgs({
  options: { json: { type: "string" } },
});

// ---------------------------------------------------------------------------
// Schemas
//
// Field-for-field mirrors of the real ones, minus the branded id types (the
// branding is irrelevant to excess/missing-key handling and would drag the
// whole contracts package in). `IsoDateTime` collapses to a plain string for
// the same reason.
// ---------------------------------------------------------------------------

const Attachment = Schema.Struct({ id: Schema.String, name: Schema.String });

/** `packages/contracts/src/orchestration.ts:1056` as it stands today. */
const OldMessageSentPayload = Schema.Struct({
  threadId: Schema.String,
  messageId: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(Attachment)),
  turnId: Schema.NullOr(Schema.String),
  streaming: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

/** `orchestration.ts:229` as it stands today. */
const OldOrchestrationMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(Attachment)),
  turnId: Schema.NullOr(Schema.String),
  streaming: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

/** `orchestration.ts:706`, the client-facing turn-start command. */
const OldClientTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: Schema.String,
  threadId: Schema.String,
  message: Schema.Struct({
    messageId: Schema.String,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(Attachment),
  }),
  createdAt: Schema.String,
});

// The three candidate encodings of the new field, so the probe compares them
// rather than assuming the issue's sketch is the right one.
const ORIGIN_VALUES = ["user", "machine"];

const OriginClosedOptional = Schema.optional(Schema.Literals(ORIGIN_VALUES));
const OriginClosedDefaulted = Schema.Literals(ORIGIN_VALUES).pipe(
  Schema.withDecodingDefault(Effect.succeed("user")),
);
const OriginOpenOptional = Schema.optional(Schema.String);

const withOrigin = (base, origin) => Schema.Struct({ ...base.fields, origin });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const results = [];

function probe(group, name, schema, input, question) {
  let outcome;
  try {
    const value = Effect.runSync(Schema.decodeUnknownEffect(schema)(input));
    outcome = {
      decoded: true,
      hasOrigin: Object.prototype.hasOwnProperty.call(value, "origin"),
      origin: value.origin ?? null,
      keys: Object.keys(value).sort(),
    };
  } catch (error) {
    outcome = { decoded: false, error: String(error?.message ?? error).split("\n")[0] };
  }
  results.push({ group, name, question, input, outcome });
  return outcome;
}

const baseSentPayload = {
  threadId: "thr_1",
  messageId: "msg_1",
  role: "user",
  text: "FIRSTMATE_OP: v1 watcher: WAKE stale:fm-crew-a1b2c3",
  turnId: null,
  streaming: false,
  createdAt: "2026-08-04T10:00:00.000Z",
  updatedAt: "2026-08-04T10:00:00.000Z",
};

const baseMessageRow = {
  id: "msg_1",
  role: "user",
  text: "poke",
  turnId: null,
  streaming: false,
  createdAt: "2026-08-04T10:00:00.000Z",
  updatedAt: "2026-08-04T10:00:00.000Z",
};

const baseCommand = {
  type: "thread.turn.start",
  commandId: "cmd_1",
  threadId: "thr_1",
  message: { messageId: "msg_1", role: "user", text: "poke", attachments: [] },
  createdAt: "2026-08-04T10:00:00.000Z",
};

// --- 1. New client -> old server. The command carries a field the server's
// schema has never heard of. If Struct is strict, every poke from an updated
// client is refused by an un-updated server.
probe(
  "new-client-to-old-server",
  "command with unknown origin decodes on old schema",
  OldClientTurnStartCommand,
  { ...baseCommand, origin: "machine" },
  "Does an excess property fail the decode or get dropped?",
);

probe(
  "new-client-to-old-server",
  "nested unknown origin on message sub-struct",
  OldClientTurnStartCommand,
  { ...baseCommand, message: { ...baseCommand.message, origin: "machine" } },
  "Same question one level down, where the field arguably belongs.",
);

// --- 2. Old server -> new client. The payload predates the field entirely.
// This is also the event-replay case: every event already in the store looks
// like this, forever.
for (const [name, origin] of [
  ["closed optional", OriginClosedOptional],
  ["closed + decoding default", OriginClosedDefaulted],
  ["open optional", OriginOpenOptional],
]) {
  probe(
    "old-server-to-new-client",
    `payload without origin, ${name}`,
    withOrigin(OldMessageSentPayload, origin),
    baseSentPayload,
    "Does a pre-change payload still decode, and what is origin then?",
  );
}

// --- 3. Replay of a stored event through the new projector, decoded into the
// read-model row. Same shape as (2) but this is the one that cannot be
// avoided by asking users to upgrade: the events are already written.
for (const [name, origin] of [
  ["closed optional", OriginClosedOptional],
  ["closed + decoding default", OriginClosedDefaulted],
]) {
  probe(
    "event-replay",
    `historical message row, ${name}`,
    withOrigin(OldOrchestrationMessage, origin),
    baseMessageRow,
    "What does a message written before the field look like after replay?",
  );
}

// --- 4. The question #20 does not ask. If origin is a closed literal union,
// what happens the day a third value ships and an older peer sees it?
probe(
  "third-value",
  "closed union meets an unknown origin value",
  withOrigin(OldMessageSentPayload, OriginClosedOptional),
  { ...baseSentPayload, origin: "cron" },
  "Can a third origin be added later without breaking older peers?",
);

probe(
  "third-value",
  "open string meets an unknown origin value",
  withOrigin(OldMessageSentPayload, OriginOpenOptional),
  { ...baseSentPayload, origin: "cron" },
  "Same, if the field is an open string instead.",
);

probe(
  "third-value",
  "closed union with decoding default meets an unknown origin value",
  withOrigin(OldMessageSentPayload, OriginClosedDefaulted),
  { ...baseSentPayload, origin: "cron" },
  "Does a decoding default rescue an out-of-range value, or only a missing one?",
);

// --- 5. Explicit undefined. Clients that spread an object with an unset field
// send `origin: undefined` over structured clone / JSON round trips
// inconsistently; check both encodings behave.
probe(
  "explicit-undefined",
  "origin: undefined, closed optional",
  withOrigin(OldMessageSentPayload, OriginClosedOptional),
  { ...baseSentPayload, origin: undefined },
  "Is an explicitly-undefined field the same as a missing one?",
);

probe(
  "explicit-undefined",
  "origin: undefined, closed + decoding default",
  withOrigin(OldMessageSentPayload, OriginClosedDefaulted),
  { ...baseSentPayload, origin: undefined },
  "Same, for the defaulted encoding.",
);

// --- 6. Null. A supervisor writing JSON by hand is as likely to send null as
// to omit the key.
probe(
  "null-origin",
  "origin: null, closed optional",
  withOrigin(OldMessageSentPayload, OriginClosedOptional),
  { ...baseSentPayload, origin: null },
  "Does null decode, or does it need Schema.NullOr?",
);

// --- 7. Encode direction. The server encodes payloads back out to the wire;
// an optional field that is absent must not materialise as an explicit
// undefined key, or every old client sees a key it did not before.
try {
  const encoded = Effect.runSync(
    Schema.encodeEffect(withOrigin(OldMessageSentPayload, OriginClosedOptional))(baseSentPayload),
  );
  results.push({
    group: "encode",
    name: "absent origin does not materialise on encode",
    question: "Does encoding add an explicit origin key when the field is unset?",
    input: baseSentPayload,
    outcome: {
      decoded: true,
      hasOrigin: Object.prototype.hasOwnProperty.call(encoded, "origin"),
      serialised: JSON.stringify(encoded).includes("origin"),
      keys: Object.keys(encoded).sort(),
    },
  });
} catch (error) {
  results.push({
    group: "encode",
    name: "absent origin does not materialise on encode",
    outcome: { decoded: false, error: String(error?.message ?? error).split("\n")[0] },
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let lastGroup = null;
for (const row of results) {
  if (row.group !== lastGroup) {
    console.log(`\n## ${row.group}`);
    lastGroup = row.group;
  }
  const o = row.outcome;
  const verdict = o.decoded
    ? `ok   origin=${JSON.stringify(o.origin ?? null)} present=${o.hasOrigin}`
    : `FAIL ${o.error}`;
  console.log(`  ${verdict.padEnd(46)} ${row.name}`);
}

const summary = {
  effect: "4.0.0-beta.102",
  node: process.version,
  ranAt: new Date().toISOString(),
  results,
};

if (flags.json) {
  writeFileSync(flags.json, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nwrote ${flags.json}`);
}
