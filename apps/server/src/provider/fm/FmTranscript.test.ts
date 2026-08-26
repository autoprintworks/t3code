/**
 * FORK DELTA (fm provider) - certification against the door's golden
 * transcripts.
 *
 * The ten files under `fixtures/acp-transcript/` are vendored verbatim from the
 * First Mate repository, where they are both the specification of `fm-acp`'s
 * wire behaviour and its own regression suite. Here the recorded `door` array
 * is replayed at the real `FmAdapter` through a `ChildProcessSpawner` stub, so
 * what is certified is this driver against the door's recording, not against a
 * mock written to agree with it. `FmTranscriptDoor.ts` serves the recording;
 * `FmAcpSupport.test.ts` covers the one layer the stub replaces, the spawn.
 *
 * Two rules are borrowed from the door's own `tests/transcript.rs`:
 *
 * 1. Every fixture must be named by the `CASES` table below, and a test asserts
 *    the table and the directory agree. A fixture no test names proves nothing.
 * 2. A case that cannot be driven end to end says so in `proof: "partial"` with
 *    the reason, rather than being dropped or asserted at half strength.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { FmSettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { makeFmAdapter, type FmAdapterLiveOptions, type FmAdapterShape } from "./FmAdapter.ts";
import { checkFmProviderStatus } from "./FmProvider.ts";
import {
  listTranscriptFixtureNames,
  makeTranscriptDoor,
  narrowTranscriptFixture,
  observedMessage,
  observedParams,
  readTranscriptFixture,
  transcriptFixtureDrift,
  watchProviderEvents,
  type FmTranscriptFixture,
  type ProviderEventWatch,
  type TranscriptDoor,
} from "./FmTranscriptDoor.ts";

const decodeFmSettings = Schema.decodeSync(FmSettings);
const FM = ProviderDriverKind.make("fm");
const INSTANCE = ProviderInstanceId.make("fm-home-one");
const SESSION = "fm-1a2b3c4d5e6f7a8b";
const HOME_CWD = "C:/Users/captain/projects/firstmate";

/**
 * Which transcript each case drives and how completely. `partial` is not a
 * softer pass: it names the exchange the driver cannot provoke and why, and
 * everything else in the file is still driven.
 */
const CASES = [
  {
    fixture: "cancel-as-a-request",
    proof: "partial",
    why: "This driver sends session/cancel as the notification ACP specifies, so the recorded acknowledgement for the request form is consumed without a reply. The cancelled prompt answer is driven.",
  },
  { fixture: "cancel-mid-prompt", proof: "driven", why: "" },
  { fixture: "daemon-not-there", proof: "driven", why: "" },
  { fixture: "first-prompt-allocates", proof: "driven", why: "" },
  { fixture: "model-discovery-probe", proof: "driven", why: "" },
  {
    fixture: "protocol-refusals",
    proof: "partial",
    why: "Seven of the ten probes cannot leave this driver: a bare integer, a request with no method, protocol version 0, a session/new before initialize, an MCP server, an image prompt and a whitespace prompt are all refused or unrepresentable before the wire. The three the driver can send are driven here; the local refusals are asserted in FmAdapter.test.ts.",
  },
  { fixture: "reattach-after-restart", proof: "driven", why: "" },
  { fixture: "reattach-another-home", proof: "driven", why: "" },
  { fixture: "set-model-then-prompt", proof: "driven", why: "" },
  { fixture: "set-model-while-live", proof: "driven", why: "" },
] as const satisfies ReadonlyArray<{
  readonly fixture: string;
  readonly proof: "driven" | "partial";
  readonly why: string;
}>;

it("names every golden transcript", () => {
  // The door's own suite refuses to run when its CASES table and the fixture
  // directory disagree. Same rule here: a transcript nothing drives certifies
  // nothing, and a transcript added upstream must fail this test until it is
  // driven.
  assert.deepStrictEqual(
    CASES.map((entry) => entry.fixture),
    [...listTranscriptFixtureNames()],
  );
  for (const entry of CASES) {
    if (entry.proof === "partial") {
      assert.isAbove(entry.why.length, 0, `${entry.fixture} must say what it cannot drive`);
    }
  }
});

it("matches the door's own fixtures when a checkout is pointed at", () => {
  // The vendored fixtures are a copy, so a door blessed with new behaviour
  // would leave this suite certifying yesterday's protocol without saying so.
  // Set `FM_ACP_FIXTURES_DIR` to `<firstmate>/fixtures/acp-transcript` to be
  // told. Unset, this is a no-op: most machines have no First Mate checkout,
  // and a suite that required one could not run in CI.
  const drift = transcriptFixtureDrift(process.env.FM_ACP_FIXTURES_DIR);
  if (drift === undefined) {
    return;
  }
  assert.deepStrictEqual(drift, [], "re-vendor these fixtures from the First Mate repository");
});

