# First Mate

First Mate is a provider you can turn on in T3 Code. It is different from the
others in one way that matters: a thread is not a fresh agent, it is a
conversation with your **first mate**, and that conversation keeps going.

This provider is off until you turn it on. It needs the First Mate door
program, `fm-acp`, installed on the machine that runs the T3 Code server.

## Turn It On

1. Open Settings, then Providers.
2. Find **First Mate** and enable it.
3. Leave **Binary path** empty if `fm-acp` is on your PATH. Otherwise put the
   full path to it.
4. Leave **First Mate home** empty to use your default home.

Open a new thread and pick **First Mate** as the agent.

## One Home, One Conversation

Each First Mate provider is pointed at one **home**. A home is a first mate,
with its own history, its own tasks, and its own model.

Opening the First Mate provider on a home shows that home's first mate as a
thread. Send a message, and you are talking to it. Close T3 Code and open it
again, and the same conversation is still there. It does not start over.

## Watching Its Workers

Your first mate delegates. When it hands a job to a worker, that worker's
conversation shows up in T3 Code as its own thread, next to the supervisor
thread it came from.

A worker thread is **read only**. There is no message box on it, because there
is nobody there to read a message: the worker takes its instructions from your
first mate, not from you. Talk to the supervisor thread instead. Everything
else works normally - you can read it, scroll it, and copy from it.

The thread is named after the worker's own task. If the worker has not named
itself yet, you see its id instead.

When a worker finishes, its thread is archived. You can still find it under
archived threads. If T3 Code was closed while workers were running, the ones
left over are archived the next time the provider connects, so the list does
not fill up with work that ended while you were away.

If a worker's transcript cannot be read, the thread says so in its timeline and
stops trying. It does not retry in the background.

## Adding A Second Mate

A second mate is a second home. Add a second First Mate provider and set its
**First Mate home** to that home's folder.

```text
Display name: First Mate
First Mate home: (empty, your default home)

Display name: Second Mate
First Mate home: ~/.firstmate/second
```

Both can run at the same time. They do not share history.

## Picking A Model

The model list comes from the home, not from T3 Code. Change the model in the
thread and the home changes with it.

You cannot change the model in the middle of a running turn. Wait for the turn
to finish, or stop it first.

## What First Mate Will Not Do

**Commit messages, pull request text, branch names and thread titles.** Other
providers write these by asking their agent, which is cheap because that agent
is a blank slate. Your first mate is not. Asking it to name a branch would put
that request into your real conversation history and hold up the message you
are actually waiting on.

So T3 Code asks a different provider for generated text. Pick one in Settings
under the text generation model. If First Mate is your only enabled provider,
these will fail with a message saying so.

**Approvals and questions.** Your first mate does not stop to ask permission,
and it does not ask multiple-choice questions. It works, and it tells you.

**Rewinding a thread.** A supervisor conversation cannot be rewound from T3
Code. The history belongs to the home.

## If It Will Not Start

The provider reports its own state in Settings. What it says, and what to do:

- **"First Mate is disabled in T3 Code settings."** Turn it on.
- **"The First Mate ACP door (`fm-acp`) is not installed or not on PATH."**
  Install it, or set Binary path to where it is.
- **"The First Mate ACP door is installed but failed to run."** The program is
  there but would not start. Run `fm-acp --version` yourself to see why.

If the provider is healthy but a thread will not open, the home is usually the
problem: the First Mate daemon for that home is not running, or First Mate home
points at the wrong folder.

Errors from the door are shown to you word for word. They come from First Mate
itself, not from T3 Code, so they say what First Mate would say.
