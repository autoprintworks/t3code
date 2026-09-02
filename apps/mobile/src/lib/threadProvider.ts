import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ServerConfig, ServerProvider } from "@t3tools/contracts";

/**
 * The provider snapshot a thread is running on, or null when its environment
 * has not reported one.
 *
 * A thread names its provider twice: the session it is attached to knows the
 * instance it opened, and the model selection knows the instance it would open
 * next. The session wins where it exists, because that is the agent the words
 * on screen actually came from.
 */
export function findProviderForThread(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
  thread: EnvironmentThreadShell,
): ServerProvider | null {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  return (
    serverConfigs
      .get(thread.environmentId)
      ?.providers.find((provider) => provider.instanceId === instanceId) ?? null
  );
}
