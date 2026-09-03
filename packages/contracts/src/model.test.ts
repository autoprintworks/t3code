import { describe, expect, it } from "vite-plus/test";

import {
  ACP_AGENT_DRIVER_KIND,
  DEFAULT_PROVIDER_ICON_KEY,
  PROVIDER_ICON_KEYS,
  isProviderIconKey,
  resolveProviderIconKey,
} from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

describe("resolveProviderIconKey", () => {
  it("prefers the key the instance asked for", () => {
    expect(resolveProviderIconKey({ driverKind: CODEX_DRIVER_KIND, iconKey: "anchor" })).toBe(
      "anchor",
    );
  });

  it("falls back to the driver's own glyph when no key is set", () => {
    expect(resolveProviderIconKey({ driverKind: CODEX_DRIVER_KIND })).toBe("openai");
    expect(resolveProviderIconKey({ driverKind: ACP_AGENT_DRIVER_KIND })).toBe(
      DEFAULT_PROVIDER_ICON_KEY,
    );
  });

  it("draws the default rather than nothing for a key it does not know", () => {
    // A newer server may name a glyph this client has no artwork for. Drawing
    // the default is what stops that instance appearing with no icon at all.
    expect(resolveProviderIconKey({ driverKind: ACP_AGENT_DRIVER_KIND, iconKey: "flask" })).toBe(
      DEFAULT_PROVIDER_ICON_KEY,
    );
  });

  it("has no glyph for a driver it has never heard of", () => {
    expect(resolveProviderIconKey({ driverKind: ProviderDriverKind.make("unheard-of") })).toBe(
      undefined,
    );
    expect(resolveProviderIconKey({ driverKind: null })).toBe(undefined);
  });

  it("treats whitespace as no key at all", () => {
    expect(resolveProviderIconKey({ driverKind: CODEX_DRIVER_KIND, iconKey: "   " })).toBe(
      "openai",
    );
  });
});

describe("isProviderIconKey", () => {
  it("accepts every key the settings menu offers", () => {
    for (const key of PROVIDER_ICON_KEYS) {
      expect(isProviderIconKey(key)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isProviderIconKey("flask")).toBe(false);
    expect(isProviderIconKey("")).toBe(false);
    expect(isProviderIconKey(undefined)).toBe(false);
  });

  it("names the default as one of its own keys", () => {
    expect(isProviderIconKey(DEFAULT_PROVIDER_ICON_KEY)).toBe(true);
  });
});
