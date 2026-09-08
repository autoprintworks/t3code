import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  AuthFleetSubject,
  type WireOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  type OrchestrationCommandIssuer,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

/**
 * Who a dispatch entry point may treat as the fleet.
 *
 * The subject of the authenticated session and nothing else. An entry point
 * never reads this off a payload, because a payload is exactly what an
 * ordinary client controls.
 */
export const commandIssuerForSubject = (subject: string): OrchestrationCommandIssuer =>
  subject === AuthFleetSubject ? "fleet" : "client";

/**
 * Refuse what only the fleet may say.
 *
 * Loud rather than quiet on purpose. Silently dropping `readOnly` would hand
 * a caller that believed it was the fleet an ordinary promptable thread and
 * no way to tell, which is the failure mode hardest to notice: everything
 * works, and the thread the user was never meant to steer is steerable.
 */
const refuseFleetOnlyField = (field: string) =>
  new OrchestrationDispatchCommandError({
    message: `'${field}' may only be set by the fleet; this session is not the fleet.`,
  });

export const canonicalizeClientCommandTimestamps = (
  command: WireOrchestrationCommand,
  receivedAt: IsoDateTime,
): WireOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

export const normalizeDispatchCommand = (
  command: WireOrchestrationCommand,
  issuer: OrchestrationCommandIssuer,
) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type === "thread.create") {
      if (issuer !== "fleet") {
        if (canonicalCommand.readOnly !== undefined) {
          return yield* refuseFleetOnlyField("readOnly");
        }
        return canonicalCommand satisfies OrchestrationCommand;
      }
      // The stamp is what the decider turns into `fleetOwned` on the thread,
      // and `fleetOwned` is what lets the fleet prompt this thread later and
      // no other read-only one.
      return { ...canonicalCommand, issuer } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    // Create-and-start carries a create inside a turn, so it carries the same
    // fleet-only field and answers to the same rule.
    if (issuer !== "fleet" && canonicalCommand.bootstrap?.createThread?.readOnly !== undefined) {
      return yield* refuseFleetOnlyField("bootstrap.createThread.readOnly");
    }

    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    const turnStart = {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        attachments: normalizedAttachments,
      },
    };

    // Stamped here and nowhere else. The decider reads it alongside the
    // thread's `fleetOwned`; see `requireThreadPromptable`.
    return (
      issuer === "fleet" ? { ...turnStart, issuer } : turnStart
    ) satisfies OrchestrationCommand;
  });
