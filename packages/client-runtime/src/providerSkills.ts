import {
  isProviderSkillModelInvocable,
  isProviderSkillUserInvocable,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";

export type ProviderSkillSourceKind = "app" | "repo" | "project" | "personal" | "system" | "other";

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  return titleCaseWords(skill.name);
}

export function getProviderSkillsForSlashMenu(
  skills: ReadonlyArray<ServerProviderSkill>,
  showSkillsInSlashMenu: boolean,
): ServerProviderSkill[] {
  return showSkillsInSlashMenu ? skills.filter((skill) => skill.enabled) : [];
}

export function getProviderSlashCommandsForSlashMenu(
  slashCommands: ReadonlyArray<ServerProviderSlashCommand>,
  visibleSkills: ReadonlyArray<ServerProviderSkill>,
): ServerProviderSlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

export function resolveProviderSkillSourceKind(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): ProviderSkillSourceKind {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "app";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  switch (normalizedScope) {
    case "repo":
    case "repository":
      return "repo";
    case "project":
    case "workspace":
    case "local":
      return "project";
    case "user":
    case "personal":
      return "personal";
    case "system":
      return "system";
    case undefined:
    case "":
      return "other";
    default:
      return "other";
  }
}

/**
 * The skills a composer picker may offer: enabled, and not marked agent-only.
 *
 * Agent-only skills are reference material the model loads at a trigger, so
 * offering them is pure noise. Web and mobile both call this, so one place
 * decides what a picker hides.
 */
export function pickableProviderSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  return skills.filter((skill) => skill.enabled && isProviderSkillUserInvocable(skill));
}

/**
 * The badge a composer menu row carries when the agent may not start the skill
 * itself, so a picker is its only entry point. Ordinary skills, which either
 * side can start, get `null` and stay unmarked.
 */
export function formatProviderSkillInvocationLabel(
  skill: Pick<ServerProviderSkill, "modelInvocable">,
): string | null {
  return isProviderSkillModelInvocable(skill) ? null : "Manual";
}

/**
 * Whether a skill row belongs to the thread's own project or to the user.
 *
 * Providers spell scope in their own words, so this narrows the many spellings
 * to the two a composer menu must tell apart. A scope it cannot place stays
 * `null`, and the caller decides what to show instead of guessing.
 */
export function classifyProviderSkillScope(
  skill: Pick<ServerProviderSkill, "scope">,
): "project" | "user" | null {
  const normalized = skill.scope?.trim().toLowerCase();
  if (normalized === "project" || normalized === "workspace" || normalized === "local") {
    return "project";
  }
  if (normalized === "user" || normalized === "personal") {
    return "user";
  }
  return null;
}

/**
 * The badge a composer menu row carries so a user can tell, before picking,
 * whether a skill comes from this thread's own project or from their user
 * scope. A scope the classifier cannot place keeps its install source, which
 * is still true about where the skill lives.
 */
export function formatProviderSkillScopeLabel(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): string | null {
  const scope = classifyProviderSkillScope(skill);
  if (scope === "project") return "Project";
  if (scope === "user") return "User";
  return formatProviderSkillInstallSource(skill);
}

export function formatProviderSkillInstallSource(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
): string | null {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return "App";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  if (normalizedScope === "system") {
    return "System";
  }
  if (
    normalizedScope === "project" ||
    normalizedScope === "workspace" ||
    normalizedScope === "local"
  ) {
    return "Project";
  }
  if (normalizedScope === "user" || normalizedScope === "personal") {
    return "Personal";
  }
  if (normalizedScope) {
    return titleCaseWords(normalizedScope);
  }

  return null;
}
