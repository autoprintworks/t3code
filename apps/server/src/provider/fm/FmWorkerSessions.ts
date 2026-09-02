/**
 * FORK DELTA (fm provider) - worker sessions, the crewmates a First Mate runs.
 *
 * The door hosts one ACP session per live worker alongside the supervisor's
 * own, and answers `session/list` with all of them. `AcpSessionRuntime` finds
 * them and routes their `session/update` notifications; this module is the
 * vocabulary between that runtime and the reactor that turns them into
 * read-only threads.
 *
 * Everything here is pure, so the identity rules - which thread id a worker
 * maps to, what changed between two polls, which message a chunk belongs to -
 * can be asserted without a door or a database.
 *
 * @module provider/fm/FmWorkerSessions
 */
import { ThreadId } from "@t3tools/contracts";

import type { AcpPeerSession } from "../acp/AcpPeerSessions.ts";

/** A worker session the supervisor's door has started to host. */
export interface FmWorkerAppeared {
  readonly _tag: "WorkerAppeared";
  readonly supervisorThreadId: ThreadId;
  readonly workerSessionId: string;
  readonly title: string | undefined;
  readonly cwd: string;
}

/** A worker session the door no longer lists. The worker is over. */
export interface FmWorkerDisappeared {
  readonly _tag: "WorkerDisappeared";
  readonly supervisorThreadId: ThreadId;
  readonly workerSessionId: string;
}

/** A chunk of assistant text belonging to one message in one worker session. */
export interface FmWorkerText {
  readonly _tag: "WorkerText";
  readonly supervisorThreadId: ThreadId;
  readonly workerSessionId: string;
  readonly messageId: string;
  readonly text: string;
}

/** That message is finished; nothing more will be appended to it. */
export interface FmWorkerTextCompleted {
  readonly _tag: "WorkerTextCompleted";
  readonly supervisorThreadId: ThreadId;
  readonly workerSessionId: string;
  readonly messageId: string;
}

/**
 * What the adapter tells the reactor about the workers under one supervisor.
 *
 * The supervisor thread id travels with every observation because that is how
 * the reactor finds the project, the provider instance and the fallbacks a
 * worker thread inherits. The worker session id is the stable key for
 * everything else.
 */
export type FmWorkerObservation =
  | FmWorkerAppeared
  | FmWorkerDisappeared
  | FmWorkerText
  | FmWorkerTextCompleted;

/** Characters a thread id may carry through URLs, logs and ref names unescaped. */
const UNSAFE_THREAD_ID_CHARS = /[^A-Za-z0-9._-]/g;

/**
 * The thread id a worker session always maps to.
 *
 * Deterministic on purpose: a poll that re-reports a worker recreates the same
 * id, so "create it once and reuse it" needs no extra bookkeeping and no
 * persisted mapping table. Both halves are included because two supervisors
 * on one machine can legitimately host session ids that look alike.
 */
export function fmWorkerThreadId(input: {
  readonly supervisorThreadId: ThreadId;
  readonly workerSessionId: string;
}): ThreadId {
  const supervisor = input.supervisorThreadId.replace(UNSAFE_THREAD_ID_CHARS, "_");
  const worker = input.workerSessionId.trim().replace(UNSAFE_THREAD_ID_CHARS, "_");
  return ThreadId.make(`fm-worker.${supervisor}.${worker}`);
}

/**
 * What the thread is called in the sidebar.
 *
 * The door names its workers; when it does not, the session id is a poor title
 * but an honest one, and is still better than an empty row the user cannot
 * tell apart from its neighbours.
 */
export function fmWorkerThreadTitle(worker: {
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
export function reconcileFmWorkers(input: {
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
 * When there is not even that - a door that streams text before announcing an
 * item - a synthesised id keeps the chunk in a message of its own rather than
 * gluing unrelated text together.
 */
export function fmWorkerMessageIdFor(input: {
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
