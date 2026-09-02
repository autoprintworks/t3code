/**
 * One place that answers "which agent process would this instance start?".
 *
 * Two enabled instances of this driver that resolve to the same command, the
 * same arguments and the same working directory are the same agent. Duplicating
 * an instance and forgetting to change the command is an easy mistake to make
 * in a settings form, and the result is two connections driving one agent, each
 * unaware of the other's turns. The driver refuses the second one, and this
 * module is what it compares on and what it says when it refuses.
 *
 * @module provider/acpAgent/AcpAgentIdentity
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { expandHomePath } from "../../pathExpansion.ts";
import { parseAcpAgentArgs, type AcpAgentSpawnSettings } from "./AcpAgentSupport.ts";

export interface AcpAgentIdentity {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /**
   * The configured working directory, or `undefined` when the instance starts
   * its agent in whichever project the session belongs to. Two instances that
   * both follow the project are only the same agent if their command line is,
   * which is exactly what the `undefined` case compares.
   */
  readonly workingDirectory: string | undefined;
}

/**
 * What identity is read from. Only the three fields that decide which process
 * would start, and each optional: a half-filled instance is the state every new
 * one begins in, and it still has an identity.
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

/**
 * The key two instances are compared on.
 *
 * Paths are resolved and then case-folded on the platforms whose filesystems
 * are case-insensitive, so `C:/Agents/one` and `c:/agents/one` are one agent.
 * The platform is passed in rather than read from `process`, so a test can ask
 * about a platform it is not running on. Arguments are compared verbatim: an
 * agent is free to treat `-v` and `--verbose` as different, and guessing
 * otherwise would refuse a configuration that works.
 */
export function acpAgentIdentityKey(identity: AcpAgentIdentity, platform: NodeJS.Platform): string {
  const caseInsensitive = platform === "win32" || platform === "darwin";
  const fold = (value: string) => (caseInsensitive ? value.toLowerCase() : value);
  const command = fold(identity.command);
  const workingDirectory =
    identity.workingDirectory === undefined
      ? ""
      : fold(NodePath.resolve(identity.workingDirectory));
  // `\u0000` cannot appear in an argument on any platform we run on, so it is
  // the one separator that cannot be forged by an argument containing it.
  return [command, workingDirectory, ...identity.args].join("\u0000");
}

/** How the agent should be named in a message the user reads. */
export function describeAcpAgentIdentity(identity: AcpAgentIdentity): string {
  const commandLine = [identity.command, ...identity.args].join(" ");
  return identity.workingDirectory === undefined
    ? commandLine
    : `${commandLine} (in ${identity.workingDirectory})`;
}
