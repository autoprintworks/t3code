/**
 * A fake ACP agent built from one of the golden transcripts in
 * `fixtures/acp-transcript/`.
 *
 * Each fixture records what a client sends and what an agent answers, so
 * replaying the recorded `agent` array through the real `AcpAgentAdapter` is
 * what certifies this driver against a fixed reading of the protocol rather
 * than against a mock somebody wrote to agree with it. `README.md` in that
 * directory says how a fixture is put together.
 *
 * The fake serves the recording over a `ChildProcessSpawner` stub instead of a
 * real subprocess. The spawn itself is the only thing that costs: everything
 * above it - ndjson framing, `AcpJsonRpcConnection`, `AcpSessionRuntime`,
 * `AcpAgentAdapter` - is the shipping code path. `buildAcpAgentSpawnInput` is
 * covered separately in `AcpAgentSupport.test.ts`, so the argv the driver
 * would hand the operating system is asserted too.
 *
 * Two properties of a real agent are reproduced deliberately, because they are
 * what the driver has to be correct about:
 *
 * 1. **Requests are answered one at a time.** A recorded answer is handed out
 *    in the order the transcript recorded it, per method.
 * 2. **Cancel jumps the queue.** An agent reads stdin independently of the
 *    turn it is working on, which is why a prompt can be stopped while it is
 *    still waiting. A fixture that sets `awaits_interrupt` withholds the
 *    prompt answer here until a real `session/cancel` line arrives, so a
 *    cancel test cannot pass by racing a prompt that had already finished.
 *
 * Test-only. Nothing outside `*.test.ts` imports this module.
 *
 * @module provider/acpAgent/AcpAgentTranscriptAgent
 */
// @effect-diagnostics nodeBuiltinImport:off
// The fixtures are raw ndjson JSON-RPC. Decoding one through a schema would
// assert this file's idea of the wire instead of the recorded bytes.
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const FIXTURE_DIR = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "fixtures",
  "acp-transcript",
);

export type JsonRecord = Record<string, unknown>;

/**
 * The fixture shape. `why` says what breaks in the world if the recording
 * stops matching, and is what a person reads when the transcript fails.
 */
export interface AcpTranscriptFixture {
  readonly why: string;
  readonly session: string;
  /** Withholds the `session/prompt` answer until a real cancel arrives. */
  readonly awaits_interrupt?: boolean;
  readonly host: ReadonlyArray<unknown>;
  readonly agent: ReadonlyArray<unknown>;
}

export function listTranscriptFixtureNames(): ReadonlyArray<string> {
  return NodeFS.readdirSync(FIXTURE_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.slice(0, -".json".length))
    .sort();
}

