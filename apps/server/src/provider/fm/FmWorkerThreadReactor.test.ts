/**
 * FORK DELTA (fm provider) - what the reactor turns worker observations into.
 *
 * The assertions are on the command stream, because that is the reactor's
 * whole output: it reads one channel and writes orchestration commands.
 * Faking the engine and the projection is what lets a test say "exactly one
 * create" and "no delete, ever" without standing a database up to read the
 * answer back out of.
 *
 * Every test ends by publishing a sentinel worker under a different
 * supervisor and asserting its create is the next command off the queue. The
 * reactor handles its channel in order, so a command that arrives before the
 * sentinel's is an extra one - which is how "creates nothing more" is proved
 * without a sleep or a poll.
 */
import { assert, it } from "@effect/vitest";
import {
  ModelSelection,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import type { FmAdapterShape } from "./FmAdapter.ts";
import type { FmWorkerObservation } from "./FmWorkerSessions.ts";
import { FmWorkerThreadReactorLive } from "./FmWorkerThreadReactor.ts";

const SUPERVISOR = ThreadId.make("fm-thread-1");
const WORKER_THREAD = ThreadId.make("fm-worker.fm-thread-1.fm-w-1");
/** A second supervisor, used only to order the assertions. */
const SENTINEL_SUPERVISOR = ThreadId.make("fm-thread-9");
const SENTINEL_THREAD = ThreadId.make("fm-worker.fm-thread-9.fm-sentinel");
const INSTANCE = ProviderInstanceId.make("fm-home-one");
const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");

const decodeModelSelection = Schema.decodeSync(ModelSelection);

const shellFor = (threadId: ThreadId): OrchestrationThreadShell => ({
  id: threadId,
  projectId: PROJECT,
  title: TrimmedNonEmptyString.make("First Mate"),
  modelSelection: decodeModelSelection({ instanceId: INSTANCE, model: "claude" }),
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

/**
 * The reactor reads three things off the projection and writes nothing back,
 * so a fake that answers those three is the whole of what it needs.
 */
interface ProjectionAnswers {
  /** Threads the projection already holds, and whether each is archived. */
  readonly lifecycles?: ReadonlyMap<string, { readonly archived: boolean }>;
  /** Workspace roots an active project already covers. */
  readonly projectsByRoot?: ReadonlyMap<string, ProjectId>;
  /** Set false to make the supervisor thread unknown to the projection. */
  readonly supervisorKnown?: boolean;
}

const notCalled = (method: string) => (): never => {
  throw new Error(`${method} is not part of the worker path`);
};

/**
 * An fm adapter that is nothing but the worker channel. Every other member is
 * a trap, because the reactor reaching for one would be the defect this stub
 * exists to catch: worker threads are read-only, so nothing here may start a
 * session, send a turn, or stop one.
 */
const makeStubFmAdapter = Effect.gen(function* () {
  const observations = yield* PubSub.unbounded<FmWorkerObservation>();
  const adapter = {
    provider: ProviderDriverKind.make("fm"),
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession: notCalled("startSession"),
    sendTurn: notCalled("sendTurn"),
    interruptTurn: notCalled("interruptTurn"),
    respondToRequest: notCalled("respondToRequest"),
    respondToUserInput: notCalled("respondToUserInput"),
    stopSession: notCalled("stopSession"),
    listSessions: notCalled("listSessions"),
    hasSession: notCalled("hasSession"),
    readThread: notCalled("readThread"),
    rollbackThread: notCalled("rollbackThread"),
    stopAll: notCalled("stopAll"),
    get streamEvents() {
      return Stream.empty;
    },
    get subscribeWorkerObservations() {
      return PubSub.subscribe(observations);
    },
    // The trap members are deliberately not typed: naming a real signature for
    // a member that must never run would only invite somebody to run it.
  } as unknown as FmAdapterShape;
  return { adapter, observations };
});

const withReactor = <A, E>(
  answers: ProjectionAnswers,
  body: (input: {
    /** Publishes observations onto the adapter's worker channel. */
    readonly observe: (...observations: ReadonlyArray<FmWorkerObservation>) => Effect.Effect<void>;
    /** Waits for the next `count` commands the reactor dispatches. */
    readonly nextCommands: (count: number) => Effect.Effect<ReadonlyArray<OrchestrationCommand>>;
    /** Asserts the reactor dispatched nothing else before the sentinel's create. */
    readonly assertNothingElse: Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const stub = yield* makeStubFmAdapter;
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    const registryChanges = yield* PubSub.unbounded<void>();

    const engineLayer = Layer.mock(OrchestrationEngineService)({
      dispatch: (command: OrchestrationCommand) =>
        Queue.offer(dispatched, command).pipe(Effect.as({ sequence: 1 })),
    });

    const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
      getThreadLifecycleById: (threadId: ThreadId) =>
        Effect.succeed(Option.fromUndefinedOr(answers.lifecycles?.get(threadId))),
      getThreadShellById: (threadId: ThreadId) =>
        Effect.succeed(
          threadId === SUPERVISOR && answers.supervisorKnown === false
            ? Option.none()
            : Option.some(shellFor(threadId)),
        ),
      getActiveProjectByWorkspaceRoot: (workspaceRoot: string) => {
        const projectId = answers.projectsByRoot?.get(workspaceRoot);
        // Only the id is read; a whole project row would be scenery.
        return Effect.succeed(
          projectId === undefined
            ? Option.none()
            : Option.some({ id: projectId } as unknown as OrchestrationProject),
        );
      },
    });

    const registryLayer = Layer.mock(ProviderAdapterRegistry)({
      listInstances: () => Effect.succeed([INSTANCE]),
      getByInstance: () => Effect.succeed(stub.adapter),
      subscribeChanges: PubSub.subscribe(registryChanges),
    });

    const observe = (...observations: ReadonlyArray<FmWorkerObservation>) =>
      Effect.forEach(observations, (observation) =>
        PubSub.publish(stub.observations, observation),
      ).pipe(Effect.asVoid);

    const nextCommands = (count: number) => Queue.takeN(dispatched, count);

    const assertNothingElse = Effect.gen(function* () {
      yield* observe({
        _tag: "WorkerAppeared",
        supervisorThreadId: SENTINEL_SUPERVISOR,
        workerSessionId: "fm-sentinel",
        title: undefined,
        cwd: "/repo",
      });
      const [command] = yield* nextCommands(1);
      assert.equal(command?.type, "thread.create");
      assert.equal(
        command?.type === "thread.create" ? command.threadId : undefined,
        SENTINEL_THREAD,
      );
    });

    return yield* body({ observe, nextCommands, assertNothingElse }).pipe(
      Effect.provide(
        FmWorkerThreadReactorLive.pipe(
          Layer.provideMerge(engineLayer),
          Layer.provideMerge(projectionLayer),
          Layer.provideMerge(registryLayer),
          Layer.provideMerge(NodeCrypto.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const appeared = (input?: {
  readonly cwd?: string;
  readonly title?: string;
}): FmWorkerObservation => ({
  _tag: "WorkerAppeared",
  supervisorThreadId: SUPERVISOR,
  workerSessionId: "fm-w-1",
  title: input?.title,
  cwd: input?.cwd ?? "/repo/worker",
});

const disappeared: FmWorkerObservation = {
  _tag: "WorkerDisappeared",
  supervisorThreadId: SUPERVISOR,
  workerSessionId: "fm-w-1",
};

it.effect("creates one read-only thread for a worker that appears", () =>
  withReactor({}, ({ observe, nextCommands, assertNothingElse }) =>
    Effect.gen(function* () {
      yield* observe(appeared({ title: "build the thing" }));

      const [command] = yield* nextCommands(1);
      assert.equal(command?.type, "thread.create");
      if (command?.type !== "thread.create") return;
      assert.equal(command.threadId, WORKER_THREAD);
      assert.equal(command.title, "build the thing");
      // The whole point: no composer, on any client.
      assert.isTrue(command.readOnly);
      // A worker is not a worktree, and inventing a branch for it would put a
      // diff on a thread nobody can act on.
      assert.isNull(command.branch);
      assert.isNull(command.worktreePath);
      // Nothing follows a create: no turn, no provider session, no message.
      // A read-only thread is a window, not a conversation.
      yield* assertNothingElse;
    }),
  ),
);

it.effect("creates nothing more when a later poll reports the same worker", () =>
  withReactor({}, ({ observe, nextCommands, assertNothingElse }) =>
    Effect.gen(function* () {
      yield* observe(appeared());
      yield* nextCommands(1);

      // Two more polls seeing the same worker. The reactor is the last line
      // against a duplicate, after the runtime's diff and the reconcile.
      yield* observe(appeared(), appeared());
      yield* assertNothingElse;
    }),
  ),
);

it.effect("archives a worker thread when the worker goes, and never deletes it", () =>
  withReactor({}, ({ observe, nextCommands, assertNothingElse }) =>
    Effect.gen(function* () {
      yield* observe(appeared(), disappeared);

      const commands = yield* nextCommands(2);
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        // The transcript of finished work is the reason the thread existed,
        // so the worker going away must never reach `thread.delete`.
        ["thread.create", "thread.archive"],
      );
      const archive = commands[1];
      assert.equal(
        archive?.type === "thread.archive" ? archive.threadId : undefined,
        WORKER_THREAD,
      );
      yield* assertNothingElse;
    }),
  ),
);

it.effect("brings an archived worker thread back rather than making a second one", () =>
  withReactor(
    { lifecycles: new Map([[WORKER_THREAD, { archived: true }]]) },
    ({ observe, nextCommands, assertNothingElse }) =>
      Effect.gen(function* () {
        yield* observe(appeared());

        const [command] = yield* nextCommands(1);
        assert.equal(command?.type, "thread.unarchive");
        assert.equal(
          command?.type === "thread.unarchive" ? command.threadId : undefined,
          WORKER_THREAD,
        );
        yield* assertNothingElse;
      }),
  ),
);

it.effect("leaves a thread it already holds alone", () =>
  withReactor(
    { lifecycles: new Map([[WORKER_THREAD, { archived: false }]]) },
    ({ observe, assertNothingElse }) =>
      Effect.gen(function* () {
        yield* observe(appeared());
        yield* assertNothingElse;
      }),
  ),
);

it.effect("writes a worker's text into the worker's own thread", () =>
  withReactor({}, ({ observe, nextCommands, assertNothingElse }) =>
    Effect.gen(function* () {
      yield* observe(
        appeared(),
        {
          _tag: "WorkerText",
          supervisorThreadId: SUPERVISOR,
          workerSessionId: "fm-w-1",
          messageId: "item-1",
          text: "reading the file",
        },
        {
          _tag: "WorkerTextCompleted",
          supervisorThreadId: SUPERVISOR,
          workerSessionId: "fm-w-1",
          messageId: "item-1",
        },
      );

      const commands = yield* nextCommands(3);
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.create", "thread.message.assistant.delta", "thread.message.assistant.complete"],
      );
      // Not the supervisor's thread. That one belongs to the human.
      for (const command of commands.slice(1)) {
        assert.equal("threadId" in command ? command.threadId : undefined, WORKER_THREAD);
      }
      yield* assertNothingElse;
    }),
  ),
);

it.effect("stops asking about a worker whose thread it could not create", () =>
  withReactor({ supervisorKnown: false }, ({ observe, assertNothingElse }) =>
    Effect.gen(function* () {
      // Ten polls' worth. The defect this guards is a subscriber that could
      // not tell an archived thread from a missing one and retried every
      // quarter second for twenty minutes.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* observe(appeared());
      }
      // A worker with no thread has nowhere to put its text either, rather
      // than dispatching into a thread id that does not exist.
      yield* observe({
        _tag: "WorkerText",
        supervisorThreadId: SUPERVISOR,
        workerSessionId: "fm-w-1",
        messageId: "item-1",
        text: "reading the file",
      });

      yield* assertNothingElse;
    }),
  ),
);

it.effect("puts a worker in the project its own directory belongs to", () =>
  withReactor(
    { projectsByRoot: new Map([["/repo/worker", OTHER_PROJECT]]) },
    ({ observe, nextCommands, assertNothingElse }) =>
      Effect.gen(function* () {
        yield* observe(appeared({ cwd: "/repo/worker" }));

        const [command] = yield* nextCommands(1);
        assert.equal(
          command?.type === "thread.create" ? command.projectId : undefined,
          OTHER_PROJECT,
        );
        yield* assertNothingElse;
      }),
  ),
);

it.effect("falls back to the supervisor's project when no project covers the worker", () =>
  withReactor({}, ({ observe, nextCommands, assertNothingElse }) =>
    Effect.gen(function* () {
      yield* observe(appeared({ cwd: "/somewhere/else" }));

      const [command] = yield* nextCommands(1);
      assert.equal(command?.type === "thread.create" ? command.projectId : undefined, PROJECT);
      yield* assertNothingElse;
    }),
  ),
);
