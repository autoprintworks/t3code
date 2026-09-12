import {
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveReadOnlyThreadModel } from "./readOnlyThreadModel.logic";

/**
 * The selection a running First Mate worker carries, verbatim, and the same
 * selection with its thinking level dropped.
 */
const workerSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
  options: [{ id: "effort", value: "medium" }],
};
const selectionWithoutThinking: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
};

const claudeModels: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-opus-5",
    name: "Opus 5",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Thinking",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
  },
];

describe("resolveReadOnlyThreadModel", () => {
  it("reads the model label and the thinking level from the stored selection", () => {
    expect(
      resolveReadOnlyThreadModel({ selection: workerSelection, models: claudeModels }),
    ).toEqual({ modelLabel: "Opus 5", thinkingLabel: "Medium" });
  });

  it("leaves out the thinking level when the selection carries no effort option", () => {
    expect(
      resolveReadOnlyThreadModel({ selection: selectionWithoutThinking, models: claudeModels }),
    ).toEqual({ modelLabel: "Opus 5", thinkingLabel: null });
  });

  it("falls back to the stored slug and value when the model list is not the selection's", () => {
    expect(resolveReadOnlyThreadModel({ selection: workerSelection, models: [] })).toEqual({
      modelLabel: "claude-opus-5",
      thinkingLabel: "medium",
    });
  });

  it("falls back to the stored value when the model no longer offers it", () => {
    const selection: ModelSelection = {
      ...workerSelection,
      options: [{ id: "effort", value: "ultrathink" }],
    };

    expect(resolveReadOnlyThreadModel({ selection, models: claudeModels })).toEqual({
      modelLabel: "Opus 5",
      thinkingLabel: "ultrathink",
    });
  });
});
