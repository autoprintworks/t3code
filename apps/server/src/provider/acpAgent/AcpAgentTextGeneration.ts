/**
 * Text generation is refused for an external ACP agent, on purpose.
 *
 * The other drivers write commit messages and thread titles by running their
 * agent's CLI once in a throwaway process. ACP has no such side channel: the
 * only way to ask an ACP agent anything is `session/prompt`, which goes into a
 * real session, appears in the user's own history, and queues behind the turn
 * they are waiting on. T3 Code also has no idea what the configured agent
 * charges for a prompt.
 *
 * So these operations fail with a message that names the alternative, rather
 * than looking unsupported by accident. Nothing is lost by it: this driver has
 * no entry in `ServerSettings.providers`, so the text generation fallback never
 * reaches for it either, and any other enabled provider does the work.
 *
 * @module provider/acpAgent/AcpAgentTextGeneration
 */
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { TextGeneration } from "../../textGeneration/TextGeneration.ts";

const DETAIL =
  "An external ACP agent only answers inside a real session, so T3 Code will not prompt it for generated text. Pick another provider for generated text in Settings.";

const refuse = <A>(operation: string): Effect.Effect<A, TextGenerationError> =>
  Effect.fail(new TextGenerationError({ operation, detail: DETAIL }));

export const makeAcpAgentTextGeneration = (): Effect.Effect<TextGeneration["Service"]> =>
  Effect.succeed(
    TextGeneration.of({
      generateCommitMessage: () => refuse("generateCommitMessage"),
      generatePrContent: () => refuse("generatePrContent"),
      generateBranchName: () => refuse("generateBranchName"),
      generateThreadTitle: () => refuse("generateThreadTitle"),
    }),
  );
