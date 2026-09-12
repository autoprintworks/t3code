import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries, type ProviderInstanceEntry } from "../../providerInstances";
import { ReadOnlyThreadModelBadges, ReadOnlyThreadModelStrip } from "./ReadOnlyThreadModel";

/** The selection a running First Mate worker carries, verbatim. */
const workerSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
  options: [{ id: "effort", value: "medium" }],
};

function modelNamed(name: string): ServerProviderModel {
  return {
    slug: "claude-opus-5",
    name,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Thinking",
          type: "select",
          options: [{ id: "medium", label: "Medium" }],
        },
      ],
    },
  };
}

function instance(instanceId: string, modelName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-11T00:00:00.000Z",
    models: [modelNamed(modelName)],
    slashCommands: [],
    skills: [],
  };
}

/**
 * Two instances of the same driver, both carrying the selected slug under a
 * different name. Only the one the selection names may supply the label, so a
 * lookup that keys off anything else shows "Other instance".
 */
const twoInstances: ReadonlyArray<ProviderInstanceEntry> = deriveProviderInstanceEntries([
  instance("claudeAgentSecondary", "Other instance"),
  instance("claudeAgent", "Opus 5"),
]);

const twoInstancesByInstanceId: ReadonlyMap<string, ProviderInstanceEntry> = new Map(
  twoInstances.map((entry) => [entry.instanceId as string, entry]),
);

describe("ReadOnlyThreadModelStrip", () => {
  it("labels the model from the instance the selection names, and says the runtime mode", () => {
    const markup = renderToStaticMarkup(
      <ReadOnlyThreadModelStrip
        providerEntries={twoInstances}
        selection={workerSelection}
        runtimeMode="full-access"
      />,
    );

    expect(markup).toContain("Opus 5");
    expect(markup).toContain("Medium");
    expect(markup).toContain("Full access");
    expect(markup).not.toContain("Other instance");
  });
});

describe("ReadOnlyThreadModelBadges", () => {
  it("labels the model from the instance the selection names", () => {
    const markup = renderToStaticMarkup(
      <ReadOnlyThreadModelBadges
        providerEntryByInstanceId={twoInstancesByInstanceId}
        selection={workerSelection}
      />,
    );

    expect(markup).toContain("Opus 5");
    expect(markup).toContain("Medium");
    expect(markup).not.toContain("Other instance");
  });

  it("falls back to the stored slug when the selection names an instance that is gone", () => {
    const markup = renderToStaticMarkup(
      <ReadOnlyThreadModelBadges
        providerEntryByInstanceId={new Map()}
        selection={workerSelection}
      />,
    );

    expect(markup).toContain("claude-opus-5");
    expect(markup).toContain("medium");
  });
});
