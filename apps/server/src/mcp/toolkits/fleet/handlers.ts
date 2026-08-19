import type {
  OrchestrationShellSnapshot,
  PreviewAutomationUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { FleetToolkit, type FleetThreadIdentity, type FleetThreadSummary } from "./tools.ts";

/**
 * Flattens a shell snapshot into fleet summaries. `archivedAt` is the read
 * model's own record of archival, so live and archived snapshots can be
 * summarised by the same code.
 */
const summarize = (snapshot: OrchestrationShellSnapshot): ReadonlyArray<FleetThreadSummary> =>
  snapshot.threads.map((thread) => ({
    threadId: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    archived: thread.archivedAt !== null,
    updatedAt: thread.updatedAt,
  }));

/**
 * Answers with the calling thread's identity. The scope is the server's own
 * record of who is calling, and is the only source this reads.
 */
export const whoami = Effect.fn("FleetToolkit.whoami")(function* (): Effect.fn.Return<
  FleetThreadIdentity,
  PreviewAutomationUnavailableError,
  McpInvocationContext.McpInvocationContext
> {
  const scope = yield* McpInvocationContext.requireMcpCapability("fleet");
  return { threadId: scope.threadId, environmentId: scope.environmentId };
});

/**
 * Lists live and archived threads together. Archived threads are the case that
 * needs listing most, because they have already left normal navigation.
 */
export const listThreads = Effect.fn("FleetToolkit.listThreads")(function* (): Effect.fn.Return<
  { readonly threads: ReadonlyArray<FleetThreadSummary> },
  PreviewAutomationUnavailableError,
  McpInvocationContext.McpInvocationContext | ProjectionSnapshotQuery.ProjectionSnapshotQuery
> {
  yield* McpInvocationContext.requireMcpCapability("fleet");
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const [live, archived] = yield* Effect.all(
    [query.getShellSnapshot(), query.getArchivedShellSnapshot()],
    { concurrency: 2 },
  ).pipe(Effect.orDie);
  return { threads: [...summarize(live), ...summarize(archived)] };
});

const handlers = {
  fleet_whoami: () => whoami(),
  fleet_list_threads: () => listThreads(),
} satisfies Parameters<typeof FleetToolkit.toLayer>[0];

export const FleetToolkitHandlersLive = FleetToolkit.toLayer(handlers);
