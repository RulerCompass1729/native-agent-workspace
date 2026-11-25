## Main's memory grows with the open windows (lane/claude-main-heap-20261124)

Daily use: the main process stopped twice on 2026-11-24 with its V8 heap full (4192 MB limit). Each context (a page, or the hidden window an agent's request opens) connects to every backend and keeps two whole states of each (`initial`, `state`). With five synthetic backends (28 MB of JSON, against 231 MB in daily use), live memory after full collections is 65 MB with one context and 384 MB with seven, about 53 MB for each more; with ten it is 549 MB, where the script stopped (a cap it was given, in place of the process's own 4192 MB limit).

Change: `state-share.cjs`. Connections to one backend (same endpoint) keep one object for each message whose content is equal, the states of one connection included. Each connection keeps its own records and lists, so what it reads is exactly the frame it was sent. Only equal content is shared (same keys in the same order); a message deeper than 100 levels never is, so a socket's data handler cannot run out of stack. `ServiceClient` takes the endpoint from `connectService`; a client without one (a unit fixture) shares nothing, and a closed connection leaves the group. Nothing changes in frames, the protocol, ownership, control or reconnecting. Both lists that pack a backend runtime and the app now have the file.

Measured, 7 contexts, 10 minutes, same synthetic load on both sides (plain node; the load itself adds about 12 MB over the 10 minutes, so live memory after the fix grows by that much):

| | before | after |
|---|---|---|
| live after collection, 1 to 7 contexts | 65 to 384 MB | 40 to 40 MB |
| live at the end of 10 minutes | 538 MB | 52 MB |
| peak heapTotal while the 7 windows opened | 487 MB | 138 MB |
| peak heapTotal in the 10 minutes after | 650 MB | 130 MB |
| CPU | 26.5 s | 24.8 s |

Snapshot: 6 agents each opening a context and taking the whole state (a 20 MB conversation), live memory 77 to 492 MB before, 45 to 72 MB after. A reply carries the sender's whole conversation and has no size limit of its own (the reader's frame limit is 64 MiB); this change does not touch it.

Not changed: what one context costs. A daily process with one context read 2.2 GB. An isolated app (five synthetic backends, 70 MB) showed 137 MB live after collection and a heapTotal of 454 MB, the rest of which was not yet collected. Scaled up by size that gives an estimate of about 0.4 GB live and 1.5 GB of heap; with about 0.2 GB outside the V8 heap it still falls 15 to 20% short of 2.2 GB, and the page of that run never became ready, so its own share is not known. This is an estimate, not a measurement of a daily process. The part that is not live memory is not reduced here; the heap of the main process grew with each further context, and that growth is what this ends.

Tests: `state-share.test.cjs` (new): sharing and what stays apart, initial replies, a changed message, moved messages, odd frames, 400 random steps where every connection reads exactly what the backend holds. 9 edits of `state-share.cjs` that break its rules each fail at least one test (`mutation-checks.txt`). With `service-transport`, `state-delta`, `state-delta-protocol`, `service-initial-delta`, `workspace-client`, `background-control`, `background-control-desktop`, `mobile-workspace-client`: 175/175. `queue-dispatch`: 385/385 on this and on the base. No code in the main process or a daemon edits in place a message that came from a backend's snapshot: the in-place writes of every caller that holds one were read. A change watcher preloaded in the real main process of the hidden app (1 page and 3 background contexts over 4 minutes, each taking its whole state, projecting it as a snapshot and serialising it every 10 seconds) watched 46,053 shared messages and saw none changed; the same watcher caught one changed on purpose. Run over 227 test files (4100/4100), it also saw none.

Undo: drop this lane; the other processes' behaviour is 297's.
