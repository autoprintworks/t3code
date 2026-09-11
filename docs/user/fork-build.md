# Telling the fork apart from official T3 Code

This build is a fork of T3 Code, not an official release. It installs beside an official install
rather than over it, so both can be on the same machine at once. Four things tell you which one you
are looking at.

- **The icon.** The fork's icon is the T3 Code plate tinted orange with a round white **AP** badge in
  the corner. An official install keeps the plain black plate. This is the quickest check in the
  taskbar, the dock and Alt-Tab.
- **The window title.** The fork's window and About panel read **T3 Code Fork**, with the release
  stage after it, for example `T3 Code Fork (Alpha)`. An official install reads `T3 Code`.
- **The sidebar.** The wordmark at the top of the sidebar carries a small **FORK** tag next to it, on
  desktop, web and mobile alike. The browser tab icon is the badged one too.
- **Your data.** The fork keeps its threads, projects and settings apart from an official install, so
  starting it does not show your official install's thread list. That is expected, not lost work.

Every build this repository produces is the fork, including nightlies. There is no official build
here, so none of the four signs above can go missing on one channel and not another.

## How updates arrive

The fork checks its own release feed, not the official one, so it only ever offers you a fork build.

Updates are automatic. When the fork finds a new version it downloads it straight away, with no
button to press. The download installs the next time you quit the app, so the version you start
tomorrow is the new one. Nothing interrupts you while you work: there is no dialog and no repeating
message. The only sign is a small label next to the update button in the sidebar, naming the version
that is waiting. Press that button if you want the new version now instead of on your next quit.

Settings shows what the updater is doing in plain words, under **Update status**: checking for
updates, downloading with the percentage, a named version waiting for a restart, or up to date.

The **Automatic updates** switch in Settings turns this off. With it off the fork tells you a new
version exists and waits: you press the update button once to download it, then once more to restart
and install. The switch is on when you first install the fork.
