import type { EnvironmentId, ProviderInstanceId, ServerProviderSkill } from "@t3tools/contracts";

/**
 * What the composer menu needs to name the skills one thread can actually run:
 * the environment that owns the project, the provider instance that would run
 * the turn, and the directory the thread is open on.
 *
 * The provider snapshot cannot answer this. It is probed once from the
 * environment's own working directory, so its project-scoped skills belong to
 * whatever repository the environment was started in.
 */
export interface ComposerSkillsTarget {
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly cwd: string | null;
}

export interface ComposerSkillsState {
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly isPending: boolean;
  readonly error: string | null;
}

const EMPTY_PROVIDER_SKILLS: ReadonlyArray<ServerProviderSkill> = Object.freeze([]);

/**
 * The slice of a surface's `useEnvironmentQuery` result this hook reads. Web
 * and mobile both return this shape.
 */
export interface ComposerSkillsQueryView {
  readonly data: { readonly skills: ReadonlyArray<ServerProviderSkill> } | null;
  readonly isPending: boolean;
  readonly error: string | null;
}

/**
 * Builds the composer's skills hook for one surface.
 *
 * This package holds no React, so the surface passes its own query hook and its
 * own `providerSkills` query in, and the shared part - when to ask, and how to
 * read the answer - lives here once.
 *
 * The query only runs while `enabled` is true. A composer that asked on mount
 * would make every open thread pay for a menu the user may never open, so the
 * caller passes the skill trigger's own state.
 */
export function createUseComposerSkills<Query>(deps: {
  readonly useEnvironmentQuery: (query: Query | null) => ComposerSkillsQueryView;
  readonly providerSkillsQuery: (args: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly cwd: string;
    };
  }) => Query;
}) {
  return function useComposerSkills(
    target: ComposerSkillsTarget,
    options?: { readonly enabled?: boolean },
  ): ComposerSkillsState {
    const enabled = options?.enabled ?? true;
    const result = deps.useEnvironmentQuery(
      enabled &&
        target.environmentId !== null &&
        target.providerInstanceId !== null &&
        target.cwd !== null
        ? deps.providerSkillsQuery({
            environmentId: target.environmentId,
            input: { providerInstanceId: target.providerInstanceId, cwd: target.cwd },
          })
        : null,
    );

    return {
      skills: result.data?.skills ?? EMPTY_PROVIDER_SKILLS,
      isPending: result.isPending,
      error: result.error,
    };
  };
}
