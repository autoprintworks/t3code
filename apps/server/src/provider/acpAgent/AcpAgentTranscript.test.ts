/**
 * Certification against the golden transcripts.
 *
 * The ten files under `fixtures/acp-transcript/` are this driver's behaviour
 * contract: one recorded ACP connection each, written from the protocol rather
 * than captured from any one agent. The recorded `agent` array is replayed at
 * the real `AcpAgentAdapter` through a `ChildProcessSpawner` stub, so what is
 * certified is the driver against a fixed reading of ACP, not against a mock
 * written to agree with it. `AcpAgentTranscriptAgent.ts` serves the recording;
 * `AcpAgentSupport.test.ts` covers the one layer the stub replaces, the spawn.
 *
 * Two rules, stated in the fixtures' own `README.md`:
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

import {
  ACP_AGENT_DRIVER_KIND,
  AcpAgentSettings,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import {
  makeAcpAgentAdapter,
  type AcpAgentAdapterLiveOptions,
  type AcpAgentAdapterShape,
} from "./AcpAgentAdapter.ts";
import { checkAcpAgentProviderStatus } from "./AcpAgentProvider.ts";
import {
  listTranscriptFixtureNames,
  makeTranscriptAgent,
  narrowTranscriptFixture,
  observedMessage,
  observedParams,
  readTranscriptFixture,
  watchProviderEvents,
  type AcpTranscriptFixture,
  type ProviderEventWatch,
  type TranscriptAgent,
} from "./AcpAgentTranscriptAgent.ts";

const decodeAcpAgentSettings = Schema.decodeSync(AcpAgentSettings);
const SESSION = "sess-1a2b3c4d5e6f7a8b";
const CWD = "C:/work/repo";
const INSTANCE = ProviderInstanceId.make("acp-agent-one");

/** The one thing a configured instance must have: something to run. */
const CONFIGURED = decodeAcpAgentSettings({ enabled: true, command: "example-acp-agent" });

/**
 * Which transcript each case drives and how completely. `partial` is not a
 * softer pass: it names the exchange the driver cannot provoke and why, and
 * everything else in the file is still driven.
 */
const CASES = [
  { fixture: "backend-unavailable", proof: "driven", why: "" },
  {
    fixture: "cancel-as-a-request",
    proof: "partial",
    why: "This driver sends session/cancel as the notification ACP specifies, so the recorded acknowledgement for the request form is consumed without a reply. The cancelled prompt answer is driven.",
  },
  { fixture: "cancel-mid-prompt", proof: "driven", why: "" },
  { fixture: "first-prompt-opens-a-session", proof: "driven", why: "" },
  { fixture: "model-discovery-probe", proof: "driven", why: "" },
  {
    fixture: "protocol-refusals",
    proof: "partial",
    why: "Seven of the ten probes cannot leave this driver: a bare integer, a request with no method, protocol version 0, a session/new before initialize, an MCP server, an image prompt and a whitespace prompt are all refused or unrepresentable before the wire. The three the driver can send are driven here; the local refusals are asserted in AcpAgentAdapter.test.ts.",
  },
  { fixture: "reattach-after-restart", proof: "driven", why: "" },
  { fixture: "reattach-unknown-session", proof: "driven", why: "" },
  { fixture: "set-model-refused-mid-turn", proof: "driven", why: "" },
  { fixture: "set-model-then-prompt", proof: "driven", why: "" },
] as const satisfies ReadonlyArray<{
  readonly fixture: string;
  readonly proof: "driven" | "partial";
  readonly why: string;
}>;

it("names every golden transcript", () => {
  // A transcript nothing drives certifies nothing, and a transcript added
  // later must fail this test until it is driven.
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

const transcriptLayer = (transcript: TranscriptAgent) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, transcript.spawner),
    NodeCrypto.layer,
  );

const openFixture = (name: string, narrowTo?: ReadonlyArray<number>): AcpTranscriptFixture => {
  const fixture = readTranscriptFixture(name);
  return narrowTo === undefined ? fixture : narrowTranscriptFixture(fixture, narrowTo);
};

