import { describe, expect, it } from "@effect/vitest";

import { resolveMode } from "./LoopIntegrityGuard.ts";

describe("LoopIntegrityGuard.resolveMode", () => {
  it("is off when nothing says otherwise", () => {
    expect(resolveMode({})).toBe("off");
    expect(resolveMode({ NODE_ENV: "production" })).toBe("off");
  });

  it("samples in development and under test", () => {
    expect(resolveMode({ NODE_ENV: "development" })).toBe("sample");
    expect(resolveMode({ NODE_ENV: "test" })).toBe("sample");
    expect(resolveMode({ VITE_DEV_SERVER_URL: "http://localhost:5173" })).toBe("sample");
  });

  it("lets the environment variable win, including turning the guard off in dev", () => {
    expect(resolveMode({ NODE_ENV: "development", T3CODE_LOOP_INTEGRITY: "off" })).toBe("off");
    expect(resolveMode({ NODE_ENV: "production", T3CODE_LOOP_INTEGRITY: "attribute" })).toBe(
      "attribute",
    );
    expect(resolveMode({ T3CODE_LOOP_INTEGRITY: " Sample " })).toBe("sample");
  });

  it("ignores a value it does not recognise", () => {
    expect(resolveMode({ T3CODE_LOOP_INTEGRITY: "loud" })).toBe("off");
    expect(resolveMode({ NODE_ENV: "development", T3CODE_LOOP_INTEGRITY: "loud" })).toBe("sample");
  });
});
