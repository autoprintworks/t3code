/**
 * The environment's own git work is bounded and cached.
 *
 * These tests run the real `RepositoryIdentityResolver` behind the reactor,
 * over a fake git runner, so they state what a loaded environment relies on:
 * identity resolution and git status draw permits from one `GitWorkDepth`
 * gate, and a workspace root already resolved in this process asks `git`
 * nothing until the reactor invalidates it.
 */
import type { OrchestrationCommand, OrchestrationEvent } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../../persistence/Services/ProjectionProjects.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as GitWorkDepth from "../../vcs/GitWorkDepth.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { RepositoryIdentityReactor } from "../Services/RepositoryIdentityReactor.ts";
import { RepositoryIdentityReactorLive } from "./RepositoryIdentityReactor.ts";

const now = "2026-06-01T00:00:00.000Z";

const projectRow = (input: {
  readonly projectId: string;
  readonly workspaceRoot: string;
}): ProjectionProject => ({
  projectId: ProjectId.make(input.projectId),
  title: input.projectId,
  workspaceRoot: input.workspaceRoot,
  repositoryIdentity: null,
  repositoryIdentityWorkspaceRoot: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
});

const projectCreated = (projectId: string, workspaceRoot: string) =>
  ({
    type: "project.created",
    sequence: 1,
    eventId: `evt-${projectId}`,
    commandId: `cmd-${projectId}`,
    aggregateKind: "project",
    aggregateId: projectId,
    actor: { kind: "user" },
    occurredAt: now,
    payload: { projectId, title: projectId, workspaceRoot },
  }) as unknown as OrchestrationEvent;

const projectMetaUpdated = (projectId: string, workspaceRoot: string) =>
  ({
    type: "project.meta-updated",
    sequence: 2,
    eventId: `evt-meta-${projectId}`,
    commandId: `cmd-meta-${projectId}`,
    aggregateKind: "project",
    aggregateId: projectId,
    actor: { kind: "user" },
    occurredAt: now,
    payload: { projectId, workspaceRoot },
  }) as unknown as OrchestrationEvent;

/** The workspace root a recorded identity command is about. */
const recordedRoot = (command: OrchestrationCommand): string =>
  (command as { readonly workspaceRoot: string }).workspaceRoot;

interface GitRunnerOptions {
  /** Holds every spawn open until this resolves, so a test can see the cap. */
  readonly hold?: Deferred.Deferred<void> | undefined;
}

/**
 * A fake git runner that answers the two commands identity resolution asks and
 * records what it was asked, when. `inFlight` and `peakInFlight` are what the
 * cap is read from; `started` lets a test wait for exactly N spawns to begin.
 */
