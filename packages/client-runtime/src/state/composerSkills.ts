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
