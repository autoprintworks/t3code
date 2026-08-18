# Thread order repair

`apps/server/src/persistence/Repairs/RepairThreadOrder.ts` is a one-off,
opt-in repair for threads whose row order was corrupted by a host clock
change. It is not wired into the migration pipeline or the `t3` CLI — see
`repairThreadOrderCli.ts` in the same folder for how a maintainer runs it by
hand against an explicit database path.

## The bug this heals

Transcript order (chat view, server pagination, mobile activity feed) is
sorted by wall-clock `created_at`, with no monotonic tiebreak. If the host
clock jumps — forward or back — while a thread is active, rows land with
`created_at` values that no longer match the order they were actually
created in, and the transcript renders out of order: a reply can appear to
land in the middle of the conversation instead of at the end.

The row insertion order that actually happened is `orchestration_events.sequence`
(monotonic autoincrement, unaffected by wall-clock changes). Messages have no
sequence column of their own; their ground truth comes from joining back to
the `thread.message-sent` event that created them. Activities carry their own
`sequence` column (added in migration 008, mirroring the event store's value
at projection time); this repair falls back to the same event-store join for
any legacy row where that column is null.

This repair does not, by itself, stop the corruption from recurring. That is
a separate ordering fix: sort transcripts by `sequence`, not wall clock, in
the web client (`deriveTimelineEntries` in `apps/web/src/session-logic.ts`),
server pagination (`ProjectionSnapshotQuery.ts`), and mobile
(`threadActivity.ts`). This repair only heals rows already on disk.

## How the repair works

For each thread and each of `projection_thread_messages` /
`projection_thread_activities`, the repair orders rows by ground-truth
sequence and finds the longest run whose `created_at` values are already
non-decreasing in that order _and that ends at the thread's most recent
row_ — the "anchors". Every other row's `created_at` is rewritten to a new
value interpolated between its nearest surviving anchors, so timestamp
order matches sequence order again.

Anchoring on the most recent row (not just on whichever non-decreasing run
happens to be longest anywhere) matters in practice: a clock excursion far
enough in the future can itself produce more rows than the thread has had
time to recover since it was fixed. A pure "longest run anywhere" search
would then pick the excursion itself as the anchor chain and rewrite the
genuinely correct, more recent rows instead. The most recent row is always
trustworthy — nothing later in sequence order contradicts it — so requiring
the anchor chain to end there guarantees the repair heals toward the
current, corrected clock.

This is detection by construction, not by hard-coded thread IDs or date
windows: it finds whatever rows disagree with sequence order, for any clock
excursion, past or future.

- **Reversible.** The pre-repair `created_at` is preserved in a
  `created_at_original` sidecar column, added lazily the first time the
  repair writes to a database.
- **Idempotent.** Once a thread's rows are non-decreasing in sequence order,
  a later run finds nothing left to rewrite for it.
- **Dry-run by default.** The repair only writes — including adding the
  sidecar column — when explicitly run with `--apply`.
