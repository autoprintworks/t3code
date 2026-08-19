import {
  EnvironmentId,
  IsoDateTime,
  PreviewAutomationUnavailableError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * Who the calling thread is. Every field is copied from the server's own
 * invocation scope, so a thread can neither widen nor forge this answer.
 */
export const FleetThreadIdentity = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The calling thread's id." }),
  environmentId: EnvironmentId.annotate({
    description: "The environment the calling thread belongs to.",
  }),
});
export type FleetThreadIdentity = typeof FleetThreadIdentity.Type;

export const FleetThreadSummary = Schema.Struct({
  threadId: ThreadId.annotate({ description: "The thread's id." }),
  projectId: ProjectId.annotate({ description: "The project the thread belongs to." }),
  title: Schema.String.annotate({ description: "The thread's current title." }),
  archived: Schema.Boolean.annotate({
    description: "True when the thread is archived, false when it is live.",
  }),
  updatedAt: IsoDateTime.annotate({ description: "When the thread last changed." }),
});
export type FleetThreadSummary = typeof FleetThreadSummary.Type;

export const FleetThreadList = Schema.Struct({
  threads: Schema.Array(FleetThreadSummary).annotate({
    description: "Live and archived threads together, each flagged by its archived field.",
  }),
});
export type FleetThreadList = typeof FleetThreadList.Type;

/**
 * `fleet_whoami` declares no parameters at all. A thread therefore cannot name
 * another thread, so impersonation is unrepresentable rather than refused.
 */
export const FleetWhoamiTool = Tool.make("fleet_whoami", {
  description:
    "Report the calling thread's own identity, taken from the server-issued credential this call arrived on. Takes no arguments: a thread can only ever ask about itself.",
  parameters: Tool.EmptyParams,
  success: FleetThreadIdentity,
  failure: PreviewAutomationUnavailableError,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Get calling thread identity")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const FleetListThreadsTool = Tool.make("fleet_list_threads", {
  description:
    "List every thread in this environment, archived ones included, so recovery work can find a thread that is no longer in normal navigation. Each entry says whether it is archived or live.",
  parameters: Tool.EmptyParams,
  success: FleetThreadList,
  failure: PreviewAutomationUnavailableError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  ],
})
  .annotate(Tool.Title, "List threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const FleetToolkit = Toolkit.make(FleetWhoamiTool, FleetListThreadsTool);
