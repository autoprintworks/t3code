import type { ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerSkillMarkerLabel, pickableComposerSkills } from "./composer-skill-presentation";

function skill(input: Partial<ServerProviderSkill> & Pick<ServerProviderSkill, "name">) {
  return {
    path: `/skills/${input.name}/SKILL.md`,
    enabled: true,
    ...input,
  } satisfies ServerProviderSkill;
}

describe("composer skill presentation", () => {
  it("leaves agent-only and disabled skills out of the popover", () => {
    const listed = pickableComposerSkills([
      skill({ name: "deploy" }),
      skill({ name: "harness-adapters", userInvocable: false }),
      skill({ name: "retired", enabled: false }),
    ]);

    expect(listed.map((entry) => entry.name)).toEqual(["deploy"]);
  });

  it("marks a skill the agent cannot start as manual", () => {
    expect(composerSkillMarkerLabel(skill({ name: "to-tickets", modelInvocable: false }))).toBe(
      "Manual",
    );
    expect(composerSkillMarkerLabel(skill({ name: "deploy" }))).toBeNull();
    expect(composerSkillMarkerLabel(skill({ name: "deploy", modelInvocable: true }))).toBeNull();
  });
});
