# Glossary

Terms whose meaning matters across T3 Code. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime T3 Code controls, such as Codex or Claude Code.                                            |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into T3 Code operations and events.                    |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Fork terms

Terms this fork adds. See [worker threads](./acp-worker-threads.md) and
[environment auth](./environment-auth.md).

| Term               | Meaning                                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External ACP agent | An agent driven through the configurable `acpAgent` driver. Its command, arguments, environment, name and icon come from the instance's settings.                                                     |
| Worker thread      | A read-only thread mirroring one peer session on a configured ACP agent's connection: work the agent started that this client did not.                                                                |
| Read-only thread   | A thread whose transcript is a window onto work driven elsewhere. `readOnly` is set once at creation and never cleared. `requireThreadPromptable` refuses turns and reverts on it.                    |
| Fleet-owned thread | A read-only thread the First Mate daemon created for itself. `fleetOwned` is set once at creation from the issuer the dispatch entry point stamped.                                                   |
| Fleet subject      | The session `subject` the First Mate daemon mints its bearer under, `"firstmate"`. It is the read-only exception: the fleet may prompt a read-only thread only when the thread is also fleet-owned.   |
| Skill invocability | Who may start a skill. `userInvocable: false` leaves a skill out of the composer picker and the provider's `/` command list. `userInvocationOnly: true` keeps the row and carries a **Manual** label. |
| Skill scope        | Where a skill came from, as the provider spells it. Discovery answers for one `cwd`, so a thread sees its own project's skills plus the user's.                                                       |
| Git work depth     | The process-wide permit count every `git` the environment runs for itself must take. See the [overview](./overview.md#git-work-depth).                                                                |
| Connection span    | One client websocket, end to end, as a trace span. The client puts its span's `traceparent` on the connect URL, so both ends of one drop share a trace id.                                            |
| Round              | One pass of a host poll: one process-table snapshot or one listener scan, with every answer derived from it. See [terminal runtime](./terminal-runtime.md).                                           |
| Back-off poll      | The shared timer behind the terminal subprocess check and the preview port scanner. A round that changes nothing multiplies the next gap; any event resets it to the base period.                     |
