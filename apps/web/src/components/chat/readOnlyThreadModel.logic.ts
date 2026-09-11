import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { getTriggerDisplayModelLabel } from "./providerIconUtils";

/**
 * Option id every provider uses for its thinking level. Read-only threads show
 * the level the worker was started with, so the value is read from the stored
 * selection rather than from a picker.
 */
const THINKING_OPTION_ID = "effort";

export interface ReadOnlyThreadModelSummary {
  readonly modelLabel: string;
  /** Null when the stored selection carries no thinking level at all. */
  readonly thinkingLabel: string | null;
}

/**
 * What a read-only thread says about the model behind it: the model's own
 * label, and the thinking level it was started with.
 *
 * The thread title of a First Mate worker already carries both as text. This
 * reads the selection instead, because a title is free text a user can rename.
 */
export function resolveReadOnlyThreadModel(input: {
  readonly selection: ModelSelection;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): ReadOnlyThreadModelSummary {
  const model = input.models.find((candidate) => candidate.slug === input.selection.model);
  const modelLabel = model ? getTriggerDisplayModelLabel(model) : input.selection.model;

  const thinkingValue = getModelSelectionStringOptionValue(input.selection, THINKING_OPTION_ID);
  if (thinkingValue === undefined) {
    return { modelLabel, thinkingLabel: null };
  }

  // The descriptor turns a stored id ("medium") into the provider's own label
  // ("Medium"). A model we don't know, or a value it no longer offers, shows
  // the stored id: it is still the truth about how the worker was started.
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === THINKING_OPTION_ID,
  );
  const choiceLabel =
    descriptor?.type === "select"
      ? descriptor.options.find((option) => option.id === thinkingValue)?.label
      : undefined;

  return { modelLabel, thinkingLabel: choiceLabel ?? thinkingValue };
}
