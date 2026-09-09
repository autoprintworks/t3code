@echo off
rem Windows twin of codexCollabMockPeer.sh: CodexSessionRuntime spawns the peer
rem through its binaryPath, and Windows cannot execute a bash wrapper. The
rem runtime passes "app-server" as the first argument (a real codex CLI
rem subcommand) and the peer reads only stdin and its environment, so drop the
rem arguments and run node on the .mjs peer.
node "%~dp0codexCollabMockPeer.mjs"