export function readTranscriptFixture(name: string): AcpTranscriptFixture {
  const raw = NodeFS.readFileSync(NodePath.join(FIXTURE_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw) as AcpTranscriptFixture;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A request or notification the fixture says a host sends. */
export interface FixtureHostMessage {
  readonly id: number | undefined;
  readonly method: string;
  readonly params: JsonRecord | undefined;
}

export function fixtureHostMessages(
  fixture: AcpTranscriptFixture,
): ReadonlyArray<FixtureHostMessage> {
  const messages: Array<FixtureHostMessage> = [];
  for (const entry of fixture.host) {
    if (!isRecord(entry) || typeof entry.method !== "string") {
      continue;
    }
    messages.push({
      id: typeof entry.id === "number" ? entry.id : undefined,
      method: entry.method,
      params: isRecord(entry.params) ? entry.params : undefined,
    });
  }
  return messages;
}

/**
 * A copy of the fixture keeping only the recorded exchanges whose request ids
 * are listed.
 *
 * `protocol-refusals` is ten probes down one connection, and several of them
 * are things this driver refuses locally and therefore never puts on the wire.
 * Replaying the file whole would hand our `initialize` the answer recorded for
 * a host that asked for protocol version 0. Narrowing states exactly which
 * exchanges are being driven instead of quietly reordering the rest.
 */
export function narrowTranscriptFixture(
  fixture: AcpTranscriptFixture,
  keepIds: ReadonlyArray<number>,
): AcpTranscriptFixture {
  const keep = new Set(keepIds);
  const keeps = (entry: unknown): boolean =>
    isRecord(entry) && typeof entry.id === "number" && keep.has(entry.id);
  return {
    ...fixture,
    host: fixture.host.filter(keeps),
    agent: fixture.agent.filter(
      (entry) => keeps(entry) || (isRecord(entry) && typeof entry.method === "string"),
    ),
  };
}

interface PlannedAnswer {
  readonly method: string;
  readonly notificationsBefore: ReadonlyArray<JsonRecord>;
  readonly body: { readonly result: unknown } | { readonly error: unknown };
  consumed: boolean;
}

/**
 * Joins the recorded `agent` array back onto the `host` array by request id,
 * so each answer is keyed by the method that earned it. Notifications keep
 * their recorded position: they are emitted immediately before the answer
 * they preceded, which is what makes streamed chunks arrive before the stop
 * reason and `session/load` replay arrive before the load result.
 */
function planAnswers(fixture: AcpTranscriptFixture): ReadonlyArray<PlannedAnswer> {
  const hostById = new Map<number, FixtureHostMessage>();
  for (const message of fixtureHostMessages(fixture)) {
    if (message.id !== undefined) {
      hostById.set(message.id, message);
    }
  }

  const planned: Array<PlannedAnswer> = [];
  let pending: Array<JsonRecord> = [];
  for (const entry of fixture.agent) {
    if (!isRecord(entry)) {
      continue;
    }
    if (typeof entry.method === "string") {
      pending.push(entry);
      continue;
    }
    const hasResult = "result" in entry;
    const hasError = "error" in entry;
    if (!hasResult && !hasError) {
      continue;
    }
    const host = typeof entry.id === "number" ? hostById.get(entry.id) : undefined;
    if (host === undefined) {
      // An answer with no host line, such as the `id: null` parse error. The
      // driver cannot provoke it, so there is nothing to hand out.
      pending = [];
      continue;
    }
    planned.push({
      method: host.method,
      notificationsBefore: pending,
      body: hasResult ? { result: entry.result } : { error: entry.error },
      consumed: false,
    });
    pending = [];
  }
  return planned;
}

export interface TranscriptConnection {
  /** Every JSON-RPC message the driver wrote to the agent's stdin, in order. */
  readonly observed: ReadonlyArray<JsonRecord>;
  /** The command the driver asked the operating system to run. */
  readonly command: ChildProcess.StandardCommand;
}

export interface TranscriptAgent {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /**
   * ACP connections, in spawn order. Every spawn is one: this driver runs the
   * configured command for nothing but ACP, so an empty list is proof that
   * nothing was launched.
   */
  readonly connections: ReadonlyArray<TranscriptConnection>;
  /** Methods written across every ACP connection, `authenticate` excluded. */
  readonly observedMethods: () => ReadonlyArray<string>;
  /**
   * Kills the most recent agent the way a crash does: the process exits with a
   * code nobody asked for, and its stdout ends where it stood. Answers `false`
   * when no ACP connection is open.
   */
  readonly crash: (exitCode?: number) => Effect.Effect<boolean>;
}

export interface TranscriptAgentOptions {
  /**
   * Methods the agent reads and then says nothing about, forever.
   *
   * The worst failure of a JSON-RPC peer is not an error, which is an answer;
   * it is a peer that accepts the connection, accepts the request, and never
   * replies. Nothing times that out except the caller, so this is how a test
   * puts a caller's own bound under load.
   */
  readonly silentMethods?: ReadonlyArray<string>;
}

const encoder = new TextEncoder();

/**
 * Builds a `ChildProcessSpawner` that answers every ACP connection from the
 * fixture. State is per spawn, so a driver that stops a session and starts a
 * new one gets a fresh agent, exactly as it would in production.
 */
export const makeTranscriptAgent = (
  fixture: AcpTranscriptFixture,
  options?: TranscriptAgentOptions,
): Effect.Effect<TranscriptAgent> =>
  Effect.sync(() => {
    const connections: Array<{
      observed: Array<JsonRecord>;
      command: ChildProcess.StandardCommand;
    }> = [];
    const crashHooks: Array<(exitCode: number) => Effect.Effect<void>> = [];

    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) {
          return yield* Effect.die(
            new Error("The transcript agent only serves standard commands."),
          );
        }

        const observed: Array<JsonRecord> = [];
        connections.push({ observed, command });

        const outbound = yield* Queue.unbounded<Uint8Array, Cause.Done>();
        const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const planned = planAnswers(fixture).map((answer) => ({ ...answer }));
        const awaitsInterrupt = fixture.awaits_interrupt === true;

        const silentMethods = new Set(options?.silentMethods ?? []);
        let cancelSeen = false;
        let heldPrompt: { readonly answer: PlannedAnswer; readonly id: unknown } | undefined;
        let stdinBuffer = "";

        const write = (message: JsonRecord) =>
          Queue.offer(outbound, encoder.encode(`${JSON.stringify(message)}\n`)).pipe(Effect.asVoid);

        const take = (method: string): PlannedAnswer | undefined => {
          const answer = planned.find((entry) => !entry.consumed && entry.method === method);
          if (answer) {
            answer.consumed = true;
          }
          return answer;
        };

        const emit = (answer: PlannedAnswer, id: unknown) =>
          Effect.gen(function* () {
            for (const notification of answer.notificationsBefore) {
              yield* write(notification);
            }
            yield* write({ jsonrpc: "2.0", id, ...answer.body });
          });

        const onMessage = (message: JsonRecord) =>
          Effect.gen(function* () {
            observed.push(message);
            const method = typeof message.method === "string" ? message.method : undefined;
            if (method === undefined) {
              return;
            }
            const id = message.id;

            if (method === "session/cancel") {
              // A real agent reads stdin ahead of the turn it is working on:
              // the switch flips in wire order, before anything queued behind
              // it.
              cancelSeen = true;
              const held = heldPrompt;
              heldPrompt = undefined;
              if (held !== undefined) {
                yield* emit(held.answer, held.id);
              }
              const ack = take("session/cancel");
              // The fixture may record a cancel sent as a request. This driver
              // sends the notification ACP specifies, and a notification takes
              // no reply, so the recorded acknowledgement is consumed and not
              // written back.
              if (ack !== undefined && id !== undefined) {
                yield* emit(ack, id);
              }
              return;
            }

            if (method === "authenticate") {
              // No fixture records `authenticate`. An agent with no auth
              // methods answers `{}` to any client that sends one, which is
              // what this line reproduces.
              yield* write({ jsonrpc: "2.0", id, result: {} });
              return;
            }

            if (silentMethods.has(method)) {
              // Read, recorded in `observed`, and never answered.
              return;
            }

            const answer = take(method);
            if (answer === undefined) {
              yield* write({
                jsonrpc: "2.0",
                id,
                error: {
                  code: -32601,
                  message: `the transcript records no answer for ${method}`,
                },
              });
              return;
            }

            if (method === "session/prompt" && awaitsInterrupt && !cancelSeen) {
              // What the agent had already said goes out now, because that
              // is when it said it: the interrupt has not arrived yet.
              // Only the terminal answer waits for it.
              for (const notification of answer.notificationsBefore) {
                yield* write(notification);
              }
              heldPrompt = { answer: { ...answer, notificationsBefore: [] }, id };
              return;
            }
            yield* emit(answer, id);
          });

        const onStdin = (chunk: Uint8Array) =>
          Effect.gen(function* () {
            stdinBuffer += new TextDecoder().decode(chunk);
            let newline = stdinBuffer.indexOf("\n");
            while (newline >= 0) {
              const line = stdinBuffer.slice(0, newline).trim();
              stdinBuffer = stdinBuffer.slice(newline + 1);
              if (line.length > 0) {
                const parsed: unknown = JSON.parse(line);
                if (isRecord(parsed)) {
                  yield* onMessage(parsed);
                }
              }
              newline = stdinBuffer.indexOf("\n");
            }
          });

        crashHooks.push((code) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(code));
            yield* Queue.end(outbound);
          }).pipe(Effect.asVoid),
        );

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Deferred.await(exited),
          isRunning: Effect.map(Deferred.isDone(exited), (done) => !done),
          kill: () =>
            Effect.gen(function* () {
              yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
              yield* Queue.end(outbound);
            }).pipe(Effect.asVoid),
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(onStdin),
          stdout: Stream.fromQueue(outbound),
          stderr: Stream.empty,
          all: Stream.fromQueue(outbound),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );

    return {
      spawner,
      connections,
      observedMethods: () =>
        connections.flatMap((connection) =>
          connection.observed
            .map((message) => (typeof message.method === "string" ? message.method : undefined))
            .filter(
              (method): method is string => method !== undefined && method !== "authenticate",
            ),
        ),
      crash: (exitCode = 137) => {
        const hook = crashHooks.at(-1);
        return hook === undefined ? Effect.succeed(false) : Effect.as(hook(exitCode), true);
      },
    } satisfies TranscriptAgent;
  });

