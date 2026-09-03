/**
 * What the reactor turns worker observations into.
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
  ACP_AGENT_DRIVER_KIND,
  ModelSelection,
  type OrchestrationCommand,
  type OrchestrationProject,
  type OrchestrationThreadShell,
  ProjectId,
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
import type { AcpAgentAdapterShape } from "./AcpAgentAdapter.ts";
import type {
  AcpAgentWorkerEndReason,
  AcpAgentWorkerObservation,
} from "./AcpAgentWorkerSessions.ts";
import { AcpAgentWorkerThreadQuery } from "./AcpAgentWorkerThreadQuery.ts";
import { AcpAgentWorkerThreadReactorLive } from "./AcpAgentWorkerThreadReactor.ts";

const SUPERVISOR = ThreadId.make("thread-1");
/** The agent's own session id, which is what a worker thread is named after. */
const HOME = "home-1";
const WORKER_THREAD = ThreadId.make("acp-worker.home-1.w-1");
/** A second supervisor on a second home, used only to order the assertions. */
const SENTINEL_SUPERVISOR = ThreadId.make("thread-9");
const SENTINEL_HOME = "home-9";
const SENTINEL_THREAD = ThreadId.make("acp-worker.home-9.sentinel-worker");
const INSTANCE = ProviderInstanceId.make("acp-agent-one");
const PROJECT = ProjectId.make("project-1");
const OTHER_PROJECT = ProjectId.make("project-2");

const decodeModelSelection = Schema.decodeSync(ModelSelection);

