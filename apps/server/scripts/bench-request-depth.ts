// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off globalFetch:off globalDate:off globalDateInEffect:off - Dev-only load harness: it drives a running server from the host shell and prints a report, so it uses Node and console APIs directly.
/**
 * Load harness for the "cut filesystem request depth" work.
 *
 * Drives a running T3 server with N git-backed projects and a churning set of
 * WebSocket clients that subscribe to VCS status and list refs, exactly the
 * shape the connection-drop diagnosis blamed for request-depth inflation.
 * While the load runs it probes `GET /api/orchestration/shell` once a second
 * and, at the end, counts git subprocess spawns from the server's own traces.
 *
 * Usage:
 *   node apps/server/scripts/bench-request-depth.ts
 *     --url http://127.0.0.1:14311 --token <pairing-token>
 *     --projects 40 --clients 6 --duration 180 --label before
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (token?.startsWith("--")) {
    const next = process.argv[index + 1];
    args.set(token.slice(2), next && !next.startsWith("--") ? next : "true");
  }
}
const arg = (name: string, fallback: string) => args.get(name) ?? fallback;

const BASE_URL = arg("url", "http://127.0.0.1:14311").replace(/\/$/, "");
const PAIRING_TOKEN = args.get("token");
const PROJECT_COUNT = Number(arg("projects", "40"));
const CLIENT_COUNT = Number(arg("clients", "6"));
const DURATION_SECONDS = Number(arg("duration", "180"));
const CONNECTION_LIFETIME_MS = Number(arg("connection-lifetime-ms", "30000"));
const LABEL = arg("label", "run");
const REPO_ROOT = NodePath.resolve(arg("repo-root", ".t3/bench-repos"));
const BRANCHES_PER_REPO = Number(arg("branches", "150"));
const TRACE_FILE = NodePath.resolve(arg("trace", ".t3/userdata/logs/server.trace.ndjson"));

if (!PAIRING_TOKEN) {
  console.error("--token <pairing-token> is required");
  process.exit(1);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// --- bench repositories -----------------------------------------------------
// Small trees with a realistic ref count: the diagnosis pinned cost on ref
// enumeration and repository identity probes, not on working-tree size.
const git = (cwd: string, ...gitArgs: readonly string[]) =>
  NodeChildProcess.execFileSync("git", [...gitArgs], { cwd, stdio: "pipe", encoding: "utf8" });

const ensureBenchRepos = (count: number) => {
  NodeFS.mkdirSync(REPO_ROOT, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const repoPath = NodePath.join(REPO_ROOT, `repo-${String(index).padStart(3, "0")}`);
    paths.push(repoPath);
    if (NodeFS.existsSync(NodePath.join(repoPath, ".git"))) continue;
    NodeFS.mkdirSync(repoPath, { recursive: true });
    git(repoPath, "init", "--quiet", "--initial-branch", "main");
    git(repoPath, "config", "user.email", "bench@example.invalid");
    git(repoPath, "config", "user.name", "bench");
    NodeFS.writeFileSync(NodePath.join(repoPath, "README.md"), `# repo ${index}\n`);
    git(repoPath, "add", ".");
    git(repoPath, "commit", "--quiet", "-m", "initial");
    const head = git(repoPath, "rev-parse", "HEAD").trim();
    // Write refs directly: 150 `git branch` spawns per repo would dwarf setup.
    const packed = [
      "# pack-refs with: peeled fully-peeled sorted ",
      `${head} refs/heads/main`,
      ...Array.from(
        { length: BRANCHES_PER_REPO },
        (_unused, branchIndex) => `${head} refs/heads/feature/branch-${branchIndex}`,
      ),
      ...Array.from(
        { length: BRANCHES_PER_REPO },
        (_unused, branchIndex) => `${head} refs/remotes/origin/feature/branch-${branchIndex}`,
      ),
      "",
    ].join("\n");
    NodeFS.writeFileSync(NodePath.join(repoPath, ".git", "packed-refs"), packed);
    // An uncommitted file keeps `status` off a trivially clean path.
    NodeFS.writeFileSync(NodePath.join(repoPath, "dirty.txt"), "pending\n");
  }
  return paths;
};

// --- auth -------------------------------------------------------------------
const exchangeToken = async () => {
  const body = new URLSearchParams({
    grant_type: AuthTokenExchangeGrantType,
    subject_token: PAIRING_TOKEN,
    subject_token_type: AuthEnvironmentBootstrapTokenType,
    requested_token_type: AuthAccessTokenType,
  });
  const response = await fetch(`${BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("token exchange returned no access_token");
  return payload.access_token;
};

// --- rpc client -------------------------------------------------------------
const wsUrl = `${BASE_URL.replace(/^http/, "ws")}/ws`;

const protocolLayer = (accessToken: string) =>
  RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Socket.layerWebSocket(wsUrl).pipe(
        Layer.provide(
          Layer.succeed(
            Socket.WebSocketConstructor,
            (socketUrl, protocols) =>
              new NodeSocket.NodeWS.WebSocket(socketUrl, protocols, {
                headers: { authorization: `Bearer ${accessToken}` },
              }) as unknown as globalThis.WebSocket,
          ),
        ),
      ),
    ),
    Layer.provide(RpcSerialization.layerJson),
  );

const makeClient = RpcClient.make(WsRpcGroup);
type WsClient = typeof makeClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withClient = <A, E, R>(
  accessToken: string,
  f: (client: WsClient) => Effect.Effect<A, E, R>,
) => makeClient.pipe(Effect.flatMap(f), Effect.provide(protocolLayer(accessToken)));

// --- load -------------------------------------------------------------------
/** Stable per-path id so re-running the harness reuses projects instead of piling up duplicates. */
const benchProjectId = (repoPath: string) => {
  const digest = NodeCrypto.createHash("sha256").update(repoPath).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    ((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join("-");
};

const seedProjects = (accessToken: string, repoPaths: readonly string[]) =>
  withClient(accessToken, (client) =>
    Effect.forEach(
      repoPaths,
      (repoPath, index) =>
        client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "project.create",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          projectId: ProjectId.make(benchProjectId(repoPath)),
          title: `bench-${index}`,
          workspaceRoot: repoPath,
          createdAt: new Date().toISOString(),
        }).pipe(Effect.ignore),
      { concurrency: 4, discard: true },
    ),
  );

