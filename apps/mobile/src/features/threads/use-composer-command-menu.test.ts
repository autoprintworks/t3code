import { describe, expect, it, vi } from "vite-plus/test";

// `../../state/queries` pulls in the connection runtime, and through it the
// Expo native modules, which the test transform cannot load. The hook under
// test only needs the skills query, so stub the module at its boundary.
vi.mock("../../state/queries", () => ({
  useComposerSkills: () => ({ skills: [] }),
}));

vi.mock("../../state/use-composer-path-search", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
}));

import { composerSelectionAtEnd } from "./use-composer-command-menu";

describe("composerSelectionAtEnd", () => {
  it("resets a changed draft owner to the new draft end", () => {
    expect(composerSelectionAtEnd("queued task 🧪")).toEqual({ start: 14, end: 14 });
  });
});
