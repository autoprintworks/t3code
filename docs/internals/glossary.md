# Glossary

> For maintainers. Using T3 Code? See [docs/user](../user/).

This is a living glossary for T3 Code. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Checkpointing](#checkpointing)
- [Connections](#connections)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Six drivers ship built in: Codex, Claude, Cursor, Grok, OpenCode, and `acpAgent`. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### External ACP agent

An agent the user configures rather than one this build implements. The `acpAgent` driver reads the command, arguments, working directory, icon and environment from the instance's settings and drives whatever they name through the shared ACP runtime. Several instances can be configured, each a separate agent. See [the user guide][28] and [providers.md][16].

#### Golden transcript

One recorded ACP connection, written from the protocol rather than captured from any one agent. The recording is replayed at the real adapter through a spawner stub, so what is certified is the driver against a fixed reading of ACP. They live in [`fixtures/acp-transcript/`][29] and are driven by `AcpAgentTranscript.test.ts`.

#### Peer session

A session on an ACP connection that this client did not open. ACP allows more than one session per connection, and `session/list` is how a client learns about the others; the protocol has no notification for one appearing, so the runtime polls. The poll is gated on a subscriber, bounded by a timeout, and its answer is diffed rather than replayed. See [AcpPeerSessions.ts][30] and [worker threads][31].

#### Worker thread

A read-only thread mirroring one peer session on a configured ACP agent's connection: work the agent started that this client did not, shown in T3 Code so a user can watch it. It is named after the agent's own session and the peer session, so two threads on one agent share one worker thread rather than duplicating it. See [AcpAgentWorkerSessions.ts][32] and [worker threads][31].

#### Read-only thread

A thread whose transcript is a window onto work driven elsewhere. `readOnly` is set once at creation, never cleared, and enforced in [the decider][8] by `requireThreadPromptable` in [commandInvariants.ts][9], which refuses `thread.turn.start` and `thread.checkpoint.revert`. The clients hide the composer; that is presentation, not the rule. It reaches the read model through fork migration 5 as an integer column, because SQLite has no boolean. See [worker threads][31].

#### Skill

A named unit of provider behavior a user can invoke from the composer, discovered from the filesystem by the driver rather than configured in T3 Code. `ServerProviderSkill` in [the server contracts][36] carries the name, the file path it was found at, an optional scope, and whether the provider has it enabled. Only the Claude driver discovers them today; a driver that cannot scope discovery to a directory answers with its snapshot skills unchanged. See [ClaudeDriver.ts][37].

#### Skill scope

Where a skill came from, as the provider spells it. Discovery answers for one `cwd`, so a thread sees its own project's skills plus the user's, and the raw `scope` string is whatever the provider wrote - `project`, `workspace`, `local`, `user`, `personal`. [providerSkillPresentation.ts][38] narrows those spellings to the two a composer menu must tell apart, Project and User, and leaves a scope it cannot place as `null` so the row falls back to its install source instead of guessing. Scope is per project on purpose: the provider snapshot is probed from the environment's own working directory, so a project-scoped skill in it belongs to wherever the environment started, not to the thread being typed on.

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

#### Repository identity

The repository a project's workspace root belongs to, keyed by its canonical git remote. It is derived state, not user input: [RepositoryIdentityReactor.ts][26] resolves it with `git` on a background worker and records it through the `project.repository-identity-recorded` event, and [ProjectionProjects.ts][27] stores it on the project row next to the workspace root it came from.

Reads never resolve it. [ProjectionSnapshotQuery.ts][10] serves the stored identity only while its recorded workspace root still equals the project's current one, so moving a project invalidates its identity with no extra write. The reactor re-resolves on project creation, on any project meta update that carries a workspace root (re-saving the folder is the user's manual refresh), and on a start-up sweep over rows whose recorded root no longer matches.

[RepositoryIdentityResolver.ts][35] answers the reactor's question and caches the answer per workspace root, so two projects under one root cost one `git` and a repeated lookup spawns nothing. The cache has no time-to-live: the only thing that makes a stored answer wrong is the root changing, and the reactor invalidates the entry on the meta update that carries a new one.

#### Git work depth

The bound on how much `git` the environment runs for itself at once, defined in [GitWorkDepth.ts][33]. VCS status subscriptions in [VcsProcess.ts][34] and repository identity lookups in [RepositoryIdentityResolver.ts][35] share one process-wide gate, so N watched projects cost at most `depth` concurrent spawns rather than N. The default tracks the host's available parallelism, clamped to 4..16; `T3CODE_GIT_WORK_DEPTH` overrides it, clamped to 1..64. Depth, not the number of open threads, is the lever.

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

Every ref a thread captures lives under `refs/t3/checkpoints/<base64url thread id>/`. That namespace is not one of Git's per-worktree ref namespaces, so refs a worktree-backed thread captures are written to the project's common ref store and survive `git worktree remove`. Because the refs are real Git refs, `git gc` never reclaims the working-tree snapshots they pin — so the refs have to be swept explicitly. Deleting a thread does that: [ThreadDeletionReactor.ts][25] enumerates the thread's namespace against the project's workspace root and drops every ref in it, which makes the thread's turn snapshots unrecoverable.

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

### Connections

#### Connection span

One client websocket, end to end, as a trace span. The environment opens `server.connection.clientSocket` when a client connects and ends it when the socket dies, carrying the close code, who sent the close frame, and the keepalive gaps, so a drop is explained rather than inferred. The client opens its own `clientRuntime.connection.rpcSession.socket` in [session.ts][39] and puts that span's `traceparent` on the connect URL, so the environment parents its span on the client's and both ends of one drop share a trace id and a `connection.id`. The client half only reaches the trace file where a client exports it, which today is web and desktop; see [observability.md][40].

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Connect any ACP agent][28]
- [Permission modes][18]
- [Workspace layout][2]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ../../apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts
[26]: ../../apps/server/src/orchestration/Layers/RepositoryIdentityReactor.ts
[27]: ../../apps/server/src/persistence/Services/ProjectionProjects.ts
[28]: ../user/external-acp-agents.md
[29]: ../../apps/server/src/provider/acpAgent/fixtures/acp-transcript/
[30]: ../../apps/server/src/provider/acp/AcpPeerSessions.ts
[31]: ./acp-worker-threads.md
[32]: ../../apps/server/src/provider/acpAgent/AcpAgentWorkerSessions.ts
[33]: ../../apps/server/src/vcs/GitWorkDepth.ts
[34]: ../../apps/server/src/vcs/VcsProcess.ts
[35]: ../../apps/server/src/project/RepositoryIdentityResolver.ts
[36]: ../../packages/contracts/src/server.ts
[37]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[38]: ../../packages/shared/src/providerSkillPresentation.ts
[39]: ../../packages/client-runtime/src/rpc/session.ts
[40]: ../operations/observability.md
