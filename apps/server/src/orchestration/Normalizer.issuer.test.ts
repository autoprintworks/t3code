import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthFleetSubject,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { commandIssuerForSubject, normalizeDispatchCommand } from "./Normalizer.ts";

/**
 * The dispatch entry point is the authority, not the schema.
 *
 * The wire schema is wide enough for a fleet create to carry `readOnly` at
 * all, so what stops an ordinary client minting a thread it is then refused
 * permission to use is this normaliser and the session it was told about.
 * These are the two directions of that, and the stamp that is its mirror on a
 * turn start.
 */
const testLayer = Layer.mergeAll(
  ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-normalizer-issuer-test-",
  }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

const NOW = "2026-01-01T00:00:00.000Z";

const threadCreate = (readOnly?: boolean) =>
  ({
    type: "thread.create",
    commandId: CommandId.make("cmd-create"),
    threadId: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "[crewmate] fm/test-gate",
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    ...(readOnly === undefined ? {} : { readOnly }),
    createdAt: NOW,
  }) as const;

/** Create-and-start: the same fleet-only field, one level down. */
const bootstrapTurnStart = (readOnly?: boolean) =>
  ({
    ...turnStart,
    bootstrap: {
      createThread: {
        projectId: ProjectId.make("project-1"),
        title: "[crewmate] fm/test-gate",
        modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        ...(readOnly === undefined ? {} : { readOnly }),
        createdAt: NOW,
      },
    },
  }) as const;

const turnStart = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-turn"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("message-1"),
    role: "user",
    text: "Continue",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  createdAt: NOW,
} as const;

describe("commandIssuerForSubject", () => {
  it("reads the fleet off the session subject and nothing else", () => {
    expect(commandIssuerForSubject(AuthFleetSubject)).toBe("fleet");
    expect(commandIssuerForSubject("browser")).toBe("client");
    expect(commandIssuerForSubject("cloud-connect")).toBe("client");
    // Near misses are clients. The subject is compared whole.
    expect(commandIssuerForSubject("firstmate-ish")).toBe("client");
  });
});

it.layer(testLayer)("normalizeDispatchCommand issuer authority", (it) => {
  it.effect("keeps readOnly and stamps the issuer on a thread.create the fleet sent", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(threadCreate(true), "fleet");

      expect(normalized.type).toBe("thread.create");
      expect(normalized).toHaveProperty("readOnly", true);
      // The stamp is what the decider records as `fleetOwned`, which is the
      // half of the turn rule that a later stamp on its own cannot supply.
      expect(normalized).toHaveProperty("issuer", "fleet");
    }),
  );

  it.effect("refuses readOnly on a thread.create a client sent", () =>
    Effect.gen(function* () {
      // Loud, not silent. Dropping the field would hand a caller that believed
      // it was the fleet an ordinary promptable thread and no way to tell.
      const error = yield* normalizeDispatchCommand(threadCreate(true), "client").pipe(Effect.flip);

      expect(error.message).toContain("'readOnly' may only be set by the fleet");
    }),
  );

  it.effect("leaves an ordinary thread.create a client sent alone", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(threadCreate(), "client");

      expect(normalized.type).toBe("thread.create");
      expect(normalized).not.toHaveProperty("issuer");
    }),
  );

  it.effect("keeps bootstrap readOnly on a create-and-start the fleet sent", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(bootstrapTurnStart(true), "fleet");

      expect(normalized.type).toBe("thread.turn.start");
      expect(normalized).toHaveProperty("issuer", "fleet");
    }),
  );

  it.effect("refuses bootstrap readOnly on a create-and-start a client sent", () =>
    Effect.gen(function* () {
      const error = yield* normalizeDispatchCommand(bootstrapTurnStart(true), "client").pipe(
        Effect.flip,
      );

      expect(error.message).toContain(
        "'bootstrap.createThread.readOnly' may only be set by the fleet",
      );
    }),
  );

  it.effect("stamps a thread.turn.start the fleet sent", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(turnStart, "fleet");

      expect(normalized).toHaveProperty("issuer", "fleet");
    }),
  );

  it.effect("leaves a thread.turn.start a client sent unstamped", () =>
    Effect.gen(function* () {
      const normalized = yield* normalizeDispatchCommand(turnStart, "client");

      expect(normalized).not.toHaveProperty("issuer");
    }),
  );
});
