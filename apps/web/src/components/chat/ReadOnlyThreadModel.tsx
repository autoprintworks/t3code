import type { ModelSelection, RuntimeMode } from "@t3tools/contracts";

import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../../providerInstances";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { resolveReadOnlyThreadModel } from "./readOnlyThreadModel.logic";

/**
 * Same words the composer's runtime mode control uses (`runtimeModeConfig` in
 * ChatComposer.tsx). Repeated rather than imported: importing that module here
 * would pull the whole composer into the sidebar and into this file's test.
 * Upstream already keeps its own copies in CompactComposerControlsMenu.tsx and
 * in the mobile thread settings. Typing this as a `Record<RuntimeMode, string>`
 * is what stops a renamed mode drifting: the union changing fails the build.
 */
const runtimeModeLabels: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/**
 * Caps the badges on a sidebar row. An unknown model falls back to the stored
 * slug, which is long enough to push the diff counts and the timestamp out of
 * the row, so a badge truncates instead of growing. The size is set here rather
 * than inherited: the card row's meta line is `text-xs`, the slim row is not.
 */
const rowModelClassName = "min-w-0 max-w-24 shrink-0 truncate text-muted-foreground/60 text-xs";
const rowThinkingClassName = "min-w-0 max-w-16 shrink-0 truncate text-muted-foreground/60 text-xs";

/**
 * Stands where the composer sits on a read-only thread: what is driving the
 * work, not a way to change it. No input, no picker, nothing to click.
 */
export function ReadOnlyThreadModelStrip(props: {
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly selection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
}) {
  const providerEntry =
    props.providerEntries.find((entry) => entry.instanceId === props.selection.instanceId) ?? null;
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
 *
 * Takes the whole instance lookup rather than one entry, so the instance is
 * picked from the selection here and cannot be picked wrongly by the caller.
 */
export function ReadOnlyThreadModelBadges(props: {
  readonly providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  readonly selection: ModelSelection;
}) {
  const providerEntry = props.providerEntryByInstanceId.get(props.selection.instanceId) ?? null;
  const { modelLabel, thinkingLabel } = resolveReadOnlyThreadModel({
    selection: props.selection,
    models: providerEntry?.models ?? [],
  });

  return (
    <>
      <span data-testid="sidebar-read-only-model" className={rowModelClassName}>
        {modelLabel}
      </span>
      {thinkingLabel === null ? null : (
        <span data-testid="sidebar-read-only-thinking" className={rowThinkingClassName}>
          {thinkingLabel}
        </span>
      )}
    </>
  );
}
