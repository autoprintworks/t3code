# How does each provider express skills, and can one contract hold all five?

Research for [#51](https://github.com/autoprintworks/t3code/issues/51), a decision ticket on [map #48](https://github.com/autoprintworks/t3code/issues/48).

Read from source and from this machine on 2026-08-11, against `main` at `90f1f866a`.

## Answer in one line

**`ServerProviderSkill` is Codex's skill shape, copied field for field — and it is already a lossy copy of Codex.** It holds Claude only by throwing away what Codex reports and Claude cannot produce. Grok has real skills on this machine that T3 cannot see at all, and the sigil is not shared: Codex uses `$`, Claude and Grok use `/`.

## 1. Per provider

| Provider | Skill concept in T3                            | Skill concept in reality                                                      | Invocation sigil |
| -------- | ---------------------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| Codex    | `skills/list` RPC (`CodexProvider.ts:398-402`) | full protocol: list, errors, extra roots, enable/disable, change notification | `$<skill>`       |
| Claude   | filesystem scan (`ClaudeSkills.ts`)            | `SKILL.md` under two roots, plus plugins                                      | `/<skill>`       |
| Grok     | **none**                                       | **real: 18 skills in `~/.grok/skills`**                                       | `/<skill>`       |
| OpenCode | **none**                                       | none found                                                                    | —                |
| Cursor   | **none**                                       | rules, not skills (`.cursor/rules/*.mdc`)                                     | —                |

Searching `apps/server/src/provider` for `skill` returns hits in exactly two provider layers. `CursorProvider.ts`, `GrokProvider.ts` and `OpenCodeProvider.ts` contain the word zero times. All three fall through to `skills: []` on the snapshot (`providerSnapshot.ts:245`).

### Grok is the live counterexample

`~/.grok/skills` on this machine holds 18 entries — `ask-matt`, `grilling`, `grill-with-docs`, `prototype`, `triage`, `tdd`, and the rest — each a symlink into the shared hub `~/.agents/skills`, each a directory with a `SKILL.md` carrying `name` and `description` frontmatter. Byte-for-byte the same format Claude uses.

Firstmate's own harness reference records the invocation, verified end to end: Grok discovers user-level skills and `/<skill>` invokes them, the same form as Claude. Codex rejects `/<skill>` as "Unrecognized command" and needs `$<skill>`.

So Grok has skills, they are on disk in a format T3 already knows how to parse, they sit one directory away from the roots T3 already scans, and T3 shows the captain none of them.

### Cursor and OpenCode

Neither shows a skill concept.

- **OpenCode**: `opencode --help` lists `agent`, `plugin`, `mcp` — no skills subcommand. `~/.config/opencode` holds `AGENTS.md`, `opencode.jsonc` (empty but for `$schema`), and `plugins`. No skills directory.
- **Cursor**: `~/.cursor` holds `AGENTS.md` and `hooks.json`. The project-level `.cursor/rules` in this repo holds `.mdc` rule files. Rules are context injected by matcher, not named units a user invokes — a different concept that should not be forced into the skill contract.

Firstmate's harness reference records no separate skill invocation for OpenCode either. **Confidence caveat:** `cursor-agent` and `grok` are not installed on this machine, so Cursor and OpenCode were read from config layout and CLI help, not from a live capability probe. Grok's skills were read directly off disk.

## 2. Does `ServerProviderSkill` hold them?

The contract (`packages/contracts/src/server.ts:88-97`) is `name`, `description?`, `path`, `scope?`, `enabled`, `displayName?`, `shortDescription?`.

Line it up against Codex's actual `SkillMetadata` (`packages/effect-codex-app-server/src/_generated/schema.gen.ts:22841`):

| Codex field                                                       | In the contract? |
| ----------------------------------------------------------------- | ---------------- |
| `name`, `description`, `path`, `enabled`                          | yes              |
| `scope`: `user \| repo \| system \| admin`                        | as a free string |
| `interface.displayName`, `interface.shortDescription`             | yes              |
| `interface.brandColor`, `iconSmall`, `iconLarge`, `defaultPrompt` | **dropped**      |
| `dependencies.tools[]`                                            | **dropped**      |

And alongside each skill, Codex returns `SkillsListEntry.errors: Array<{message, path}>` (`schema.gen.ts:28888`) — the skills it could not load, and why. **T3 parses the `skills` array and ignores `errors` entirely** (`CodexProvider.ts:255-289`).

That is the same fault [#50](https://github.com/autoprintworks/t3code/issues/50) found on the Claude side, where 19 dangling links vanished silently. On the Codex side the provider is _already telling us_, and the contract has nowhere to put it.

### Where Claude cannot fill the shape

- `enabled` is hard-coded `true` (`ClaudeSkills.ts:138`). Claude has no enable state to read, so the field means "Codex says so" for one provider and nothing for the other.
- `displayName` and `shortDescription` are Codex `interface` fields from `SKILL.json`. Claude's frontmatter parser reads only `name` and `description` (`ClaudeSkills.ts:49-50`), so both are always absent.
- `scope` collides. Claude emits `user` / `project`; Codex emits `user` / `repo` / `system` / `admin`. The presentation layer maps `project`, `workspace` and `local` to "Project" and falls through everything else to title case (`apps/web/src/providerSkillPresentation.ts:38-50`) — so Codex's `repo` renders as **"Repo"** and Claude's `project` as **"Project"**, two labels for one idea, side by side in one picker. `admin` renders as "Admin" and means nothing to a reader.

### `path` is the load-bearing problem

`path` is required and filesystem-shaped. Today both providers can supply one, so it holds — but it is doing work it should not:

`formatProviderSkillInstallSource` **sniffs the path string** for `/.codex/plugins/` and `/.agents/plugins/` to decide whether to print "App" (`providerSkillPresentation.ts:29-32`). That is provider-specific knowledge encoded as a substring match on a path, in the web layer, because the contract has no field for "where did this come from".

Any provider whose skills are not host files — a remote or hosted skill store — cannot satisfy `path` at all. Making it required bet that every provider's skills are files on this machine. That bet holds for three of five today because the other two have no skills.

## 3. What is missing

Four gaps, in the order they hurt:

1. **Load errors.** Codex reports them and T3 discards them; Claude does not report them at all. Nothing in the contract can carry "this exists and is broken". This is the single fix that spans both [#50](https://github.com/autoprintworks/t3code/issues/50) and this ticket.
2. **Invocability.** The two conventions from [#21](https://github.com/autoprintworks/t3code/issues/21) — `disable-model-invocation: true` for user-only, `user-invocable: false` for agent-only — mean opposite things, and neither is parsed. Without this the picker cannot know whether inserting a name will do anything, which is exactly the [#49](https://github.com/autoprintworks/t3code/issues/49) failure.
3. **Sigil.** See section 4.
4. **Whether `enabled` is writable.** Codex has `skills/config/write {enabled, name|path} -> {effectiveEnabled}` (`schema.gen.ts:39276`). T3 never calls it. A boolean the user can see and cannot change is a worse affordance than no boolean.

Two further Codex capabilities T3 does not use, both directly relevant to [#50](https://github.com/autoprintworks/t3code/issues/50)'s options:

- **`skills/extraRoots/set`** (`schema.gen.ts:39296`) — configurable extra skill roots. That is #50's option C, already implemented in the protocol, for one provider, unused.
- **`SkillsChangedNotification`** (`schema.gen.ts:39265`) — an invalidation signal when watched skill files change. Unhandled. Claude's equivalent `commands_changed` is a deliberate no-op (`ClaudeAdapter.ts:3367`), so the picker goes stale on both providers.

## 4. Does the sigil differ? Yes

| Provider | Sigil                                 |
| -------- | ------------------------------------- |
| Claude   | `/<skill>`                            |
| Grok     | `/<skill>`                            |
| Codex    | `$<skill>` — `/` is rejected outright |

And T3's own composer inserts **neither**. The `$` picker inserts the bare name with no sigil (`ChatComposer.tsx:1719`, `ThreadComposer.tsx:566`), which is why it does nothing — the [#49](https://github.com/autoprintworks/t3code/issues/49) finding. `$` is T3's trigger character borrowed from Codex's, not a string any provider parses.

**Consequence for the contract:** one picker cannot insert one string. Either the contract carries the sigil per provider, or the composer resolves it from the active provider at insertion time. There is no third option that works for both Claude and Codex.

## 5. Can one contract hold all five?

Yes — but not this one, and not by widening it field by field.

The current contract is Codex's shape minus the parts Codex actually uses. Growing it toward Codex makes it emptier for Claude; growing it toward Claude adds nothing Codex needs. Three of five providers contribute no skills at all, and one of those three (Grok) has skills T3 simply does not look for.

The shape that survives all five, in rough priority:

- **`name` and `description`** — the only two fields every skill format on this machine actually has.
- **`invocation`** — how a skill is named in a prompt, per provider. Replaces the hard-coded sigil. Absent means "not user-invocable", which folds in gap 2.
- **`source`** — a structured origin (user / project / system / plugin / extra root), replacing both the colliding `scope` strings and the path-substring sniffing. Providers map their own vocabulary onto it once, at the provider layer, not in the web layer.
- **`path`** — keep it, make it **optional**, and demote it to a diagnostic ("where do I go to fix this"), not an identity or a source hint.
- **`enabled`** — model it as absent / read-only / writable rather than a bare boolean, so the UI can tell "off" from "unknown".
- **A sibling errors list** on the provider snapshot, not on the skill — the skills that failed to load and why. Codex already sends it; Claude needs #50's option A to produce it.

`name` and `description` are the whole common core. Everything else is per-provider and should be modelled as optional or as an explicit variant, not assumed.

**Recommended scope for this map:** the first three (`invocation`, `source`, and the errors list) are what unblock #21, #49 and #50. `path` and `enabled` are cleanups that can follow.

## Confidence

**Read from source:** every contract field, both parsers, the Codex generated schema, the presentation mapping, the absence of skill handling in the Cursor, Grok and OpenCode layers.

**Measured on this machine:** Grok's 18 skills and their symlink targets, OpenCode's config layout and CLI help, Cursor's config layout, and which CLIs are installed.

**Read from firstmate's verified harness reference:** the per-provider invocation sigils, including Codex's outright rejection of `/`.

**Not verified:** Cursor and OpenCode were read from config layout and help output, not a live capability probe — neither CLI is installed here. If either has grown a skill concept recently, this write-up would miss it. Codex's `errors`, `extraRoots` and `config/write` were read from the generated schema, not exercised against a live app-server.
