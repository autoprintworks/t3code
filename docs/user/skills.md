# Skills

A skill is a saved instruction set that Claude Code can run on demand. You write skills as files on
disk, and T3 Code finds them for you. This guide is about picking and running them from the
composer.

Skills are a Claude feature. Codex, Cursor, Grok, OpenCode and ACP agents do not have them, and a
thread on those providers shows no skill menu.

## Run A Skill

Type `$` in the composer. A menu opens with the skills the thread can run. Pick one and it becomes a
chip in your message. Send the message and the skill runs.

Skills also appear in the `/` slash menu. Picking one there does the same thing.

If you type `$something` and nothing matches, T3 Code leaves the text alone and sends it as you
wrote it.

## Project Skills And User Skills

Each row in the menu carries a badge:

- **Project** means the skill lives in this thread's project. It only shows on threads of that
  project.
- **User** means the skill lives in your own Claude config and shows on every thread.

If a skill's scope is not one T3 Code recognizes, the row shows where the skill was installed from
instead.

The menu asks the environment for the skills at the thread's own folder, so a project skill in one
repository never appears in a thread on a different one.

## Skills With Screenshots And Other Attachments

You can send a skill together with an image or another attachment. Claude Code ignores a slash
command that arrives with an image, so T3 Code sends the skill's own instructions instead of the
command name. The skill still runs, and you do not have to do anything different.

## The Menu Is Empty

Check these in order:

1. The thread is on a Claude provider.
2. The skill file is in your Claude config directory, or in the project the thread is open on.
3. The skill is enabled in Claude Code.

T3 Code re-reads skills from disk a few seconds after you change them, so a new skill may take one
more `$` to appear.
