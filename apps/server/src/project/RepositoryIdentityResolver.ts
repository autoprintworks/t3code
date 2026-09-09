import type { RepositoryIdentity } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProcessRunner from "../processRunner.ts";
import * as GitWorkDepth from "../vcs/GitWorkDepth.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

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

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
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

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: string,
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
      args: ["-C", cacheKey, "remote", "-v"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(gitWorkDepth.withPermit, Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
  return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey }) : null;
});

/**
 * Resolving spawns `git` twice, and on Windows creating a child process blocks
 * the Node event loop even through the asynchronous API. Only
 * `RepositoryIdentityReactor` may call this, off the request path; read paths
 * serve the identity recorded on the project row.
 *
 * Each spawn takes a permit from the shared `GitWorkDepth` gate, so identity
 * work and git status work together never exceed the configured depth.
 */
export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const gitWorkDepth = yield* GitWorkDepth.GitWorkDepth;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;

  const repositoryRootCache = yield* Cache.makeWith<string, string | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(GitWorkDepth.GitWorkDepth, gitWorkDepth),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null ? Duration.zero : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(GitWorkDepth.GitWorkDepth, gitWorkDepth),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null
            ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
            : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fn(
    "RepositoryIdentityResolver.resolve",
  )(function* (cwd) {
    const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
    if (cacheKey === null) return null;
    return yield* Cache.get(repositoryIdentityCache, cacheKey);
  });

  // Re-saving a folder is the user's manual refresh, so it must reach `git`
  // again for both questions the resolve asks. Dropping the root entry alone
  // would still serve the remote from the identity cache, so drop the identity
  // entry for the root that is cached now, then the root entry itself.
  const invalidate: RepositoryIdentityResolver["Service"]["invalidate"] = Effect.fn(
    "RepositoryIdentityResolver.invalidate",
  )(function* (cwd) {
    const cacheKey = yield* Cache.getOption(repositoryRootCache, cwd);
    if (Option.isSome(cacheKey) && cacheKey.value !== null) {
      yield* Cache.invalidate(repositoryIdentityCache, cacheKey.value);
    }
    yield* Cache.invalidate(repositoryRootCache, cwd);
  });

  return RepositoryIdentityResolver.of({ resolve, invalidate });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(GitWorkDepth.layer),
);