const shellFor = (threadId: ThreadId): OrchestrationThreadShell => ({
  id: threadId,
  projectId: PROJECT,
  title: TrimmedNonEmptyString.make("Example agent"),
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
  /** Worker threads this home already has on disk, as the sweep would find them. */
  readonly existingWorkerThreadIds?: ReadonlyArray<ThreadId>;
  /** Assistant message ids a thread already holds, as an adoption would read them. */
  readonly assistantMessageIds?: ReadonlyArray<string>;
}

const notCalled = (method: string) => (): never => {
  throw new Error(`${method} is not part of the worker path`);
};

/**
 * An adapter that is nothing but the worker channel. Every other member is
 * a trap, because the reactor reaching for one would be the defect this stub
 * exists to catch: worker threads are read-only, so nothing here may start a
 * session, send a turn, or stop one.
 */
const makeStubAcpAgentAdapter = Effect.gen(function* () {
  const observations = yield* PubSub.unbounded<AcpAgentWorkerObservation>();
  const adapter = {
    provider: ACP_AGENT_DRIVER_KIND,
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
  } as unknown as AcpAgentAdapterShape;
  return { adapter, observations };
});

const withReactor = <A, E>(
  answers: ProjectionAnswers,
  body: (input: {
    /** Publishes observations onto the adapter's worker channel. */
    readonly observe: (
      ...observations: ReadonlyArray<AcpAgentWorkerObservation>
    ) => Effect.Effect<void>;
    /** Waits for the next `count` commands the reactor dispatches. */
    readonly nextCommands: (count: number) => Effect.Effect<ReadonlyArray<OrchestrationCommand>>;
    /** Asserts the reactor dispatched nothing else before the sentinel's create. */
    readonly assertNothingElse: Effect.Effect<void>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const stub = yield* makeStubAcpAgentAdapter;
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

    const workerQueryLayer = Layer.mock(AcpAgentWorkerThreadQuery)({
      listActiveThreadIdsByPrefix: () => Effect.succeed(answers.existingWorkerThreadIds ?? []),
      listThreadAssistantMessageIds: () => Effect.succeed(answers.assistantMessageIds ?? []),
    });

    const registryLayer = Layer.mock(ProviderAdapterRegistry)({
      listInstances: () => Effect.succeed([INSTANCE]),
      getByInstance: () => Effect.succeed(stub.adapter),
      subscribeChanges: PubSub.subscribe(registryChanges),
    });

    const observe = (...observations: ReadonlyArray<AcpAgentWorkerObservation>) =>
      Effect.forEach(observations, (observation) =>
        PubSub.publish(stub.observations, observation),
      ).pipe(Effect.asVoid);

    const nextCommands = (count: number) => Queue.takeN(dispatched, count);

    const assertNothingElse = Effect.gen(function* () {
      yield* observe({
        _tag: "WorkerAppeared",
        supervisorThreadId: SENTINEL_SUPERVISOR,
        homeSessionId: SENTINEL_HOME,
        workerSessionId: "sentinel-worker",
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
        AcpAgentWorkerThreadReactorLive.pipe(
          Layer.provideMerge(engineLayer),
          Layer.provideMerge(projectionLayer),
          Layer.provideMerge(registryLayer),
          Layer.provideMerge(workerQueryLayer),
          Layer.provideMerge(NodeCrypto.layer),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const appeared = (input?: {
  readonly cwd?: string;
  readonly title?: string;
}): AcpAgentWorkerObservation => ({
  _tag: "WorkerAppeared",
  supervisorThreadId: SUPERVISOR,
  homeSessionId: HOME,
  workerSessionId: "w-1",
  title: input?.title,
  cwd: input?.cwd ?? "/repo/worker",
});

const gone = (reason: AcpAgentWorkerEndReason): AcpAgentWorkerObservation => ({
  _tag: "WorkerDisappeared",
  supervisorThreadId: SUPERVISOR,
  homeSessionId: HOME,
  workerSessionId: "w-1",
  reason,
});

const roster = (...workerSessionIds: ReadonlyArray<string>): AcpAgentWorkerObservation => ({
  _tag: "WorkerRoster",
  supervisorThreadId: SUPERVISOR,
  homeSessionId: HOME,
  workerSessionIds,
});

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
      yield* observe(appeared(), gone("finished"));

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
          homeSessionId: HOME,
          workerSessionId: "w-1",
          messageId: "item-1",
          text: "reading the file",
        },
        {
          _tag: "WorkerTextCompleted",
          supervisorThreadId: SUPERVISOR,
          homeSessionId: HOME,
          workerSessionId: "w-1",
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
        homeSessionId: HOME,
        workerSessionId: "w-1",
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

it.effect("leaves a worker thread alone when the watch ends rather than the worker", () =>
  withReactor({}, ({ observe, nextCommands, assertNothingElse }) =>
    Effect.gen(function* () {
      // A supervising agent and its workers outlive an editor restart. Archiving on
      // a lost connection would file away work that is still running.
      yield* observe(appeared(), gone("unknown"));

      const commands = yield* nextCommands(1);
      assert.deepStrictEqual(
        commands.map((command) => command.type),
        ["thread.create"],
      );
      yield* assertNothingElse;
    }),
  ),
);

it.effect("archives the worker threads a restart left behind", () =>
  withReactor(
    {
      existingWorkerThreadIds: [WORKER_THREAD, ThreadId.make("acp-worker.home-1.w-stale")],
    },
    ({ observe, nextCommands, assertNothingElse }) =>
      Effect.gen(function* () {
        // One worker is still listed, the other ended while the editor was
        // not running. Nothing else sweeps, so the first roster has to.
        yield* observe(roster("w-1"));

        const [command] = yield* nextCommands(1);
        assert.equal(command?.type, "thread.archive");
        assert.equal(
          command?.type === "thread.archive" ? command.threadId : undefined,
          ThreadId.make("acp-worker.home-1.w-stale"),
        );
        // Once per home per process: a later roster must not re-read or
        // re-archive, or the poll would cost a query every two seconds.
        yield* observe(roster("w-1"));
        yield* assertNothingElse;
      }),
  ),
);

it.effect("says so in the thread when a worker's transcript cannot be read", () =>
  withReactor({}, ({ observe, nextCommands, assertNothingElse }) =>
    Effect.gen(function* () {
      yield* observe(appeared(), {
        _tag: "WorkerLoadFailed",
        supervisorThreadId: SUPERVISOR,
        homeSessionId: HOME,
        workerSessionId: "w-1",
        detail: "session/load timed out after 60000ms",
      });

      const commands = yield* nextCommands(2);
      const activity = commands[1];
      assert.equal(activity?.type, "thread.activity.append");
      if (activity?.type !== "thread.activity.append") return;
      assert.equal(activity.threadId, WORKER_THREAD);
      // An empty thread with no explanation is the symptom a user cannot tell
      // apart from a thread that is still loading.
      assert.equal(activity.activity.tone, "error");
      assert.equal(activity.activity.kind, "acp.worker.transcript-unavailable");
      yield* assertNothingElse;
    }),
  ),
);

it.effect("writes nothing twice when a reload replays a message the thread has", () =>
  withReactor(
    {
      lifecycles: new Map([[WORKER_THREAD, { archived: false }]]),
      assistantMessageIds: ["item-1"],
    },
    ({ observe, assertNothingElse }) =>
      Effect.gen(function* () {
        // `session/load` replays the whole history under the same ids, and a
        // delta appends, so writing it again would double the message.
        yield* observe(
          appeared(),
          {
            _tag: "WorkerText",
            supervisorThreadId: SUPERVISOR,
            homeSessionId: HOME,
            workerSessionId: "w-1",
            messageId: "item-1",
            text: "reading the file",
          },
          {
            _tag: "WorkerTextCompleted",
            supervisorThreadId: SUPERVISOR,
            homeSessionId: HOME,
            workerSessionId: "w-1",
            messageId: "item-1",
          },
        );

        yield* assertNothingElse;
      }),
  ),
);
