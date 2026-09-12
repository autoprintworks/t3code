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
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import {
  rememberTurnEnvironment,
  sameTurnEnvironment,
  takeTurnEnvironment,
} from "./TurnEnvironment.ts";

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

// The register is bounded, so a turn start whose environment nobody takes
// costs one entry rather than growing for the life of the process.
const MAX_PARKED_TURN_ENVIRONMENTS = 256;

describe("turn environment side channel", () => {
  it.effect("hands a parked environment to the one command that carried it", () =>
    Effect.gen(function* () {
      yield* rememberTurnEnvironment(makeTurnStart("cmd-1", true));
      expect(takeTurnEnvironment(CommandId.make("cmd-1"))).toEqual(environment);
    }),
  );

  it.effect("gives a later turn on the same thread nothing of the previous turn's", () =>
    Effect.gen(function* () {
      yield* rememberTurnEnvironment(makeTurnStart("cmd-2", true));
      expect(takeTurnEnvironment(CommandId.make("cmd-2"))).toEqual(environment);
      // Taking removes it. A second turn asks with its own command id and gets
      // nothing, so the spawn falls back to the instance environment.
      expect(takeTurnEnvironment(CommandId.make("cmd-2"))).toBeUndefined();

      yield* rememberTurnEnvironment(makeTurnStart("cmd-3", false));
      expect(takeTurnEnvironment(CommandId.make("cmd-3"))).toBeUndefined();
    }),
  );

  it("has nothing for an event with no command id", () => {
    expect(takeTurnEnvironment(null)).toBeUndefined();
  });

  /**
   * An eviction means a turn spawns without the tooling it asked for. The
   * bound stays, so the register cannot grow without limit, but the drop is
   * reported rather than silent.
   */
  it.effect("warns with the command id when it evicts a parked environment", () => {
    const warnings: string[] = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") {
        warnings.push(JSON.stringify(message));
      }
    });

    return Effect.gen(function* () {
      for (let index = 0; index < MAX_PARKED_TURN_ENVIRONMENTS; index += 1) {
        yield* rememberTurnEnvironment(makeTurnStart(`cmd-fill-${index}`, true));
      }
      expect(warnings).toHaveLength(0);

      // One past the bound. The oldest entry goes, and says so.
      yield* rememberTurnEnvironment(makeTurnStart("cmd-overflow", true));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("cmd-fill-0");
      expect(takeTurnEnvironment(CommandId.make("cmd-fill-0"))).toBeUndefined();
      expect(takeTurnEnvironment(CommandId.make("cmd-overflow"))).toEqual(environment);

      // Leave the register empty for the tests that share this module.
      for (let index = 1; index < MAX_PARKED_TURN_ENVIRONMENTS; index += 1) {
        takeTurnEnvironment(CommandId.make(`cmd-fill-${index}`));
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Logger.layer([logger], { mergeWithExisting: false }),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ),
      ),
    );
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

const decodeEnvironment = Schema.decodeUnknownSync(ProviderInstanceEnvironment);

/**
 * A turn's environment is compared with the live session's to decide whether
 * that session must restart. A false difference restarts a process for
 * nothing, so these pin what counts as the same.
 */
describe("sameTurnEnvironment", () => {
  it("reads a missing environment and an empty one as the same", () => {
    expect(sameTurnEnvironment(undefined, undefined)).toBe(true);
    expect(sameTurnEnvironment(undefined, decodeEnvironment([]))).toBe(true);
    expect(sameTurnEnvironment(decodeEnvironment([]), undefined)).toBe(true);
  });

  it("ignores the order the entries arrive in", () => {
    const first = decodeEnvironment([
      { name: "FM_UNIT", value: "unit-7" },
      { name: "PATH", value: SECRET_TOOL_DIR },
    ]);
    const second = decodeEnvironment([
      { name: "PATH", value: SECRET_TOOL_DIR },
      { name: "FM_UNIT", value: "unit-7" },
    ]);
    expect(sameTurnEnvironment(first, second)).toBe(true);
  });

  it("ignores the case of a name, the way a spawn does", () => {
    const upper = decodeEnvironment([{ name: "PATH", value: SECRET_TOOL_DIR }]);
    const mixed = decodeEnvironment([{ name: "Path", value: SECRET_TOOL_DIR }]);
    expect(sameTurnEnvironment(upper, mixed)).toBe(true);

    // Two entries for one variable: the last wins at spawn, and here too.
    const duplicated = decodeEnvironment([
      { name: "Path", value: "/other" },
      { name: "PATH", value: SECRET_TOOL_DIR },
    ]);
    expect(sameTurnEnvironment(upper, duplicated)).toBe(true);
  });

  it("ignores fields the process never sees", () => {
    const plain = decodeEnvironment([{ name: "FM_TOKEN", value: "secret" }]);
    const marked = decodeEnvironment([{ name: "FM_TOKEN", value: "secret", sensitive: true }]);
    expect(sameTurnEnvironment(plain, marked)).toBe(true);
  });

  it("reads a changed value, an added name, and a missing environment as different", () => {
    const base = decodeEnvironment([{ name: "FM_UNIT", value: "unit-7" }]);
    expect(
      sameTurnEnvironment(base, decodeEnvironment([{ name: "FM_UNIT", value: "unit-8" }])),
    ).toBe(false);
    expect(
      sameTurnEnvironment(
        base,
        decodeEnvironment([
          { name: "FM_UNIT", value: "unit-7" },
          { name: "PATH", value: SECRET_TOOL_DIR },
        ]),
      ),
    ).toBe(false);
    expect(sameTurnEnvironment(base, undefined)).toBe(false);
  });
});
