/**
 * The wire half of worker threads.
 *
 * These fixtures are written here rather than vendored, because they record
 * exchanges the recorded transcripts do not yet cover: `session/list`
 * answered more than once, with the set of workers changing between answers.
 * Everything above the spawner is the shipping path, so what is asserted is
 * what the driver really writes and really routes.
 *
 * @see AcpAgentTranscript.test.ts for the certification suite against the real
 *   recordings.
 * @see AcpAgentWorkerThreadReactor.test.ts for what the observations become.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ACP_AGENT_DRIVER_KIND,
  AcpAgentSettings,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
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

import {
  type AcpAgentAdapterLiveOptions,
  type AcpAgentAdapterShape,
  makeAcpAgentAdapter,
} from "./AcpAgentAdapter.ts";
import { makeAcpAgentRuntime } from "./AcpAgentSupport.ts";
import {
  type AcpTranscriptFixture,
  type JsonRecord,
  makeTranscriptAgent,
  observedParams,
  readTranscriptFixture,
  type TranscriptAgent,
  type TranscriptAgentOptions,
  watchProviderEvents,
} from "./AcpAgentTranscriptAgent.ts";
import type { AcpAgentWorkerObservation } from "./AcpAgentWorkerSessions.ts";

const decodeAcpAgentSettings = Schema.decodeSync(AcpAgentSettings);
const PROVIDER = ACP_AGENT_DRIVER_KIND;
const INSTANCE = ProviderInstanceId.make("acp-agent-one");
const HOME_CWD = "C:/Users/captain/projects/example";
const SUPERVISOR_SESSION = "supervisor-session";
const WORKER_SESSION = "w-1";
/**
 * The whole of the interval, spent on a virtual clock. `it.effect` runs on a
 * test clock, so the poll's own `Schedule.spaced` never fires by itself and a
 * test that wants a second poll has to ask for one.
 */
const POLL_INTERVAL = Duration.millis(10);

const SECOND_WORKER_SESSION = "w-2";

const secondWorkerRow = {
  sessionId: SECOND_WORKER_SESSION,
  cwd: "C:/Users/captain/projects/example/worker-2",
  title: "write the tests",
};

const workerRow = {
  sessionId: WORKER_SESSION,
  cwd: "C:/Users/captain/projects/example/worker",
  title: "build the thing",
};
const supervisorRow = { sessionId: SUPERVISOR_SESSION, cwd: HOME_CWD, title: "supervisor" };

/**
 * An agent that advertises `session/list` and answers it once per recorded
 * `sessions` array, in order.
 *
 * The worker's replay is attached to the `session/load` answer because that is
 * where a real agent puts it: loading a session is what streams its history
 * back.
 */
