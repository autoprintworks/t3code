#!/usr/bin/env bash
# Prototype: a Windows arm for fm-session-lock-lib.sh.
#
# Not a patch. A runnable proof of the two operations the real lib needs on
# Git Bash, so the shape can be judged before it is written for real:
#
#   fm_win_harness_pid        -> the harness pid for this session
#   fm_win_pid_alive <pid>    -> is that pid still a live harness
#
# The upstream lib gets both from `ps -o comm= -p`, which MSYS ps does not
# implement. Neither function below spawns a walk: the pid is handed over by
# Claude Code in CLAUDE_PID, and liveness comes from one `ps -W`.

# Applicability. Return 2 for "not this platform", so a caller can fall through
# to the existing POSIX ancestry walk rather than treating it as a failure.
fm_win_applicable() {
  case "$(uname 2>/dev/null || true)" in
    MINGW* | MSYS* | CYGWIN*) return 0 ;;
    *) return 2 ;;
  esac
}

# The native image path of a live native pid, or empty.
# ps -W columns: PID PPID PGID WINPID TTY UID STIME COMMAND
# COMMAND is a full Windows path and contains spaces, so take the tail.
fm_win_image_of() {
  local pid=$1
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  ps -W 2>/dev/null | awk -v p="$pid" '
    $4 == p { for (i = 8; i <= NF; i++) printf "%s%s", $i, (i < NF ? " " : "\n"); exit }
  '
}

# The harness pid owning this session.
#
# CLAUDE_PID is exported by the claude CLI itself into every Bash tool call and
# every hook invocation. It is a NATIVE Windows pid, so it is not in the MSYS
# pid namespace: kill -0 and /proc/<pid> both miss it.
fm_win_harness_pid() {
  fm_win_applicable || return $?
  case "${CLAUDE_PID:-}" in '' | *[!0-9]*) return 1 ;; esac
  fm_win_pid_alive "$CLAUDE_PID" || return 1
  printf '%s\n' "$CLAUDE_PID"
}

# Is $1 a live harness process.
#
# Matches the FULL IMAGE PATH, not the basename. Claude Desktop installs its
# own claude.exe and runs ~20 of them, so a basename match accepts an unrelated
# process and a stale lock never reads as stale. $2 overrides the expected
# image; it defaults to this session's own CLI.
fm_win_pid_alive() {
  local pid=$1 expect=${2:-${CLAUDE_CODE_EXECPATH:-}} image
  image=$(fm_win_image_of "$pid") || return 1
  [ -n "$image" ] || return 1
  [ -n "$expect" ] || return 1
  # Normalise separators; ps -W and CLAUDE_CODE_EXECPATH agree on case here.
  [ "$(printf '%s' "$image" | tr '\\' '/')" = "$(printf '%s' "$expect" | tr '\\' '/')" ]
}
