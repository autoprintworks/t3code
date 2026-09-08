# Threads You Watch

Most threads in T3 Code are yours to drive: you type, the agent answers. A few
are not. They have no composer at the bottom, and the sidebar shows them like
any other thread. These are **watch-only** threads.

A watch-only thread is a live window onto work that something else is driving.
You see every message, every tool call, and every diff as it lands. You cannot
send a message into it.

## Where They Come From

Two things create them.

**An ACP agent working on its own.** When you connect an external ACP agent,
that agent may already be running sessions you did not start, from its own CLI
or another app. T3 Code mirrors each of those as a watch-only thread so you can
follow along. The agent owns that conversation, so the way to steer it is
through the agent itself, not through T3 Code.

**A tool that drives T3 Code for you.** Some tools connect to your T3 Code
server and run work on your behalf. When one of those starts a thread, the
thread is watch-only for you and promptable by the tool that made it. You watch
the work; the tool steers it.

## What You Can Still Do

Everything except send a turn:

- Read the whole transcript, live.
- Open the diffs and the checkpoints the turn produced.
- Archive it, snooze it, rename it, delete it.

You cannot start a turn, and you cannot revert to an earlier checkpoint, since
reverting also drives the agent.

## Want Your Own Thread Instead?

Open a new thread on the same project and pick the provider you want. A thread
you create is always yours to drive. If the watch-only thread mirrors an ACP
agent, anything you send from that agent's own interface shows up in the mirror
here as it happens.
