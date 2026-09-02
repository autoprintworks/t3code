/**
 * One place that answers "which agent process would this instance start?".
 *
 * The answer is used to name the agent in a message the user reads, so it
 * resolves the same fields the spawn does and prints them the way they were
 * typed.
 *
 * @module provider/acpAgent/AcpAgentIdentity
 */
import { expandHomePath } from "../../pathExpansion.ts";
import { parseAcpAgentArgs, type AcpAgentSpawnSettings } from "./AcpAgentSupport.ts";

export interface AcpAgentIdentity {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * The configured working directory, or `undefined` when the instance starts
   * its agent in whichever project the session belongs to.
   */
  readonly workingDirectory: string | undefined;
}

/**
 * What identity is read from, each field optional: a half-filled instance is
 * the state every new one begins in, and it still has an identity.
 */
export type AcpAgentIdentitySettings = Partial<
  Pick<AcpAgentSpawnSettings, "command" | "args" | "workingDirectory">
>;

export function resolveAcpAgentIdentity(
  settings: AcpAgentIdentitySettings | null | undefined,
): AcpAgentIdentity {
  const workingDirectory = settings?.workingDirectory?.trim();
  return {
    command: settings?.command?.trim() ?? "",
    args: parseAcpAgentArgs(settings?.args),
    workingDirectory: workingDirectory ? expandHomePath(workingDirectory) : undefined,
  };
}

/** How the agent should be named in a message the user reads. */
export function describeAcpAgentIdentity(identity: AcpAgentIdentity): string {
  const commandLine = [identity.command, ...identity.args].join(" ");
  return identity.workingDirectory === undefined
    ? commandLine
    : `${commandLine} (in ${identity.workingDirectory})`;
}
