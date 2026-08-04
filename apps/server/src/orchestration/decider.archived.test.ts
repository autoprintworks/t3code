import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(input: {
  readonly archivedAt?: string | null;
  readonly messages?: OrchestrationThread["messages"];
}): OrchestrationReadModel {
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
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        deletedAt: null,
        messages: input.messages ?? [],
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

it.layer(NodeServices.layer)("archived thread decider", (it) => {
  it.effect("rejects a turn start on an archived thread", () =>
    Effect.gen(function* () {
      // Accepting it would persist a user message the provider reactor then
      // drops, leaving the sender with every signal that it landed.
      const error = yield* decideOrchestrationCommand({
        command: turnStart("cmd-turn-start-archived"),
        readModel: makeReadModel({ archivedAt: NOW }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("still accepts a turn start on an unarchived thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: turnStart("cmd-turn-start-active"),
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("rejects archiving a thread with a queued turn start", () =>
    Effect.gen(function* () {
      // Closes the mid-flight window the turn-start guard cannot: the provider
      // reactor cannot resolve an archived thread and drops the turn silently,
      // and its hot event stream means the drop is unrecoverable.
      // The decider clock is the Effect test clock pinned to the epoch, so a
      // user message 30s before it with no adopting turn is queued work.
      const queuedMessage = {
        id: MessageId.make("message-queued"),
        role: "user",
        text: "Continue",
        turnId: null,
        streaming: false,
        createdAt: "1969-12-31T23:59:30.000Z",
        updatedAt: "1969-12-31T23:59:30.000Z",
      } as OrchestrationThread["messages"][number];
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-queued"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ messages: [queuedMessage] }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("still archives a thread with no queued turn start", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.archive",
          commandId: CommandId.make("cmd-archive-idle"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual(["thread.archived"]);
    }),
  );
});
