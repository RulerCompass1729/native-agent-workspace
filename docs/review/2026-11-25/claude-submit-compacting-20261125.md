## A send made while Claude compacts is not recorded as failed (lane/claude-submit-compacting-20261125)

A queue item sent to a Claude session in the middle of its own compaction was recorded failed ("submission unconfirmed") after 15 s, and Claude ran it when the compaction ended, 46 s in. Claude keeps a prompt that arrives then queued and reports it accepted when its turn starts. The late start was recorded as input typed in Claude, so it also moved the session's control.

How often: 2 rows recorded unconfirmed are still kept from the last 7 days, 1 of them during a compaction (a lower bound, kept state is not complete). In the same 7 days 267 Claude records held 655 compactions, all automatic, none typed (median 78 s, longest 218 s, 591 over 15 s). 611 ran inside a turn and 30 at a turn's start, where the receipt comes before the compaction. The 14 that Claude started while idle are the ones that hold a new prompt; 2 of them held one.

Change:
- `claude-submit.cjs`: while Claude compacts, an authorized send has no clock; the end gives it a whole 15 s. An end nobody reports is taken after 5 minutes. A listener that asks for its next command while the clock is stopped has lost the result: uncertain at once, as it already was for a queued input.
- `adapters.cjs`: NAW saw the end of a compaction but not its start, so the launch settings gain the `PreCompact` hook (the same observing command as the other hooks; no polling, the mod is unchanged). SessionStart, UserPromptSubmit, Stop and StopFailure end it.
- `queue-dispatch.cjs`: the call to the backend has its own 40 s limit, which a compaction outlasts. When that limit passes, the dispatcher reads the state once more; if this session's pending row is this very item's and still waits for native (or was just accepted), the item stays sent and follows that row. A row that then ends unconfirmed settles the item failed.

Unchanged: no compaction, 15 s; not authorized, not sent after 15 s; a closed channel, a rebound mod, an ended context, at once. A message that waits for its own native turn. A subagent's compaction holds nothing.

Choices:
- `PreCompact` can stop a compaction (exit 2) and its output goes into the summary. The hook script prints nothing and exits 0; a test runs the real script with and without a backend.
- After a `/compact` the person types, Claude shows "PreCompact [command] completed successfully" under "Compacted", and the next request carries that line. Automatic compactions show nothing (both seen on 2.1.332). The matcher `auto` would remove it and leave a typed `/compact` at 15 s.
- The qualification basis includes `adapters.cjs`, so Claude is qualified again at the next backend start, as after any change there.

Tests: `claude-submit-compacting.test.cjs` (new, 26) and 13 in `queue-dispatch.test.cjs`. Red on `294d1609`: 7 in the first version of the new file and 3 dispatcher tests; the rest are the cases that must not change. Mutations: 36 of 37 red; the other (the hook returning early for `PreCompact`) changes nothing that can be seen. Related tests: 4454 of 4454 (173 files).

Real Claude 2.1.332 with a local fixed model (no provider, no cost), the repository's own host, terminal, mod and hooks:

| | base 294d1609 | this branch |
|---|---|---|
| sent during a 47 s compaction | unconfirmed at 15.0 s; ran anyway as a second row, control moved | accepted after 47.2 s, one row, one request |
| the same through the queue and the 40 s call | item failed at 15 s; the task ran anyway | call ended at 40.0 s, item stayed sent, then done with its reply |
| session stopped in the middle | | uncertain at once |
| compaction at the turn's start | | accepted before it, 0.05 s |
| no compaction | | accepted |

Left:
- A send made by the person that outlasts 40 s still shows the confirmation timeout; its row stays waiting and becomes submitted.
- An item already recorded failed whose task is seen running later is not changed back. Nothing does that today: a failed item keeps no tag, and the late start is recorded as native input. It would take more than 20 lines.
- Claude's setting `idleCompaction: false` would remove the compactions that hold a prompt. Not changed here.

Undo: drop this lane's commit.
