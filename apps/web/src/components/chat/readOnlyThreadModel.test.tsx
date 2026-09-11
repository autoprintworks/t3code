import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ReadOnlyThreadModelBadges, ReadOnlyThreadModelStrip } from "./ReadOnlyThreadModel";

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

function claudeEntries() {
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-11T00:00:00.000Z",
    models: [
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
    ],
    slashCommands: [],
    skills: [],
  };
  return deriveProviderInstanceEntries([provider]);
}

describe("ReadOnlyThreadModelStrip", () => {
  it("shows the model, the thinking level and the runtime mode", () => {
    const markup = renderToStaticMarkup(
      <ReadOnlyThreadModelStrip
        providerEntries={claudeEntries()}
        instanceId={ProviderInstanceId.make("claudeAgent")}
        selection={workerSelection}
        runtimeMode="full-access"
      />,
    );

    expect(markup).toContain("Opus 5");
    expect(markup).toContain("Medium");
    expect(markup).toContain("Full access");
    // A strip, not a composer: nothing to type into and nothing to pick.
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("<button");
  });

  it("omits the thinking level when the selection carries no effort option", () => {
    const markup = renderToStaticMarkup(
      <ReadOnlyThreadModelStrip
        providerEntries={claudeEntries()}
        instanceId={ProviderInstanceId.make("claudeAgent")}
        selection={selectionWithoutThinking}
        runtimeMode="full-access"
      />,
    );

    expect(markup).toContain("Opus 5");
    expect(markup).toContain("Full access");
    expect(markup).not.toContain("Medium");
    expect(markup).not.toContain("Unknown");
  });
});

describe("ReadOnlyThreadModelBadges", () => {
  it("shows the model and the thinking level in the row", () => {
    const markup = renderToStaticMarkup(
      <ReadOnlyThreadModelBadges
        providerEntry={claudeEntries()[0] ?? null}
        selection={workerSelection}
      />,
    );

    expect(markup).toContain("Opus 5");
    expect(markup).toContain("Medium");
  });

  it("omits the thinking level when the selection carries no effort option", () => {
    const markup = renderToStaticMarkup(
      <ReadOnlyThreadModelBadges
        providerEntry={claudeEntries()[0] ?? null}
        selection={selectionWithoutThinking}
      />,
    );

    expect(markup).toContain("Opus 5");
    expect(markup).not.toContain("Medium");
    expect(markup).not.toContain("Unknown");
  });

  it("falls back to the stored slug and value when the model is unknown", () => {
    const markup = renderToStaticMarkup(
      <ReadOnlyThreadModelBadges providerEntry={null} selection={workerSelection} />,
    );

    expect(markup).toContain("claude-opus-5");
    expect(markup).toContain("medium");
  });
});
