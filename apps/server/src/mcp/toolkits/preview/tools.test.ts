import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { PreviewSnapshotToolkit, PreviewStandardToolkit, PreviewToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

const schemaHasMultipleAllOfDescriptions = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  const allOf = Array.isArray(record.allOf) ? record.allOf : [];
  const descriptionCount = allOf.filter(
    (member) =>
      member !== null &&
      typeof member === "object" &&
      typeof (member as Record<string, unknown>).description === "string",
  ).length;
  return descriptionCount > 1 || Object.values(record).some(schemaHasMultipleAllOfDescriptions);
};

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(PreviewToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    if (tool.name === "preview_navigate") {
      expect(schemaHasMultipleAllOfDescriptions(schema)).toBe(false);
    }
    expect(
      schema.properties?.tabId,
      `${tool.name} must allow an explicit collaborative browser tab target`,
    ).toBeDefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

// The preview toolkit's declared surface is frozen. A second toolkit now sits
// beside it, so this locks preview's tool names and parameter fields and fails
// if a later change adds, drops, or renames any of them.
const PREVIEW_DECLARED_SURFACE: Readonly<Record<string, ReadonlyArray<string>>> = {
  preview_click: ["locator", "selector", "tabId", "timeoutMs", "x", "y"],
  preview_evaluate: ["awaitPromise", "expression", "returnByValue", "tabId"],
  preview_navigate: ["readiness", "tabId", "target", "timeoutMs", "url"],
  preview_open: ["open", "reuseExistingTab", "show", "tabId", "url"],
  preview_press: ["key", "modifiers", "tabId"],
  preview_recording_start: ["tabId"],
  preview_recording_stop: ["tabId"],
  preview_resize: ["height", "mode", "orientation", "preset", "tabId", "timeoutMs", "width"],
  preview_scroll: ["deltaX", "deltaY", "locator", "selector", "tabId"],
  preview_set_appearance: ["colorScheme", "tabId"],
  preview_snapshot: ["tabId"],
  preview_status: ["tabId"],
  preview_type: ["clear", "locator", "selector", "tabId", "text", "timeoutMs"],
  preview_wait_for: ["locator", "selector", "tabId", "text", "timeoutMs", "urlIncludes"],
};

it("keeps the preview toolkit's declared surface unchanged", () => {
  const actual = Object.fromEntries(
    Object.values(PreviewToolkit.tools).map((tool) => {
      const schema = Tool.getJsonSchema(tool) as {
        readonly properties?: Readonly<Record<string, unknown>>;
      };
      return [tool.name, Object.keys(schema.properties ?? {}).toSorted()] as const;
    }),
  );
  expect(actual).toEqual(PREVIEW_DECLARED_SURFACE);
  expect(Object.keys(PreviewStandardToolkit.tools).toSorted()).toEqual(
    Object.keys(PREVIEW_DECLARED_SURFACE)
      .filter((name) => name !== "preview_snapshot")
      .toSorted(),
  );
  expect(Object.keys(PreviewSnapshotToolkit.tools)).toEqual(["preview_snapshot"]);
});
