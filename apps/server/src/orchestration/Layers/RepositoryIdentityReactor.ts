import { CommandId, type OrchestrationEvent, type ProjectId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  RepositoryIdentityReactor,
  type RepositoryIdentityReactorShape,
} from "../Services/RepositoryIdentityReactor.ts";

interface ResolutionRequest {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  /**
   * Whether to drop the resolver's cached answer first. Set only for a project
   * whose workspace root the user just saved, which is the one gesture that can
   * make a cached answer wrong.
   */
  readonly refresh: boolean;
}

/**
 * Which project events ask for a fresh resolution.
 *
 * `project.meta-updated` counts whenever it carries a workspace root, even an
 * unchanged one: re-saving a project's folder is how a user forces a re-read
 * after changing the repository's remote. That is also the only trigger that
 * bypasses the resolver's cache, so the manual refresh still reaches `git`.
 */
function resolutionRequestForEvent(event: OrchestrationEvent): ResolutionRequest | null {
  if (event.type === "project.created") {
    return {
      projectId: event.payload.projectId,
      workspaceRoot: event.payload.workspaceRoot,
      refresh: false,
    };
  }
  if (event.type === "project.meta-updated" && event.payload.workspaceRoot !== undefined) {
    return {
      projectId: event.payload.projectId,
      workspaceRoot: event.payload.workspaceRoot,
      refresh: true,
    };
  }
  return null;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionProjectRepository = yield* ProjectionProjectRepository;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  const serverCommandId = crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => CommandId.make(`server:repository-identity:${uuid}`)),
  );

  /**
   * Resolving spawns `git`, which blocks the event loop on Windows. That is
   * exactly why it lives here: one project at a time, on a background worker,
   * never on a request. The resolver caches per workspace root, so several
   * projects sharing a root cost one resolution between them.
   */
  const resolveAndRecord = Effect.fn("resolveAndRecord")(function* (request: ResolutionRequest) {
    if (request.refresh) {
      yield* repositoryIdentityResolver.invalidate(request.workspaceRoot);
    }
    const repositoryIdentity = yield* repositoryIdentityResolver.resolve(request.workspaceRoot);
    yield* orchestrationEngine.dispatch({
      type: "project.repository-identity.record",
      commandId: yield* serverCommandId,
      projectId: request.projectId,
      workspaceRoot: request.workspaceRoot,
      repositoryIdentity,
    });
  });

  const resolveAndRecordSafely = (request: ResolutionRequest) =>
    resolveAndRecord(request).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("repository identity reactor failed to record an identity", {
          projectId: request.projectId,
          workspaceRoot: request.workspaceRoot,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(resolveAndRecordSafely);

  /**
   * Catch up projects whose stored identity does not belong to their current
   * workspace root: ones added before this reactor existed, ones moved while
   * the server was down, and ones whose resolution failed last time. A project
   * that already matches costs nothing here.
   */
  const enqueueUnresolvedProjects = Effect.fn("enqueueUnresolvedProjects")(function* () {
    const projectRows = yield* projectionProjectRepository.listAll();
    for (const row of projectRows) {
      if (row.deletedAt !== null || row.repositoryIdentityWorkspaceRoot === row.workspaceRoot) {
        continue;
      }
      yield* worker.enqueue({
        projectId: row.projectId,
        workspaceRoot: row.workspaceRoot,
        refresh: false,
      });
    }
  });

  const start: RepositoryIdentityReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const request = resolutionRequestForEvent(event);
        return request === null ? Effect.void : worker.enqueue(request);
      }),
    );
    yield* enqueueUnresolvedProjects().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("repository identity reactor failed to sweep unresolved projects", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies RepositoryIdentityReactorShape;
});

export const RepositoryIdentityReactorLive = Layer.effect(RepositoryIdentityReactor, make);
