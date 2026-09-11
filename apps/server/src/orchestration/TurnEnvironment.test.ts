import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { rememberTurnEnvironment, takeTurnEnvironment } from "./TurnEnvironment.ts";

const THREAD_UPDATED_AT = "2026-01-01T00:00:00.000Z";

/** The directory the daemon puts on PATH. No client may see this value. */
const SECRET_TOOL_DIR = "/opt/fm/bin";

const environment = Schema.decodeUnknownSync(ProviderInstanceEnvironment)([
  { name: "FM_UNIT", value: "unit-7" },
  { name: "PATH", value: SECRET_TOOL_DIR },
]);

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: THREAD_UPDATED_AT,
        updatedAt: THREAD_UPDATED_AT,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: THREAD_UPDATED_AT,
  };
}

function makeTurnStart(commandId: string, withEnvironment: boolean): OrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(commandId),
    threadId: ThreadId.make("thread-1"),
    message: {
      messageId: MessageId.make(`message-${commandId}`),
      role: "user",
      text: "hello",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    ...(withEnvironment ? { environment } : {}),
    createdAt: THREAD_UPDATED_AT,
  };
}

describe("turn environment side channel", () => {
  it("hands a parked environment to the one command that carried it", () => {
    rememberTurnEnvironment(makeTurnStart("cmd-1", true));
    expect(takeTurnEnvironment(CommandId.make("cmd-1"))).toEqual(environment);
  });

  it("gives a later turn on the same thread nothing of the previous turn's", () => {
    rememberTurnEnvironment(makeTurnStart("cmd-2", true));
    expect(takeTurnEnvironment(CommandId.make("cmd-2"))).toEqual(environment);
    // Taking removes it. A second turn asks with its own command id and gets
    // nothing, so the spawn falls back to the instance environment.
    expect(takeTurnEnvironment(CommandId.make("cmd-2"))).toBeUndefined();

    rememberTurnEnvironment(makeTurnStart("cmd-3", false));
    expect(takeTurnEnvironment(CommandId.make("cmd-3"))).toBeUndefined();
  });

  it("has nothing for an event with no command id", () => {
    expect(takeTurnEnvironment(null)).toBeUndefined();
  });
});

/**
 * The environment's values name paths on the server's filesystem. A client
 * has no use for them and must not display them, so no event may carry them.
 */
describe("thread.turn.start environment stays out of the event stream", () => {
  it.effect("emits no event carrying the turn's environment", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: makeTurnStart("cmd-events", true),
        readModel: makeReadModel(),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.some((event) => event.type === "thread.turn-start-requested")).toBe(true);

      // @effect-diagnostics-next-line preferSchemaOverJson:off - Scans the whole event shape for a value no schema should carry.
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(SECRET_TOOL_DIR);
      expect(serialized).not.toContain("environment");
      expect(serialized).not.toContain("FM_UNIT");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
