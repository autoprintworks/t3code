import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProviderInstanceId, type ServerProviderSkill } from "@t3tools/contracts";

import { createUseComposerSkills, type ComposerSkillsQueryView } from "./composerSkills.ts";

interface SkillsQuery {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly cwd: string;
  };
}

const skill = {
  name: "review",
  path: "/repo/.claude/skills/review",
  scope: "project",
  enabled: true,
} as unknown as ServerProviderSkill;

function makeHook(answer: ComposerSkillsQueryView) {
  const asked: Array<SkillsQuery | null> = [];
  const useComposerSkills = createUseComposerSkills<SkillsQuery>({
    useEnvironmentQuery: (query) => {
      asked.push(query);
      return query === null ? { data: null, isPending: false, error: null } : answer;
    },
    providerSkillsQuery: (args) => args,
  });
  return { asked, useComposerSkills };
}

const target = {
  environmentId: EnvironmentId.make("env-1"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  cwd: "/repo",
};

describe("createUseComposerSkills", () => {
  it("asks for the thread's own project when enabled", () => {
    const { asked, useComposerSkills } = makeHook({
      data: { skills: [skill] },
      isPending: false,
      error: null,
    });

    const state = useComposerSkills(target, { enabled: true });

    expect(asked).toEqual([
      { environmentId: "env-1", input: { providerInstanceId: "claude", cwd: "/repo" } },
    ]);
    expect(state.skills).toEqual([skill]);
  });

  it("asks for nothing while the trigger is closed", () => {
    const { asked, useComposerSkills } = makeHook({
      data: { skills: [skill] },
      isPending: false,
      error: null,
    });

    const state = useComposerSkills(target, { enabled: false });

    expect(asked).toEqual([null]);
    expect(state.skills).toEqual([]);
    expect(state.isPending).toBe(false);
  });

  it("asks for nothing until the target is complete", () => {
    const { asked, useComposerSkills } = makeHook({
      data: { skills: [skill] },
      isPending: false,
      error: null,
    });

    useComposerSkills({ ...target, cwd: null });

    expect(asked).toEqual([null]);
  });
});
