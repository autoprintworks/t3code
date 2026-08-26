/**
 * FORK DELTA (fm provider) - behaviour the golden transcripts cannot record.
 *
 * The transcripts are a record of what the door answered, so they can only
 * certify exchanges that reach the wire. Three things do not:
 *
 * - refusals this driver makes locally, which is why the door's recorded
 *   answers for an image prompt and a whitespace prompt are never provoked;
 * - the door's own cancel race, where a cancel with no prompt in flight would
 *   sit in the queue and stop the prompt that followed it;
 * - the replay guard, which drops `session/load` history because T3 Code
 *   already holds it.
 *
 * @see FmTranscript.test.ts for the certification suite itself.
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
  ApprovalRequestId,
  FmSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  fmLiveTurnForNotification,
  makeFmAdapter,
  parseFmResume,
  type FmAdapterLiveOptions,
  type FmAdapterShape,
} from "./FmAdapter.ts";
import {
  makeTranscriptDoor,
  observedMessage,
  readTranscriptFixture,
  watchProviderEvents,
  type FmTranscriptFixture,
  type ProviderEventWatch,
  type TranscriptDoor,
} from "./FmTranscriptDoor.ts";

const decodeFmSettings = Schema.decodeSync(FmSettings);
const FM = ProviderDriverKind.make("fm");
const INSTANCE = ProviderInstanceId.make("fm-home-one");
const HOME_CWD = "C:/Users/captain/projects/firstmate";

it("accepts only a resume cursor it wrote itself", () => {
  assert.deepStrictEqual(parseFmResume({ schemaVersion: 1, sessionId: "fm-1a2b3c4d5e6f7a8b" }), {
    schemaVersion: 1,
    sessionId: "fm-1a2b3c4d5e6f7a8b",
  });
  assert.deepStrictEqual(parseFmResume({ schemaVersion: 1, sessionId: "  fm-abc  " }), {
    schemaVersion: 1,
    sessionId: "fm-abc",
  });
  // A cursor from another provider, or from a future schema, must open a new
  // session rather than be handed to `session/load`: the door refuses an id
  // that belongs to another home, and a malformed one would strand the thread.
  assert.isUndefined(parseFmResume({ schemaVersion: 2, sessionId: "fm-abc" }));
  assert.isUndefined(parseFmResume({ sessionId: "fm-abc" }));
  assert.isUndefined(parseFmResume({ schemaVersion: 1, sessionId: "   " }));
  assert.isUndefined(parseFmResume(undefined));
  assert.isUndefined(parseFmResume("fm-abc"));
});

it("forwards a notification only while its own turn is still live", () => {
  const turnId = TurnId.make("turn-1");

  assert.equal(
    fmLiveTurnForNotification({ activeTurnId: turnId, cancelRequestedTurnIds: new Set() }),
    turnId,
  );
  // `session/load` replay: the thread already holds this history in T3 Code's
  // own event store, so forwarding it would print every message twice.
  assert.isUndefined(
    fmLiveTurnForNotification({ activeTurnId: undefined, cancelRequestedTurnIds: new Set() }),
  );
  // A chunk the door had queued before it read the cancel. The user has
  // already been told the turn stopped.
  assert.isUndefined(
    fmLiveTurnForNotification({
      activeTurnId: turnId,
      cancelRequestedTurnIds: new Set([turnId]),
    }),
  );
});

const driveDoor = <A, E>(
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
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, door.spawner),
          NodeCrypto.layer,
        ),
      ),
      Effect.scoped,
    );
  });

const started = (adapter: FmAdapterShape, id: string) =>
  adapter.startSession({
    threadId: ThreadId.make(id),
    provider: FM,
    cwd: HOME_CWD,
    runtimeMode: "full-access",
  });

it.effect("refuses locally what the door would refuse on the wire", () =>
  driveDoor(readTranscriptFixture("first-prompt-allocates"), ({ adapter, door }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fm-local-refusals");
      yield* started(adapter, "fm-local-refusals");

      // "that prompt has no text in it, and the first mate has nothing to
      // answer" - the door's words for the same case. Sending it anyway would
      // burn a place in the door's single-prompt queue to be told no.
      const empty = yield* adapter
        .sendTurn({ threadId, input: "   ", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(empty._tag, "ProviderAdapterValidationError");

      // "fm-acp takes text and resource links; it declared image, audio and
      // embedded context unsupported."
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

      // Nothing left this host, so nothing allocated a supervisor conversation.
      assert.deepStrictEqual(door.observedMethods(), ["initialize", "session/new"]);
    }),
  ),
);

it.effect("has nothing to answer for permissions, questions or a rollback", () =>
  driveDoor(readTranscriptFixture("first-prompt-allocates"), ({ adapter }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fm-nothing-to-answer");
      yield* started(adapter, "fm-nothing-to-answer");
      const requestId = ApprovalRequestId.make("req-1");

      const permission = yield* adapter
        .respondToRequest(threadId, requestId, "accept")
        .pipe(Effect.flip);
      assert.include(permission.message, "never asks for permission");

      const question = yield* adapter
        .respondToUserInput(threadId, requestId, { answers: [] })
        .pipe(Effect.flip);
      assert.include(question.message, "asks no structured questions");

      const rollback = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.include(rollback.message, "cannot be rewound from the host");

      // The argument is still validated before the refusal, so a caller with a
      // bug hears about the bug rather than the policy.
      const badCount = yield* adapter.rollbackThread(threadId, 0).pipe(Effect.flip);
      assert.equal(badCount._tag, "ProviderAdapterValidationError");
    }),
  ),
);

it.effect("does not leave a cancel in the queue when no prompt is running", () =>
  driveDoor(readTranscriptFixture("first-prompt-allocates"), ({ adapter, door }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fm-idle-cancel");
      yield* started(adapter, "fm-idle-cancel");

      // The door's own regression test is called "a cancel left in the queue
      // cannot stop the prompt that followed it". This is the host half of it:
      // with no turn in flight there is nothing to cancel, so no
      // `session/cancel` line is written at all.
      yield* adapter.interruptTurn(threadId);
      assert.isUndefined(observedMessage(door, "session/cancel"));

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "what is the fleet doing?",
        attachments: [],
      });
      assert.isDefined(turn.turnId);
      assert.deepStrictEqual(door.observedMethods(), [
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
  driveDoor(
    readTranscriptFixture("cancel-mid-prompt"),
    ({ adapter, door, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("fm-wrong-turn");
        yield* started(adapter, "fm-wrong-turn");

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "read every task note and summarise them",
            attachments: [],
          })
          .pipe(Effect.forkChild);

        // Wait for the door's own first chunk. Interrupting before that
        // would be a cancel with no prompt in flight, which is a different
        // path entirely and would pass without proving anything.
        yield* events.awaitType("content.delta");

        // `cancel-mid-prompt` withholds the prompt answer until a cancel
        // arrives, so this interrupt for a stale turn id must be dropped or
        // the fiber below would settle without a `session/cancel` on the
        // wire.
        yield* adapter.interruptTurn(threadId, TurnId.make("some-other-turn"));
        assert.isUndefined(observedMessage(door, "session/cancel"));

        yield* adapter.interruptTurn(threadId);
        yield* Fiber.join(turnFiber);
        assert.isDefined(observedMessage(door, "session/cancel"));
      }),
    // The grace period is the local fallback for a door that never answers a
    // cancel. Pushing it far out means only the door's real answer can end
    // this turn.
    { cancelGrace: "5 minutes" },
  ),
);

it.effect("stops the door process when the session stops", () =>
  driveDoor(readTranscriptFixture("first-prompt-allocates"), ({ adapter }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fm-stop");
      yield* started(adapter, "fm-stop");
      assert.isTrue(yield* adapter.hasSession(threadId));

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));

      // A stopped session is not a session. Anything else would let the UI
      // keep talking to a door that is gone.
      const error = yield* adapter
        .sendTurn({ threadId, input: "still there?", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
    }),
  ),
);

it.effect("reports a door that exits on its own instead of leaving the session alive", () =>
  driveDoor(readTranscriptFixture("first-prompt-allocates"), ({ adapter, door, events }) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("fm-door-crash");
      yield* started(adapter, "fm-door-crash");
      assert.isTrue(yield* adapter.hasSession(threadId));

      assert.isTrue(yield* door.crash(137));

      const exited = yield* events.awaitType("session.exited");
      assert.equal(exited.type === "session.exited" ? exited.payload.exitKind : undefined, "error");
      assert.include(
        exited.type === "session.exited" ? (exited.payload.reason ?? "") : "",
        "exited unexpectedly with code 137",
      );
      // A crash is a transport failure the user should see, not just a
      // lifecycle event the sidebar quietly swallows.
      assert.include(events.types(), "runtime.error");

      // The session is gone, so the UI cannot keep talking to a dead door.
      assert.isFalse(yield* adapter.hasSession(threadId));
      const error = yield* adapter
        .sendTurn({ threadId, input: "still there?", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterSessionNotFoundError");
    }),
  ),
);

it.effect("fails the live turn when the door dies mid-prompt", () =>
  driveDoor(
    readTranscriptFixture("cancel-mid-prompt"),
    ({ adapter, door, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("fm-door-crash-mid-turn");
        yield* started(adapter, "fm-door-crash-mid-turn");

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "read every task note and summarise them",
            attachments: [],
          })
          .pipe(Effect.forkChild);

        // The fixture withholds the prompt answer until a cancel arrives, so
        // the turn is genuinely in flight when the door dies.
        yield* events.awaitType("content.delta");
        assert.isTrue(yield* door.crash(1));

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

        // Exactly one terminal turn event: the door-exit watcher and the
        // prompt's own failure both settle, and the second must be a no-op.
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
  driveDoor(
    readTranscriptFixture("cancel-mid-prompt"),
    ({ adapter, events }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("fm-stop-mid-turn");
        yield* started(adapter, "fm-stop-mid-turn");

        const turnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "read every task note and summarise them",
            attachments: [],
          })
          .pipe(Effect.forkChild);
        yield* events.awaitType("content.delta");

        // Closing the door's scope kills the process, and the prompt request
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
  driveDoor(readTranscriptFixture("first-prompt-allocates"), ({ adapter, door }) =>
    Effect.gen(function* () {
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("fm-wrong-provider"),
          provider: ProviderDriverKind.make("codex"),
          cwd: HOME_CWD,
          runtimeMode: "full-access",
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterValidationError");
      assert.deepStrictEqual(door.spawnedCommands, []);
    }),
  ),
);
