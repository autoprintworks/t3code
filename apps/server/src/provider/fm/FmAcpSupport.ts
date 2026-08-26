/**
 * FORK DELTA (fm provider) - spawn contract for the First Mate ACP door.
 *
 * The door is `fm-acp`, a Rust binary in the First Mate repository. It speaks
 * ACP over stdio and serves exactly one First Mate home:
 *
 * ```
 * Usage:
 *   fm-acp [--home <dir>]
 *       --home <dir>    which First Mate home to serve
 *                       (default: FM_V2_HOME, else ~/.firstmate/v2)
 * ```
 *
 * One provider connection is one door process is one home, so a second mate is
 * simply a second provider instance whose `homePath` points somewhere else.
 * Nothing in here is shared with the Grok `binaryPath` masquerade in
 * `../acp/GrokAcpSupport.ts`; the only shared code is `AcpSessionRuntime`,
 * which is the host's generic ACP plumbing.
 *
 * @module provider/fm/FmAcpSupport
 */
import type { FmSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";

/** The door publishes no auth methods, and answers `authenticate` with `{}`. */
export const FM_AUTH_METHOD_ID = "none";

/** Model the door falls back to when the home has never chosen one. */
export const FM_FALLBACK_MODEL_ID = "claude";

/**
 * ID-10 host invariants, stated once so the certification suite can assert
 * them against the same constant the runtime uses.
 *
 * The door never reads or writes files on the host's behalf and never opens a
 * terminal; the supervisor conversation is text in, text out. Advertising
 * either capability would invite a future door revision to use it.
 */
export const FM_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const satisfies EffectAcpSchema.InitializeRequest["clientCapabilities"];

/** The door hosts no MCP servers, so the list is always empty. */
export const FM_MCP_SERVERS: ReadonlyArray<EffectAcpSchema.McpServer> = [];

type FmAcpSpawnSettings = Pick<FmSettings, "binaryPath" | "homePath">;

export function buildFmAcpSpawnInput(
  fmSettings: FmAcpSpawnSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const homePath = fmSettings?.homePath?.trim();
  return {
    command: fmSettings?.binaryPath || "fm-acp",
    // Omitting `--home` is meaningful: the door then resolves FM_V2_HOME, and
    // failing that `~/.firstmate/v2`, which is what a single-home install wants.
    args: homePath ? ["--home", homePath] : [],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

interface FmAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "mcpServers" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fmSettings: FmAcpSpawnSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeFmAcpRuntime = (
  input: FmAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildFmAcpSpawnInput(input.fmSettings, input.cwd, input.environment),
        clientCapabilities: FM_CLIENT_CAPABILITIES,
        mcpServers: FM_MCP_SERVERS,
        authMethodId: FM_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Model ids are opaque strings owned by the door's menu (`claude`, `opencode`,
 * `pi`, ...), so they are only trimmed - never expanded through T3 Code's
 * per-provider alias table, which knows nothing about First Mate.
 */
export function resolveFmModelId(model: string | null | undefined): string {
  return model?.trim() || FM_FALLBACK_MODEL_ID;
}

export function currentFmModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}
