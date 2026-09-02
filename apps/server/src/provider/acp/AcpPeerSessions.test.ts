/**
 * The rules a `session/list` answer is read by, asserted without a door.
 *
 * @see AcpSessionRuntime, which owns the polling fiber these rules feed.
 */
import { assert, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  advertisesSessionList,
  diffPeerSessions,
  peerSessionsFromListResponse,
} from "./AcpPeerSessions.ts";

const initializeResult = (
  agentCapabilities?: EffectAcpSchema.InitializeResponse["agentCapabilities"],
): EffectAcpSchema.InitializeResponse =>
  agentCapabilities === undefined
    ? { protocolVersion: 1 }
    : { protocolVersion: 1, agentCapabilities };

const listed = (
  sessions: ReadonlyArray<EffectAcpSchema.SessionInfo>,
): EffectAcpSchema.ListSessionsResponse => ({ sessions });

it("reads the list capability as presence, not as a boolean", () => {
  // ACP spells "supported" as an empty object, so truthiness is the wrong
  // question: `{}` is support and `null` is not.
  assert.isTrue(advertisesSessionList(initializeResult({ sessionCapabilities: { list: {} } })));
  assert.isFalse(advertisesSessionList(initializeResult({ sessionCapabilities: { list: null } })));
  assert.isFalse(advertisesSessionList(initializeResult({ sessionCapabilities: {} })));
  assert.isFalse(advertisesSessionList(initializeResult({})));
  assert.isFalse(advertisesSessionList(initializeResult()));
});

it("keeps only the sessions this connection did not open itself", () => {
  const peers = peerSessionsFromListResponse({
    ownSessionId: "fm-supervisor",
    response: listed([
      { sessionId: "fm-supervisor", cwd: "/repo", title: "supervisor" },
      { sessionId: "fm-worker-1", cwd: "/repo/a", title: "  build the thing  " },
      // A duplicate row is one worker, not two: the id is the identity.
      { sessionId: "fm-worker-1", cwd: "/repo/a", title: "build the thing" },
      // No usable id, so no stable key; surfacing it under a blank one would
      // collide with every other unnamed session.
      { sessionId: "   ", cwd: "/repo/b" },
      {
        sessionId: "fm-worker-2",
        cwd: "/repo/b",
        title: "   ",
        updatedAt: " 2026-09-02T00:00:00Z ",
      },
    ]),
  });

  assert.deepStrictEqual(peers, [
    { sessionId: "fm-worker-1", title: "build the thing", cwd: "/repo/a", updatedAt: undefined },
    {
      sessionId: "fm-worker-2",
      title: undefined,
      cwd: "/repo/b",
      updatedAt: "2026-09-02T00:00:00Z",
    },
  ]);
});

it("names what appeared and what disappeared between two answers", () => {
  const session = (sessionId: string) => ({
    sessionId,
    title: undefined,
    cwd: "/repo",
    updatedAt: undefined,
  });

  const diff = diffPeerSessions({
    previous: [session("fm-worker-1"), session("fm-worker-2")],
    next: [session("fm-worker-2"), session("fm-worker-3")],
  });

  assert.deepStrictEqual(
    diff.appeared.map((entry) => entry.sessionId),
    ["fm-worker-3"],
  );
  assert.deepStrictEqual(diff.disappeared, ["fm-worker-1"]);
  // The whole current set travels with every diff, so a consumer that misses
  // one item can still recover the truth from the next.
  assert.deepStrictEqual(
    diff.present.map((entry) => entry.sessionId),
    ["fm-worker-2", "fm-worker-3"],
  );

  const unchanged = diffPeerSessions({
    previous: [session("fm-worker-2")],
    next: [session("fm-worker-2")],
  });
  assert.deepStrictEqual(unchanged.appeared, []);
  assert.deepStrictEqual(unchanged.disappeared, []);
});
