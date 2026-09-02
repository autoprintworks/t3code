/**
 * Worker sessions: the peer sessions a supervising agent runs.
 *
 * A supervising agent hosts one ACP session per live worker alongside the supervisor's
 * own, and answers `session/list` with all of them. `AcpSessionRuntime` finds
 * them and routes their `session/update` notifications; this module is the
 * vocabulary between that runtime and the reactor that turns them into
 * read-only threads.
 *
 * Everything here is pure, so the identity rules - which thread id a worker
 * maps to, what changed between two polls, which message a chunk belongs to -
 * can be asserted without an agent or a database.
 *
 * @module provider/acpAgent/AcpAgentWorkerSessions
 */
import { ThreadId } from "@t3tools/contracts";

import type { AcpPeerSession } from "../acp/AcpPeerSessions.ts";

/** Fields every observation carries, whatever it says. */
interface AcpAgentWorkerObservationBase {
  /**
   * Which supervisor thread saw this. The reactor reads the project, the
   * provider instance and the model fallbacks from it.
   */
  readonly supervisorThreadId: ThreadId;
  /**
   * The agent's own ACP session id, the one this client opened.
   *
   * This, not the supervisor thread id, is what a worker thread is named
   * after: two supervisor threads opened on one home are two views of one set
   * of workers, and naming by thread would mint a duplicate thread per worker
   * per view.
   */
  readonly homeSessionId: string;
}

/** A peer session the supervisor's agent has started to host. */
export interface AcpAgentWorkerAppeared extends AcpAgentWorkerObservationBase {
  readonly _tag: "WorkerAppeared";
  readonly workerSessionId: string;
  readonly title: string | undefined;
  readonly cwd: string;
}

/**
 * Why a worker stopped being watched.
 *
 * ACP's `SessionInfo` has no status field, so the protocol never says "this
 * worker finished". What it does say is whether the agent still lists the
 * session while the agent is answering, and that is the whole difference:
 *
 * - `finished`: the agent answered `session/list` and this session was not in
 *   it. The worker is over, and its thread is archived.
 * - `unknown`: the watch itself ended - connection lost, editor shutting down,
 *   agent exited. The worker's fate is not ours to state, so the thread keeps
 *   its place in the sidebar and only its spinner is cleared. The agent process
 *   and its workers outlive an editor restart, so archiving here would archive
 *   work that is still running.
 */
export type AcpAgentWorkerEndReason = "finished" | "unknown";

/** A worker session that is no longer being watched. */
export interface AcpAgentWorkerDisappeared extends AcpAgentWorkerObservationBase {
  readonly _tag: "WorkerDisappeared";
  readonly workerSessionId: string;
  readonly reason: AcpAgentWorkerEndReason;
}

/**
 * Every worker this home is hosting right now, as of one poll.
 *
 * The reactor needs the whole set, not just what changed, because what it
 * knows is in memory and the threads it made are on disk. After a restart the
 * two disagree, and the roster is what settles it: a worker thread for this
 * home that the roster does not mention is a worker that ended while the
 * editor was not running.
 */
export interface AcpAgentWorkerRoster extends AcpAgentWorkerObservationBase {
  readonly _tag: "WorkerRoster";
  readonly workerSessionIds: ReadonlyArray<string>;
}

/**
 * The worker's transcript could not be read.
 *
 * Said out loud rather than logged, because the alternative is a thread that
 * is empty for a reason the user cannot see. One attempt, one answer: this is
 * a terminal statement about that worker, not a promise to try again.
 */
export interface AcpAgentWorkerLoadFailed extends AcpAgentWorkerObservationBase {
  readonly _tag: "WorkerLoadFailed";
  readonly workerSessionId: string;
  readonly detail: string;
}

/** A chunk of assistant text belonging to one message in one worker session. */
export interface AcpAgentWorkerText extends AcpAgentWorkerObservationBase {
  readonly _tag: "WorkerText";
  readonly workerSessionId: string;
  readonly messageId: string;
  readonly text: string;
}

/** That message is finished; nothing more will be appended to it. */
export interface AcpAgentWorkerTextCompleted extends AcpAgentWorkerObservationBase {
  readonly _tag: "WorkerTextCompleted";
  readonly workerSessionId: string;
  readonly messageId: string;
}

/**
 * What the adapter tells the reactor about the workers under one supervisor.
 *
 * The supervisor thread id travels with every observation because that is how
 * the reactor finds the project, the provider instance and the fallbacks a
 * worker thread inherits. The home session id is the stable key for everything
 * else.
 */
