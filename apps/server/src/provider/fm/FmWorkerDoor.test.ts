/**
 * FORK DELTA (fm provider) - the wire half of worker threads.
 *
 * These fixtures are written here rather than vendored, because they record
 * exchanges the door's own golden transcripts do not yet cover: `session/list`
 * answered more than once, with the set of workers changing between answers.
 * Everything above the spawner is the shipping path, so what is asserted is
 * what the driver really writes and really routes.
 *
 * @see FmTranscript.test.ts for the certification suite against the real
 *   recordings.
 * @see FmWorkerThreadReactor.test.ts for what the observations become.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { FmSettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type FmAdapterLiveOptions, type FmAdapterShape, makeFmAdapter } from "./FmAdapter.ts";
import {
  type FmTranscriptFixture,
  type JsonRecord,
  makeTranscriptDoor,
  observedParams,
  readTranscriptFixture,
  type TranscriptDoor,
  watchProviderEvents,
} from "./FmTranscriptDoor.ts";
import type { FmWorkerObservation } from "./FmWorkerSessions.ts";

const decodeFmSettings = Schema.decodeSync(FmSettings);
const FM = ProviderDriverKind.make("fm");
const INSTANCE = ProviderInstanceId.make("fm-home-one");
const HOME_CWD = "C:/Users/captain/projects/firstmate";
const SUPERVISOR_SESSION = "fm-supervisor";
const WORKER_SESSION = "fm-w-1";
/**
 * The whole of the interval, spent on a virtual clock. `it.effect` runs on a
 * test clock, so the poll's own `Schedule.spaced` never fires by itself and a
 * test that wants a second poll has to ask for one.
 */
const POLL_INTERVAL = Duration.millis(10);

const workerRow = {
  sessionId: WORKER_SESSION,
  cwd: "C:/Users/captain/projects/firstmate/worker",
  title: "build the thing",
};
const supervisorRow = { sessionId: SUPERVISOR_SESSION, cwd: HOME_CWD, title: "First Mate" };

/**
 * A door that advertises `session/list` and answers it once per recorded
 * `sessions` array, in order.
 *
 * The worker's replay is attached to the `session/load` answer because that is
 * where the real door puts it: loading a session is what streams its history
 * back.
 */
const peerFixture = (input: {
  readonly why: string;
  readonly lists: ReadonlyArray<ReadonlyArray<JsonRecord>>;
  readonly replay?: ReadonlyArray<JsonRecord>;
}): FmTranscriptFixture => {
  const loadId = 2 + input.lists.length;
  return {
    why: input.why,
    session: SUPERVISOR_SESSION,
    allocates: false,
    supervisor: {},
    host: [
      { id: 0, jsonrpc: "2.0", method: "initialize" },
      { id: 1, jsonrpc: "2.0", method: "session/new" },
      ...input.lists.map((_, index) => ({
        id: 2 + index,
        jsonrpc: "2.0",
        method: "session/list",
      })),
      { id: loadId, jsonrpc: "2.0", method: "session/load" },
    ],
    door: [
      {
        id: 0,
        jsonrpc: "2.0",
        result: {
          protocolVersion: 1,
          authMethods: [],
          agentCapabilities: {
            loadSession: true,
            // The capability is spelled as presence, which is what makes the
            // runtime start polling at all.
            sessionCapabilities: { list: {} },
            promptCapabilities: { audio: false, embeddedContext: false, image: false },
          },
        },
      },
      { id: 1, jsonrpc: "2.0", result: { sessionId: SUPERVISOR_SESSION } },
      ...input.lists.map((sessions, index) => ({
        id: 2 + index,
        jsonrpc: "2.0",
        result: { sessions },
      })),
      ...(input.replay ?? []),
      { id: loadId, jsonrpc: "2.0", result: {} },
    ],
  };
};

/**
 * Collects worker observations as they are published and lets a test wait for
 * one by shape.
 *
 * The subscription is taken before `startSession`, in the caller's own fiber,
 * for the same reason the adapter takes its peer subscription before `start`:
 * the first poll is immediate, and a consumer that subscribes afterwards would
 * be waiting for an appearance nobody will republish.
 */
const watchWorkerObservations = (adapter: FmAdapterShape) =>
  Effect.gen(function* () {
    const seen: Array<FmWorkerObservation> = [];
    const waiters: Array<{
      readonly match: (observation: FmWorkerObservation) => boolean;
      readonly deferred: Deferred.Deferred<FmWorkerObservation>;
    }> = [];
    const subscription = yield* adapter.subscribeWorkerObservations;

    const fiber = yield* Stream.runForEach(Stream.fromSubscription(subscription), (observation) =>
      Effect.gen(function* () {
        seen.push(observation);
        const matched = waiters.filter((waiter) => waiter.match(observation));
        for (const waiter of matched) {
          waiters.splice(waiters.indexOf(waiter), 1);
          yield* Deferred.succeed(waiter.deferred, observation);
        }
      }),
    ).pipe(Effect.forkChild);

    const awaitObservation = (match: (observation: FmWorkerObservation) => boolean) =>
      Effect.gen(function* () {
        const existing = seen.find(match);
        if (existing !== undefined) {
          return existing;
        }
        const deferred = yield* Deferred.make<FmWorkerObservation>();
        waiters.push({ match, deferred });
        return yield* Deferred.await(deferred);
      });

    return {
      seen,
      awaitObservation,
      awaitTag: (tag: FmWorkerObservation["_tag"]) =>
        awaitObservation((observation) => observation._tag === tag),
      stop: Fiber.interrupt(fiber),
    };
  });

