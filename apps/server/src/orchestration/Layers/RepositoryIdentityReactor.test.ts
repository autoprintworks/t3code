/**
 * RepositoryIdentityReactor owns the only `git` spawn for repository identity.
 *
 * These tests state the two triggers that keep the read path free of spawns:
 * the project events that ask for a fresh resolution, and the start-up sweep
 * that catches up rows whose stored identity no longer belongs to their
 * workspace root.
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../../persistence/Services/ProjectionProjects.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { RepositoryIdentityReactor } from "../Services/RepositoryIdentityReactor.ts";
import { RepositoryIdentityReactorLive } from "./RepositoryIdentityReactor.ts";

const now = "2026-06-01T00:00:00.000Z";

const identityFor = (rootPath: string): RepositoryIdentity => ({
  canonicalKey: `github.com/acme${rootPath}`,
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: `https://github.com/acme${rootPath}.git`,
  },
  rootPath,
});

const projectRow = (input: {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentityWorkspaceRoot: string | null;
  readonly deletedAt?: string;
}): ProjectionProject => ({
  projectId: ProjectId.make(input.projectId),
  title: input.projectId,
  workspaceRoot: input.workspaceRoot,
  repositoryIdentity:
    input.repositoryIdentityWorkspaceRoot === null
      ? null
      : identityFor(input.repositoryIdentityWorkspaceRoot),
  repositoryIdentityWorkspaceRoot: input.repositoryIdentityWorkspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: now,
  updatedAt: now,
  deletedAt: input.deletedAt ?? null,
});

interface Harness {
  readonly resolveCalls: Array<string>;
  readonly invalidateCalls: Array<string>;
  readonly dispatched: Queue.Queue<OrchestrationCommand>;
  readonly events: Queue.Queue<OrchestrationEvent>;
}

/**
 * Builds the reactor over stubs for everything it touches, so a test can name
 * exactly which workspace roots it resolved and which commands it dispatched.
 *
 * `resolve` dies for any root in `failingRoots`, which proves one bad project
 * does not stop the worker.
 */
const makeHarness = (input: {
  readonly projects: ReadonlyArray<ProjectionProject>;
  readonly failingRoots?: ReadonlySet<string>;
}) =>
  Effect.gen(function* () {
    const resolveCalls: Array<string> = [];
    const invalidateCalls: Array<string> = [];
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    const events = yield* Queue.unbounded<OrchestrationEvent>();

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

    const resolverLayer = Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: (cwd: string) =>
        Effect.suspend(() => {
          resolveCalls.push(cwd);
          return input.failingRoots?.has(cwd) === true
            ? Effect.die(new Error(`git failed for ${cwd}`))
            : Effect.succeed(identityFor(cwd));
        }),
      invalidate: (cwd: string) =>
        Effect.sync(() => {
          invalidateCalls.push(cwd);
        }),
    });

    const layer = RepositoryIdentityReactorLive.pipe(
      Layer.provide(Layer.mergeAll(engineLayer, projectsLayer, resolverLayer, NodeCrypto.layer)),
    );

    return {
      layer,
      harness: { resolveCalls, invalidateCalls, dispatched, events } satisfies Harness,
    };
  });

/** The workspace root a recorded identity command is about. */
const recordedRoot = (command: OrchestrationCommand): string =>
  (command as { readonly workspaceRoot: string }).workspaceRoot;

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

const projectMetaUpdated = (
  projectId: string,
  payload: { readonly title?: string; readonly workspaceRoot?: string },
) =>
  ({
    type: "project.meta-updated",
    sequence: 2,
    eventId: `evt-meta-${projectId}`,
    commandId: `cmd-meta-${projectId}`,
    aggregateKind: "project",
    aggregateId: projectId,
    actor: { kind: "user" },
    occurredAt: now,
    payload: { projectId, ...payload },
  }) as unknown as OrchestrationEvent;

describe("RepositoryIdentityReactor", () => {
  it.effect("sweeps only projects whose stored identity is not their workspace root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, harness } = yield* makeHarness({
          projects: [
            projectRow({
              projectId: "project-current",
              workspaceRoot: "/w/current",
              repositoryIdentityWorkspaceRoot: "/w/current",
            }),
            projectRow({
              projectId: "project-never-resolved",
              workspaceRoot: "/w/new",
              repositoryIdentityWorkspaceRoot: null,
            }),
            projectRow({
              projectId: "project-moved",
              workspaceRoot: "/w/moved",
              repositoryIdentityWorkspaceRoot: "/w/before-the-move",
            }),
            projectRow({
              projectId: "project-deleted",
              workspaceRoot: "/w/deleted",
              repositoryIdentityWorkspaceRoot: null,
              deletedAt: now,
            }),
          ],
        });

        yield* Effect.gen(function* () {
          const reactor = yield* RepositoryIdentityReactor;
          yield* reactor.start();
          yield* reactor.drain;
        }).pipe(Effect.provide(layer));

        expect(harness.resolveCalls.toSorted()).toEqual(["/w/moved", "/w/new"]);
        expect((yield* Queue.takeAll(harness.dispatched)).map(recordedRoot).toSorted()).toEqual([
          "/w/moved",
          "/w/new",
        ]);
      }),
    ),
  );

  it.effect("resolves on project.created and on a meta update that carries a workspace root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, harness } = yield* makeHarness({ projects: [] });

        const recorded = yield* Effect.gen(function* () {
          const reactor = yield* RepositoryIdentityReactor;
          yield* reactor.start();

          yield* Queue.offer(harness.events, projectCreated("project-1", "/w/created"));
          // A rename carries no workspace root, so it asks for no resolution.
          yield* Queue.offer(harness.events, projectMetaUpdated("project-1", { title: "Renamed" }));
          // Re-saving the folder is how a user forces a re-read.
          yield* Queue.offer(
            harness.events,
            projectMetaUpdated("project-1", { workspaceRoot: "/w/resaved" }),
          );

          const first = yield* Queue.take(harness.dispatched);
          const second = yield* Queue.take(harness.dispatched);
          return [first, second];
        }).pipe(Effect.provide(layer));

        expect(recorded.map(recordedRoot)).toEqual(["/w/created", "/w/resaved"]);
        expect(harness.resolveCalls).toEqual(["/w/created", "/w/resaved"]);
      }),
    ),
  );

  it.effect("keeps resolving after one project fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer, harness } = yield* makeHarness({
          projects: [],
          failingRoots: new Set(["/w/broken"]),
        });

        const recorded = yield* Effect.gen(function* () {
          const reactor = yield* RepositoryIdentityReactor;
          yield* reactor.start();

          yield* Queue.offer(harness.events, projectCreated("project-broken", "/w/broken"));
          yield* Queue.offer(harness.events, projectCreated("project-ok", "/w/ok"));

          return yield* Queue.take(harness.dispatched);
        }).pipe(Effect.provide(layer));

        expect(recordedRoot(recorded)).toEqual("/w/ok");
        expect(harness.resolveCalls).toEqual(["/w/broken", "/w/ok"]);
      }),
    ),
  );
});
