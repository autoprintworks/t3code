# Why does mobile delete a server-rejected queued message and report it as delivered?

Research for [#25](https://github.com/autoprintworks/t3code/issues/25). Source-only: every
claim below is cited to a file and line in the `t3code` checkout at
`C:\00_AI_Development\t3code` (paths below are repo-relative).

**The short answer.** The issue is accurate. On mobile, a deterministic server rejection of a
queued turn start (an `OrchestrationCommandInvariantError` from the decider) resolves to
`"discard"` in the outbox model, and `completeDelivery` treats a non-retry outcome identically
to success: it deletes the message and returns `true`. The only trace is a `console.warn`. There
is no error field on `QueuedThreadMessage` and no thread-error surface anywhere in mobile, so the
user sees nothing. Web, by contrast, restores the composer draft and calls `setThreadError` on
the same failure. Issue #19's fix (reject `thread.turn.start` on an archived thread in the
decider) did land and is what makes this path newly reachable and explicit; mobile silently
converts that explicit rejection back into a drop. Every specific line reference in the issue is
correct modulo trivial drift.

---

## 1. The retry decision: only transport is retryable, everything else discards

`resolveThreadOutboxFailureAction` returns `"retry"` only for a settings-sync stage, an
interrupt, or a transport error; otherwise `"discard"`
(`apps/mobile/src/state/thread-outbox-model.ts:214-227`). "Transport error" is defined by
`shouldRetryThreadOutboxDelivery`, which matches only `_tag === "ConnectionTransientError"` or a
transport connection-error message string (`thread-outbox-model.ts:199-209`,
`isTransportConnectionErrorMessage` from `packages/client-runtime/src/errors/transport.ts`). A
deterministic `OrchestrationCommandInvariantError` is neither, so it falls through to `"discard"`.

The issue quotes these functions and cites `199-227`. Confirmed exact — `shouldRetry...` is
`199-209` and `resolveThreadOutboxFailureAction` is `214-227`.

## 2. `QueuedThreadMessage` has no error or status field

`QueuedThreadMessage` (`apps/mobile/src/state/thread-outbox-model.ts:69-81`) carries
`environmentId`, `threadId`, `messageId`, `commandId`, `text`, `attachments`, optional
`modelSelection` / `runtimeMode` / `interactionMode`, optional `creation`, and `createdAt`. There
is no `error`, `status`, or `failedAt` field. The persisted schema
(`QueuedThreadMessageSchema`, `:39-54`) matches — nowhere to record a failure even if the drain
wanted to. The issue's claim and its `69-81` citation are correct.

## 3. `completeDelivery` treats discard as delivered

`completeDelivery` (`apps/mobile/src/state/use-thread-outbox-drain.ts:145-164`):

- calls `reportFailure(deliveryResult, "start-turn")`; if that returns `true` (retry) it returns
  `false`, which keeps the message queued and schedules backoff (`:148-150`);
- otherwise it calls `removeThreadOutboxMessage(queuedMessage)` and returns `true` (`:152-153`).

`reportFailure` (`:121-144`) returns `false` for any non-failure result *and* for a `"discard"`
action, because `retry = action === "retry"` and it returns `retry` (`:134,143`). So a
deterministic rejection produces `reportFailure` → `false` → the `completeDelivery` early return
is skipped → the message is deleted and `true` is returned. `true` bubbles up as `sent` in the
drain's `.then((sent) => ...)` at `:392-402`, which clears the retry bookkeeping — i.e. reported
as delivered. The issue's paraphrased snippet and its `145-164` / `135-142` citations are
correct; the real `console.warn` is at `:135-142`.

Note: the `startTurn` command atom is created with `reportFailure: false`
(`use-thread-outbox-drain.ts:89`), so the atom layer itself surfaces nothing either. The only
output on this path is the developer `console.warn` at `:135-142`.

## 4. Mobile has no thread-error surface at all

A repo-wide search for `setThreadError` / `threadError` / `LocalThreadError` under
`apps/mobile/src` returns nothing. Web's `setThreadError`
(`apps/web/src/components/ChatView.tsx:2579-2601+`) writes into
`localServerErrorsByThreadKey`; mobile has no equivalent store or call site. So even if the drain
detected the rejection, there is currently no place to show it. This confirms the issue's
"Reverse-state note": neither a way to recover the message nor a way to see it was dropped.

## 5. How web handles the same rejection (the model mobile lacks)

In web's send handler, a failed `startThreadTurn` is captured as `failure`
(`apps/web/src/components/ChatView.tsx:4893-4894`). When `failure !== null`
(`:4900-4943`):

- If the composer is empty (no prompt, images, terminal/element contexts, preview annotations,
  or review comments — `:4901-4910`), it **restores the draft**: it removes the optimistic user
  message (`:4911-4918`), then rewrites `promptRef`, the composer image/terminal/element refs,
  and the composer draft store back to the pre-send snapshot
  (`:4919-4929`) and resets the cursor (`:4930-4934`). The text the user typed comes back into
  the composer.
