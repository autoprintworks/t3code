import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

/**
 * Read-only is a rule, not a rendering choice.
 *
 * A worker thread mirrors a conversation another agent owns. Hiding the
 * composer stops the client that knows about the flag; these tests are about
 * every caller that does not, which is an older mobile build, a script, and a
 * bare dispatch over the websocket alike.
 */
function makeReadModel(readOnly: boolean): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Worker",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        readOnly,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

function turnStart(commandId: string) {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(commandId),
    threadId: ThreadId.make("thread-1"),
    message: {
      messageId: MessageId.make("message-1"),
      role: "user",
      text: "Continue",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: NOW,
  } as const;
}

function revert(commandId: string) {
  return {
    type: "thread.checkpoint.revert",
    commandId: CommandId.make(commandId),
    threadId: ThreadId.make("thread-1"),
    turnCount: 1,
    createdAt: NOW,
  } as const;
}

it.layer(NodeServices.layer)("read-only thread decider", (it) => {
  it.effect("refuses a turn start on a read-only thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: turnStart("cmd-turn-read-only"),
        readModel: makeReadModel(true),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("still accepts a turn start on an ordinary thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: turnStart("cmd-turn-promptable"),
        readModel: makeReadModel(false),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("refuses a checkpoint revert on a read-only thread", () =>
    Effect.gen(function* () {
      // A revert drives the provider on the thread just as a turn does.
      const error = yield* decideOrchestrationCommand({
        command: revert("cmd-revert-read-only"),
        readModel: makeReadModel(true),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
