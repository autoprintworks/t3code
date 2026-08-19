import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const THREAD_UPDATED_AT = "2026-01-01T00:00:00.000Z";

function makeReadModel(threadUpdatedAt = THREAD_UPDATED_AT): OrchestrationReadModel {
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
        createdAt: threadUpdatedAt,
        updatedAt: threadUpdatedAt,
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
    updatedAt: threadUpdatedAt,
  };
}

/** Decides a turn start and returns the user message event it emits. */
function startTurn(createdAt: string, readModel = makeReadModel()) {
  return Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({
      command: {
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-${createdAt}`),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      },
      readModel,
    });
    const events = Array.isArray(decided) ? decided : [decided];
    const userMessage = events.find((event) => event.type === "thread.message-sent");
    if (userMessage?.type !== "thread.message-sent") {
      throw new Error("expected a thread.message-sent event");
    }
    return userMessage;
  }).pipe(Effect.provide(NodeServices.layer));
}

/** Server now, offset by `millis`, as an ISO string. */
const isoFromNow = (millis: number) =>
  Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.addDuration(now, millis)));

const serverNowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);

/**
 * The client sends its own wall clock with a turn. That clock is not trusted:
 * a skewed client would otherwise write a timestamp outside the thread's own
 * history, which reads as a hole in the transcript even though the event-store
 * sequence still orders the rows correctly.
 *
 * These use `it.live` because the clamp compares the client value against the
 * real server clock, and the default TestClock sits at the epoch, which would
 * make every fixture timestamp look like it came from the future.
 */
describe("thread.turn.start client clock", () => {
  it.live("keeps a plausible client timestamp", () =>
    Effect.gen(function* () {
      // After the thread's last event and before server now: the ordinary
      // case. The value survives, so the row shows the time the user hit send
      // rather than the time the server received it.
      const plausible = yield* isoFromNow(-1_000);
      const event = yield* startTurn(plausible);
      expect(event.payload.createdAt).toBe(plausible);
      expect(event.payload.updatedAt).toBe(plausible);
      expect(event.occurredAt).toBe(plausible);
    }),
  );

  it.live("clamps a client clock running ahead of the server down to server now", () =>
    Effect.gen(function* () {
      const future = yield* isoFromNow(86_400_000);
      const event = yield* startTurn(future);
      expect(event.payload.createdAt).not.toBe(future);
      expect(Date.parse(event.payload.createdAt)).toBeLessThanOrEqual(yield* serverNowMillis);
      expect(Date.parse(event.payload.createdAt)).toBeGreaterThanOrEqual(
        Date.parse(THREAD_UPDATED_AT),
      );
    }),
  );

  it.live("clamps a client clock behind the thread's last event up to that event", () =>
    Effect.gen(function* () {
      // A row cannot predate the thread it belongs to. The floor is the
      // thread's own last event, not the epoch.
      const event = yield* startTurn("2020-06-01T00:00:00.000Z");
      expect(event.payload.createdAt).toBe(THREAD_UPDATED_AT);
    }),
  );

  it.live("falls back to the server clock when the floor is itself in the future", () =>
    Effect.gen(function* () {
      // A thread damaged by an earlier clock excursion can carry an updatedAt
      // ahead of server now. Clamping up to that value would spread the damage
      // to every later row, so the server's own clock wins.
      const futureThreadUpdatedAt = yield* isoFromNow(86_400_000);
      const event = yield* startTurn(
        "2020-06-01T00:00:00.000Z",
        makeReadModel(futureThreadUpdatedAt),
      );
      expect(event.payload.createdAt).not.toBe(futureThreadUpdatedAt);
      expect(Date.parse(event.payload.createdAt)).toBeLessThanOrEqual(yield* serverNowMillis);
    }),
  );

  it.live("falls back to the server clock for an unparseable client value", () =>
    Effect.gen(function* () {
      const event = yield* startTurn("not-a-timestamp");
      expect(Number.isFinite(Date.parse(event.payload.createdAt))).toBe(true);
    }),
  );
});