export type AcpAgentWorkerObservation =
  | AcpAgentWorkerAppeared
  | AcpAgentWorkerDisappeared
  | AcpAgentWorkerRoster
  | AcpAgentWorkerLoadFailed
  | AcpAgentWorkerText
  | AcpAgentWorkerTextCompleted;

/** Characters a thread id may carry through URLs, logs and ref names unescaped. */
const UNSAFE_THREAD_ID_CHARS = /[^A-Za-z0-9._-]/g;

/** The longest a sanitised id segment may be before it is hashed down. */
const MAX_THREAD_ID_SEGMENT_CHARS = 64;

/**
 * A 32-bit FNV-1a of the raw text, hex, eight characters.
 *
 * Only ever used as a suffix on a truncated segment, so it needs to separate
 * two ids that share a long prefix, not to resist an adversary.
 */
function shortHash(raw: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * One id segment: safe characters only, and bounded in length.
 *
 * An agent may derive its session id from a path, which on Windows can be
 * long. Truncating alone would collide two homes under one directory, so the
 * truncation carries a hash of the whole original.
 */
function threadIdSegment(raw: string): string {
  const safe = raw.trim().replace(UNSAFE_THREAD_ID_CHARS, "_");
  if (safe.length <= MAX_THREAD_ID_SEGMENT_CHARS) {
    return safe;
  }
  return `${safe.slice(0, MAX_THREAD_ID_SEGMENT_CHARS - 9)}-${shortHash(raw)}`;
}

/**
 * What every worker thread id for one home begins with.
 *
 * Exported because it is also the range a sweep reads: `>= prefix` and
 * `< prefix + "￿"` is an index scan over one home's worker threads, which
 * is what keeps the startup reconcile proportional to that home's workers
 * rather than to every thread in the database.
 */
export function acpAgentWorkerThreadIdPrefix(homeSessionId: string): string {
  return `acp-worker.${threadIdSegment(homeSessionId)}.`;
}

/**
 * The thread id a worker session always maps to.
 *
 * Deterministic on purpose: a poll that re-reports a worker recreates the same
 * id, so "create it once and reuse it" needs no extra bookkeeping and no
 * persisted mapping table. The home is included because two agents on one
 * machine can legitimately host session ids that look alike; the supervisor
 * thread is not, because two threads on one home watch the same workers.
 */
export function acpAgentWorkerThreadId(input: {
  readonly homeSessionId: string;
  readonly workerSessionId: string;
}): ThreadId {
  return ThreadId.make(
    `${acpAgentWorkerThreadIdPrefix(input.homeSessionId)}${threadIdSegment(input.workerSessionId)}`,
  );
}

/**
 * What the thread is called in the sidebar.
 *
 * A supervising agent names its workers; when it does not, the session id is a poor title
 * but an honest one, and is still better than an empty row the user cannot
 * tell apart from its neighbours.
 */
export function acpAgentWorkerThreadTitle(worker: {
  readonly title: string | undefined;
  readonly workerSessionId: string;
}): string {
  const title = worker.title?.trim();
  return title ? title : worker.workerSessionId;
}

/**
 * The workers that appeared and disappeared, measured against what a consumer
 * already knows rather than against the previous poll.
 *
 * Reconciling against the whole `present` set is what makes a consumer immune
 * to a dropped diff: one late item still restores the truth. It is also what
 * makes a repeated poll a no-op, because a worker already in `known` is not
 * reported again.
 */
export function reconcileAcpAgentWorkers(input: {
  readonly known: ReadonlySet<string>;
  readonly present: ReadonlyArray<AcpPeerSession>;
}): {
  readonly appeared: ReadonlyArray<AcpPeerSession>;
  readonly disappeared: ReadonlyArray<string>;
} {
  const presentIds = new Set(input.present.map((session) => session.sessionId));
  return {
    appeared: input.present.filter((session) => !input.known.has(session.sessionId)),
    disappeared: [...input.known].filter((sessionId) => !presentIds.has(sessionId)),
  };
}

/**
 * Which message a chunk of worker text belongs to.
 *
 * ACP tags most content with the item it belongs to, but a chunk may arrive
 * bare, and the last started item is the only honest answer for one of those.
 * When there is not even that - an agent that streams text before announcing an
 * item - a synthesised id keeps the chunk in a message of its own rather than
 * gluing unrelated text together.
 */
export function acpAgentWorkerMessageIdFor(input: {
  readonly workerSessionId: string;
  readonly itemId: string | undefined;
  readonly currentMessageId: string | undefined;
  readonly fallbackCount: number;
}): string {
  const itemId = input.itemId?.trim();
  if (itemId) return itemId;
  if (input.currentMessageId) return input.currentMessageId;
  return `${input.workerSessionId}#${input.fallbackCount}`;
}