/**
 * Finds the message the driver wrote for `method`, so a test can assert on the
 * params the fixture pins rather than on the whole envelope.
 */
export function observedMessage(
  transcript: TranscriptAgent,
  method: string,
  occurrence = 0,
): JsonRecord | undefined {
  const matches = transcript.connections
    .flatMap((connection) => connection.observed)
    .filter((message) => message.method === method);
  return matches[occurrence];
}

export function observedParams(
  transcript: TranscriptAgent,
  method: string,
  occurrence = 0,
): JsonRecord | undefined {
  const message = observedMessage(transcript, method, occurrence);
  return message !== undefined && isRecord(message.params) ? message.params : undefined;
}

/**
 * Collects runtime events as they are published and lets a test wait for one
 * without polling.
 *
 * The shipping code offers no wire barrier between `turn.started` and the
 * first streamed chunk, and a cancel test that fires before the prompt is
 * really in flight proves nothing. Subscribing here and waiting for the chunk
 * is what makes "the prompt is still running" a fact rather than a hope.
 */
export const watchProviderEvents = (adapter: {
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}) =>
  Effect.gen(function* () {
    const seen: Array<ProviderRuntimeEvent> = [];
    const waiters: Array<{
      readonly match: (event: ProviderRuntimeEvent) => boolean;
      readonly deferred: Deferred.Deferred<ProviderRuntimeEvent>;
    }> = [];

    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        seen.push(event);
        // Taken before anything is removed: each match is spliced out of
        // `waiters` as it is settled, and a live splice would skip the next.
        const matched = waiters.filter((waiter) => waiter.match(event));
        for (const waiter of matched) {
          waiters.splice(waiters.indexOf(waiter), 1);
          yield* Deferred.succeed(waiter.deferred, event);
        }
      }),
    ).pipe(Effect.forkChild);

    const awaitEvent = (match: (event: ProviderRuntimeEvent) => boolean) =>
      Effect.gen(function* () {
        const existing = seen.find(match);
        if (existing !== undefined) {
          return existing;
        }
        const deferred = yield* Deferred.make<ProviderRuntimeEvent>();
        waiters.push({ match, deferred });
        return yield* Deferred.await(deferred);
      });

    return {
      seen,
      awaitEvent,
      awaitType: (type: ProviderRuntimeEvent["type"]) => awaitEvent((event) => event.type === type),
      stop: Fiber.interrupt(fiber),
      types: () => seen.map((event) => event.type),
      assistantText: () =>
        seen
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
          .join(""),
    };
  });

type EffectSuccess<T> = [T] extends [Effect.Effect<infer A, infer _E, infer _R>] ? A : never;

export type ProviderEventWatch = EffectSuccess<ReturnType<typeof watchProviderEvents>>;
