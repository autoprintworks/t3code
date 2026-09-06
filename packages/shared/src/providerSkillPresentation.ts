import type { ServerProviderSkill } from "@t3tools/contracts";

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
