/**
 * Behaviour the golden transcripts cannot record.
 *
 * A transcript is a record of what an agent answered, so it can only certify
 * exchanges that reach the wire. Three things do not:
 *
 * - refusals this driver makes locally, which is why the recorded answers for
 *   an image prompt and a whitespace prompt are never provoked;
 * - the cancel race, where a cancel with no prompt in flight would sit in the
 *   agent's queue and stop the prompt that followed it;
 * - the replay guard, which drops `session/load` history because T3 Code
 *   already holds it.
 *
 * @see AcpAgentTranscript.test.ts for the certification suite itself.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  ACP_AGENT_DRIVER_KIND,
  AcpAgentSettings,
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  acpAgentLiveTurnForNotification,
  makeAcpAgentAdapter,
  parseAcpAgentResume,
  type AcpAgentAdapterLiveOptions,
  type AcpAgentAdapterShape,
} from "./AcpAgentAdapter.ts";
import {
  makeTranscriptAgent,
  observedMessage,
  readTranscriptFixture,
  watchProviderEvents,
  type AcpTranscriptFixture,
  type ProviderEventWatch,
  type TranscriptAgent,
} from "./AcpAgentTranscriptAgent.ts";

const decodeAcpAgentSettings = Schema.decodeSync(AcpAgentSettings);
const INSTANCE = ProviderInstanceId.make("acp-agent-one");
const CWD = "C:/work/repo";
const CONFIGURED = decodeAcpAgentSettings({ enabled: true, command: "example-acp-agent" });

it("accepts only a resume cursor it wrote itself", () => {
  assert.deepStrictEqual(
    parseAcpAgentResume({ schemaVersion: 1, sessionId: "sess-1a2b3c4d5e6f7a8b" }),
    { schemaVersion: 1, sessionId: "sess-1a2b3c4d5e6f7a8b" },
  );
  assert.deepStrictEqual(parseAcpAgentResume({ schemaVersion: 1, sessionId: "  sess-abc  " }), {
    schemaVersion: 1,
    sessionId: "sess-abc",
  });
  // A cursor from another provider, or from a future schema, must open a new
  // session rather than be handed to `session/load`: an agent refuses an id it
  // does not know, and a malformed one would strand the thread.
  assert.isUndefined(parseAcpAgentResume({ schemaVersion: 2, sessionId: "sess-abc" }));
  assert.isUndefined(parseAcpAgentResume({ sessionId: "sess-abc" }));
  assert.isUndefined(parseAcpAgentResume({ schemaVersion: 1, sessionId: "   " }));
  assert.isUndefined(parseAcpAgentResume(undefined));
  assert.isUndefined(parseAcpAgentResume("sess-abc"));
});

it("forwards a notification only while its own turn is still live", () => {
  const turnId = TurnId.make("turn-1");

  assert.equal(
    acpAgentLiveTurnForNotification({ activeTurnId: turnId, cancelRequestedTurnIds: new Set() }),
    turnId,
  );
  // `session/load` replay: the thread already holds this history in T3 Code's
  // own event store, so forwarding it would print every message twice.
  assert.isUndefined(
    acpAgentLiveTurnForNotification({
      activeTurnId: undefined,
      cancelRequestedTurnIds: new Set(),
    }),
  );
  // A chunk the agent had queued before it read the cancel. The user has
  // already been told the turn stopped.
  assert.isUndefined(
    acpAgentLiveTurnForNotification({
      activeTurnId: turnId,
      cancelRequestedTurnIds: new Set([turnId]),
    }),
  );
});

const driveAgent = <A, E>(
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
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, agent.spawner),
          NodeCrypto.layer,
        ),
      ),
      Effect.scoped,
    );
  });

const started = (adapter: AcpAgentAdapterShape, id: string) =>
  adapter.startSession({
    threadId: ThreadId.make(id),
    provider: ACP_AGENT_DRIVER_KIND,
    cwd: CWD,
    runtimeMode: "full-access",
  });

it.effect("refuses locally what an agent would refuse on the wire", () =>
  driveAgent(readTranscriptFixture("first-prompt-opens-a-session"), ({ adapter, agent }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-local-refusals");
      yield* started(adapter, "acp-local-refusals");

      // "that prompt has no text in it, and this agent has nothing to answer"
      // is the recorded refusal for the same case. Sending it anyway would
      // spend a place in the agent's prompt queue to be told no.
      const empty = yield* adapter
        .sendTurn({ threadId, input: "   ", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(empty._tag, "ProviderAdapterValidationError");

      // The client capabilities this driver sends declare no image support, so
      // an attachment is refused here rather than on the wire.
      const withImage = yield* adapter
        .sendTurn({
          threadId,
          input: "look at this",
          attachments: [
            {
              type: "image",
              id: "att-1",
              name: "shot.png",
              mimeType: "image/png",
              sizeBytes: 128,
            },
          ],
        })
        .pipe(Effect.flip);
      assert.equal(withImage._tag, "ProviderAdapterValidationError");
      assert.include(withImage.message, "attachments cannot be sent");

      // Nothing left this host, so nothing opened a turn the user pays for.
      assert.deepStrictEqual(agent.observedMethods(), ["initialize", "session/new"]);
    }),
  ),
);

it.effect("has nothing to answer for permissions, questions or a rollback", () =>
  driveAgent(readTranscriptFixture("first-prompt-opens-a-session"), ({ adapter }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-nothing-to-answer");
      yield* started(adapter, "acp-nothing-to-answer");
      const requestId = ApprovalRequestId.make("req-1");

      const permission = yield* adapter
        .respondToRequest(threadId, requestId, "accept")
        .pipe(Effect.flip);
      assert.include(permission.message, "no permission request to answer");

      const question = yield* adapter
        .respondToUserInput(threadId, requestId, { answers: [] })
        .pipe(Effect.flip);
      assert.include(question.message, "no structured question to answer");

      const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.include(rollback.message, "no way to rewind it from the client");

      // The argument is still validated before the refusal, so a caller with a
      // bug hears about the bug rather than the policy.
      const badCount = yield* adapter.rollbackThread(threadId, 0).pipe(Effect.flip);
      assert.equal(badCount._tag, "ProviderAdapterValidationError");
    }),
  ),
);

it.effect("does not leave a cancel in the queue when no prompt is running", () =>
  driveAgent(readTranscriptFixture("first-prompt-opens-a-session"), ({ adapter, agent }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-idle-cancel");
      yield* started(adapter, "acp-idle-cancel");

      // A cancel written with no turn in flight can sit in the agent's queue
      // and stop the prompt that follows it. With nothing to cancel, no
      // `session/cancel` line is written at all.
      yield* adapter.interruptTurn(threadId);
      assert.isUndefined(observedMessage(agent, "session/cancel"));

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "what is left to do?",
        attachments: [],
      });
      assert.isDefined(turn.turnId);
      assert.deepStrictEqual(agent.observedMethods(), [
        "initialize",
        "session/new",
        "session/prompt",
      ]);

      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.status, "ready");
    }),
  ),
);

it.effect("ignores an interrupt aimed at a turn that is not the live one", () =>
  driveAgent(
    readTranscriptFixture("cancel-mid-prompt"),
    ({ adapter, agent, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("acp-wrong-turn");
        yield* started(adapter, "acp-wrong-turn");

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "read every file and summarise them",
            attachments: [],
          })
          .pipe(Effect.forkChild);

        // Wait for the agent's own first chunk. Interrupting before that would
        // be a cancel with no prompt in flight, which is a different path
        // entirely and would pass without proving anything.
        yield* events.awaitType("content.delta");

        // `cancel-mid-prompt` withholds the prompt answer until a cancel
        // arrives, so this interrupt for a stale turn id must be dropped or
        // the fiber below would settle without a `session/cancel` on the wire.
        yield* adapter.interruptTurn(threadId, TurnId.make("some-other-turn"));
        assert.isUndefined(observedMessage(agent, "session/cancel"));

        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(turnFiber);
        assert.isDefined(observedMessage(agent, "session/cancel"));
      }),
    // The grace period is the local fallback for an agent that never answers a
    // cancel. Pushing it far out means only the agent's real answer can end
    // this turn.
    { cancelGrace: "5 minutes" },
  ),
);

it.effect("stops the agent process when the session stops", () =>
  driveAgent(readTranscriptFixture("first-prompt-opens-a-session"), ({ adapter }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-stop");
      yield* started(adapter, "acp-stop");
      assert.isTrue(yield* adapter.hasSession(threadId));

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));

      // A stopped session is not a session. Anything else would let the UI
      // keep talking to a process that is gone.
      const error = yield* adapter
        .sendTurn({ threadId, input: "still there?", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
    }),
  ),
);

it.effect("reports an agent that exits on its own instead of leaving the session alive", () =>
  driveAgent(readTranscriptFixture("first-prompt-opens-a-session"), ({ adapter, agent, events }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("acp-crash");
      yield* started(adapter, "acp-crash");
      assert.isTrue(yield* adapter.hasSession(threadId));

      assert.isTrue(yield* agent.crash(137));

      const exited = yield* events.awaitType("session.exited");
      assert.equal(exited.type === "session.exited" ? exited.payload.exitKind : undefined, "error");
      assert.include(
        exited.type === "session.exited" ? (exited.payload.reason ?? "") : "",
        "exited unexpectedly with code 137",
      );
      // A crash is a transport failure the user should see, not just a
      // lifecycle event the sidebar quietly swallows.
      assert.include(events.types(), "runtime.error");

      // The session is gone, so the UI cannot keep talking to a dead process.
      assert.isFalse(yield* adapter.hasSession(threadId));
      const error = yield* adapter
        .sendTurn({ threadId, input: "still there?", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
    }),
  ),
);

it.effect("fails the live turn when the agent dies mid-prompt", () =>
  driveAgent(
    readTranscriptFixture("cancel-mid-prompt"),
    ({ adapter, agent, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("acp-crash-mid-turn");
        yield* started(adapter, "acp-crash-mid-turn");

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "read every file and summarise them",
            attachments: [],
          })
          .pipe(Effect.forkChild);

        // The fixture withholds the prompt answer until a cancel arrives, so
        // the turn is genuinely in flight when the agent dies.
        yield* events.awaitType("content.delta");
        assert.isTrue(yield* agent.crash(1));

        const completed = yield* events.awaitEvent((event) => event.type === "turn.completed");
        assert.equal(
          completed.type === "turn.completed" ? completed.payload.state : undefined,
          "failed",
        );

        const exited = yield* events.awaitType("session.exited");
        assert.equal(
          exited.type === "session.exited" ? exited.payload.exitKind : undefined,
          "error",
        );

        // Exactly one terminal turn event: the exit watcher and the prompt's
        // own failure both settle, and the second must be a no-op.
        assert.equal(events.types().filter((type) => type === "turn.completed").length, 1);

        yield* Effect.exit(Fiber.join(turnFiber));
        const sessions = yield* adapter.listSessions();
        assert.deepStrictEqual(sessions, []);
      }),
    // Far enough out that the local cancel fallback cannot be what ends this
    // turn; only the crash can.
    { cancelGrace: "5 minutes" },
  ),
);

it.effect("settles the live turn when the session is stopped mid-prompt", () =>
  driveAgent(
    readTranscriptFixture("cancel-mid-prompt"),
    ({ adapter, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("acp-stop-mid-turn");
        yield* started(adapter, "acp-stop-mid-turn");

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "read every file and summarise them",
            attachments: [],
          })
          .pipe(Effect.forkChild);
        yield* events.awaitType("content.delta");

        // Closing the session scope kills the process, and the prompt request
        // it was holding is never answered. Without an explicit settle the
        // caller waits on a process that no longer exists.
        yield* adapter.stopSession(threadId);

        const completed = yield* events.awaitEvent((event) => event.type === "turn.completed");
        assert.equal(
          completed.type === "turn.completed" ? completed.payload.state : undefined,
          "cancelled",
        );
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Fiber.join(turnFiber))));
      }),
    { cancelGrace: "5 minutes" },
  ),
);

it.effect("refuses a start aimed at another provider", () =>
  driveAgent(readTranscriptFixture("first-prompt-opens-a-session"), ({ adapter, agent }) =>
    Effect.gen(function* () {
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("acp-wrong-provider"),
          provider: ProviderDriverKind.make("codex"),
          cwd: CWD,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterValidationError");
      // The configured command is the user's own; a start for another driver
      // must not run it.
      assert.deepStrictEqual(agent.connections, []);
    }),
  ),
);