const driveTranscript = <A, E>(
  fixture: AcpTranscriptFixture,
  body: (input: {
    readonly adapter: AcpAgentAdapterShape;
    readonly agent: TranscriptAgent;
    readonly events: ProviderEventWatch;
  }) => Effect.Effect<A, E>,
  options?: AcpAgentAdapterLiveOptions,
) =>
  Effect.gen(function* () {
    const agent = yield* makeTranscriptAgent(fixture);
    return yield* Effect.gen(function* () {
      const adapter = yield* makeAcpAgentAdapter(CONFIGURED, {
        instanceId: INSTANCE,
        ...options,
      }).pipe(Effect.orDie);
      const events = yield* watchProviderEvents(adapter);
      const result = yield* body({ adapter, agent, events });
      yield* events.stop;
      return result;
    }).pipe(Effect.provide(transcriptLayer(agent)), Effect.scoped);
  });

const startFor = (
  adapter: AcpAgentAdapterShape,
  threadId: ThreadId,
  overrides?: Record<string, unknown>,
) =>
  adapter.startSession({
    threadId,
    provider: ACP_AGENT_DRIVER_KIND,
    cwd: CWD,
    runtimeMode: "full-access",
    ...overrides,
  });

/** The agent's own words for a refusal, taken from the fixture rather than retyped. */
const recordedErrorMessage = (fixture: AcpTranscriptFixture, id: number): string => {
  const entry = fixture.agent.find(
    (candidate): candidate is { id: number; error: { message: string } } =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { id?: unknown }).id === id &&
      "error" in candidate,
  );
  assert.isDefined(entry, `the fixture records no error for id ${id}`);
  return entry.error.message;
};

it.effect("model-discovery-probe: reads the agent's model menu without prompting", () =>
  Effect.gen(function* () {
    const agent = yield* makeTranscriptAgent(openFixture("model-discovery-probe"));

    const snapshot = yield* checkAcpAgentProviderStatus(CONFIGURED, process.env).pipe(
      Effect.provide(transcriptLayer(agent)),
      Effect.scoped,
    );

    assert.equal(snapshot.status, "ready");
    // The version comes from ACP's own `agentInfo`, so it costs no extra spawn
    // and works for an agent whose CLI has no `--version` at all.
    assert.equal(snapshot.version, "1.4.0");
    assert.deepStrictEqual(
      snapshot.models.map((model) => model.slug),
      ["default", "fast", "deep", "research", "offline"],
    );
    // The probe has fifteen seconds and it never prompts. A probe that opened
    // a turn to fill a dropdown would be a bug the model list alone would not
    // reveal, and could cost the user money.
    assert.deepStrictEqual(agent.observedMethods(), ["initialize", "session/new"]);
  }),
);

it.effect("first-prompt-opens-a-session: drives an ordinary first conversation", () =>
  driveTranscript(openFixture("first-prompt-opens-a-session"), ({ adapter, agent, events }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-first-prompt");
      const session = yield* startFor(adapter, threadId);

      assert.equal(session.provider, "acpAgent");
      assert.equal(session.model, "default");
      assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId: SESSION });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "what is left to do?",
        attachments: [],
      });
      yield* events.awaitType("turn.completed");

      assert.deepStrictEqual(observedParams(agent, "session/new"), {
        cwd: CWD,
        mcpServers: [],
      });
      assert.deepStrictEqual(observedParams(agent, "session/prompt"), {
        sessionId: SESSION,
        prompt: [{ type: "text", text: "what is left to do?" }],
      });
      assert.equal(events.assistantText(), "Two tests are failing and one file is unformatted.");

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

it.effect("set-model-then-prompt: the choice reaches the prompt, not just the answer", () =>
  driveTranscript(openFixture("set-model-then-prompt"), ({ adapter, agent, events }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-set-model");
      const session = yield* startFor(adapter, threadId, {
        modelSelection: { instanceId: INSTANCE, model: "fast" },
      });

      assert.equal(session.model, "fast");
      assert.deepStrictEqual(observedParams(agent, "session/set_model"), {
        sessionId: SESSION,
        modelId: "fast",
      });

      yield* adapter.sendTurn({ threadId, input: "say when you are ready", attachments: [] });
      yield* events.awaitType("turn.completed");

      assert.equal(events.assistantText(), "Ready.");
      // The model reaches the turn, not only the session record: a setting that
      // changed nothing would be worse than one that refused.
      const started = events.seen.find((event) => event.type === "turn.started");
      assert.isDefined(started);
      if (started?.type === "turn.started") {
        assert.deepStrictEqual(started.payload, { model: "fast" });
      }
      assert.deepStrictEqual(agent.observedMethods(), [
        "initialize",
        "session/new",
        "session/set_model",
        "session/prompt",
      ]);
    }),
  ),
);

