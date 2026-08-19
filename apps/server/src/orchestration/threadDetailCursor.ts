import type { ThreadId } from "@t3tools/contracts";

/**
 * Opaque, exclusive cursor for windowed thread detail reads. Encodes the thread
 * id and the keyset boundary of an already-delivered page: the boundary turn's
 * anchor sequence (`projection_turns.sequence`, the event-store sequence of the
 * turn's opening message) and turn id. Passing it back requests the adjacent
 * disjoint slice of strictly older turns under `(anchor, turn_id)` ordering.
 *
 * The anchor is a sequence rather than a timestamp because a wall clock is not
 * an ordering key: a host clock excursion reorders turns against their write
 * order, which breaks the keyset walk and can drop rows off every page.
 *
 * The boundary is deliberately NOT a `projection_turns.row_id`: row ids are
 * rewritten by the revert projector (delete + re-upsert) and by projection
 * rebuilds, which would silently invalidate every persisted cursor with no
 * event emitted. The (anchor, turnId) pair is derived from event content, so
 * cursors survive both and no client-side refresh machinery is needed. The
 * anchor doubles as the bound for rows with no turn linkage (user messages,
 * turnless activities). The thread id is embedded so a cursor can never be
 * replayed against a different thread. Clients must treat the string as opaque.
 */
export interface ThreadDetailPageCursor {
  readonly threadId: ThreadId;
  readonly beforeAnchorSeq: number;
  /** Boundary turn id; "" for the rare turn row with a null turn_id. */
  readonly beforeTurnId: string;
}

/**
 * Cursor format version. Version 1 encoded the anchor as an ISO timestamp; a
 * v1 cursor decodes to null so an in-flight client degrades to a first-page
 * request instead of paging against a boundary that no longer means anything.
 */
const CURSOR_VERSION = 2;

export function encodeThreadDetailPageCursor(cursor: ThreadDetailPageCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      t: cursor.threadId,
      a: cursor.beforeAnchorSeq,
      i: cursor.beforeTurnId,
    }),
  ).toString("base64url");
}

/**
 * Returns null for anything that is not a well-formed cursor. Callers degrade
 * a malformed, outdated or foreign-thread cursor to a first-page request.
 */
export function decodeThreadDetailPageCursor(encoded: string): ThreadDetailPageCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== CURSOR_VERSION) {
    return null;
  }
  if (typeof record.t !== "string" || record.t.length === 0) {
    return null;
  }
  if (typeof record.a !== "number" || !Number.isSafeInteger(record.a) || record.a < 0) {
    return null;
  }
  // An empty turn key is a valid boundary value, not malformed input: the key
  // is "" for a row with a null turn_id.
  if (typeof record.i !== "string") {
    return null;
  }
  return { threadId: record.t as ThreadId, beforeAnchorSeq: record.a, beforeTurnId: record.i };
}
