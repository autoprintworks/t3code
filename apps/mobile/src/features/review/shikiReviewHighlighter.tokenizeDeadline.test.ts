import { expect, it, vi } from "vite-plus/test";

import { highlightSourceFile } from "./shikiReviewHighlighter";

const tokenization = vi.hoisted(() => ({
  timeLimits: [] as Array<number | undefined>,
}));

vi.mock("@shikijs/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shikijs/core")>();
  return {
    ...original,
    createHighlighterCore: async (...args: Parameters<typeof original.createHighlighterCore>) => {
      const highlighter = await original.createHighlighterCore(...args);
      return {
        ...highlighter,
        codeToTokensBase: (...input: Parameters<typeof highlighter.codeToTokensBase>) => {
          tokenization.timeLimits.push(input[1]?.tokenizeTimeLimit);
          return highlighter.codeToTokensBase(...input);
        },
      };
    },
  };
});

it("tokenizes without a wall-clock deadline", async () => {
  // Shiki's default 500ms per-line deadline stops the tokenizer mid-line on a busy
  // device and emits the rest of the line as one token wearing whatever scope was open.
  // The same file would then highlight differently depending on machine load, which is
  // what made the warmup test flaky. Long lines are bypassed before the tokenizer, so
  // the deadline buys nothing here.
  await highlightSourceFile({
    path: "example.ts",
    contents: "const answer: number = 42;",
    theme: "dark",
  });

  expect(tokenization.timeLimits.length).toBeGreaterThan(0);
  expect(tokenization.timeLimits.every((limit) => limit === 0)).toBe(true);
});