/** One churning client: subscribe, list refs, hold, drop, reconnect. */
const runLoadClient = (
  accessToken: string,
  repoPaths: readonly string[],
  deadline: number,
  clientIndex: number,
) =>
  Effect.gen(function* () {
    while (Date.now() < deadline) {
      yield* withClient(accessToken, (client) =>
        Effect.gen(function* () {
          // Mirror a real client: hold the shell stream open and declare the
          // background scopes it depends on, so background pollers see demand.
          yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
            Stream.runDrain,
            Effect.ignore,
            Effect.forkScoped,
          );
          const reportActivity = client[WS_METHODS.serverReportClientActivity]({
            clientId: `bench-${clientIndex}`,
            clientKind: "desktop-renderer",
            visible: true,
            focused: true,
            recentlyInteracted: true,
            appState: "active",
            scopes: [
              { type: "server-config" },
              { type: "provider-status" },
              { type: "diagnostics" },
              ...repoPaths.flatMap((cwd) => [
                { type: "vcs-status" as const, cwd },
                { type: "git-refs" as const, cwd },
              ]),
            ],
            observedAt: DateTime.makeUnsafe(new Date().toISOString()),
          }).pipe(Effect.ignoreCause({ log: true }));
          yield* reportActivity;
          yield* reportActivity.pipe(Effect.delay("15 seconds"), Effect.forever, Effect.forkScoped);
          yield* Effect.forEach(
            repoPaths,
            (cwd) =>
              client[WS_METHODS.subscribeVcsStatus]({ cwd }).pipe(
                Stream.runDrain,
                Effect.ignore,
                Effect.forkScoped,
              ),
            { concurrency: "unbounded", discard: true },
          );
          yield* Effect.forEach(
            repoPaths,
            (cwd) =>
              client[WS_METHODS.vcsListRefs]({ cwd, limit: 50, refKind: "all" }).pipe(
                Effect.ignore,
              ),
            { concurrency: "unbounded", discard: true },
          );
          yield* Effect.sleep(Math.min(CONNECTION_LIFETIME_MS, Math.max(0, deadline - Date.now())));
        }),
      ).pipe(Effect.scoped, Effect.ignore);
    }
  });

