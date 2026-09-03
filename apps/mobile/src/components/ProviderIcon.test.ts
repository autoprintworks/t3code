import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { PROVIDER_ICON_KEYS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

/**
 * `ProviderIcon.tsx` cannot be imported here: it pulls in `react-native`, whose
 * source is Flow and which this runner refuses to parse. The switch is read as
 * text instead, which is enough to answer the only question that matters -
 * whether a key a user can pick has artwork behind it on this client.
 */
const source = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("./ProviderIcon.tsx", import.meta.url)),
  "utf8",
);

describe("provider icon artwork", () => {
  it("draws every key the settings menu offers", () => {
    // A key the web client draws and this one does not is one instance with
    // two different faces, which is the bug the shared key list exists to stop.
    const missing = PROVIDER_ICON_KEYS.filter((key) => !source.includes(`case "${key}":`));
    expect(missing).toEqual([]);
  });

  it("falls back to nothing rather than to another vendor's mark", () => {
    expect(source).toContain("default: {");
    expect(source).toMatch(/default: \{[\s\S]*?return null;/);
  });
});
