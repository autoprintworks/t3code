# What can T3 see, and what would it have to read to see every skill set?

Research for [#50](https://github.com/autoprintworks/t3code/issues/50), a decision ticket on [map #48](https://github.com/autoprintworks/t3code/issues/48).

Read from source and from this machine's filesystem on 2026-08-11, against `main` at `90f1f866a`.

## Headline

**The junctions the map calls a stopgap have already rotted. All 19 of them are dangling, and nothing reported it.**

They point at `C:\00_AI_Development\firstmate-claude-code`, which no longer exists. The live firstmate is at `C:\00_AI_Development\firstmate`. Nobody noticed because discovery skips unreadable entries silently, and because firstmate's skills still reach a firstmate thread by a second, unrelated route — the project-scope symlink inside the repo.

This is not a hypothetical about designing for a machine with no junctions. The junctions are already load-bearing and already broken.

## 1. The two reaches

There are two independent readers, and they do not read the same thing.

### T3's reach — the picker

`apps/server/src/provider/Drivers/ClaudeSkills.ts:100-105` scans exactly two roots:

| Root                         | Scope     |
| ---------------------------- | --------- |
| `<claude config dir>/skills` | `user`    |
| `<cwd>/.claude/skills`       | `project` |

The config dir resolves as the instance's `homePath`, then `CLAUDE_CONFIG_DIR`, then `~/.claude` (`ClaudeSkills.ts:57-90`).

Three behaviours matter more than the roots:

- **Unreadable entries vanish silently.** `readDirectory` and `readFileString` are both wrapped in `Effect.orElseSucceed` (`:110-118`); a missing `SKILL.md` hits `continue` at `:120`. A dangling junction produces no warning, no badge, no log line. It is indistinguishable from a skill that was never installed.
- **Malformed frontmatter is also dropped silently** (`:126-132`), with a comment reasoning that Claude Code would not load it either.
- **Project scope silently overwrites user scope by name.** `skillsByName.set(name, …)` at `:137` with project read second. Two skills with the same name are not a conflict; the project one just wins, unannounced.

### Claude Code's reach — the agent

T3 passes the SDK no skill list, directory, or allow-list. Skills reach the running agent solely through `settingSources: [...CLAUDE_SETTING_SOURCES]` at `apps/server/src/provider/Layers/ClaudeAdapter.ts:4098`, meaning Claude Code loads them itself from its own roots.

Claude Code's roots are a superset of T3's. In particular it loads **plugin** skills from `~/.claude/plugins/`, which T3 never scans. On this machine that directory is real and populated:

- `~/.claude/plugins/known_marketplaces.json` registers `claude-plugins-official` (`anthropics/claude-plugins-official`), installed to `~/.claude/plugins/marketplaces/claude-plugins-official`.
- `~/.claude/plugins/installed_plugins.json` records `frontend-design@claude-plugins-official`, cached under `~/.claude/plugins/cache/`.

T3 recognises plugin paths in exactly one place, and only to render a source label: `/.codex/plugins/` and `/.agents/plugins/` at `apps/web/src/providerSkillPresentation.ts:30-32`. `~/.claude/plugins/` appears nowhere.

## 2. Ground truth on this machine

Measured 2026-08-11.

| Location                                        | State                                                        |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `~/.claude/skills`                              | 60 entries — **19 broken**, 41 working                       |
| `~/.agents/skills`                              | 60 entries, itself containing the same 19 dangling junctions |
| `~/.codex/skills`                               | 59 entries                                                   |
| `~/.claude/plugins`                             | real, 1 plugin installed, **never scanned by T3**            |
| `C:\00_AI_Development\firstmate-claude-code`    | **does not exist**                                           |
| `C:\AGOS\skills-marketplace`                    | **does not exist**                                           |
| `C:\00_AI_Development\firstmate\.agents\skills` | 19 skills, live                                              |
| `C:\00_AI_Development\firstmate\.claude\skills` | symlink to `.agents/skills`                                  |

The 19 broken entries are exactly firstmate's: `afk`, `ahoy`, `ask-user-authority`, `bearings`, `bootstrap-diagnostics`, `decision-hold-lifecycle`, `diagnostic-reasoning`, `firstmate-codexapp`, `firstmate-coding-guidelines`, `firstmate-orca`, `fmx-respond`, `harness-adapters`, `project-management`, `quota-array-dispatch`, `secondmate-provisioning`, `shelve`, `stow`, `stuck-crewmate-recovery`, `updatefirstmate`.

Two of the map's Notes are stale as a result: firstmate is not at `firstmate-claude-code`, and the marketplace is not at `C:\AGOS\skills-marketplace`. The real marketplace in use is Claude's own plugin marketplace under `~/.claude/plugins/`, which is a different mechanism from the one the map describes.

### Why nothing broke visibly

Firstmate's 19 skills still load in a firstmate thread, because `cwd` is the firstmate repo and the project root `<cwd>/.claude/skills` is a working symlink into `.agents/skills`. Both readers find them there.

Open a thread on **any other project** and firstmate's skills are invisible to both readers. The user-scope junctions that were supposed to make them global do nothing.

So the junction stopgap is not merely fragile in principle. It has already failed, and its failure is masked by an unrelated path that only holds inside one repo.

## 3. What happens when the two reaches disagree

The ticket asks. Today, three concrete disagreements exist:

1. **Plugin skills** — loaded by the agent, absent from the picker. The captain cannot pick a skill the agent is actively using.
2. **Dangling junctions** — absent from both, but the _reason_ is invisible. A skill the captain installed and believes is present is simply not there, with no diagnostic anywhere.
3. **The `$` versus `/` split** — established in [#49](https://github.com/autoprintworks/t3code/issues/49): the SDK reports user-invocable skills as slash commands, so a skill can be in the picker twice, working under one sigil and inert under the other.

Of these, the second is the most damaging and the cheapest to fix. A picker that shows nothing is honest. A picker that silently drops what it cannot read teaches the captain that a skill was never installed, when in fact it was installed and its link rotted.

**Recommendation regardless of which reach T3 adopts: stop swallowing read failures.** A directory entry with no readable `SKILL.md` is a fact worth reporting, not noise to discard.

## 4. What T3 should read — the options

Four shapes, cheapest first.

### A. Report what it already cannot read

No new roots. Change `Effect.orElseSucceed` at `ClaudeSkills.ts:110-118` to distinguish "directory absent" from "entry present but unreadable", and carry the second as a broken entry on the snapshot.

- **Buys:** the rot becomes visible the day it happens. Would have caught all 19 of these.
- **Costs:** one new state on `ServerProviderSkill` and a badge. No discovery change.
- **Does not solve:** reach. Firstmate's skills stay invisible outside its own repo.

### B. Add `~/.claude/plugins/` to the scan

Read the plugin registry files rather than guessing at the cache layout — `known_marketplaces.json` and `installed_plugins.json` are both stable JSON with install paths in them.

- **Buys:** closes the largest known gap between the two reaches. Marketplace skills become pickable.
- **Costs:** a second discovery shape — registry-driven rather than directory-driven — and it must track Claude Code's plugin layout, which T3 does not own.
- **Does not solve:** arbitrary skill sets that are not plugins, such as firstmate's.

### C. A configured list of extra roots

A T3 setting naming additional skill directories, scanned exactly like the existing two.

- **Buys:** any skill set becomes reachable with no filesystem trickery. Firstmate registers `C:\00_AI_Development\firstmate\.agents\skills` and never needs a junction.
- **Costs:** it makes T3's reach _diverge_ from the agent's. A skill in a T3-only root shows in the picker and does not load in the agent — the worst disagreement of the three above, deliberately introduced.
- **Mitigation:** only worth doing if the same root is also fed to the agent, which means writing it into Claude Code's own settings rather than T3's.

### D. A skill set declares its own reach

A manifest at the skill set's root naming where it lives, which T3 discovers rather than being told.

- **Buys:** the map's stated goal — adding a skill set needs no hand-made link and no T3 setting.
- **Costs:** a new format nobody else implements. Claude Code will not read it, so the agent still needs the skills on its own paths. It solves T3's reach and not the agent's, which is the same divergence as option C with more work.

**The honest reading:** T3's reach is not actually the problem. The agent's reach is, and T3 does not own it. Every option that widens T3's reach alone widens the disagreement.

The one thing T3 can do well, cheaply, and without divergence is **option A**. Options B, C and D all end in the same place: whatever T3 scans, the agent must scan too, and that is Claude Code's configuration, not T3's.

That suggests a fifth shape worth putting to the captain: **T3 stops trying to have its own reach, and instead reports the agent's** — deriving the picker from what the SDK reports rather than from a filesystem scan. [#49](https://github.com/autoprintworks/t3code/issues/49) found the SDK already reports user-invocable skills as slash commands, which is a partial version of exactly this.

## 5. Per provider

| Provider | Skill discovery                                                                  | Reach owned by                    |
| -------- | -------------------------------------------------------------------------------- | --------------------------------- |
| Claude   | filesystem scan, two roots (`ClaudeSkills.ts`)                                   | Claude Code, via `settingSources` |
| Codex    | `skills/list` RPC (`CodexProvider.ts:398-400`)                                   | the Codex app-server              |
| Cursor   | not investigated — see [#51](https://github.com/autoprintworks/t3code/issues/51) |                                   |
| Grok     | not investigated — see [#51](https://github.com/autoprintworks/t3code/issues/51) |                                   |
| OpenCode | not investigated — see [#51](https://github.com/autoprintworks/t3code/issues/51) |                                   |

Codex is the instructive case: T3 asks the provider what skills exist and gets a real answer including a real `enabled` value (`CodexProvider.ts:271`), rather than scanning a filesystem and hard-coding `enabled: true` (`ClaudeSkills.ts:139`). Codex has no reach problem because it never guesses.

That is the fifth shape above, already implemented, for one provider.

## 6. Remote and mobile clients

The scan runs server-side against the server's own filesystem and `cwd`. A mobile or remote client renders a picker describing **the host machine's disk**, and `ServerProviderSkill.path` is an absolute host path (`packages/contracts/src/server.ts:90`, required).

That is coherent as long as the agent also runs on the host, which it does — the client is a view, not a runtime. So remote and mobile are not broken today.

They do constrain the options:

- Option A works everywhere; a broken-entry badge is just data.
- Option B works, since the plugin registry is also on the host.
- Options C and D need care. A configured root or a manifest is host state, so the setting must live server-side, not in client storage, or a phone will configure a path that means nothing.

## Confidence

**Measured directly on this machine:** the 19 dangling junctions, the missing `firstmate-claude-code` and `C:\AGOS\skills-marketplace`, the contents of the plugin registry, and the entry counts in all four skill roots.

**Read from source:** every discovery behaviour cited, including the silent skips, the scope precedence, and the absence of any plugin path in discovery.

**Not verified:** Claude Code's exact plugin loading paths were inferred from the registry files on disk, not read from Claude Code's source, which is not available here.

**Not investigated:** Cursor, Grok, OpenCode. Deferred to [#51](https://github.com/autoprintworks/t3code/issues/51).

## Immediately actionable, outside this ticket

The 19 dangling junctions are a live fault on the captain's machine, not just evidence. Repointing them at `C:\00_AI_Development\firstmate\.agents\skills` restores firstmate's skills outside the firstmate repo. That is a five-minute fix and it is independent of every decision above.
