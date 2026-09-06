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
 * scope.
 */
export function formatProviderSkillScopeLabel(
  skill: Pick<ServerProviderSkill, "scope">,
): "Project" | "User" | null {
  const scope = classifyProviderSkillScope(skill);
  if (scope === "project") return "Project";
  if (scope === "user") return "User";
  return null;
}