const makeFakeGitRunner = (options: GitRunnerOptions = {}) =>
  Effect.gen(function* () {
    const commands: Array<ReadonlyArray<string>> = [];
    const started = yield* Queue.unbounded<ReadonlyArray<string>>();
    const state = { inFlight: 0, peakInFlight: 0 };

    const stdoutFor = (args: ReadonlyArray<string>): string => {
      if (args.includes("--show-toplevel")) {
        return `${args[1] ?? ""}\n`;
      }
      if (args.includes("remote")) {
        const rootPath = args[1] ?? "";
        return `origin\thttps://github.com/acme${rootPath}.git (fetch)\norigin\thttps://github.com/acme${rootPath}.git (push)\n`;
      }
      return "";
    };

    const runner = ProcessRunner.ProcessRunner.of({
      run: (input: ProcessRunner.ProcessRunInput) =>
        Effect.gen(function* () {
          commands.push(input.args);
          state.inFlight += 1;
          state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
          yield* Queue.offer(started, input.args);
          if (options.hold !== undefined) {
            yield* Deferred.await(options.hold);
          } else {
            yield* Effect.yieldNow;
          }
          state.inFlight -= 1;
          return {
            stdout: stdoutFor(input.args),
            stderr: "",
            code: 0,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }),
    } as unknown as ProcessRunner.ProcessRunner["Service"]);

    return { runner, commands, started, state };
  });

/**
 * Builds the reactor over the real resolver, so the cache and the gate under
 * test are the production ones, and exposes a `VcsProcess` on the same gate so
 * a test can put git status work through it at the same time.
 */
const makeHarness = (input: {
  readonly projects: ReadonlyArray<ProjectionProject>;
  readonly depth: number;
  readonly hold?: Deferred.Deferred<void> | undefined;
}) =>
  Effect.gen(function* () {
    const git = yield* makeFakeGitRunner({ hold: input.hold });
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    const events = yield* Queue.unbounded<OrchestrationEvent>();

    const gitWorkDepthLayer = Layer.succeed(
      GitWorkDepth.GitWorkDepth,
      yield* GitWorkDepth.makeWith(input.depth),
    );
    const runnerLayer = Layer.succeed(ProcessRunner.ProcessRunner, git.runner);

    const engineLayer = Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Queue.offer(dispatched, command).pipe(Effect.as({ sequence: 1 })),
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    } as unknown as typeof OrchestrationEngineService.Service);

    const projectsLayer = Layer.succeed(ProjectionProjectRepository, {
      upsert: () => Effect.die("unused"),
      getById: () => Effect.succeed(Option.none()),
      listAll: () => Effect.succeed(input.projects),
      deleteById: () => Effect.die("unused"),
    });

    const layer = Layer.mergeAll(
      RepositoryIdentityReactorLive,
      Layer.effect(VcsProcess.VcsProcess, VcsProcess.make),
    ).pipe(
      Layer.provide(
        Layer.effect(
          RepositoryIdentityResolver.RepositoryIdentityResolver,
          RepositoryIdentityResolver.make(),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          engineLayer,
          projectsLayer,
          runnerLayer,
          gitWorkDepthLayer,
          NodeCrypto.layer,
        ),
      ),
    );

    return { layer, git, dispatched, events };
  });

/** One git status call, the other side of the gate from identity resolution. */
const runGitStatus = (cwd: string) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    return yield* vcsProcess.run({
      operation: "test.status",
      command: "git",
      args: ["-C", cwd, "status", "--porcelain"],
      cwd,
    });
  });

