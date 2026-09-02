/**
 * Peer sessions - the sessions an ACP connection hosts besides its own.
 *
 * ACP lets one agent connection carry more than one session. `session/list`
 * is how a client learns about the sessions it did not open itself, and the
 * protocol has no agent-to-client notification for a session appearing, so
 * polling that method is the protocol's own answer rather than a workaround.
 *
 * Everything here is pure: capability reading, filtering the connection's own
 * session out of the answer, and diffing two answers. `AcpSessionRuntime` owns
 * the polling fiber and the routing; this module is what its tests can assert
 * against without a door.
 *
 * @module provider/acp/AcpPeerSessions
 */
import type * as EffectAcpSchema from "effect-acp/schema";

/** One session on this connection that the connection did not open itself. */
export interface AcpPeerSession {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly cwd: string;
  readonly updatedAt: string | undefined;
}

/**
 * What changed between two `session/list` answers.
 *
 * `appeared` and `disappeared` are what a caller acts on; `present` is the
 * whole current set, so a caller that lost its place can reconcile from one
 * value instead of replaying a diff history.
 */
export interface AcpPeerSessionDiff {
  readonly present: ReadonlyArray<AcpPeerSession>;
  readonly appeared: ReadonlyArray<AcpPeerSession>;
  readonly disappeared: ReadonlyArray<string>;
}

/**
 * Whether the agent said it answers `session/list`.
 *
 * The capability is a presence flag, not a boolean: ACP spells "supported" as
 * an empty object, so `null` and absent both mean no.
 */
export function advertisesSessionList(
  initializeResult: EffectAcpSchema.InitializeResponse,
): boolean {
  const list = initializeResult.agentCapabilities?.sessionCapabilities?.list;
  return list !== undefined && list !== null;
}

/**
 * The sessions in a `session/list` answer that are not this connection's own.
 *
 * A session with no usable id is dropped rather than surfaced under a blank
 * key: the id is what every caller downstream uses as its stable identity.
 */
export function peerSessionsFromListResponse(input: {
  readonly response: EffectAcpSchema.ListSessionsResponse;
  readonly ownSessionId: string;
}): ReadonlyArray<AcpPeerSession> {
  const seen = new Set<string>();
  const peers: Array<AcpPeerSession> = [];
  for (const session of input.response.sessions) {
    const sessionId = session.sessionId.trim();
    if (sessionId === "" || sessionId === input.ownSessionId || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    const title = session.title?.trim();
    const updatedAt = session.updatedAt?.trim();
    peers.push({
      sessionId,
      title: title ? title : undefined,
      cwd: session.cwd,
      updatedAt: updatedAt ? updatedAt : undefined,
    });
  }
  return peers;
}

/** Diffs the previous peer set against the newest answer, keyed by session id. */
export function diffPeerSessions(input: {
  readonly previous: ReadonlyArray<AcpPeerSession>;
  readonly next: ReadonlyArray<AcpPeerSession>;
}): AcpPeerSessionDiff {
  const previousIds = new Set(input.previous.map((session) => session.sessionId));
  const nextIds = new Set(input.next.map((session) => session.sessionId));
  return {
    present: input.next,
    appeared: input.next.filter((session) => !previousIds.has(session.sessionId)),
    disappeared: input.previous
      .map((session) => session.sessionId)
      .filter((sessionId) => !nextIds.has(sessionId)),
  };
}
