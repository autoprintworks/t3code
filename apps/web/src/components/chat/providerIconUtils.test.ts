import { ACP_AGENT_DRIVER_KIND, PROVIDER_ICON_KEYS, ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROVIDER_ICON_BY_ICON_KEY,
  PROVIDER_ICON_KEYS_WITHOUT_ARTWORK,
  providerInstanceIcon,
} from "./providerIconUtils";

describe("provider icon artwork", () => {
  it("has a glyph for every key the settings menu offers", () => {
    // A key a user can pick with nothing behind it is an instance that draws
    // no icon. The list is in the failure message so the gap names itself.
    expect(PROVIDER_ICON_KEYS_WITHOUT_ARTWORK).toEqual([]);
  });

  it("draws nothing extra", () => {
    expect(Object.keys(PROVIDER_ICON_BY_ICON_KEY).toSorted()).toEqual(
      [...PROVIDER_ICON_KEYS].toSorted(),
    );
  });
});

describe("providerInstanceIcon", () => {
  it("draws the key an instance asked for", () => {
    expect(providerInstanceIcon({ driverKind: ACP_AGENT_DRIVER_KIND, iconKey: "gemini" })).toBe(
      PROVIDER_ICON_BY_ICON_KEY.gemini,
    );
  });

  it("draws the ACP mark for a configured agent that named no key", () => {
    expect(providerInstanceIcon({ driverKind: ACP_AGENT_DRIVER_KIND })).toBe(
      PROVIDER_ICON_BY_ICON_KEY.acp,
    );
  });

  it("draws the built-in driver's own mark", () => {
    expect(providerInstanceIcon({ driverKind: ProviderDriverKind.make("codex") })).toBe(
      PROVIDER_ICON_BY_ICON_KEY.openai,
    );
  });

  it("draws nothing for a driver this build has never heard of", () => {
    expect(providerInstanceIcon({ driverKind: ProviderDriverKind.make("unheard-of") })).toBe(null);
  });
});