describe("bounded git work", () => {
  it.effect("holds git status and identity resolution to one shared depth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>();
        const { layer, git } = yield* makeHarness({
          projects: [projectRow({ projectId: "project-a", workspaceRoot: "/w/a" })],
          depth: 1,
          hold,
        });

        yield* Effect.gen(function* () {
          const reactor = yield* RepositoryIdentityReactor;
          const identity = yield* Effect.gen(function* () {
            yield* reactor.start();
            yield* reactor.drain;
          }).pipe(Effect.scoped, Effect.forkChild);
          const status = yield* runGitStatus("/w/a").pipe(Effect.forkChild);

          // One permit, so exactly one spawn is running and nothing else has
          // begun. Both fibers want the gate; only one holds it.
          yield* Queue.take(git.started);
          expect(git.state.inFlight).toBe(1);
          expect(yield* Queue.size(git.started)).toBe(0);

          yield* Deferred.succeed(hold, undefined);
          yield* Fiber.join(status);
          yield* Fiber.join(identity);
        }).pipe(Effect.provide(layer));

        expect(git.state.peakInFlight).toBe(1);
        expect(git.state.inFlight).toBe(0);
        // Both kinds of work went through, so the one permit was shared.
        expect(git.commands.some((args) => args.includes("--show-toplevel"))).toBe(true);
        expect(git.commands.some((args) => args.includes("status"))).toBe(true);
      }),
    ),
  );

  it.effect("never runs more git than the configured depth under load", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const depth = 3;
        const hold = yield* Deferred.make<void>();
        const { layer, git } = yield* makeHarness({
          projects: [
            projectRow({ projectId: "project-a", workspaceRoot: "/w/a" }),
            projectRow({ projectId: "project-b", workspaceRoot: "/w/b" }),
          ],
          depth,
          hold,
        });

        yield* Effect.gen(function* () {
          const reactor = yield* RepositoryIdentityReactor;
          const identity = yield* Effect.gen(function* () {
            yield* reactor.start();
            yield* reactor.drain;
          }).pipe(Effect.scoped, Effect.forkChild);
          const statuses = yield* Effect.forEach(
            ["/w/a", "/w/b", "/w/c", "/w/d", "/w/e", "/w/f"],
            (cwd) => runGitStatus(cwd).pipe(Effect.forkChild),
          );

          // All `depth` permits are held, so no seventh spawn can have begun.
          yield* Effect.forEach([1, 2, 3], () => Queue.take(git.started));
          expect(git.state.inFlight).toBe(depth);
          expect(yield* Queue.size(git.started)).toBe(0);

          yield* Deferred.succeed(hold, undefined);
          yield* Effect.forEach(statuses, Fiber.join);
          yield* Fiber.join(identity);
        }).pipe(Effect.provide(layer));

        expect(git.state.peakInFlight).toBe(depth);
        expect(git.state.inFlight).toBe(0);
      }),
    ),
  );

  it.effect("asks git once for a workspace root two projects share", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, git, dispatched } = yield* makeHarness({
          projects: [
            projectRow({ projectId: "project-a", workspaceRoot: "/w/shared" }),
            projectRow({ projectId: "project-b", workspaceRoot: "/w/shared" }),
          ],
          depth: 4,
        });

        const recorded = yield* Effect.gen(function* () {
          const reactor = yield* RepositoryIdentityReactor;
          yield* reactor.start();
          yield* reactor.drain;
          return yield* Queue.takeAll(dispatched);
        }).pipe(Effect.scoped, Effect.provide(layer));

        // Both projects get an identity recorded...
        expect(recorded.map(recordedRoot)).toEqual(["/w/shared", "/w/shared"]);
        // ...from a single pair of git subprocesses.
        expect(git.commands).toEqual([
          ["-C", "/w/shared", "rev-parse", "--show-toplevel"],
          ["-C", "/w/shared", "remote", "-v"],
        ]);
      }),
    ),
  );

  it.effect("serves a repeated lookup from cache and re-reads after a root is saved", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, git, dispatched, events } = yield* makeHarness({
          projects: [],
          depth: 4,
        });

        const spawnsAfterRepeat = yield* Effect.gen(function* () {
          const reactor = yield* RepositoryIdentityReactor;
          yield* reactor.start();

          yield* Queue.offer(events, projectCreated("project-a", "/w/shared"));
          yield* Queue.take(dispatched);
          const spawnsAfterFirst = git.commands.length;

          // A second project on the same root asks the same git question.
          yield* Queue.offer(events, projectCreated("project-b", "/w/shared"));
          yield* Queue.take(dispatched);
          const spawnsAfterRepeat = git.commands.length;

          // Re-saving the folder is the user's manual refresh, so it must reach
          // git even though the root has not changed.
          yield* Queue.offer(events, projectMetaUpdated("project-a", "/w/shared"));
          yield* Queue.take(dispatched);
          const spawnsAfterResave = git.commands.length;

          return { spawnsAfterFirst, spawnsAfterRepeat, spawnsAfterResave };
        }).pipe(Effect.scoped, Effect.provide(layer));

        expect(spawnsAfterRepeat.spawnsAfterFirst).toBe(2);
        // The repeat issued no git subprocess at all.
        expect(spawnsAfterRepeat.spawnsAfterRepeat).toBe(2);
        // The saved root invalidated the entry, so git ran again.
        expect(spawnsAfterRepeat.spawnsAfterResave).toBe(4);
      }),
    ),
  );
});