- Then, unless the failure was an interrupt, it squashes the cause and calls
  `setThreadError(threadIdForSend, message)` (`:4936-4942`), surfacing the server's error
  message on the thread.

That is the two-part behavior mobile is missing: restore-to-composer plus a visible thread error.
The issue's `4900-4943` citation is exact.

## 6. Where the deterministic rejection comes from (server) and #19's role

`thread.turn.start` in the decider now calls `requireThreadNotArchived` as its first step
(`apps/server/src/orchestration/decider.ts:762-771`), whose comment explicitly says a stale
client sending into an archived thread "is refused here rather than persisting a user message the
provider reactor would later drop in silence." `requireThreadNotArchived`
(`apps/server/src/orchestration/commandInvariants.ts:135-152`) fails with an
`OrchestrationCommandInvariantError` when `archivedAt !== null`. That error type is defined in
`apps/server/src/orchestration/Errors.ts` and raised throughout the decider
(`decider.ts:12` import; e.g. `:785,791,306,415,470`).

This is exactly the fix #19 asked for (its "Suggested shape" option 1: "Reject in the decider").
[#19](https://github.com/autoprintworks/t3code/issues/19) is CLOSED, and the presence of
`requireThreadNotArchived` on the turn-start path plus `apps/server/src/orchestration/
decider.archived.test.ts` confirms it landed. So the issue's claim — "#19 made
`thread.turn.start` reject on an archived thread instead of accepting and silently dropping it,
which improved web and made this mobile bug easier to reach" — is accurate.

The rejection is **general**, not archive-specific: any `OrchestrationCommandInvariantError` from
the turn-start path (deleted/missing thread, cross-project proposed plan at `decider.ts:784-795`,
model/state invariants, etc.) reaches the same mobile discard. The issue's "pre-existing and
general" framing is correct.

## 7. Contracts

There is no dedicated outbox or delivery-result contract in `packages/contracts` — the outbox is
a mobile-local concern. Delivery uses the standard `thread.startTurn` command atom
(`apps/mobile/src/state/use-thread-outbox-drain.ts:220-236`), and failures arrive as an
`AtomCommandResult` whose `cause` is squashed with `Cause.squash` (`:131`). The error tags that
drive the retry decision (`ConnectionTransientError`, transport message matching) live in
`packages/client-runtime/src/errors/transport.ts`, not in `packages/contracts`. So no contract
change is strictly required for a fix; the schema that would change is the mobile-local
`QueuedThreadMessageSchema` (§2).

---

## Fix surface the issue proposes (mapped, not implemented)

The bug is the silence, not the discard policy (the issue is explicit that discard-on-
deterministic-failure should stay). The three touch points:

- **(a) Distinguish rejected from delivered in `completeDelivery`.** Today `completeDelivery`
  (`use-thread-outbox-drain.ts:145-164`) collapses "retry", "discard", and "success" into two
  outcomes (`false` = keep+retry, `true` = delete). A fix needs `resolveThreadOutboxFailureAction`
  to be consulted for its actual action (`"retry"` vs `"discard"`) at the drain level, so a
  discard can be handled distinctly from a genuine success rather than both deleting and returning
  `true`. `reportFailure` already computes `action`/`retry` (`:129-134`) but throws the
  `"discard"` distinction away by returning only the boolean.

- **(b) Add a status/error field to `QueuedThreadMessage`.** Required if the chosen surface is
  "keep the message queued in a failed state." Would touch both the runtime interface
  (`thread-outbox-model.ts:69-81`) and the persisted `QueuedThreadMessageSchema` (`:39-54`),
  including a schema-version bump (`THREAD_OUTBOX_SCHEMA_VERSION`, `:24,40`) and the drain guards
  that today re-send `queuedMessages[0]` unconditionally (`use-thread-outbox-drain.ts:290-300`)
  so a failed message is not retried forever.

- **(c) Restore-to-composer like web.** Would require introducing a mobile thread-error surface
  (mobile has none today, §4) and a composer-restore path mirroring
  `ChatView.tsx:4900-4942`. This is the larger of the two options because it needs new UI state,
  whereas (b) reuses the existing outbox list rendering.

The minimal change consistent with the issue's stated intent is (a) + one of {(b) keep-in-failed-
state, (c) restore-to-composer}. No server or contract change is needed.

---

## Where the issue is inaccurate or out of date

Nothing material. All line ranges cited in the issue resolve to the described code (with only the
trivial split that `shouldRetryThreadOutboxDelivery` is `199-209` and
`resolveThreadOutboxFailureAction` is `214-227`, both inside the issue's `199-227` range). The
diagnosis, the web-vs-mobile contrast, the "general, not archive-specific" scope, and the #19
causal link are all correct against current source.
