import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  decodeThreadDetailPageCursor,
  encodeThreadDetailPageCursor,
} from "./threadDetailCursor.ts";

describe("threadDetailCursor", () => {
  it("round-trips a cursor", () => {
    const cursor = {
      threadId: ThreadId.make("thread-1"),
      beforeAnchorAt: "2026-08-01T00:00:00.000Z",
      beforeTurnId: "turn-9",
    };
    expect(decodeThreadDetailPageCursor(encodeThreadDetailPageCursor(cursor))).toEqual(cursor);
  });

  it("round-trips empty boundary values", () => {
    // The anchor is COALESCE(requested_at, started_at, '') and the turn key
    // is COALESCE(turn_id, ''), so a server-minted cursor can legitimately
    // carry empty strings; rejecting them would degrade a valid cursor to a
    // first-page request that repeats recent history (review finding).
    const cursor = {
      threadId: ThreadId.make("thread-1"),
      beforeAnchorAt: "",
      beforeTurnId: "",
    };
    expect(decodeThreadDetailPageCursor(encodeThreadDetailPageCursor(cursor))).toEqual(cursor);
  });

  it("rejects a cursor from another format version", () => {
    // Version 2 keyed the boundary on an event-store sequence. Reading its
    // fields under the current meanings would page from the wrong place, so
    // the version is checked before anything else.
    expect(
      decodeThreadDetailPageCursor(
        Buffer.from(JSON.stringify({ v: 2, t: "thread-1", a: 41, i: "turn-9" })).toString(
          "base64url",
        ),
      ),
    ).toBeNull();
    expect(
      decodeThreadDetailPageCursor(
        Buffer.from(
          JSON.stringify({ t: "thread-1", a: "2026-08-01T00:00:00.000Z", i: "turn-9" }),
        ).toString("base64url"),
      ),
    ).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(decodeThreadDetailPageCursor("not-base64-json")).toBeNull();
    expect(decodeThreadDetailPageCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
    expect(
      decodeThreadDetailPageCursor(
        Buffer.from(JSON.stringify({ v: 3, t: "" })).toString("base64url"),
      ),
    ).toBeNull();
    expect(
      decodeThreadDetailPageCursor(
        Buffer.from(JSON.stringify({ v: 3, t: "thread-1", a: 5, i: "x" })).toString("base64url"),
      ),
    ).toBeNull();
  });
});