const doorLayer = (door: TranscriptDoor) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, door.spawner),
    NodeCrypto.layer,
  );

const openFixture = (name: string, narrowTo?: ReadonlyArray<number>): FmTranscriptFixture => {
  const fixture = readTranscriptFixture(name);
  return narrowTo === undefined ? fixture : narrowTranscriptFixture(fixture, narrowTo);
};

const driveTranscript = <A, E>(
  fixture: FmTranscriptFixture,
  body: (input: {
    readonly adapter: FmAdapterShape;
    readonly door: TranscriptDoor;
    readonly events: ProviderEventWatch;
  }) => Effect.Effect<A, E>,
  options?: FmAdapterLiveOptions,
) =>
  Effect.gen(function* () {
    const door = yield* makeTranscriptDoor(fixture);
    return yield* Effect.gen(function* () {
      const adapter = yield* makeFmAdapter(decodeFmSettings({}), {
        instanceId: INSTANCE,
        ...options,
      }).pipe(Effect.orDie);
      const events = yield* watchProviderEvents(adapter);
      const result = yield* body({ adapter, door, events });
      yield* events.stop;
      return result;
    }).pipe(Effect.provide(doorLayer(door)), Effect.scoped);
  });

const startFor = (
  adapter: FmAdapterShape,
  threadId: ThreadId,
  overrides?: Record<string, unknown>,
) =>
  adapter.startSession({
    threadId,
    provider: FM,
    cwd: HOME_CWD,
    runtimeMode: "full-access",
    ...overrides,
  });

/** The door's own words for a refusal, taken from the fixture rather than retyped. */
const recordedErrorMessage = (fixture: FmTranscriptFixture, id: number): string => {
  const entry = fixture.door.find(
    (candidate): candidate is { id: number; error: { message: string } } =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { id?: unknown }).id === id &&
      "error" in candidate,
  );
  assert.isDefined(entry, `the fixture records no error for id ${id}`);
  return entry.error.message;
};

it.effect("model-discovery-probe: reads the door's model menu without allocating", () =>
  Effect.gen(function* () {
    const fixture = openFixture("model-discovery-probe");
    const door = yield* makeTranscriptDoor(fixture, { version: "fm-acp 0.1.0" });

    // `fm` ships disabled, so a probe of the default settings would report
    // exactly that. This is the enabled case, which is the one that talks.
    const snapshot = yield* checkFmProviderStatus(
      decodeFmSettings({ enabled: true }),
      process.env,
    ).pipe(Effect.provide(doorLayer(door)), Effect.scoped);

    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.version, "0.1.0");
    assert.deepStrictEqual(
      snapshot.models.map((model) => model.slug),
      ["claude", "opencode", "pi", "grok", "kimi"],
    );
    // "It has fifteen seconds and it never prompts, so nothing here may
    // allocate." A probe that opened a supervisor conversation to fill a
    // dropdown would be a bug the model list alone would not reveal.
    assert.deepStrictEqual(door.observedMethods(), ["initialize", "session/new"]);
  }),
);

it.effect("first-prompt-allocates: drives a home's supervisor conversation", () =>
  driveTranscript(openFixture("first-prompt-allocates"), ({ adapter, door, events }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fm-first-prompt");
      const session = yield* startFor(adapter, threadId);

      assert.equal(session.provider, "fm");
      assert.equal(session.model, "claude");
      assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId: SESSION });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "what is the fleet doing?",
        attachments: [],
      });
      yield* events.awaitType("turn.completed");

      assert.deepStrictEqual(observedParams(door, "session/new"), {
        cwd: HOME_CWD,
        mcpServers: [],
      });
      assert.deepStrictEqual(observedParams(door, "session/prompt"), {
        sessionId: SESSION,
        prompt: [{ type: "text", text: "what is the fleet doing?" }],
      });
      assert.equal(events.assistantText(), "Two tasks are running and one is waiting on you.");

      const completed = events.seen.find((event) => event.type === "turn.completed");
      assert.isDefined(completed);
      if (completed?.type === "turn.completed") {
        assert.equal(completed.turnId, turn.turnId);
        assert.deepStrictEqual(completed.payload, { state: "completed", stopReason: "end_turn" });
      }
      assert.includeMembers(events.types(), [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "content.delta",
        "turn.completed",
      ]);
    }),
  ),
);

