import { ProviderDriverKind, type ServerProviderSkill } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { formatProviderSkillDisplayName } from "@t3tools/shared/providerSkillPresentation";

import { searchProviderSkills } from "../../providerSkillSearch";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

function skill(input: Partial<ServerProviderSkill> & Pick<ServerProviderSkill, "name">) {
  return {
    path: `/skills/${input.name}/SKILL.md`,
    enabled: true,
    ...input,
  } satisfies ServerProviderSkill;
}

const CLAUDE = ProviderDriverKind.make("claudeAgent");

// Mirrors how ChatComposer turns the provider's skills into menu items.
function skillItems(skills: ReadonlyArray<ServerProviderSkill>): ComposerCommandItem[] {
  return searchProviderSkills(skills, "").map((entry) => ({
    id: `skill:${CLAUDE}:${entry.name}`,
    type: "skill" as const,
    provider: CLAUDE,
    skill: entry,
    label: formatProviderSkillDisplayName(entry),
    description: entry.shortDescription ?? entry.description ?? "Run provider skill",
  }));
}

function renderSkillMenu(skills: ReadonlyArray<ServerProviderSkill>): string {
  return renderToStaticMarkup(
    <ComposerCommandMenu
      items={skillItems(skills)}
      resolvedTheme="dark"
      isLoading={false}
      triggerKind="skill"
      activeItemId={null}
      onHighlightedItemChange={() => {}}
      onSelect={() => {}}
    />,
  );
}

describe("ComposerCommandMenu skills", () => {
  it("leaves agent-only skills out of the picker", () => {
    const markup = renderSkillMenu([
      skill({ name: "deploy", description: "Deploy the app." }),
      skill({
        name: "harness-adapters",
        description: "Agent-only reference.",
        userInvocable: false,
      }),
    ]);

    expect(markup).toContain("Deploy");
    expect(markup).not.toContain("Harness Adapters");
    expect(markup).not.toContain("Agent-only reference.");
  });

  it("marks a skill the agent cannot start as manual", () => {
    const markup = renderSkillMenu([
      skill({ name: "deploy", description: "Deploy the app." }),
      skill({ name: "to-tickets", description: "Split a spec.", modelInvocable: false }),
    ]);

    const markers = markup.match(/data-composer-skill-invocation="true"/g) ?? [];
    expect(markers).toHaveLength(1);
    expect(markup).toContain("Manual");
    expect(markup.indexOf("To Tickets")).toBeLessThan(markup.indexOf("Manual"));
  });
});
