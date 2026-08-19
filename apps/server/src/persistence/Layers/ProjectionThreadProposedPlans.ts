import { NonNegativeInt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadProposedPlansInput,
  ListProjectionThreadProposedPlansInput,
  ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
  type ProjectionThreadProposedPlanRepositoryShape,
} from "../Services/ProjectionThreadProposedPlans.ts";

const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan.mapFields(
  Struct.assign({
    sequence: NonNegativeInt,
  }),
);

const makeProjectionThreadProposedPlanRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadProposedPlanRow = SqlSchema.void({
    Request: ProjectionThreadProposedPlan,
    execute: (row) => sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id,
        thread_id,
        turn_id,
        sequence,
        plan_markdown,
        implemented_at,
        implementation_thread_id,
        created_at,
        updated_at
      )
      VALUES (
        ${row.planId},
        ${row.threadId},
        ${row.turnId},
        -- A plan is upserted again on every edit; it keeps the sequence of the
        -- event that first created it, so it holds its transcript position.
        COALESCE(
          (
            SELECT sequence
            FROM projection_thread_proposed_plans
            WHERE plan_id = ${row.planId}
          ),
          ${row.sequence ?? null},
          0
        ),
        ${row.planMarkdown},
        ${row.implementedAt},
        ${row.implementationThreadId},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        sequence = excluded.sequence,
        plan_markdown = excluded.plan_markdown,
        implemented_at = excluded.implemented_at,
        implementation_thread_id = excluded.implementation_thread_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionThreadProposedPlanRows = SqlSchema.findAll({
    Request: ListProjectionThreadProposedPlansInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        sequence,
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY
        sequence ASC,
        created_at ASC,
        plan_id ASC
    `,
  });

  const deleteProjectionThreadProposedPlanRows = SqlSchema.void({
    Request: DeleteProjectionThreadProposedPlansInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadProposedPlanRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadProposedPlanRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadProposedPlanRepository.upsert:query")),
    );

  const listByThreadId: ProjectionThreadProposedPlanRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.listByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadProposedPlanRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadProposedPlanRepositoryShape;
});

export const ProjectionThreadProposedPlanRepositoryLive = Layer.effect(
  ProjectionThreadProposedPlanRepository,
  makeProjectionThreadProposedPlanRepository,
);
