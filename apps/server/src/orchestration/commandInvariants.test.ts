import { it as effectIt } from "@effect/vitest";
import { assert, describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  issuedByFleet,
  listThreadsByProjectId,
  requireThread,
  requireThreadAbsent,
  requireThreadPromptable,
} from "./commandInvariants.ts";

const now = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

/**
 * `thread-1`, made read-only, and either the fleet's or nobody's.
 *
 * Two threads read as read-only and they are not the same thing. One is a
 * thread the First Mate daemon created for itself, which the user watches and
 * the daemon still drives. The other mirrors an ACP worker's session, which
 * nothing on this server may drive. `fleetOwned` is the only field that tells
 * them apart.
 */
function readOnlyReadModel(fleetOwned: boolean): OrchestrationReadModel {
  return {
    ...readModel,
    threads: readModel.threads.map((thread) =>
      thread.id === ThreadId.make("thread-1") ? { ...thread, readOnly: true, fleetOwned } : thread,
    ),
  };
}

const fleetTurnStartCommand: OrchestrationCommand = {
  ...messageSendCommand,
  commandId: CommandId.make("cmd-fleet-1"),
  issuer: "fleet",
};

const revertCommand: OrchestrationCommand = {
  type: "thread.checkpoint.revert",
  commandId: CommandId.make("cmd-revert-1"),
  threadId: ThreadId.make("thread-1"),
  turnCount: 1,
  createdAt: now,
};

describe("issuedByFleet", () => {
  it("reads the stamp a dispatch entry point put on a turn start", () => {
    expect(issuedByFleet(fleetTurnStartCommand)).toBe(true);
    expect(issuedByFleet(messageSendCommand)).toBe(false);
  });

  it("is false for every command that has no stamp to carry", () => {
    // Only `thread.turn.start` has the field. A checkpoint revert drives the
    // provider just as a turn does, so the absence of the field here is what
    // keeps the fleet exception from spreading to it.
    expect(issuedByFleet(revertCommand)).toBe(false);
  });
});

describe("requireThreadPromptable", () => {
  it("lets the fleet prompt a read-only thread the fleet owns", async () => {
    const thread = await Effect.runPromise(
      requireThreadPromptable({
        readModel: readOnlyReadModel(true),
        command: fleetTurnStartCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));
  });

  it("refuses a user on that same thread", async () => {
    await expect(
      Effect.runPromise(
        requireThreadPromptable({
          readModel: readOnlyReadModel(true),
          command: messageSendCommand,
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("is read-only");
  });

  it("refuses the fleet on a read-only thread the fleet does not own", async () => {
    // The ACP worker mirror. The stamp is genuine and buys nothing, because
    // ownership is the other half of the rule.
    await expect(
      Effect.runPromise(
        requireThreadPromptable({
          readModel: readOnlyReadModel(false),
          command: fleetTurnStartCommand,
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("is read-only");
  });

  it("refuses a checkpoint revert even on the fleet's own thread", async () => {
    await expect(
      Effect.runPromise(
        requireThreadPromptable({
          readModel: readOnlyReadModel(true),
          command: revertCommand,
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("is read-only");
  });

  it("lets anyone prompt an ordinary thread", async () => {
    const thread = await Effect.runPromise(
      requireThreadPromptable({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.readOnly).toBeUndefined();
  });
});

describe("commandInvariants", () => {
  it("lists threads by project", () => {
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  effectIt.effect("requires existing thread", () =>
    Effect.gen(function* () {
      const thread = yield* requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      });
      assert.equal(thread.id, ThreadId.make("thread-1"));

      const missing = yield* Effect.exit(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      );
      assert.equal(missing._tag, "Failure");
      assert.include(String(missing), "does not exist");
    }),
  );

  effectIt.effect("requires missing thread for create flows", () =>
    Effect.gen(function* () {
      yield* requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      });

      const duplicate = yield* Effect.exit(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      );
      assert.equal(duplicate._tag, "Failure");
      assert.include(String(duplicate), "already exists");
    }),
  );

  effectIt.effect(
    "lets a draft retry re-create a thread id after its first attempt was deleted",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-1");
        const firstAttempt = readModel.threads.find((thread) => thread.id === threadId)!;
        const afterRollback: OrchestrationReadModel = {
          ...readModel,
          threads: readModel.threads.map((thread) =>
            thread.id === threadId ? { ...thread, deletedAt: now, updatedAt: now } : thread,
          ),
        };
        const retry: OrchestrationCommand = {
          type: "thread.create",
          commandId: CommandId.make("cmd-retry"),
          threadId,
          projectId: firstAttempt.projectId,
          title: firstAttempt.title,
          modelSelection: firstAttempt.modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
        };

        yield* requireThreadAbsent({ readModel: afterRollback, command: retry, threadId });
      }),
  );
});
