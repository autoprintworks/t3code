# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## This repo's existing vocabulary comes first

T3 Code is a pnpm monorepo (7 packages, 4 apps) but **one product with one shared vocabulary**,
so it is single-context: one `CONTEXT.md` and one `docs/adr/` at the root, not per-package.

Two documents already own domain language here and outrank anything `/domain-modeling` would
create fresh:

- **`AGENTS.md` → "A small glossary"** — the working definitions of _you_, _we/maintainers_,
  _user_, _agent_, _provider_, _client_, _environment_, _project_, _thread_, _turn_, _T3 home_.
  These are load-bearing: "user" means the person directing coding agents, never the maintainer.
- **`docs/internals/glossary.md`** — the full architectural glossary with file links (command,
  decider, event, projector, adapter, reactor, receipt, checkpoint).

Add to those rather than starting a parallel glossary. `AGENTS.md` says new vocabulary belongs
in `docs/internals/glossary.md`.

## File structure

Single-context repo (this repo):

```
/
├── CONTEXT.md                         ← not yet created
├── docs/
│   ├── adr/                           ← not yet created
│   ├── agents/                        ← this directory
│   ├── internals/glossary.md          ← existing, authoritative
│   ├── user/
│   └── operations/
└── apps/, packages/
```

`docs/` is already split by audience and `AGENTS.md` is strict about it: user-visible behaviour
goes in `docs/user/` (shipped-product voice, no repo tooling or source paths), architecture and
contributor material in `docs/internals/`, runbooks in `docs/operations/`. An ADR is contributor
material, so `docs/adr/` sits at the root as its own kind rather than inside `docs/internals/`.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the glossary. Don't drift to synonyms it explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
