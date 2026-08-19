import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type IsoDateTime,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  PreviewAutomationUnavailableError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { listThreads, whoami } from "./handlers.ts";

const makeScope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const makeThreadShell = (
  threadId: string,
  archivedAt: string | null,
): OrchestrationThreadShell => ({
  id: ThreadId.make(threadId),
  projectId: ProjectId.make("project-1"),
  title: `title for ${threadId}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z" as IsoDateTime,
  updatedAt: "2026-01-02T00:00:00.000Z" as IsoDateTime,
  archivedAt: archivedAt as IsoDateTime | null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const makeSnapshot = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects: [],
  threads,
  updatedAt: "2026-01-02T00:00:00.000Z" as IsoDateTime,
});

const makeProjectionLayer = (
  live: ReadonlyArray<OrchestrationThreadShell>,
  archived: ReadonlyArray<OrchestrationThreadShell>,
) =>
  Layer.succeed(ProjectionSnapshotQuery, {
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.succeed(makeSnapshot(live)),
    getArchivedShellSnapshot: () => Effect.succeed(makeSnapshot(archived)),
    searchThreads: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getProjectShellById: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getThreadWorkspaceRoot: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
  });

it.effect("reports the calling thread's identity from the invocation scope", () => {
  const scope = makeScope(["fleet"]);
  return Effect.gen(function* () {
    const identity = yield* whoami().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    );
    expect(identity).toEqual({
      threadId: scope.threadId,
      environmentId: scope.environmentId,
    });
  });
});

it.effect("refuses the identity verb with the existing capability error", () => {
  const scope = makeScope(["preview"]);
  return Effect.gen(function* () {
    const error = yield* whoami().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "fleet",
      environmentId: scope.environmentId,
      threadId: scope.threadId,
      providerSessionId: scope.providerSessionId,
      providerInstanceId: scope.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the fleet capability.");
  });
});

it.effect("lists archived threads alongside live ones and says which is which", () => {
  const scope = makeScope(["fleet"]);
  return Effect.gen(function* () {
    const result = yield* listThreads().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(
        makeProjectionLayer(
          [makeThreadShell("thread-live", null)],
          [makeThreadShell("thread-archived", "2026-01-03T00:00:00.000Z")],
        ),
      ),
    );
    expect(result.threads).toEqual([
      {
        threadId: "thread-live",
        projectId: "project-1",
        title: "title for thread-live",
        archived: false,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        threadId: "thread-archived",
        projectId: "project-1",
        title: "title for thread-archived",
        archived: true,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });
});

it.effect("refuses listing with the existing capability error", () => {
  const scope = makeScope(["preview"]);
  return Effect.gen(function* () {
    const error = yield* listThreads().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provide(makeProjectionLayer([], [])),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({ capability: "fleet" });
  });
});
