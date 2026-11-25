## Main's memory grows with the open windows (lane/claude-main-heap-20261124)

Daily use: the main process stopped twice on 2026-11-24 with its V8 heap full (4192 MB limit). Each context (a page, or the hidden window an agent's request opens) connects to every backend and keeps two whole states of each (`initial`, `state`). Synthetic backends at a fifth of the daily size, 5 of them: live memory after full collections 65 MB with one context, 384 MB with seven, 549 MB with ten (about +49 MB each), and the run stops at the tenth.

Change: `state-share.cjs`. Connections to one backend (same endpoint) keep one object for each message whose content is equal, the states of one connection included. Each connection keeps its own records and lists, so what it reads is exactly the frame it was sent. Only equal content is shared (same keys in the same order); a message deeper than 100 levels never is, so a socket's data handler cannot run out of stack. `ServiceClient` takes the endpoint from `connectService`; a client without one (a unit fixture) shares nothing, and a closed connection leaves the group. Nothing changes in frames, the protocol, ownership, control or reconnecting. Both lists that pack a backend runtime and the app now have the file.

Measured, 7 contexts, 10 minutes, same synthetic load on both sides (plain node, stopped before any crash):

| | before | after |
|---|---|---|
| live after collection, 1 to 7 contexts | 65 to 384 MB | 40 to 40 MB |
| peak heapTotal in 10 minutes | 650 MB | 130 MB |
| CPU | 26.5 s | 24.8 s |

Snapshot: 6 agents each opening a context and taking the whole state (a 20 MB conversation), live memory 77 to 492 MB before, 45 to 72 MB after. A reply carries the sender's whole conversation and has no size limit of its own (the reader's frame limit is 64 MiB); this change does not touch it.

Not changed: what one context costs (its parse and the collections around it). On the old code one context of a daily process was read at 2.2 GB and an isolated app shows live memory of about 0.4 GB of that; the rest is uncollected garbage, which this does not reduce.

Tests: `state-share.test.cjs` (new): sharing and what stays apart, initial replies, a changed message, moved messages, odd frames, 400 random steps where every connection reads exactly what the backend holds. With `service-transport`, `state-delta`, `state-delta-protocol`, `service-initial-delta`, `workspace-client`, `background-control`, `background-control-desktop`, `mobile-workspace-client`: 175/175. `queue-dispatch`: 385/385. 9 edits of `state-share.cjs` that break the rules each fail a test.

Undo: drop this lane; the other processes' behaviour is 297's.