const driveDoor = <A, E>(
  fixture: FmTranscriptFixture,
  body: (input: {
    readonly adapter: FmAdapterShape;
    readonly door: TranscriptDoor;
  }) => Effect.Effect<A, E, Scope.Scope>,
  options?: FmAdapterLiveOptions,
) =>
  Effect.gen(function* () {
    const door = yield* makeTranscriptDoor(fixture);
    return yield* Effect.gen(function* () {
      const adapter = yield* makeFmAdapter(decodeFmSettings({}), {
        instanceId: INSTANCE,
        peerSessionPollInterval: POLL_INTERVAL,
        ...options,
      }).pipe(Effect.orDie);
      return yield* body({ adapter, door });
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

const startSupervisor = (adapter: FmAdapterShape, threadId: ThreadId) =>
  adapter.startSession({ threadId, provider: FM, cwd: HOME_CWD, runtimeMode: "full-access" });

/**
 * Advances the virtual clock until the door has been asked for its session
 * list `count` times. No real time passes: each step wakes the poll's sleep,
 * and the loop stops as soon as the request it was waiting for is on the wire.
 */
const pollUntilListed = (door: TranscriptDoor, count: number) =>
  TestClock.adjust(POLL_INTERVAL).pipe(
    Effect.repeat({
      until: () => observedParams(door, "session/list", count - 1) !== undefined,
    }),
    Effect.asVoid,
  );

it.effect("never asks a door that did not say it answers session/list", () =>
  Effect.gen(function* () {
    const fixture = readTranscriptFixture("first-prompt-allocates");
    const door = yield* makeTranscriptDoor(fixture);
    yield* Effect.gen(function* () {
      const adapter = yield* makeFmAdapter(decodeFmSettings({}), {
        instanceId: INSTANCE,
        peerSessionPollInterval: POLL_INTERVAL,
      }).pipe(Effect.orDie);
      const threadId = ThreadId.make("fm-no-capability");
      yield* startSupervisor(adapter, threadId);
      // A whole turn's worth of round trips, so a poll that was going to
      // happen has had every chance to. The recorded `initialize` answer
      // carries no `sessionCapabilities`, so there must be none.
      yield* adapter.sendTurn({ threadId, input: "what is the fleet doing?", attachments: [] });

      assert.deepStrictEqual(door.observedMethods(), [
        "initialize",
        "session/new",
        "session/prompt",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, door.spawner),
          NodeCrypto.layer,
        ),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("finds a worker, loads it once, and routes its text away from the supervisor", () =>
  driveDoor(
    peerFixture({
      why: "One worker, still there on the second poll, replaying one message.",
      lists: [
        [supervisorRow, workerRow],
        [supervisorRow, workerRow],
      ],
      replay: [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: WORKER_SESSION,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "reading the file" },
            },
          },
        },
      ],
    }),
    ({ adapter, door }) =>
      Effect.gen(function* () {
        const workers = yield* watchWorkerObservations(adapter);
        const events = yield* watchProviderEvents(adapter);
        yield* startSupervisor(adapter, ThreadId.make("fm-peer-load"));

        const appeared = yield* workers.awaitTag("WorkerAppeared");
        assert.equal(
          appeared._tag === "WorkerAppeared" ? appeared.workerSessionId : undefined,
          WORKER_SESSION,
        );
        assert.equal(
          appeared._tag === "WorkerAppeared" ? appeared.title : undefined,
          "build the thing",
        );
        // The worker's own directory travels with it, so the thread can land
        // in the project that actually covers the work.
        assert.equal(appeared._tag === "WorkerAppeared" ? appeared.cwd : undefined, workerRow.cwd);

        const text = yield* workers.awaitTag("WorkerText");
        assert.equal(text._tag === "WorkerText" ? text.text : undefined, "reading the file");
        assert.equal(text._tag === "WorkerText" ? text.workerSessionId : undefined, WORKER_SESSION);

        // The supervisor's own session is untouched. A worker's chunk landing
        // there would print another agent's work in the human's thread.
        assert.deepStrictEqual(
          events.seen.filter((event) => event.type === "content.delta"),
          [],
        );
        // The load asked for the worker and for nothing else.
        assert.deepStrictEqual(observedParams(door, "session/load")?.sessionId, WORKER_SESSION);

        // A second poll seeing the same worker asks for nothing again: the
        // session is already loaded, and loading it twice would replay its
        // history into the thread a second time.
        yield* pollUntilListed(door, 2);
        assert.isUndefined(observedParams(door, "session/load", 1));

        yield* events.stop;
        yield* workers.stop;
      }),
  ),
);

it.effect("reports one worker across repeated polls, then says it is gone", () =>
  driveDoor(
    peerFixture({
      why: "The same worker on two polls, gone on the third.",
      lists: [[supervisorRow, workerRow], [supervisorRow, workerRow], [supervisorRow]],
    }),
    ({ adapter, door }) =>
      Effect.gen(function* () {
        const workers = yield* watchWorkerObservations(adapter);
        yield* startSupervisor(adapter, ThreadId.make("fm-peer-gone"));

        yield* workers.awaitTag("WorkerAppeared");
        yield* pollUntilListed(door, 3);
        const gone = yield* workers.awaitTag("WorkerDisappeared");
        assert.equal(
          gone._tag === "WorkerDisappeared" ? gone.workerSessionId : undefined,
          WORKER_SESSION,
        );

        // The disappearance is only reachable through the third answer, so
        // reaching it proves the second poll ran - and the second poll saw the
        // same worker and said nothing about it.
        assert.equal(
          workers.seen.filter((observation) => observation._tag === "WorkerAppeared").length,
          1,
        );
        assert.isDefined(observedParams(door, "session/list", 2));

        yield* workers.stop;
      }),
  ),
);
