// @effect-diagnostics globalConsole:off
// This test measures how a read scales with project count, so it prints its
// numbers.
/**
 * A shell read must start no child process.
 *
 * Repository identity is derived state: a background reactor resolves it and
 * the projection stores it. The read path therefore reads a column. This test
 * states that as a property rather than as a millisecond figure - it installs
 * the *only* `ChildProcessSpawner` in the stack, counts every spawn, and
 * requires zero. A read that cannot spawn cannot block the event loop, at any
 * project count.
 */
import { ProjectId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as PlatformError from "effect/PlatformError";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";

interface SpawnLog {
  readonly commands: Array<string>;
}

/**
 * The only spawner in the stack. It records the attempt and refuses it, so the
 * read still completes and the assertion can name every command a read tried
 * to run.
 */
const describeCommand = (command: ChildProcess.Command): string =>
  command._tag === "PipedCommand"
    ? `${describeCommand(command.left)} | ${describeCommand(command.right)}`
    : [command.command, ...command.args].join(" ");

const makeCountingSpawnerLayer = (log: SpawnLog) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      log.commands.push(describeCommand(command));
      return Effect.fail(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "Command",
          method: "spawn",
          description: "a read path must not create a child process",
        }),
      );
    }),
  );

const makeTestLayer = (log: SpawnLog) => {
  const spawnerLayer = makeCountingSpawnerLayer(log);
  return OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer.pipe(Layer.provide(spawnerLayer))),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      Layer.mergeAll(NodeFileSystem.layer, NodeCrypto.layer, NodePath.layer, spawnerLayer),
    ),
  );
};

const seedProjects = Effect.fn("seedProjects")(function* (projectCount: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_projects`;
  yield* sql`DELETE FROM projection_threads`;

  for (let index = 0; index < projectCount; index += 1) {
    const projectId = `project-${index}`;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json,
        scripts_json, created_at, updated_at, deleted_at
      ) VALUES (
        ${projectId}, ${`Project ${index}`}, ${`/tmp/workspace-${index}`},
        '{"provider":"codex","model":"gpt-5-codex"}', '[]',
        '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL
      )
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode,
        interaction_mode, branch, worktree_path, latest_turn_id,
        latest_user_message_at, pending_approval_count, pending_user_input_count,
        has_actionable_proposed_plan, created_at, updated_at, deleted_at
      ) VALUES (
        ${`thread-${index}`}, ${projectId}, ${`Thread ${index}`},
        '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
        NULL, NULL, NULL, NULL, 0, 0, 0,
        '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z', NULL
      )
    `;
  }
});

/** Reads every projection surface that used to resolve repository identity. */
const readEverySurface = Effect.fn("readEverySurface")(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  yield* snapshotQuery.getShellSnapshot();
  yield* snapshotQuery.getArchivedShellSnapshot();
  yield* snapshotQuery.getSnapshot();
  yield* snapshotQuery.getCommandReadModel();
  yield* snapshotQuery.getProjectShellById(ProjectId.make("project-0"));
  yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace-0");
});

const runWithProjects = async (projectCount: number) => {
  const log: SpawnLog = { commands: [] };
  // This test measures wall time around one read, so it needs a plain runtime
  // rather than the vitest test runtime's fibers.
  // eslint-disable-next-line t3code/no-manual-effect-runtime-in-tests
  const elapsedMs = await Effect.runPromise(
    Effect.gen(function* () {
      yield* seedProjects(projectCount);
      // Warm nothing on purpose: the first read after boot is the cold one,
      // and it is the read the user waits on.
      const startedAt = performance.now();
      yield* readEverySurface();
      return performance.now() - startedAt;
    }).pipe(Effect.provide(makeTestLayer(log)), Effect.scoped),
  );
  return { log, elapsedMs };
};

describe("shell snapshot spawns nothing", () => {
  it("creates zero child processes for a read, at one project and at two hundred", async () => {
    const small = await runWithProjects(1);
    const large = await runWithProjects(200);

    console.log(
      `  1 project:    ${Math.round(small.elapsedMs)} ms, spawns ${small.log.commands.length}
` + `  200 projects: ${Math.round(large.elapsedMs)} ms, spawns ${large.log.commands.length}`,
    );

    expect(
      small.log.commands,
      `a read at 1 project spawned: ${small.log.commands.join(" | ")}`,
    ).toEqual([]);
    expect(
      large.log.commands,
      `a read at 200 projects spawned: ${large.log.commands.join(" | ")}`,
    ).toEqual([]);
  }, 120_000);

  it("keeps a two hundred project read inside the shell read budget", async () => {
    const large = await runWithProjects(200);
    expect(
      Math.round(large.elapsedMs),
      `a 200 project read took ${Math.round(large.elapsedMs)} ms`,
    ).toBeLessThanOrEqual(250);
  }, 120_000);
});