it.effect("set-model-refused-mid-turn: the agent's refusal reaches the user verbatim", () =>
  Effect.gen(function* () {
    const fixture = openFixture("set-model-refused-mid-turn");
    const refusal = recordedErrorMessage(fixture, 2);

    const error = yield* driveTranscript(fixture, ({ adapter }) =>
      startFor(adapter, ThreadId.make("acp-live-model"), {
        modelSelection: { instanceId: INSTANCE, model: "fast" },
      }).pipe(Effect.flip),
    );

    assert.equal(error._tag, "ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      assert.equal(error.method, "session/set_model");
      // T3 Code cannot know why any given agent said no, so the agent's own
      // sentence is what the user gets. Paraphrasing it here would let a
      // regression that dropped the wording pass unnoticed.
      assert.equal(error.detail, refusal);
      assert.include(error.detail, "Start a new thread to change model.");
    }
  }),
);

it.effect("cancel-mid-prompt: a prompt that is still running is stopped by the agent", () =>
  driveTranscript(
    openFixture("cancel-mid-prompt"),
    ({ adapter, agent, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("acp-cancel-mid-prompt");
        yield* startFor(adapter, threadId);

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "read every file and summarise them",
            attachments: [],
          })
          .pipe(Effect.forkChild);

        // The fixture sets `awaits_interrupt`, so the fake withholds the prompt
        // answer until a real `session/cancel` line arrives. Waiting for the
        // streamed chunk proves the prompt is genuinely mid-flight: the agent
        // has spoken and has not answered.
        yield* events.awaitType("content.delta");
        assert.equal(events.assistantText(), "Reading the files");
        const sessions = yield* adapter.listSessions();
        assert.equal(sessions[0]?.status, "running");

        yield* adapter.interruptTurn(threadId);

        const turn = yield* Fiber.join(turnFiber);
        yield* events.awaitType("turn.completed");

        const cancel = observedMessage(agent, "session/cancel");
        assert.isDefined(cancel);
        // ACP specifies cancel as a notification. Giving it an id would leave
        // the agent owing a reply nobody is waiting for.
        assert.isUndefined(cancel?.id);
        assert.deepStrictEqual(cancel?.params, { sessionId: SESSION });

        const completed = events.seen.find((event) => event.type === "turn.completed");
        assert.isDefined(completed);
        if (completed?.type === "turn.completed") {
          assert.equal(completed.turnId, turn.turnId);
          // `cancelled` is a stop reason, not an error, and it is the agent's
          // own answer rather than one this driver synthesised: the local
          // fallback would have interrupted the prompt fiber instead.
          assert.deepStrictEqual(completed.payload, {
            state: "cancelled",
            stopReason: "cancelled",
          });
        }
        assert.deepStrictEqual(agent.observedMethods(), [
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

it.effect("cancel-as-a-request: the cancel still settles the turn the agent queued", () =>
  driveTranscript(
    openFixture("cancel-as-a-request"),
    ({ adapter, agent, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("acp-cancel-as-request");
        yield* startFor(adapter, threadId);

        const turnFiber = yield* adapter
          .sendTurn({ threadId, input: "start the long sweep", attachments: [] })
          .pipe(Effect.forkChild);

        yield* events.awaitType("turn.started");
        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(turnFiber);
        yield* events.awaitType("turn.completed");

        // The fixture records an agent answering a cancel sent as a request.
        // This driver sends the notification form, so the recorded
        // acknowledgement has no reply to be written back to; the prompt's own
        // `cancelled` answer is what settles the turn either way.
        assert.isUndefined(observedMessage(agent, "session/cancel")?.id);
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

it.effect("reattach-after-restart: a restart resumes the same session", () =>
  driveTranscript(openFixture("reattach-after-restart"), ({ adapter, agent, events }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-reattach");
      const session = yield* startFor(adapter, threadId, {
        resumeCursor: { schemaVersion: 1, sessionId: SESSION },
      });

      // `session/load`, not `session/new`. Starting a second conversation
      // beside the running one is the failure this fixture exists to catch.
      assert.deepStrictEqual(agent.observedMethods(), ["initialize", "session/load"]);
      assert.deepStrictEqual(observedParams(agent, "session/load"), {
        sessionId: SESSION,
        cwd: CWD,
        mcpServers: [],
      });
      // The load result carries no session id of its own, so the cursor the
      // client kept is what must round-trip.
      assert.deepStrictEqual(session.resumeCursor, { schemaVersion: 1, sessionId: SESSION });
      assert.equal(session.model, "default");
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

it.effect("reattach-unknown-session: an id the agent does not know is refused by name", () =>
  Effect.gen(function* () {
    const fixture = openFixture("reattach-unknown-session");
    const refusal = recordedErrorMessage(fixture, 1);

    const error = yield* driveTranscript(fixture, ({ adapter }) =>
      adapter
        .startSession({
          threadId: ThreadId.make("acp-unknown-session"),
          provider: ACP_AGENT_DRIVER_KIND,
          cwd: "C:/work/other-repo",
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "sess-ffffffffffffffff" },
        })
        .pipe(Effect.flip),
    );

    assert.equal(error._tag, "ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      assert.equal(error.detail, refusal);
      assert.include(error.detail, "belongs to another one");
    }
  }),
);

it.effect(
  "backend-unavailable: a session opens with no model list, and a reattach fails loudly",
  () =>
    Effect.gen(function* () {
      const fixture = openFixture("backend-unavailable");
      const refusal = recordedErrorMessage(fixture, 2);

      yield* driveTranscript(fixture, ({ adapter, agent }) =>
        Effect.gen(function* () {
          // One agent process cannot both create and load, so the two exchanges
          // are two provider connections, which is also how a user would meet
          // them: a fresh session, then a restart that tries to reattach.
          const created = yield* startFor(adapter, ThreadId.make("acp-backend-new"));
          // No model list is not an error: an agent that cannot reach its own
          // backend can still hold a session, and inventing a model here would
          // put a name in the picker that nothing can run.
          assert.isUndefined(created.model);
          assert.deepStrictEqual(created.resumeCursor, { schemaVersion: 1, sessionId: SESSION });

          const error = yield* startFor(adapter, ThreadId.make("acp-backend-load"), {
            resumeCursor: { schemaVersion: 1, sessionId: SESSION },
          }).pipe(Effect.flip);

          assert.equal(error._tag, "ProviderAdapterRequestError");
          if (error._tag === "ProviderAdapterRequestError") {
            assert.equal(error.detail, refusal);
            assert.include(error.detail, "the service behind this agent is not running");
          }
          assert.equal(agent.connections.length, 2);
        }),
      );
    }),
);

it.effect("protocol-refusals: an unknown model is refused with the menu the agent has", () =>
  Effect.gen(function* () {
    // Narrowed to the three exchanges this driver can send: initialize (id 2),
    // session/new (id 4) and session/set_model (id 7). The rest of the file is
    // covered by the local refusals in AcpAgentAdapter.test.ts, or is
    // unrepresentable here - the transport frames one JSON-RPC message per
    // line, so a bare integer never leaves this host.
    const fixture = openFixture("protocol-refusals", [2, 4, 7]);
    const refusal = recordedErrorMessage(openFixture("protocol-refusals"), 7);

    const error = yield* driveTranscript(fixture, ({ adapter }) =>
      startFor(adapter, ThreadId.make("acp-refusals"), {
        modelSelection: { instanceId: INSTANCE, model: "gpt-5" },
      }).pipe(Effect.flip),
    );

    assert.equal(error._tag, "ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      assert.equal(error.method, "session/set_model");
      assert.equal(error.detail, refusal);
      assert.include(error.detail, "it has default, fast");
    }
  }),
);
