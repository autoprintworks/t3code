# Connect Any ACP Agent

T3 Code ships built-in support for a handful of agents. If the agent you want is
not one of them, and it speaks the **Agent Client Protocol** (ACP), you can add
it yourself from Settings. No fork, no build.

ACP is a small open protocol for talking to a coding agent over standard input
and output. An agent that supports it usually says so, often behind a flag like
`--acp`.

## Add One

1. Open Settings, then Providers.
2. Add a provider and pick **ACP agent**.
3. Fill in the command that starts the agent.
4. Enable it.

The only field you must fill in is **Command**. Everything else has a sensible
empty state.

| Field                 | What it is                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| Display name          | What you see in the picker and the sidebar. Defaults to the driver's name.                             |
| Command               | The executable to run. Must speak ACP over stdio.                                                      |
| Arguments             | One argument per line. There is no shell, so nothing is split or expanded for you.                     |
| Working directory     | Where the agent starts. Leave it empty and it starts in the project the thread belongs to.             |
| Icon                  | The glyph clients draw for this agent.                                                                 |
| Authentication method | The method id sent to the agent's `authenticate` call. Leave it empty unless the agent publishes one.  |
| Environment variables | From the shared provider fields. Use this for API keys and anything else the agent reads from its env. |

Then open a new thread and pick your agent.

### Arguments Are One Per Line

T3 Code starts the agent directly, not through a shell. That means it cannot
guess where one argument ends and the next begins, so you say it:

```text
--acp
--config
C:\Program Files\my agent\config.json
```

Three arguments. Quoting is neither needed nor understood, and a path with
spaces in it works as typed.

## Add Several

Each ACP agent provider is one agent. Add a second one for a second agent, and
both run at the same time with their own models, sessions and history.

Two providers may name the same command. Each one starts its own process and
talks to it down its own pipe, so two entries that differ only in their
environment variables are two agents, not one entered twice.

## Example: A Local Agent Over npx

```text
Display name: Example Agent
Command: npx
Arguments:
  -y
  @example/acp-agent
Working directory: (empty, follows the project)
Icon: Terminal
```

## Example: An Agent That Serves One Fixed Directory

Some agents are a front end for a service that owns its own workspace, rather
than a per-project process. Give those a working directory and they ignore
which project the thread is in:

```text
Display name: First Mate
Command: fm-acp
Arguments: (none)
Working directory: ~/.firstmate/v2
Icon: Anchor
```

`~` is expanded in the working directory only. The command and the arguments
reach the agent exactly as typed, so an agent that takes its home as a flag
needs that path written out in full, or set through an environment variable on
the provider.

A second one of those is a second provider with a second directory. Both run
side by side.

## Picking A Model

The model list comes from the agent, not from T3 Code. It arrives when a
session opens, and choosing one sends the id straight back. T3 Code never
invents a model id, so if your agent offers none, the picker is empty and the
agent uses whatever it defaults to.

Most ACP agents cannot change model in the middle of a turn. Wait for the turn
to finish, or stop it first.

## Watching Its Workers

Some agents delegate. When your agent hands a job to a worker of its own, that
worker's conversation shows up in T3 Code as its own thread, next to the thread
it came from.

A worker thread is **read only**. There is no message box on it, because there
is nobody there to read a message: the worker takes its instructions from the
agent that started it, not from you. Talk to the main thread instead.
Everything else works normally - you can read it, scroll it, and copy from it.

The thread is named after the worker's own task. If the worker has not named
itself yet, you see its id instead.

When a worker finishes, its thread is archived. You can still find it under
archived threads. If T3 Code was closed while workers were running, the ones
left over are archived the next time the provider connects, so the list does
not fill up with work that ended while you were away.

If a worker's transcript cannot be read, the thread says so in its timeline and
stops trying. It does not retry in the background.

An agent that does not delegate never grows worker threads, and T3 Code never
asks it for any. Only an agent that says it can list its sessions is asked.

## What A Configured Agent Will Not Do

**Write commit messages, pull request text, branch names or thread titles.**
The built-in providers write these by running their agent once in a throwaway
process. ACP has no such side channel: the only way to ask is to prompt a real
session, which lands in your own history and queues behind the turn you are
waiting on. So T3 Code asks a different provider for generated text. Pick one in
Settings under the text generation model.

## If It Will Not Start

The provider reports its own state in Settings. What it says, and what to do:

- **"No command is configured for this ACP agent."** Fill in Command.
- **"... could not be started. Check that the command is installed and on
  PATH."** The command was not found. Install it, or give the full path to it.
- **"... did not open an ACP session: ..."** The program ran but did not answer
  as an ACP agent. The rest of the message is the agent's own words. Check that
  you passed whatever flag puts it into ACP mode.

Every message names the full command line it tried, so you can run the same
thing in a terminal and see what happens.
