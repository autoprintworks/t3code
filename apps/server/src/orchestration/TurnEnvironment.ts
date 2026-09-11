/**
 * TurnEnvironment - side channel for a turn start's `environment`.
 *
 * The field is absent from every orchestration event on purpose: its values
 * name paths on the server's filesystem, which no client needs and none may
 * display, so it must not reach persisted state, the timeline, or the wire.
 * The engine parks it here once the command commits, and the provider reactor
 * takes it when it handles that command's `thread.turn-start-requested`.
 * Taking removes it, so a later turn on the same thread never inherits it.
 *
 * @module TurnEnvironment
 */
import type {
  CommandId,
  OrchestrationCommand,
  ProviderInstanceEnvironment,
} from "@t3tools/contracts";

// A parked entry is normally taken within one event round trip. The cap is
// there for the turn start that is deduplicated or dropped, so a missed take
// costs one entry rather than growing the map for the life of the process.
const MAX_PARKED_TURN_ENVIRONMENTS = 256;

const environmentsByCommandId = new Map<CommandId, ProviderInstanceEnvironment>();

export function rememberTurnEnvironment(command: OrchestrationCommand): void {
  if (command.type !== "thread.turn.start" || command.environment === undefined) {
    return;
  }
  if (environmentsByCommandId.size >= MAX_PARKED_TURN_ENVIRONMENTS) {
    const oldest = environmentsByCommandId.keys().next();
    if (!oldest.done) {
      environmentsByCommandId.delete(oldest.value);
    }
  }
  environmentsByCommandId.set(command.commandId, command.environment);
}

export function takeTurnEnvironment(
  commandId: CommandId | null,
): ProviderInstanceEnvironment | undefined {
  if (commandId === null) {
    return undefined;
  }
  const environment = environmentsByCommandId.get(commandId);
  environmentsByCommandId.delete(commandId);
  return environment;
}
