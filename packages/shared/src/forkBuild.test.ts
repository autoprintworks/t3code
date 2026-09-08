import { describe, expect, it } from "vite-plus/test";

import { resolveForkBuildIdentity } from "./forkBuild.ts";

describe("resolveForkBuildIdentity", () => {
  it.each(["0.0.32-ap.4", "1.2.3-ap.10", "0.0.32-ap.4+build.7"])(
    "recognizes the fork release tag in %s",
    (version) => {
      expect(resolveForkBuildIdentity(version)).toEqual({
        isFork: true,
        appBaseName: "T3 Code Fork",
        tagLabel: "FORK",
      });
    },
  );

  it.each(["0.0.32", "0.0.28-nightly.20260616.12", "0.0.32-ap", "0.0.32-apx.4", "", undefined, null])(
    "treats %s as an upstream build",
    (version) => {
      expect(resolveForkBuildIdentity(version)).toEqual({
        isFork: false,
        appBaseName: "T3 Code",
        tagLabel: null,
      });
    },
  );
});
