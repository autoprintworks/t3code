# Resolving an upstream conflict

> For maintainers and workers of this fork. Using T3 Code? See [docs/user](../user/).

This is the fixed brief for one job: the fork update pipeline filed an issue titled
`Upstream <tag> conflicts with fork`, and the merge has to be resolved. The brief is versioned with
the code on purpose. The rules it names live in `fork-features.json`, so a fork feature added today
changes the resolution rule without anyone rewriting a brief held somewhere else.

Read [`fork-features.json`](../../fork-features.json) before you start. Every entry has a `keep`
line: one sentence saying what of ours must survive in that entry's `files`, and what takes
upstream. That sentence is the contract below.

## The contract

1. Merge the tag. `git merge --no-ff <tag>`. Never rebase
   ([#60](https://github.com/autoprintworks/t3code/issues/60)). A rebase rewrites the fork's own
   history and loses the record of what this fork changed.
2. For every conflicting hunk, take upstream, unless a `keep` line names that file.
3. For a file a `keep` line names, apply that `keep` line. Keep exactly what the sentence says
   survives. Take upstream for the rest of the file. Do not keep a fork hunk the sentence does not
   cover, and do not widen the sentence because a hunk looks useful.
4. Run the gate. Every command in [Running the gate](#running-the-gate) has to pass.
5. Open one pull request against `main`. List the per-file rule you used, file by file, in the body.

There is no judgement step in the middle. A conflict the `keep` lines do not settle is not yours to
decide: say so in the issue and stop, rather than inventing a rule.

## Why upstream wins by default

The fork's value is the list in `fork-features.json` and nothing else. Everything outside that list
is upstream's code the fork happens to be carrying, and carrying a fork hunk nobody can name is how
a fork drifts until it can no longer take an upstream release at all. So the default is upstream,
and the exceptions are written down.

## Applying a keep line

A `keep` line takes one of two shapes.

- **Ours whole.** The file is the fork's own module and upstream has no file at that path, so
  nothing in it takes upstream. Upstream cannot conflict with a path it does not have, so this
  shape usually appears only after upstream adds a file at the same path. If that happens, keep our
  file and rename upstream's.
- **Ours in part.** The file is upstream's, and the fork patches a named part of it. Take
  upstream's whole file first, then re-apply only the named part on top. Resolving hunk by hunk
  against a rewritten upstream file is how a re-applied patch ends up half landed.

`terminal-subprocess-poll` is the worked example of the second shape: `pollLoop.ts` is ours whole,
and `Manager.ts` and `PortScanner.ts` take upstream, then get the `pollLoop` call sites put back on
top. That is what #125 did against upstream `v0.0.39`.

## Running the gate

```sh
pnpm typecheck
pnpm lint
pnpm test
node scripts/check-fork-features.ts
```

Those are the four steps the fork update gate runs, in that order. See
`.github/workflows/fork-update.yml`. Run all four, repo-wide, even though AGENTS.md tells an agent
not to run repo-wide checks in the ordinary case: a merge from upstream can touch any file in the
tree, so this job is the named exception.

`node scripts/check-fork-features.ts` is the proof the resolution kept the fork. It fails when a
listed file or test file is gone, then runs every listed test. Every entry names a test that cannot
pass on plain upstream, so a resolution that dropped a feature turns it red rather than passing
quietly. A red run names the feature that lost its home.

Do not edit `fork-features.json` to make the gate green. A missing path means the feature moved or
was dropped. Move the feature back, or, when upstream genuinely moved the file, point the entry at
where it lives now and say so in the pull request body.

## The pull request

Title: `chore: merge upstream <tag>`. Body:

- The tag merged, and the count of conflicting files.
- One line per conflicting file: the file, the feature whose `keep` line covered it, and what you
  kept. For a file no `keep` line named, say "took upstream".
- The gate commands above, with their output.

Link the conflict issue the pipeline filed. Do not merge the pull request yourself. Once it is on
`main`, dispatch `fork-update.yml` again against the same tag.
