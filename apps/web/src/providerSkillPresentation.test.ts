import { describe, expect, it } from "vite-plus/test";

import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
  formatProviderSkillScopeLabel,
} from "./providerSkillPresentation";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("formatProviderSkillInstallSource", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      formatProviderSkillInstallSource({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("App");
  });

  it("maps standard scopes to user-facing labels", () => {
    expect(
      formatProviderSkillInstallSource({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("Personal");
    expect(
      formatProviderSkillInstallSource({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("System");
    expect(
      formatProviderSkillInstallSource({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("Project");
  });
});

describe("formatProviderSkillScopeLabel", () => {
  it("names project and user scope so a menu row can be read at a glance", () => {
    expect(
      formatProviderSkillScopeLabel({
        path: "/projects/project-a/.claude/skills/deploy/SKILL.md",
        scope: "project",
      }),
    ).toBe("Project");
    expect(
      formatProviderSkillScopeLabel({
        path: "/Users/julius/.claude/skills/summarize/SKILL.md",
        scope: "user",
      }),
    ).toBe("User");
  });

  it("keeps the install source for a scope it cannot place", () => {
    expect(
      formatProviderSkillScopeLabel({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("System");
    expect(
      formatProviderSkillScopeLabel({
        path: "/workspace/skills/mystery/SKILL.md",
      }),
    ).toBe(null);
  });
});
