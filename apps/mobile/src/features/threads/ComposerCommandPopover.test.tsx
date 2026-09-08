import { ProviderDriverKind, type ServerProviderSkill } from "@t3tools/contracts";
import {
  formatProviderSkillDisplayName,
  pickableProviderSkills,
} from "@t3tools/shared/providerSkillPresentation";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

// React Native ships Flow sources this runner cannot parse, so the native
// leaves stand in as host elements. What is under test is the popover's own
// rendering, which is all plain React.
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
  useColorScheme: () => "dark",
}));
vi.mock("@callstack/liquid-glass", () => ({
  isLiquidGlassSupported: false,
  LiquidGlassView: "LiquidGlassView",
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: "SymbolView" }));
vi.mock("../../components/AppText", () => ({ AppText: "AppText" }));
vi.mock("../../components/PierreEntryIcon", () => ({ PierreEntryIcon: "PierreEntryIcon" }));

import { ComposerCommandPopover, type ComposerCommandItem } from "./ComposerCommandPopover";

const PROVIDER = ProviderDriverKind.make("claudeAgent");

/**
 * Renders an element tree far enough to read the strings a user would see.
 * Function and `memo` components are called; host elements are walked.
 */
function renderedText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((child) => renderedText(child)).join("|");
  if (!isValidElement(node)) return "";

  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  const elementType: unknown = element.type;
  const component =
    typeof elementType === "function"
      ? elementType
      : typeof elementType === "object" && elementType !== null && "type" in elementType
        ? (elementType as { readonly type: unknown }).type
        : null;

  if (typeof component === "function") {
    return renderedText((component as (props: unknown) => ReactNode)(element.props));
  }
  return renderedText(element.props.children);
}

function skill(
  overrides: Partial<ServerProviderSkill> & { readonly name: string },
): ServerProviderSkill {
  return {
    path: `/skills/${overrides.name}/SKILL.md`,
    enabled: true,
    ...overrides,
  };
}

/** Builds the popover's items the way `ThreadComposer` does, then renders them. */
function renderSkillRows(skills: ReadonlyArray<ServerProviderSkill>): string {
  const items: ReadonlyArray<ComposerCommandItem> = pickableProviderSkills(skills).map((entry) => ({
    id: `skill:${PROVIDER}:${entry.name}`,
    type: "skill",
    provider: PROVIDER,
    skill: entry,
    label: formatProviderSkillDisplayName(entry),
    description: entry.shortDescription ?? entry.description ?? "Run provider skill",
  }));

  return renderedText(
    <ComposerCommandPopover
      items={items}
      triggerKind="skill"
      isLoading={false}
      onSelect={() => {}}
    />,
  );
}

describe("ComposerCommandPopover skill rows", () => {
  it("renders no row for a skill a user may not pick", () => {
    const rendered = renderSkillRows([
      skill({ name: "deploy", description: "Deploy the app." }),
      skill({
        name: "harness-adapters",
        description: "Agent-only reference.",
        userInvocable: false,
      }),
    ]);

    expect(rendered).toContain("Deploy");
    expect(rendered).not.toContain("Harness Adapters");
    expect(rendered).not.toContain("Agent-only reference.");
  });

  it("marks a skill the agent cannot start as manual", () => {
    const rendered = renderSkillRows([
      skill({ name: "deploy", description: "Deploy the app." }),
      skill({ name: "to-tickets", description: "Split a spec.", modelInvocable: false }),
    ]);

    expect(rendered.match(/Manual/g) ?? []).toHaveLength(1);
    expect(rendered.indexOf("To Tickets")).toBeLessThan(rendered.indexOf("Manual"));
  });
});
