import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { collectForkIconArtifacts } from "./generate-fork-icons.ts";

describe("generate-fork-icons", () => {
  // The fork's artwork is committed, so nothing at build time would notice if a
  // change to the generator, or a hand-edit of an asset, made the two disagree.
  it.effect(
    "produces the committed fork icons byte for byte",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
        const artifacts = yield* collectForkIconArtifacts();

        assert.isAbove(artifacts.length, 0);

        for (const artifact of artifacts) {
          const committed = Buffer.from(
            yield* fs.readFile(path.join(repoRoot, artifact.relativePath)),
          );

          assert.isTrue(
            committed.equals(artifact.contents),
            `${artifact.relativePath} does not match the generator. Run \`node scripts/generate-fork-icons.ts\` and commit the result.`,
          );
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    60_000,
  );
});
