/**
 * FORK DELTA (fm provider) - the two reads the worker-thread reactor needs.
 *
 * These live here rather than on `ProjectionSnapshotQuery` because they are
 * fork-local: nothing outside the fm provider asks "which worker threads does
 * this First Mate home already have" or "which assistant messages does this
 * thread already hold". Keeping them out of the shared shape keeps the fork
 * delta inside `provider/fm`, which is the whole point of the inventory in
 * `docs/internals/fm-provider-fork-delta.md`.
 *
 * Both reads are deliberately narrow and both take a `limit`. This code runs on
 * the Node event loop thread behind a synchronous SQLite driver, so a read that
 * can return an unbounded number of rows is a read that can stall the editor.
 *
 * @module provider/fm/FmWorkerThreadQuery
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";

export interface FmWorkerThreadQueryShape {
  /**
   * The live threads whose id starts with `prefix`.
   *
   * A prefix range read, not a scan: worker thread ids share a prefix per
   * First Mate home, so this reads one home's worker threads off the primary
   * key rather than every thread in the database.
   */
  readonly listActiveThreadIdsByPrefix: (input: {
    readonly prefix: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;

  /**
   * The assistant message ids a thread already holds.
   *
   * Ids only, so adopting an existing thread costs one narrow indexed read
   * rather than hydrating a transcript. A caller replaying a conversation it
   * did not originate uses this to tell "already written" from "new".
   */
  readonly listThreadAssistantMessageIds: (input: {
    readonly threadId: ThreadId;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<string>, ProjectionRepositoryError>;
}

export class FmWorkerThreadQuery extends Context.Service<
  FmWorkerThreadQuery,
  FmWorkerThreadQueryShape
>()("t3/provider/fm/FmWorkerThreadQuery") {}

function toQueryError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A half-open range on the primary key, not `LIKE`: SQLite will not use the
  // index for a `LIKE` under the default collation, and this read happens once
  // per home per process start.
  const listActiveThreadIdsByPrefixRows = SqlSchema.findAll({
    Request: Schema.Struct({
      lowerBound: Schema.String,
      upperBound: Schema.String,
      limit: Schema.Number,
    }),
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: ({ lowerBound, upperBound, limit }) =>
      sql`
        SELECT thread_id AS "threadId"
        FROM projection_threads
        WHERE thread_id >= ${lowerBound}
          AND thread_id < ${upperBound}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY thread_id ASC
        LIMIT ${limit}
      `,
  });

  const listThreadAssistantMessageIdRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId, limit: Schema.Number }),
    Result: Schema.Struct({ messageId: Schema.String }),
    execute: ({ threadId, limit }) =>
      sql`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role = 'assistant'
        ORDER BY sequence ASC, created_at ASC, message_id ASC
        LIMIT ${limit}
      `,
  });

  const listActiveThreadIdsByPrefix: FmWorkerThreadQueryShape["listActiveThreadIdsByPrefix"] = (
    input,
  ) =>
    listActiveThreadIdsByPrefixRows({
      lowerBound: input.prefix,
      // `\u{10FFFF}` is the largest code point, so no id beginning with the
      // prefix can sort at or above this bound.
      upperBound: `${input.prefix}\u{10FFFF}`,
      limit: input.limit,
    }).pipe(
      Effect.map((rows) => rows.map((row) => row.threadId)),
      Effect.mapError(
        toQueryError(
          "FmWorkerThreadQuery.listActiveThreadIdsByPrefix:query",
          "FmWorkerThreadQuery.listActiveThreadIdsByPrefix:decodeRow",
        ),
      ),
    );

  const listThreadAssistantMessageIds: FmWorkerThreadQueryShape["listThreadAssistantMessageIds"] = (
    input,
  ) =>
    listThreadAssistantMessageIdRows(input).pipe(
      Effect.map((rows) => rows.map((row) => row.messageId)),
      Effect.mapError(
        toQueryError(
          "FmWorkerThreadQuery.listThreadAssistantMessageIds:query",
          "FmWorkerThreadQuery.listThreadAssistantMessageIds:decodeRow",
        ),
      ),
    );

  return {
    listActiveThreadIdsByPrefix,
    listThreadAssistantMessageIds,
  } satisfies FmWorkerThreadQueryShape;
});

export const FmWorkerThreadQueryLive = Layer.effect(FmWorkerThreadQuery, make);
