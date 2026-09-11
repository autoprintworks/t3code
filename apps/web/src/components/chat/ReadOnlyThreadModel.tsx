import type { ModelSelection, ProviderInstanceId, RuntimeMode } from "@t3tools/contracts";

import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { resolveReadOnlyThreadModel } from "./readOnlyThreadModel.logic";

/**
 * Same words the composer's runtime mode control uses (`runtimeModeConfig` in
 * ChatComposer.tsx). Repeated rather than imported: importing that module here
 * would pull the whole composer into the sidebar and into this file's test.
 */
const runtimeModeLabels: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/**
 * Stands where the composer sits on a read-only thread: what is driving the
 * work, not a way to change it. No input, no picker, nothing to click.
 */
export function ReadOnlyThreadModelStrip(props: {
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly instanceId: ProviderInstanceId | string;
  readonly selection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}) {
  const providerEntry =
    props.providerEntries.find((entry) => entry.instanceId === props.instanceId) ?? null;
  const { modelLabel, thinkingLabel } = resolveReadOnlyThreadModel({
    selection: props.selection,
    models: providerEntry?.models ?? [],
  });

  return (
    <div className="w-full ps-[calc(env(safe-area-inset-left)+0.75rem)] pe-[calc(env(safe-area-inset-right)+0.75rem)] sm:ps-[calc(env(safe-area-inset-left)+1.25rem)] sm:pe-[calc(env(safe-area-inset-right)+1.25rem)]">
      <div className="mx-auto flex w-full max-w-3xl justify-center pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:pb-[calc(env(safe-area-inset-bottom)+1.25rem)]">
        <div
          data-testid="read-only-thread-model-strip"
          aria-label="Read-only thread"
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-card/80 px-2.5 py-1 text-secondary-label text-xs"
        >
          {providerEntry ? (
            <ProviderInstanceIcon
              driverKind={providerEntry.driverKind}
              displayName={providerEntry.displayName}
              iconKey={providerEntry.iconKey}
              accentColor={providerEntry.accentColor}
              showBadge={shouldShowInstanceBadge(providerEntry, props.providerEntries)}
              iconClassName="size-3.5 opacity-70"
              badgeClassName="right-[-0.1875rem] bottom-[-0.1875rem] h-3 min-w-3 px-0.5 text-[7px]"
            />
          ) : null}
          <span className="min-w-0 truncate font-medium text-foreground/80">{modelLabel}</span>
          {thinkingLabel === null ? null : (
            <>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate">{thinkingLabel}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span className="min-w-0 truncate">{runtimeModeLabels[props.runtimeMode]}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Model and thinking level on a read-only sidebar row. A read-only thread
 * cannot be opened to change either one, so the row carries them at rest
 * instead of only in the hover card.
 */
export function ReadOnlyThreadModelBadges(props: {
  readonly providerEntry: ProviderInstanceEntry | null;
  readonly selection: ModelSelection;
}) {
  const { modelLabel, thinkingLabel } = resolveReadOnlyThreadModel({
    selection: props.selection,
    models: props.providerEntry?.models ?? [],
  });

  return (
    <>
      <span data-testid="sidebar-read-only-model" className="shrink-0 text-muted-foreground/60">
        {modelLabel}
      </span>
      {thinkingLabel === null ? null : (
        <span
          data-testid="sidebar-read-only-thinking"
          className="shrink-0 text-muted-foreground/60"
        >
          {thinkingLabel}
        </span>
      )}
    </>
  );
}