// --- measurement ------------------------------------------------------------
const probeShell = async (accessToken: string, deadline: number) => {
  const samples: number[] = [];
  const failures: string[] = [];
  while (Date.now() < deadline) {
    const startedAt = performance.now();
    try {
      const response = await fetch(`${BASE_URL}/api/orchestration/shell`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      await response.arrayBuffer();
      const elapsed = performance.now() - startedAt;
      if (response.ok) samples.push(elapsed);
      else failures.push(`${response.status} after ${Math.round(elapsed)}ms`);
    } catch (error) {
      failures.push(`${String(error)} after ${Math.round(performance.now() - startedAt)}ms`);
    }
    await sleep(1000);
  }
  return { samples, failures };
};

const quantile = (sorted: readonly number[], q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;

const readTraceWindow = (windowStartMs: number, windowEndMs: number) => {
  const counts = new Map<string, number>();
  const directory = NodePath.dirname(TRACE_FILE);
  const base = NodePath.basename(TRACE_FILE);
  const files = NodeFS.existsSync(directory)
    ? NodeFS.readdirSync(directory)
        .filter((name) => name === base || name.startsWith(`${base}.`))
        .map((name) => NodePath.join(directory, name))
    : [];
  let traceBytesInWindow = 0;
  let traceRecordsInWindow = 0;
  for (const file of files) {
    for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
      if (line.length === 0) continue;
      let record: { name?: string; startTimeUnixNano?: string };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const startedAtMs = Number(BigInt(record.startTimeUnixNano ?? "0") / 1_000_000n);
      if (startedAtMs < windowStartMs || startedAtMs > windowEndMs) continue;
      traceRecordsInWindow += 1;
      traceBytesInWindow += line.length + 1;
      const name = record.name ?? "<unnamed>";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return { counts, traceBytesInWindow, traceRecordsInWindow };
};

// --- main -------------------------------------------------------------------
const main = async () => {
  console.log(`[bench:${LABEL}] preparing ${PROJECT_COUNT} bench repositories under ${REPO_ROOT}`);
  const repoPaths = ensureBenchRepos(PROJECT_COUNT);
  const accessToken = await exchangeToken();
  console.log(`[bench:${LABEL}] seeding projects`);
  await Effect.runPromise(seedProjects(accessToken, repoPaths).pipe(Effect.scoped, Effect.ignore));

  const startedAtMs = Date.now();
  const deadline = startedAtMs + DURATION_SECONDS * 1000;
  console.log(
    `[bench:${LABEL}] running ${CLIENT_COUNT} churning clients for ${DURATION_SECONDS}s ` +
      `(connection lifetime ${CONNECTION_LIFETIME_MS}ms)`,
  );

  const loadFiber = Effect.runFork(
    Effect.forEach(
      Array.from({ length: CLIENT_COUNT }, (_unused, index) => index),
      (clientIndex) => runLoadClient(accessToken, repoPaths, deadline, clientIndex),
      { concurrency: "unbounded", discard: true },
    ).pipe(
      Effect.scoped,
      Effect.catchCause((cause) => Effect.logError(Cause.pretty(cause))),
    ),
  );

  const { samples, failures } = await probeShell(accessToken, deadline);
  await Effect.runPromise(Fiber.interrupt(loadFiber).pipe(Effect.ignore));

  // Traces are batched; give the sink a moment to flush the tail of the window.
  await sleep(2000);
  const finishedAtMs = Date.now();
  const { counts, traceBytesInWindow, traceRecordsInWindow } = readTraceWindow(
    startedAtMs,
    finishedAtMs,
  );
  const minutes = (finishedAtMs - startedAtMs) / 60_000;

  const sorted = [...samples].sort((left, right) => left - right);
  const round = (value: number) => Math.round(value);
  console.log("");
  console.log(`=== bench:${LABEL} ===`);
  console.log(
    `window                 ${new Date(startedAtMs).toISOString()} .. ${new Date(finishedAtMs).toISOString()}`,
  );
  console.log(`projects / clients     ${PROJECT_COUNT} / ${CLIENT_COUNT}`);
  console.log(`shell samples          n=${sorted.length} failures=${failures.length}`);
  console.log(
    `shell latency (ms)     p50=${round(quantile(sorted, 0.5))} p90=${round(quantile(sorted, 0.9))} ` +
      `p99=${round(quantile(sorted, 0.99))} worst=${round(sorted.at(-1) ?? 0)}`,
  );
  if (failures.length > 0) {
    console.log(`shell failures         ${failures.slice(0, 5).join(" | ")}`);
  }
  const spawnCount = counts.get("processRunner.runProcessCore") ?? 0;
  console.log(
    `git spawns             n=${spawnCount} rate=${(spawnCount / minutes).toFixed(1)}/min`,
  );
  for (const name of [
    "ws.rpc.vcs.listRefs",
    "VcsProcess.run",
    "GitWorkflowService.detectGitRepositoryForCommand",
    "checkGrokProviderStatus",
    "checkClaudeProviderStatus",
  ]) {
    console.log(`  ${name.padEnd(48)} n=${counts.get(name) ?? 0}`);
  }
  console.log(
    `trace volume           ${(traceBytesInWindow / 1024 / 1024).toFixed(2)} MiB / ${minutes.toFixed(1)} min ` +
      `= ${(traceBytesInWindow / 1024 / 1024 / (minutes / 60)).toFixed(0)} MiB/hour (${traceRecordsInWindow} spans)`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
