/**
 * The identity rules worker threads rest on.
 *
 * @see AcpAgentWorkerThreadReactor.test.ts for what these rules buy at the seam.
 */
import { assert, it } from "@effect/vitest";

import type { AcpPeerSession } from "../acp/AcpPeerSessions.ts";
import {
  acpAgentWorkerMessageIdFor,
  acpAgentWorkerThreadId,
  acpAgentWorkerThreadIdPrefix,
  acpAgentWorkerThreadTitle,
  reconcileAcpAgentWorkers,
} from "./AcpAgentWorkerSessions.ts";

const HOME = "home-1";

const worker = (sessionId: string): AcpPeerSession => ({
  sessionId,
  title: undefined,
  cwd: "/repo",
  updatedAt: undefined,
});

it("maps a worker session to one thread id, every time", () => {
  const first = acpAgentWorkerThreadId({ homeSessionId: HOME, workerSessionId: "w-1" });
  assert.equal(first, "acp-worker.home-1.w-1");
  // The same worker on the next poll is the same thread, which is what makes
  // "create once, reuse" need no persisted mapping table.
  assert.equal(acpAgentWorkerThreadId({ homeSessionId: HOME, workerSessionId: "  w-1  " }), first);
  // Two agents on one machine can host ids that look alike, so the home is in
  // the key.
  assert.notEqual(
    acpAgentWorkerThreadId({ homeSessionId: "home-2", workerSessionId: "w-1" }),
    first,
  );
  // Anything that would need escaping in a URL, a log line or a ref name is
  // flattened rather than carried.
  assert.equal(
    acpAgentWorkerThreadId({ homeSessionId: HOME, workerSessionId: "a/b c:d" }),
    "acp-worker.home-1.a_b_c_d",
  );
});

it("keys a worker on its home, not on the thread watching it", () => {
  // Two supervisor threads opened on one home watch the same workers. Naming
  // by thread would mint a second thread per worker per view; naming by home
  // is what makes the second view a view of the first.
  assert.equal(
    acpAgentWorkerThreadId({ homeSessionId: HOME, workerSessionId: "w-1" }),
    acpAgentWorkerThreadId({ homeSessionId: HOME, workerSessionId: "w-1" }),
  );
  assert.equal(acpAgentWorkerThreadIdPrefix(HOME), "acp-worker.home-1.");
  assert.ok(
    acpAgentWorkerThreadId({ homeSessionId: HOME, workerSessionId: "w-1" }).startsWith(
      acpAgentWorkerThreadIdPrefix(HOME),
    ),
  );
});

it("bounds a long id without collapsing two of them together", () => {
  // An agent may derive its session id from a path, which on Windows is long.
  // Truncating alone would file two homes under one directory as one home.
  const longA = `C:/Users/glyn/${"deep/".repeat(30)}alpha`;
  const longB = `C:/Users/glyn/${"deep/".repeat(30)}beta`;
  const idA = acpAgentWorkerThreadId({ homeSessionId: longA, workerSessionId: "w-1" });
  const idB = acpAgentWorkerThreadId({ homeSessionId: longB, workerSessionId: "w-1" });
  assert.notEqual(idA, idB);
  assert.ok(idA.length < 100, `expected a bounded id, got ${String(idA.length)} characters`);
  // Still deterministic: the same home twice is the same thread twice.
  assert.equal(idA, acpAgentWorkerThreadId({ homeSessionId: longA, workerSessionId: "w-1" }));
});

it("falls back to the session id when the agent names no worker", () => {
  assert.equal(acpAgentWorkerThreadTitle({ title: " build ", workerSessionId: "w-1" }), "build");
  assert.equal(acpAgentWorkerThreadTitle({ title: "   ", workerSessionId: "w-1" }), "w-1");
  assert.equal(acpAgentWorkerThreadTitle({ title: undefined, workerSessionId: "w-1" }), "w-1");
});

it("reports a worker once however many polls see it", () => {
  const first = reconcileAcpAgentWorkers({ known: new Set(), present: [worker("w-1")] });
  assert.deepStrictEqual(
    first.appeared.map((entry) => entry.sessionId),
    ["w-1"],
  );
  assert.deepStrictEqual(first.disappeared, []);

  // The same answer again. A consumer that already knows this worker is told
  // nothing, which is what stops a poll every two seconds creating threads.
  const repeat = reconcileAcpAgentWorkers({ known: new Set(["w-1"]), present: [worker("w-1")] });
  assert.deepStrictEqual(repeat.appeared, []);
  assert.deepStrictEqual(repeat.disappeared, []);

  const gone = reconcileAcpAgentWorkers({ known: new Set(["w-1"]), present: [] });
  assert.deepStrictEqual(gone.appeared, []);
  assert.deepStrictEqual(gone.disappeared, ["w-1"]);
});

it("recovers a missed appearance from the next answer", () => {
  // The consumer never saw `w-1` appear, but `present` carries the whole
  // set, so the very next reconcile restores it alongside the new worker.
  const recovered = reconcileAcpAgentWorkers({
    known: new Set(["w-0"]),
    present: [worker("w-1"), worker("w-2")],
  });
  assert.deepStrictEqual(
    recovered.appeared.map((entry) => entry.sessionId),
    ["w-1", "w-2"],
  );
  assert.deepStrictEqual(recovered.disappeared, ["w-0"]);
});

it("puts a bare chunk in the message the agent last started", () => {
  const base = { workerSessionId: "w-1", fallbackCount: 3 };
  assert.equal(
    acpAgentWorkerMessageIdFor({ ...base, itemId: " item-9 ", currentMessageId: "item-1" }),
    "item-9",
  );
  assert.equal(
    acpAgentWorkerMessageIdFor({ ...base, itemId: undefined, currentMessageId: "item-1" }),
    "item-1",
  );
  // An agent that streams text before announcing an item: the chunk gets a
  // message of its own rather than being glued onto unrelated text.
  assert.equal(
    acpAgentWorkerMessageIdFor({ ...base, itemId: undefined, currentMessageId: undefined }),
    "w-1#3",
  );
});
