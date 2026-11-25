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

Hidden app, real Electron main process with a page that loaded its session list (110 synthetic sessions), sampled every 10 s:

| | before | after |
|---|---|---|
| one context (70 MB of JSON), live after collection | 255 MB | 78 MB |
| same, heapTotal at 10 s / settled | 495 / 355 MB | 155 / 155 MB |
| page and 6 background contexts (28 MB of JSON), 10 minutes, heapTotal highest sample | 672 MB | 129 MB |
| same, live after collection at the end | 560 MB | 53 MB |

Counted in the real main process after collection (the inspector, synthetic data): among messages whose text is longer than 200 characters, the old code holds 3.97 times as many objects as the new one (75,883 against 19,106, which is one for each such message). With one page open there are ten `ServiceClient` objects, five connected and five already closed but still referenced, each with two whole states (`initial` and `state`); both trees have the five closed ones. They did not grow in this run: eight more contexts opened and closed by direct connections, about 110 seconds later there were still five; reconnecting and replacing a backend were not tried. Which reference keeps them was not found, and this change leaves it; when measured they held lists and not a second copy of the messages (a message the backend later changes or removes stays in their old state, at most one old state's worth).

Scaled by size to a daily state of 231 MB, the old code would hold about 0.75 GB live. The heap would be about 1.6 GB while starting and 1.1 GB when settled; with about 0.2 GB outside the V8 heap that is a fifth (starting) or two fifths (settled) short of the 2.2 GB the daily process was read at, and when that was read is not recorded. This is an estimate from synthetic data, not a measurement of the daily process. An earlier run without a page (its synthetic data had a wrong field, since fixed) gave a lower figure and is withdrawn.

Tests: `state-share.test.cjs` (new): sharing and what stays apart, initial replies, a changed message, moved messages, odd frames, 400 random steps where every connection reads exactly what the backend holds. 9 edits of `state-share.cjs` that break its rules each fail at least one test. With `service-transport`, `state-delta`, `state-delta-protocol`, `service-initial-delta`, `workspace-client`, `background-control`, `background-control-desktop`, `mobile-workspace-client`: 175/175. `queue-dispatch`: 385/385 on this and on the base. No code in the main process or a daemon was found that edits in place a message from a backend's snapshot. Read: `mobile-workspace.cjs` (its rows are new objects), `legacy-claude.cjs` and `legacy-codex.cjs` (a clone or their own records), `operator-control.cjs` `insertRows` and `decorate`, `room-state.cjs` and `session-labels.cjs` `apply` (spreads), `main.cjs` deliveries and `background-control.cjs` (read only). WeakMaps in those files are keyed by clients, sessions or windows, never by a message. A change watcher (preloaded, compares each shared message's JSON every 2 seconds and at exit, so it misses a change undone between checks or one that leaves the JSON equal) was run two ways. Over 227 test files: 4100/4100, where only 737 messages were shared because most tests use no real connection. In the real main process of the hidden app with a page and 3 background contexts over 4 minutes, each taking its whole state, projecting it as a snapshot and serialising it every 10 seconds: 46,050 shared messages, none changed, no page errors. The same watcher caught one message changed on purpose. A deep-frozen run covers only 1347 objects in 7 test files and its 9 other failures are the ReferenceErrors that strict mode alone gives on the base too.

Undo: drop this lane; the other processes' behaviour is 297's.
