/**
 * Repository identity becomes stored derived state.
 *
 * Before this, `getShellSnapshot` resolved every project's repository identity
 * by spawning `git` on the request path. On Windows, creating a child process
 * blocks the Node event loop even through the asynchronous API, so a read cost
 * seconds and its cost grew with project count. A background reactor now
 * resolves the identity off the read path and records it in these columns.
 *
 * `repository_identity_workspace_root` is the directory the identity was
 * resolved from. Reads serve the identity only while it still equals
 * `workspace_root`, so moving a project invalidates its identity by itself,
 * with no second write and no window where the sidebar shows the old label.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "repository_identity_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN repository_identity_json TEXT
    `;
  }

  if (!columns.some((column) => column.name === "repository_identity_workspace_root")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN repository_identity_workspace_root TEXT
    `;
  }
});
