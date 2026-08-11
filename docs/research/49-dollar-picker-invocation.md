# Does picking a skill from the `$` menu actually invoke it?

Research for [#49](https://github.com/autoprintworks/t3code/issues/49), a decision ticket on [map #48](https://github.com/autoprintworks/t3code/issues/48).

Read from source on 2026-08-11 against `main` at `90f1f866a`, plus live evidence from a running Claude thread on this machine.

## Answer

**No. `$name` does not invoke anything. `/name` does.**

The composer has two entry types that both look like "pick a thing and it runs":

| Picked              | Inserted | Expanded by          | Result                         |
| ------------------- | -------- | -------------------- | ------------------------------ |
| a **skill**         | `$name ` | nothing              | literal text reaches the model |
| a **slash command** | `/name ` | the Claude Agent SDK | the command runs               |

`$` is T3's own sigil. It appears nowhere in the Agent SDK, nowhere in Claude Code, and nothing in `apps/server/src` parses, expands, or validates it. A picked skill travels to the model as the eight characters `$wayfinder` inside an ordinary user message.

The important consequence is not that `$name` is inert. It is that **T3 already has a working path and the picker points at the broken one.**

## The two paths, traced

### Skills — the broken path

Discovery is a filesystem scan, and it is display-only:

- `apps/server/src/provider/Drivers/ClaudeSkills.ts` scans `<claude config dir>/skills` and `<cwd>/.claude/skills`, reading `name` and `description` from frontmatter.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts:4098` passes the SDK `settingSources: [...CLAUDE_SETTING_SOURCES]` and no skill list, skill directory, or allowed-skills option. Claude Code loads skills itself from its own roots. Everything discovery finds feeds the picker and nothing else.

Insertion is literal text on both clients:

- `apps/web/src/components/chat/ChatComposer.tsx:1719` — ``const replacement = `$${item.skill.name} `;``
- `apps/mobile/src/features/threads/ThreadComposer.tsx:566` — ``replacement = `$${item.skill.name} `;``

Nothing consumes it. A grep across `apps/server/src` for skill-sigil handling returns no non-test hits. The only server-side code mentioning skills is discovery, the provider snapshot, and the status cache — all of them building the list, none of them reading a message back.

### Slash commands — the working path

These do not come from the filesystem. They come from the SDK's own initialization handshake:

- `apps/server/src/provider/Layers/ClaudeProvider.ts:757` — `slashCommands: parseClaudeInitializationCommands(init.commands)`
- `apps/server/src/provider/Layers/ClaudeProvider.ts:631-653` — parses each into `ServerProviderSlashCommand` (`name`, `description?`, `input?`)

Insertion carries the sigil the SDK understands:

- `apps/web/src/components/chat/ChatComposer.tsx:1701` — ``const replacement = `/${item.command.name} `;``
- `apps/mobile/src/features/threads/ThreadComposer.tsx:568,570` — same for both slash-command variants

T3 does not expand these either. It does not need to: the string reaches the SDK, and the SDK expands it before the model sees it.

## The four questions

### 1. Does it work at all?

No, for `$name`. Yes, for `/name`.

**Live evidence, this machine, 2026-08-11.** In a Claude thread on the firstmate home:

- `/wait-what` sent alone → arrived as a proper command block with the skill body loaded. The skill ran.
- `/wayfinder` sent alone → same. The skill ran.
- `/ask-matt` and `/wayfinder` typed as trailing lines under a question in the same message → arrived as literal text. Nothing ran.

That last case is not a bug. Slash commands only expand when they are the whole message, which is standard Claude Code behaviour. It is recorded here because it is an easy false positive: it looks exactly like the `$name` failure and is not the same thing.

### 2. Does it reach a skill the agent would otherwise refuse to self-invoke?

**`$name` fails hardest precisely here, and `/name` succeeds.**

Both `wait-what` and `wayfinder` carry `disable-model-invocation: true`. Claude Code hides such skills from the agent completely — not badged, absent — so the model cannot see them and cannot reach them with the Skill tool. That is the whole reason the picker matters.

Sending `$wayfinder` therefore gives the model a string naming something it cannot see, with no mechanism to resolve it. The model's only available response is to guess. When it acts, it acts because the name happened to be meaningful to it, not because anything invoked.

Sending `/wayfinder` works, and was verified working.

### 3. Does it differ by provider?

Yes, materially.

**Claude** — the split above. Skills scanned from disk, display-only; slash commands from the SDK handshake, functional.

**Codex** — skills come from the app-server over RPC, not from a filesystem scan: `apps/server/src/provider/Layers/CodexProvider.ts:398-400` calls `skills/list`, parsed at `:255-287`. Notably `enabled` is reported by Codex itself (`:271`) rather than hard-coded, so Codex's snapshot carries real state where Claude's does not. Codex has its own invocation mechanism and its own visibility rules; `$name` is no more meaningful to it than to Claude.

**Cursor, Grok, OpenCode** — not investigated here. They belong to [#51](https://github.com/autoprintworks/t3code/issues/51).

### 4. Does it differ by client?

No. Web and mobile insert byte-identical strings for both types — `$name ` for skills, `/name ` for slash commands. Mobile uses a native tokenizing editor rather than Lexical, but the text it produces is the same. The web chip is presentation only.

Mobile carries one extra variant, `slash-command` alongside `provider-slash-command` (`ThreadComposer.tsx:568,570`), both inserting `/name`. Web distinguishes the same two at `ChatComposer.tsx:1679,1700`.

## What this means for the map

The ticket says the answer decides which map this is. It decides something narrower and more useful:

**The picker's two lists overlap, and the captain cannot tell them apart.** A user-invocable skill appears twice — once under `$` where picking it does nothing, and once under `/` where picking it works. Both render as a name and a description. Nothing marks one as inert.

So the live question is not "should the picker invoke". It is **"why does the `$` list exist at all for Claude?"** Three shapes are available:

1. **Make `$` expand.** Add server-side rewriting of `$name` into something the provider understands. Costs a parser and a per-provider mapping; the sigil stays T3's own.
2. **Drop `$` for Claude and show only what the SDK reports.** Cheapest and immediately correct. Costs the filesystem-derived metadata — `path`, `scope`, frontmatter — which [#50](https://github.com/autoprintworks/t3code/issues/50) and [#51](https://github.com/autoprintworks/t3code/issues/51) may want.
3. **Keep both lists but merge them at presentation**, so one entry per skill inserts whichever sigil actually works for that provider.

Option 3 is the only one that preserves the filesystem metadata and works today, but it needs the two lists reconciled by name, and nothing currently does that.

## Confidence

**Proven from source:** the insertion strings, the absence of any server-side `$` handling, the SDK origin of slash commands, the display-only nature of skill discovery, and the client parity.

**Proven live on this machine:** that `/name` invokes a `disable-model-invocation: true` skill in a T3 Claude thread, and that a trailing slash command in a multi-line message does not.

**Not tested:** `$name` sent deliberately into a live thread to observe the model's reaction. The source shows no mechanism could exist, so this would confirm rather than discover. Script below if you want it on the record.

**Not investigated:** Cursor, Grok, OpenCode. Deferred to [#51](https://github.com/autoprintworks/t3code/issues/51).

## Live test script, two minutes

If you want the negative case recorded rather than inferred:

1. Open a Claude thread in T3 on any project.
2. Type `$` and pick `wayfinder` from the menu. Send it alone.
3. Expected from source: the model receives the text `$wayfinder` and no skill loads. It will most likely ask what you meant, or guess.
4. Now send `/wayfinder` alone in the same thread.
5. Expected: the skill body loads and wayfinder runs.

The contrast between steps 3 and 5 is the finding.
