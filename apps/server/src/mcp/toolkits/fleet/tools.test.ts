import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { FleetToolkit } from "./tools.ts";

const getObjectSchema = (tool: Tool.Any) =>
  Tool.getJsonSchema(tool) as {
    readonly type?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: unknown;
    readonly anyOf?: unknown;
    readonly oneOf?: unknown;
  };

it("exports provider-compatible object schemas", () => {
  for (const tool of Object.values(FleetToolkit.tools)) {
    const schema = getObjectSchema(tool);
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
  }
});

it("declares the fleet toolkit's tool names", () => {
  expect(Object.keys(FleetToolkit.tools).toSorted()).toEqual([
    "fleet_list_threads",
    "fleet_whoami",
  ]);
});

// The identity verb answers from the server's own invocation scope. Declaring
// no parameters is what makes impersonation unrepresentable, so the declared
// schema — not just the call sites — has to stay empty.
it("gives fleet_whoami no parameters at all, so no call can name another thread", () => {
  const schema = getObjectSchema(FleetToolkit.tools.fleet_whoami);
  expect(Object.keys(schema.properties ?? {})).toEqual([]);
  expect(schema.required ?? []).toEqual([]);
  expect(JSON.stringify(schema)).not.toMatch(/thread/i);
});
