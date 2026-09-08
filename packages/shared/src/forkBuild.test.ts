import { describe, expect, it } from "vite-plus/test";

import { FORK_APP_ID, resolveForkBuildIdentity } from "./forkBuild.ts";

describe("resolveForkBuildIdentity", () => {
  it("names every build this repository makes after the fork", () => {
    expect(resolveForkBuildIdentity()).toEqual({
      appId: FORK_APP_ID,
      appBaseName: "T3 Code Fork",
      tagLabel: "FORK",
    });
  });

  it("keeps the fork name out of upstream's namespace", () => {
    // A build that answered to upstream's app id would collide with an official
    // install: same taskbar grouping, same protocol registration.
    expect(FORK_APP_ID).toBe("com.autoprintworks.t3code");
    expect(resolveForkBuildIdentity().appBaseName).not.toBe("T3 Code");
  });
});
