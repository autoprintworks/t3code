/**
 * FORK DELTA (fm provider) - the identity rules worker threads rest on.
 *
 * @see FmWorkerThreadReactor.test.ts for what these rules buy at the seam.
 */
import { assert, it } from "@effect/vitest";

import { ThreadId } from "@t3tools/contracts";

import type { AcpPeerSession } from "../acp/AcpPeerSessions.ts";
import {
  fmWorkerMessageIdFor,
  fmWorkerThreadId,
  fmWorkerThreadTitle,
  reconcileFmWorkers,
} from "./FmWorkerSessions.ts";

const SUPERVISOR = ThreadId.make("fm-thread-1");

const worker = (sessionId: string): AcpPeerSession => ({
  sessionId,
  title: undefined,
  cwd: "/repo",
  updatedAt: undefined,
});

it("maps a worker session to one thread id, every time", () => {
  const first = fmWorkerThreadId({ supervisorThreadId: SUPERVISOR, workerSessionId: "fm-w-1" });
  assert.equal(first, "fm-worker.fm-thread-1.fm-w-1");
  // The same worker on the next poll is the same thread, which is what makes
  // "create once, reuse" need no persisted mapping table.
  assert.equal(
    fmWorkerThreadId({ supervisorThreadId: SUPERVISOR, workerSessionId: "  fm-w-1  " }),
    first,
  );
  // Two supervisors on one machine can host ids that look alike, so both
  // halves are in the key.
  assert.notEqual(
    fmWorkerThreadId({
      supervisorThreadId: ThreadId.make("fm-thread-2"),
      workerSessionId: "fm-w-1",
    }),
    first,
  );
  // Anything that would need escaping in a URL, a log line or a ref name is
  // flattened rather than carried.
  assert.equal(
    fmWorkerThreadId({ supervisorThreadId: SUPERVISOR, workerSessionId: "a/b c:d" }),
    "fm-worker.fm-thread-1.a_b_c_d",
  );
});

it("falls back to the session id when the door names no worker", () => {
  assert.equal(fmWorkerThreadTitle({ title: " build ", workerSessionId: "fm-w-1" }), "build");
  assert.equal(fmWorkerThreadTitle({ title: "   ", workerSessionId: "fm-w-1" }), "fm-w-1");
  assert.equal(fmWorkerThreadTitle({ title: undefined, workerSessionId: "fm-w-1" }), "fm-w-1");
});

it("reports a worker once however many polls see it", () => {
  const first = reconcileFmWorkers({ known: new Set(), present: [worker("fm-w-1")] });
  assert.deepStrictEqual(
    first.appeared.map((entry) => entry.sessionId),
    ["fm-w-1"],
  );
  assert.deepStrictEqual(first.disappeared, []);

  // The same answer again. A consumer that already knows this worker is told
  // nothing, which is what stops a poll every two seconds creating threads.
  const repeat = reconcileFmWorkers({ known: new Set(["fm-w-1"]), present: [worker("fm-w-1")] });
  assert.deepStrictEqual(repeat.appeared, []);
  assert.deepStrictEqual(repeat.disappeared, []);

  const gone = reconcileFmWorkers({ known: new Set(["fm-w-1"]), present: [] });
  assert.deepStrictEqual(gone.appeared, []);
  assert.deepStrictEqual(gone.disappeared, ["fm-w-1"]);
});

it("recovers a missed appearance from the next answer", () => {
  // The consumer never saw `fm-w-1` appear, but `present` carries the whole
  // set, so the very next reconcile restores it alongside the new worker.
  const recovered = reconcileFmWorkers({
    known: new Set(["fm-w-0"]),
    present: [worker("fm-w-1"), worker("fm-w-2")],
  });
  assert.deepStrictEqual(
    recovered.appeared.map((entry) => entry.sessionId),
    ["fm-w-1", "fm-w-2"],
  );
  assert.deepStrictEqual(recovered.disappeared, ["fm-w-0"]);
});

it("puts a bare chunk in the message the door last started", () => {
  const base = { workerSessionId: "fm-w-1", fallbackCount: 3 };
  assert.equal(
    fmWorkerMessageIdFor({ ...base, itemId: " item-9 ", currentMessageId: "item-1" }),
    "item-9",
  );
  assert.equal(
    fmWorkerMessageIdFor({ ...base, itemId: undefined, currentMessageId: "item-1" }),
    "item-1",
  );
  // A door that streams text before announcing an item: the chunk gets a
  // message of its own rather than being glued onto unrelated text.
  assert.equal(
    fmWorkerMessageIdFor({ ...base, itemId: undefined, currentMessageId: undefined }),
    "fm-w-1#3",
  );
});