it.effect("set-model-then-prompt: the choice reaches the launch, not just the answer", () =>
  driveTranscript(openFixture("set-model-then-prompt"), ({ adapter, door, events }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fm-set-model");
      const session = yield* startFor(adapter, threadId, {
        modelSelection: { instanceId: INSTANCE, model: "opencode" },
      });

      assert.equal(session.model, "opencode");
      assert.deepStrictEqual(observedParams(door, "session/set_model"), {
        sessionId: SESSION,
        modelId: "opencode",
      });

      yield* adapter.sendTurn({ threadId, input: "stand by", attachments: [] });
      yield* events.awaitType("turn.completed");

      assert.equal(events.assistantText(), "Aye.");
      // The model reaches the turn, not only the session record: a setting that
      // changed nothing would be worse than one that refused.
      const started = events.seen.find((event) => event.type === "turn.started");
      assert.isDefined(started);
      if (started?.type === "turn.started") {
        assert.deepStrictEqual(started.payload, { model: "opencode" });
      }
      assert.deepStrictEqual(door.observedMethods(), [
        "initialize",
        "session/new",
        "session/set_model",
        "session/prompt",
      ]);
    }),
  ),
);

it.effect("set-model-while-live: the door's refusal reaches the user verbatim", () =>
  Effect.gen(function* () {
    const fixture = openFixture("set-model-while-live");
    const refusal = recordedErrorMessage(fixture, 2);

    const error = yield* driveTranscript(fixture, ({ adapter }) =>
      startFor(adapter, ThreadId.make("fm-live-model"), {
        modelSelection: { instanceId: INSTANCE, model: "opencode" },
      }).pipe(Effect.flip),
    );

    assert.equal(error._tag, "ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      assert.equal(error.method, "session/set_model");
      // Refusal wording is part of the door's contract: it names the command
      // that unblocks the user. Paraphrasing it here would let a regression in
      // that sentence pass unnoticed.
      assert.equal(error.detail, refusal);
      assert.include(error.detail, "End it first with: fm unit end u-7");
    }
  }),
);

it.effect("cancel-mid-prompt: a prompt that is still running is stopped by the door", () =>
  driveTranscript(
    openFixture("cancel-mid-prompt"),
    ({ adapter, door, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("fm-cancel-mid-prompt");
        yield* startFor(adapter, threadId);

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "read every task note and summarise them",
            attachments: [],
          })
          .pipe(Effect.forkChild);

        // The transcript's supervisor sets `awaits_interrupt`, so the fake
        // withholds the prompt answer until a real `session/cancel` line
        // arrives. Waiting for the streamed chunk proves the prompt is
        // genuinely mid-flight: the door has spoken and has not answered.
        yield* events.awaitType("content.delta");
        assert.equal(events.assistantText(), "Reading the queue");
        const sessions = yield* adapter.listSessions();
        assert.equal(sessions[0]?.status, "running");

        yield* adapter.interruptTurn(threadId);

        const turn = yield* Fiber.join(turnFiber);
        yield* events.awaitType("turn.completed");

        const cancel = observedMessage(door, "session/cancel");
        assert.isDefined(cancel);
        // ACP specifies cancel as a notification. Giving it an id would leave
        // the door owing a reply nobody is waiting for.
        assert.isUndefined(cancel?.id);
        assert.deepStrictEqual(cancel?.params, { sessionId: SESSION });

        const completed = events.seen.find((event) => event.type === "turn.completed");
        assert.isDefined(completed);
        if (completed?.type === "turn.completed") {
          assert.equal(completed.turnId, turn.turnId);
          // `cancelled` is a stop reason, not an error, and it is the door's
          // own answer rather than one this driver synthesised: the local
          // fallback would have interrupted the prompt fiber instead.
          assert.deepStrictEqual(completed.payload, {
            state: "cancelled",
            stopReason: "cancelled",
          });
        }
        assert.deepStrictEqual(door.observedMethods(), [
          "initialize",
          "session/new",
          "session/prompt",
          "session/cancel",
        ]);
      }),
    // Far longer than this test can take. If the grace fallback fired, the
    // assertions above would be proving the local cancel path instead.
    { cancelGrace: "5 minutes" },
  ),
);

it.effect("cancel-as-a-request: the cancel still settles the turn the door queued", () =>
  driveTranscript(
    openFixture("cancel-as-a-request"),
    ({ adapter, door, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("fm-cancel-as-request");
        yield* startFor(adapter, threadId);

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "start the long sweep", attachments: [] })
          .pipe(Effect.forkChild);

        yield* events.awaitType("turn.started");
        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(turnFiber);
        yield* events.awaitType("turn.completed");

        // The fixture records the door answering a cancel sent as a request.
        // This driver sends the notification form, so the recorded
        // acknowledgement has no reply to be written back to; the prompt's own
        // `cancelled` answer is what settles the turn either way.
        assert.isUndefined(observedMessage(door, "session/cancel")?.id);
        const completed = events.seen.find((event) => event.type === "turn.completed");
        assert.isDefined(completed);
        if (completed?.type === "turn.completed") {
          assert.deepStrictEqual(completed.payload, {
            state: "cancelled",
            stopReason: "cancelled",
          });
        }
        // Nothing was streamed before the interrupt, and nothing was invented.
        assert.equal(events.assistantText(), "");
      }),
    { cancelGrace: "5 minutes" },
  ),
);

