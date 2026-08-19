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
      beforeAnchorSeq: 4211,
      beforeTurnId: "turn-9",
    };
    expect(decodeThreadDetailPageCursor(encodeThreadDetailPageCursor(cursor))).toEqual(cursor);
  });

  it("round-trips empty boundary values", () => {
    // The anchor is 0 for a turn whose originating event could not be resolved
    // and the turn key is COALESCE(turn_id, ''), so a server-minted cursor can
    // legitimately carry both; rejecting them would degrade a valid cursor to a
    // first-page request that repeats recent history (review finding).
    const cursor = {
      threadId: ThreadId.make("thread-1"),
      beforeAnchorSeq: 0,
      beforeTurnId: "",
    };
    expect(decodeThreadDetailPageCursor(encodeThreadDetailPageCursor(cursor))).toEqual(cursor);
  });

  it("rejects a version 1 cursor so an in-flight client restarts from page one", () => {
    // Version 1 encoded the anchor as an ISO timestamp. Paging against it would
    // compare a timestamp with a sequence and silently drop turns.
    const legacy = Buffer.from(
      JSON.stringify({ t: "thread-1", a: "2026-08-01T00:00:00.000Z", i: "turn-9" }),
    ).toString("base64url");
    expect(decodeThreadDetailPageCursor(legacy)).toBeNull();
  });

  it("rejects a non-integer or negative anchor", () => {
    for (const anchor of [1.5, -1, Number.NaN, "12"]) {
      const encoded = Buffer.from(
        JSON.stringify({ v: 2, t: "thread-1", a: anchor, i: "turn-9" }),
      ).toString("base64url");
      expect(decodeThreadDetailPageCursor(encoded)).toBeNull();
    }
  });

  it("rejects malformed input", () => {
    expect(decodeThreadDetailPageCursor("not-base64-json")).toBeNull();
    expect(decodeThreadDetailPageCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
    expect(
      decodeThreadDetailPageCursor(Buffer.from(JSON.stringify({ t: "" })).toString("base64url")),
    ).toBeNull();
    expect(
      decodeThreadDetailPageCursor(
        Buffer.from(JSON.stringify({ v: 2, t: "thread-1", a: 5, i: 7 })).toString("base64url"),
      ),
    ).toBeNull();
  });
});
