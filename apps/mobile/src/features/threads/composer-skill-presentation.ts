import { isProviderSkillUserInvocable, type ServerProviderSkill } from "@t3tools/contracts";
import { formatProviderSkillInvocationLabel } from "@t3tools/shared/providerSkillPresentation";

/**
 * Skills the composer popover may offer. Agent-only skills are reference
 * material the model loads at a precise trigger, so picking one is never the
 * right move and listing it is pure noise.
 */
export function pickableComposerSkills(
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<ServerProviderSkill> {
  return skills.filter((skill) => skill.enabled && isProviderSkillUserInvocable(skill));
}

/**
 * Marker for a popover row whose skill the agent cannot start, for which the
 * popover is the only entry point. `null` for ordinary skills.
 */
export function composerSkillMarkerLabel(
  skill: Pick<ServerProviderSkill, "modelInvocable">,
): string | null {
  return formatProviderSkillInvocationLabel(skill);
}