it.effect("reattach-after-restart: a restart resumes the same first mate", () =>
  driveTranscript(openFixture("reattach-after-restart"), ({ adapter, door, events }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fm-reattach");
      const session = yield* startFor(adapter, threadId, {
        resumeCursor: { schemaVersion: 1, sessionId: SESSION },
      });

      // `session/load`, not `session/new`. Starting a second first mate beside
      // the running one is the failure this fixture exists to catch.
      assert.deepStrictEqual(door.observedMethods(), ["initialize", "session/load"]);
      assert.deepStrictEqual(observedParams(door, "session/load"), {
        sessionId: SESSION,
        cwd: HOME_CWD,
        mcpServers: [],
      });
      // The load result carries no session id of its own, so the cursor the
      // host kept is what must round-trip.
      assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId: SESSION });
      assert.equal(session.model, "claude");
      assert.equal(session.status, "ready");
      assert.includeMembers(events.types(), ["session.started", "thread.started"]);

      const threadStarted = events.seen.find((event) => event.type === "thread.started");
      assert.isDefined(threadStarted);
      if (threadStarted?.type === "thread.started") {
        assert.deepStrictEqual(threadStarted.payload, { providerThreadId: SESSION });
      }
    }),
  ),
);

it.effect("reattach-another-home: a session id from another home is refused by name", () =>
  Effect.gen(function* () {
    const fixture = openFixture("reattach-another-home");
    const refusal = recordedErrorMessage(fixture, 1);

    const error = yield* driveTranscript(fixture, ({ adapter }) =>
      adapter
        .startSession({
          threadId: ThreadId.make("fm-other-home"),
          provider: FM,
          cwd: "C:/Users/captain/projects/other",
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "fm-ffffffffffffffff" },
        })
        .pipe(Effect.flip),
    );

    assert.equal(error._tag, "ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      assert.equal(error.detail, refusal);
      assert.include(error.detail, "open the provider on that home instead");
    }
  }),
);

it.effect("daemon-not-there: a session opens with no model list, and a reattach fails loudly", () =>
  Effect.gen(function* () {
    const fixture = openFixture("daemon-not-there");
    const refusal = recordedErrorMessage(fixture, 2);

    yield* driveTranscript(fixture, ({ adapter, door }) =>
      Effect.gen(function* () {
        // One door process cannot both create and load, so the two exchanges
        // are two provider connections, which is also how the Desktop would
        // meet them: a fresh session, then a restart that tries to reattach.
        const created = yield* startFor(adapter, ThreadId.make("fm-daemon-new"));
        // "with no model list rather than an invented one, so the fifteen
        // second probe does not fail".
        assert.isUndefined(created.model);
        assert.deepStrictEqual(created.resumeCursor, { schemaVersion: 1, sessionId: SESSION });

        const error = yield* startFor(adapter, ThreadId.make("fm-daemon-load"), {
          resumeCursor: { schemaVersion: 1, sessionId: SESSION },
        }).pipe(Effect.flip);

        assert.equal(error._tag, "ProviderAdapterRequestError");
        if (error._tag === "ProviderAdapterRequestError") {
          assert.equal(error.detail, refusal);
          assert.include(error.detail, "fm-daemon --home");
        }
        assert.equal(door.connections.length, 2);
      }),
    );
  }),
);

it.effect("protocol-refusals: an unknown model is refused with the menu this home has", () =>
  Effect.gen(function* () {
    // Narrowed to the three exchanges this driver can send: initialize (id 2),
    // session/new (id 4) and session/set_model (id 7). The rest of the file is
    // covered by the local refusals in FmAdapter.test.ts, or is unrepresentable
    // here - the transport frames one JSON-RPC message per line, so a bare
    // integer never leaves this host.
    const fixture = openFixture("protocol-refusals", [2, 4, 7]);
    const refusal = recordedErrorMessage(openFixture("protocol-refusals"), 7);

    const error = yield* driveTranscript(fixture, ({ adapter }) =>
      startFor(adapter, ThreadId.make("fm-refusals"), {
        modelSelection: { instanceId: INSTANCE, model: "gpt-5" },
      }).pipe(Effect.flip),
    );

    assert.equal(error._tag, "ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      assert.equal(error.method, "session/set_model");
      assert.equal(error.detail, refusal);
      assert.include(error.detail, "it has claude, opencode");
    }
  }),
);