const peerFixture = (input: {
  readonly why: string;
  readonly lists: ReadonlyArray<ReadonlyArray<JsonRecord>>;
  readonly replay?: ReadonlyArray<JsonRecord>;
}): AcpTranscriptFixture => {
  const loadId = 2 + input.lists.length;
  return {
    why: input.why,
    session: SUPERVISOR_SESSION,
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
    agent: [
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
const watchWorkerObservations = (adapter: AcpAgentAdapterShape) =>
  Effect.gen(function* () {
    const seen: Array<AcpAgentWorkerObservation> = [];
    const waiters: Array<{
      readonly match: (observation: AcpAgentWorkerObservation) => boolean;
      readonly deferred: Deferred.Deferred<AcpAgentWorkerObservation>;
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

    const awaitObservation = (match: (observation: AcpAgentWorkerObservation) => boolean) =>
      Effect.gen(function* () {
        const existing = seen.find(match);
        if (existing !== undefined) {
          return existing;
        }
        const deferred = yield* Deferred.make<AcpAgentWorkerObservation>();
        waiters.push({ match, deferred });
        return yield* Deferred.await(deferred);
      });

    return {
      seen,
      awaitObservation,
      awaitTag: (tag: AcpAgentWorkerObservation["_tag"]) =>
        awaitObservation((observation) => observation._tag === tag),
      stop: Fiber.interrupt(fiber),
    };
  });

const driveAgent = <A, E>(
  fixture: AcpTranscriptFixture,
  body: (input: {
    readonly adapter: AcpAgentAdapterShape;
    readonly agent: TranscriptAgent;
  }) => Effect.Effect<A, E, Scope.Scope>,
  options?: AcpAgentAdapterLiveOptions,
  agentOptions?: TranscriptAgentOptions,
) =>
  Effect.gen(function* () {
    const agent = yield* makeTranscriptAgent(fixture, agentOptions);
    return yield* Effect.gen(function* () {
      const adapter = yield* makeAcpAgentAdapter(decodeAcpAgentSettings({}), {
        instanceId: INSTANCE,
        peerSessionPollInterval: POLL_INTERVAL,
        ...options,
      }).pipe(Effect.orDie);
      return yield* body({ adapter, agent });
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

const startSupervisor = (adapter: AcpAgentAdapterShape, threadId: ThreadId) =>
  adapter.startSession({ threadId, provider: PROVIDER, cwd: HOME_CWD, runtimeMode: "full-access" });

/**
 * Advances the virtual clock until the agent has been asked for its session
 * list `count` times. No real time passes: each step wakes the poll's sleep,
 * and the loop stops as soon as the request it was waiting for is on the wire.
 */
const pollUntilListed = (agent: TranscriptAgent, count: number) =>
  TestClock.adjust(POLL_INTERVAL).pipe(
    Effect.repeat({
      until: () => observedParams(agent, "session/list", count - 1) !== undefined,
    }),
    Effect.asVoid,
  );

it.effect("never asks an agent that did not say it answers session/list", () =>
  Effect.gen(function* () {
    const fixture = readTranscriptFixture("first-prompt-opens-a-session");
    const agent = yield* makeTranscriptAgent(fixture);
    yield* Effect.gen(function* () {
      const adapter = yield* makeAcpAgentAdapter(decodeAcpAgentSettings({}), {
        instanceId: INSTANCE,
        peerSessionPollInterval: POLL_INTERVAL,
      }).pipe(Effect.orDie);
      const threadId = ThreadId.make("no-capability");
      yield* startSupervisor(adapter, threadId);
      // A whole turn's worth of round trips, so a poll that was going to
      // happen has had every chance to. The recorded `initialize` answer
      // carries no `sessionCapabilities`, so there must be none.
      yield* adapter.sendTurn({ threadId, input: "what is the fleet doing?", attachments: [] });

      assert.deepStrictEqual(agent.observedMethods(), [
        "initialize",
        "session/new",
        "session/prompt",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, agent.spawner),
          NodeCrypto.layer,
        ),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("finds a worker, loads it once, and routes its text away from the supervisor", () =>
  driveAgent(
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
    ({ adapter, agent }) =>
      Effect.gen(function* () {
        const workers = yield* watchWorkerObservations(adapter);
        const events = yield* watchProviderEvents(adapter);
        yield* startSupervisor(adapter, ThreadId.make("peer-load"));

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
        assert.deepStrictEqual(observedParams(agent, "session/load")?.sessionId, WORKER_SESSION);

        // A second poll seeing the same worker asks for nothing again: the
        // session is already loaded, and loading it twice would replay its
        // history into the thread a second time.
        yield* pollUntilListed(agent, 2);
        assert.isUndefined(observedParams(agent, "session/load", 1));

        yield* events.stop;
        yield* workers.stop;
      }),
  ),
);

it.effect("reports one worker across repeated polls, then says it is gone", () =>
  driveAgent(
    peerFixture({
      why: "The same worker on two polls, gone on the third.",
      lists: [[supervisorRow, workerRow], [supervisorRow, workerRow], [supervisorRow]],
    }),
    ({ adapter, agent }) =>
      Effect.gen(function* () {
        const workers = yield* watchWorkerObservations(adapter);
        yield* startSupervisor(adapter, ThreadId.make("peer-gone"));

        yield* workers.awaitTag("WorkerAppeared");
        yield* pollUntilListed(agent, 3);
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
        assert.isDefined(observedParams(agent, "session/list", 2));

        yield* workers.stop;
      }),
  ),
);

/**
 * The load timeout `AcpSessionRuntime` applies to a peer `session/load`.
 *
 * Named here rather than configured, so the number this suite waits out is the
 * number that ships.
 */
const PEER_LOAD_TIMEOUT = Duration.seconds(60);

it.effect("keeps finding workers while an agent sits on one session/load", () =>
  driveAgent(
    peerFixture({
      why: "An agent that accepts session/load and never answers it.",
      lists: [
        [supervisorRow, workerRow],
        [supervisorRow, workerRow, secondWorkerRow],
      ],
    }),
    ({ adapter, agent }) =>
      Effect.gen(function* () {
        const workers = yield* watchWorkerObservations(adapter);
        yield* startSupervisor(adapter, ThreadId.make("peer-hung-load"));

        yield* workers.awaitTag("WorkerAppeared");

        // The load for the first worker is on the wire and will never be
        // answered. If it were awaited inline, this is where everything would
        // stop: the second worker only exists in the second poll's answer.
        yield* pollUntilListed(agent, 2);
        yield* workers.awaitObservation(
          (observation) =>
            observation._tag === "WorkerAppeared" &&
            observation.workerSessionId === SECOND_WORKER_SESSION,
        );

        // And the hung request is bounded rather than held forever: it ends by
        // saying so in the worker's own thread.
        yield* TestClock.adjust(PEER_LOAD_TIMEOUT);
        const failed = yield* workers.awaitTag("WorkerLoadFailed");
        assert.equal(
          failed._tag === "WorkerLoadFailed" ? failed.workerSessionId : undefined,
          WORKER_SESSION,
        );

        yield* workers.stop;
      }),
    undefined,
    { silentMethods: ["session/load"] },
  ),
);

it.effect("says a worker is gone even while its own load is still hanging", () =>
  driveAgent(
    peerFixture({
      why: "The worker is listed once, then gone, and its load never answers.",
      lists: [[supervisorRow, workerRow], [supervisorRow]],
    }),
    ({ adapter, agent }) =>
      Effect.gen(function* () {
        const workers = yield* watchWorkerObservations(adapter);
        yield* startSupervisor(adapter, ThreadId.make("peer-vanish-mid-load"));

        yield* workers.awaitTag("WorkerAppeared");
        yield* pollUntilListed(agent, 2);

        // "Gone" is decided by the agent answering `session/list` without it,
        // not by whether the load that was in flight ever came back.
        const gone = yield* workers.awaitTag("WorkerDisappeared");
        assert.equal(
          gone._tag === "WorkerDisappeared" ? gone.workerSessionId : undefined,
          WORKER_SESSION,
        );
        assert.equal(gone._tag === "WorkerDisappeared" ? gone.reason : undefined, "finished");

        // One attempt, and no second one: a load that failed is a terminal
        // statement about that worker, not a retry loop.
        yield* TestClock.adjust(PEER_LOAD_TIMEOUT);
        yield* workers.awaitTag("WorkerLoadFailed");
        assert.isUndefined(observedParams(agent, "session/load", 1));

        yield* workers.stop;
      }),
    undefined,
    { silentMethods: ["session/load"] },
  ),
);

it.effect("asks an agent nothing at all while nobody is watching its workers", () =>
  Effect.gen(function* () {
    const fixture = peerFixture({
      why: "The capability is advertised, so only the missing subscriber can stop the poll.",
      lists: [[supervisorRow, workerRow]],
    });
    const agent = yield* makeTranscriptAgent(fixture);
    yield* Effect.gen(function* () {
      const runtime = yield* makeAcpAgentRuntime({
        agentSettings: decodeAcpAgentSettings({}),
        childProcessSpawner: agent.spawner,
        cwd: HOME_CWD,
        clientInfo: { name: "t3-code", version: "0.0.0" },
        peerSessions: { pollInterval: POLL_INTERVAL },
      }).pipe(Effect.orDie);

      yield* runtime.acp.start().pipe(Effect.orDie);
      // Ten intervals' worth. The poll loop is forked and running; what it is
      // not doing is asking, because subscribing is the on switch.
      yield* TestClock.adjust(Duration.times(POLL_INTERVAL, 10));

      assert.deepStrictEqual(agent.observedMethods(), ["initialize", "session/new"]);
    }).pipe(Effect.provide(NodeCrypto.layer), Effect.scoped);
  }),
);
