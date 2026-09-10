import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind, type ServerProviderSkill } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";

import { searchProviderSkills } from "../../providerSkillSearch";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

describe("ComposerCommandMenu", () => {
  it("renders slash commands with their descriptions", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "slash:model",
            type: "slash-command",
            command: "model",
            label: "/model",
            description: "Switch response model for this thread",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="slash:model"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("/model");
    expect(markup).toContain("Switch response model for this thread");
  });

  it("shows the app source for an app skill", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:browser",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "browser",
              path: "/Users/maria/.codex/plugins/browser/skills/browser/SKILL.md",
              scope: "user",
              enabled: true,
            },
            label: "Browser",
            description: "Open and control the in-app browser",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="skill"
        activeItemId="skill:codex:browser"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain("Browser");
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain(">App Skill</span>");
    expect(markup).toContain("Open and control the in-app browser");
    expect(markup).toContain("<svg");
  });

  it("shows the repo source for a slash skill", () => {
    const markup = renderToStaticMarkup(
      <ComposerCommandMenu
        items={[
          {
            id: "skill:codex:ask-matt",
            type: "skill",
            provider: ProviderDriverKind.make("codex"),
            skill: {
              name: "ask-matt",
              displayName: "Ask Matt",
              path: "/skills/ask-matt/SKILL.md",
              scope: "repo",
              enabled: true,
            },
            label: "/skill:ask-matt",
            description: "Find the right skill or workflow",
          },
        ]}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId="skill:codex:ask-matt"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );

    expect(markup).toContain('<span class="text-secondary-label">/skill:</span>Ask Matt');
    expect(markup).toContain('data-slot="badge"');
    expect(markup).toContain("lucide-folder");
    expect(markup).toContain(">Repo</span>");
    expect(markup).toContain("Find the right skill or workflow");
  });
});

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
      skill({ name: "to-tickets", description: "Split a spec.", userInvocationOnly: true }),
    ]);

    const markers = markup.match(/Manual/g) ?? [];
    expect(markers).toHaveLength(1);
    expect(markup.indexOf("To Tickets")).toBeLessThan(markup.indexOf("Manual"));
  });
});
