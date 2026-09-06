/**
 * ClaudeSkills — filesystem discovery of Claude Code skills for the `$` picker.
 *
 * Claude Code loads skills from `<config dir>/skills` (user scope) and
 * `<cwd>/.claude/skills` (project scope), one directory per skill with a
 * `SKILL.md` carrying YAML frontmatter. The Agent SDK init handshake surfaces
 * skills only as slash commands without their filesystem paths, so the
 * provider snapshot scans the same locations directly, mirroring how the
 * Codex app-server reports its skills.
 *
 * That same slash-command-only reality is why this module also owns the
 * `$name` -> `/name` rewrite the Claude adapter applies to outgoing prompts.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

import { expandHomePath } from "../../pathExpansion.ts";

type ClaudeSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

/**
 * Enumerate Claude Code skills from the user config dir and the workspace.
 * Discovery is best-effort: unreadable roots and malformed skill entries are
 * skipped so a broken skill never degrades the provider snapshot. On name
 * collisions the project-scoped skill wins, matching Claude Code's
 * most-specific-wins resolution.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);

  const roots: ReadonlyArray<{ directory: string; scope: ClaudeSkillScope }> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in Claude Code
      // either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

/**
 * A message can reach a skill by two routes, and both land here. The `$` picker
 * inserts a chip that serializes to `$name`, the token the Codex app-server
 * understands; the `/` menu lists the same skills (Claude Code reports every
 * skill as a plain slash command) and inserts `/name`. Claude Code itself only
 * runs the `/name` form, so `$name` has to be rewritten on the way out.
 *
 * Only the leading token counts: a mention further into the message could never
 * have started a skill.
 */
const LEADING_SKILL_MENTION_PATTERN = /^[$/]([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s|$)/;

/** The parts of a discovered skill the outgoing-prompt code needs. */
export type ClaudeSkillRef = Pick<ServerProviderSkill, "name" | "path">;

export interface LeadingSkillMention {
  readonly skill: ClaudeSkillRef;
  /** Everything after the token, leading whitespace included. */
  readonly rest: string;
}

/**
 * Cheap check for whether {@link findLeadingSkillMention} could match, so
 * callers can skip skill discovery for the overwhelming majority of turns.
 */
export function hasLeadingSkillMention(text: string): boolean {
  return LEADING_SKILL_MENTION_PATTERN.test(text);
}

/**
 * Resolve a leading `$name` or `/name` token against the discovered skills.
 * An unknown name yields `null`: it is ordinary text, or a provider slash
 * command that is not a skill, and either way it must be left alone.
 */
export function findLeadingSkillMention(
  text: string,
  skills: ReadonlyArray<ClaudeSkillRef>,
): LeadingSkillMention | null {
  const match = LEADING_SKILL_MENTION_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const skill = skills.find((candidate) => candidate.name === match[1]);
  return skill ? { skill, rest: text.slice(match[0].length) } : null;
}

/**
 * Read a skill's instructions, dropping the frontmatter Claude Code strips too.
 * Unreadable skills yield `undefined` so the caller can fall back rather than
 * fail a turn.
 */
export const readClaudeSkillBody = Effect.fn("readClaudeSkillBody")(function* (
  skillPath: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem
    .readFileString(skillPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) {
    return undefined;
  }
  const body = contents.replace(FRONTMATTER_PATTERN, "").trim();
  return body.length > 0 ? body : undefined;
});

/**
 * Build the prompt for a skill invocation that cannot use a slash command.
 * Claude Code refuses to expand `/name` when the user message also carries an
 * image block, so those turns inline the skill's own instructions instead. The
 * path is named because skill bodies routinely point at sibling files.
 */
export function formatInlinedSkillPrompt(input: {
  readonly skill: ClaudeSkillRef;
  readonly body: string;
  readonly rest: string;
}): string {
  const rest = input.rest.trim();
  return [
    `Run the ${input.skill.name} skill. Its instructions follow, from ${input.skill.path}; any relative path inside them is relative to that file's directory.`,
    "",
    input.body,
    ...(rest ? ["", "---", "", rest] : []),
  ].join("\n");
}
