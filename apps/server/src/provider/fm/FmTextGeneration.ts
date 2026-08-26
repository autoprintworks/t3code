/**
 * FORK DELTA (fm provider) - text generation is deliberately refused.
 *
 * Every other driver writes commit messages and thread titles by prompting its
 * own agent, which is cheap because that agent is stateless. The First Mate
 * door is not: one provider connection is one home's supervisor conversation,
 * and `session/prompt` is what allocates it. Asking the first mate to name a
 * branch would put "write me a commit message" into the user's real supervisor
 * history, and would count against the same single-prompt-at-a-time queue the
 * user's actual turn is waiting in.
 *
 * So `fm` fails these operations with a message that names the alternative,
 * rather than pretending they are unsupported by accident.
 *
 * @module provider/fm/FmTextGeneration
 */
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { TextGeneration } from "../../textGeneration/TextGeneration.ts";

const DETAIL =
  "First Mate provides a home's supervisor conversation, not a scratch model. Pick another provider for generated text in Settings.";

const refuse = <A>(operation: string): Effect.Effect<A, TextGenerationError> =>
  Effect.fail(new TextGenerationError({ operation, detail: DETAIL }));

export const makeFmTextGeneration = (): Effect.Effect<TextGeneration["Service"]> =>
  Effect.succeed(
    TextGeneration.of({
      generateCommitMessage: () => refuse("generateCommitMessage"),
      generatePrContent: () => refuse("generatePrContent"),
      generateBranchName: () => refuse("generateBranchName"),
      generateThreadTitle: () => refuse("generateThreadTitle"),
    }),
  );
