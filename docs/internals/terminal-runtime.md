# Terminal runtime

The environment server owns PTYs, session lifetime, and retained output. Every
client, including the desktop renderer, attaches through the environment connection.
This lets clients reconnect or share a running session. Renderer choices stay local
to each client and do not change terminal contracts.

## Output and retention

[Terminal history](../../apps/server/src/terminal/Manager.ts) is incremental.
PTY callbacks append new chunks; live events carry only those chunks. Materializing
or copying full scrollback on every callback makes output cost grow with retained
history, so snapshots and coalesced persistence are the materialization boundaries.
Persistence queues the mutable history buffer and reads its latest value when the
write runs. Clear, restart, and close must drain writes before completing their
lifecycle boundary.

Server history is capped at 5,000 lines and 8 MiB of UTF-8 text per terminal, so a
long unterminated line cannot bypass retention. Eviction removes the oldest output
without splitting Unicode code points; live output is not truncated. Release
discarded chunk references immediately, even if array compaction happens later.
Client buffers have a separate 512 KiB cap. Measure throughput with full scrollback
when changing this path.

Restoration must read only the bounded tail of current or legacy history files,
skip any incomplete UTF-8 prefix, and apply the line limit. Close the read handle
before rewriting the capped file. Reading whole old logs would defeat the memory
bound during startup.

## Subprocess poll

A terminal's label says whether a child process is running in it. That answer comes
from a host process table, read on a timer by
[`Manager.ts`](../../apps/server/src/terminal/Manager.ts). The timer is a
[back-off poll](../../apps/server/src/pollLoop.ts), the same engine the preview
port scanner uses.

One **round** takes one process-table snapshot and derives every session's answer
from it in memory. The cost of a round does not grow with the number of terminals.
The snapshot comes from the resource-monitor sidecar where it is available, and from
one spawned `ps -eo pid=,ppid=,comm=` or one `powershell.exe Get-CimInstance
Win32_Process` where it is not.

| Knob                | Value                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| Base period         | 2000 ms                                                                                        |
| Back-off            | x2 per round that changed nothing, capped at x8 on a sidecar snapshot and x30 on a spawned one |
| Probe budget        | the lower of the platform ceiling (1500 ms Windows, 1000 ms POSIX) and 0.75 of the base period |
| Per-session fan-out | 4                                                                                              |

So an idle host settles at a 16 s gap while the sidecar answers, and at a 60 s gap
while it does not. The second ceiling is upstream's (#9476): a degraded round spawns
a process, and one spawn a minute is the rate upstream chose for that. The first
applies when a round costs a sidecar read, which is cheap enough to do more often.

The probe budget is computed once, from the base period, because the base is the
shortest gap the loop can run at. A probe that hits its budget is therefore always
cancelled before the next round is due. The round is awaited inside the loop, so a
round that overruns skips to the next base-period boundary rather than overlapping
the next round or spinning after it.

Every terminal event the manager publishes wakes the poll, which puts the next round
back on the base period. A wake never cuts the base period short, so a chatty
terminal cannot drive the poll faster than its configured rate.

One kind of event does not wake it: the activity events a round publishes from its
own spawned fallback data, when the sidecar snapshot failed. Waking on those would
let the round re-trigger itself and hot-loop the spawn. The suppression is per event,
not a mode on the manager, so a keystroke during a degraded round still resets the
cadence. The cost is latency on the idle path only: with no sidecar and no terminal
activity, a label can be up to 60 s stale.

A snapshot that fails or times out is not authoritative. It leaves every session's
last known state alone, because one bad probe is far more likely than every
subprocess exiting at once.

## Renderer ownership

Android and web use the same `libghostty-vt` C ABI for terminal behavior. Platform
adapters own drawing and input integration, and React stays out of terminal frames.
The web adapter shares one WebAssembly instance per browser tab while each terminal
owns and frees its own handles. The canonical upstream pin is
[`native/libghostty-vt/VERSION`](../../native/libghostty-vt/VERSION); both native and
web artifacts must be rebuilt when it changes. Web embeds the revision in its build
info so the ABI check can detect drift without a second pin.

Restoring scrollback must not send terminal replies to the current shell. Historical
device queries can otherwise provoke fresh replies that appear as junk at the
prompt. The server strips query/response traffic from retained history, and the
[web renderer](../../apps/web/src/terminal/ghostty/core.ts) detaches its PTY writer
during replay. Preserve both protections when changing retention or renderer code.
