import type { RepositoryIdentity } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as GitWorkDepth from "../vcs/GitWorkDepth.ts";

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    /**
     * The identity of the repository `cwd` belongs to, or `null` when it is not
     * in one. Served from cache for a workspace root already resolved in this
     * process, so a repeat asks `git` nothing.
     */
    readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
    /**
     * Drops the cached answer for `cwd`, so the next `resolve` spawns `git`
     * again. The reactor calls this when a project's workspace root changes.
     */
    readonly invalidate: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

/**
 * How many workspace roots keep a cached identity. A fleet opens one project
 * per isolated copy, so this is sized for far more projects than a user has,
 * and an entry is a handful of short strings.
 */
const REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

/**
 * Resolves a working directory to its repository root, or `null` when the
 * directory is not inside a repository. Callers fall back to the directory
 * itself.
 */
const resolveRepositoryRootPath = Effect.fn("RepositoryIdentityResolver.resolveRootPath")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const gitWorkDepth = yield* GitWorkDepth.GitWorkDepth;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(gitWorkDepth.withPermit, Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.code !== 0) {
      return null;
    }

    const candidate = topLevelResult.value.stdout.trim();
    return candidate.length > 0 ? candidate : null;
  },
);

const resolveRepositoryIdentityForRootPath = Effect.fn(
  "RepositoryIdentityResolver.resolveForRootPath",
)(function* (
  rootPath: string,
): Effect.fn.Return<
  RepositoryIdentity | null,
  never,
  ProcessRunner.ProcessRunner | GitWorkDepth.GitWorkDepth
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const gitWorkDepth = yield* GitWorkDepth.GitWorkDepth;
  const remoteResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", rootPath, "remote", "-v"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(gitWorkDepth.withPermit, Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
  return remote ? buildRepositoryIdentity({ ...remote, rootPath }) : null;
});

/**
 * Resolving spawns `git` twice, and on Windows creating a child process blocks
 * the Node event loop even through the asynchronous API. Only
 * `RepositoryIdentityReactor` may call this, off the request path; read paths
 * serve the identity recorded on the project row.
 *
 * Two bounds keep that cost flat as the number of open threads grows. Each
 * spawn takes a permit from the shared `GitWorkDepth` gate, so identity work
 * and git status work together never exceed the configured depth. And the
 * answer is cached per workspace root, so the fleet case - many projects
 * rooted in isolated copies, plus the start-up sweep - asks `git` once per
 * root rather than once per lookup.
 *
 * The cache is keyed on the workspace root string the caller passes, which is
 * the value stored on the project row, and it has no time-to-live: the only
 * thing that makes a stored answer wrong is the root changing, and the reactor
 * calls `invalidate` when it does.
 */
export const make = Effect.fn("RepositoryIdentityResolver.make")(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const gitWorkDepth = yield* GitWorkDepth.GitWorkDepth;

  const resolveUncached = Effect.fn("RepositoryIdentityResolver.resolveUncached")(
    function* (cwd: string) {
      const rootPath = yield* resolveRepositoryRootPath(cwd);
      return yield* resolveRepositoryIdentityForRootPath(rootPath ?? cwd);
    },
    Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
    Effect.provideService(GitWorkDepth.GitWorkDepth, gitWorkDepth),
  );

  const cache = yield* Cache.makeWith(resolveUncached, {
    capacity: REPOSITORY_IDENTITY_CACHE_CAPACITY,
  });

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fn(
    "RepositoryIdentityResolver.resolve",
  )(function* (cwd) {
    return yield* Cache.get(cache, cwd);
  });

  const invalidate: RepositoryIdentityResolver["Service"]["invalidate"] = (cwd) =>
    Cache.invalidate(cache, cwd);

  return RepositoryIdentityResolver.of({ resolve, invalidate });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(GitWorkDepth.layer),
);
