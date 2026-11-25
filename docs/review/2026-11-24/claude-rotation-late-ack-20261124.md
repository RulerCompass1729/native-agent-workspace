## A handoff receipt that arrives late counts as delivered (lane/claude-rotation-late-ack-20261124)

The 297 integration review (head `77c10ff8`) was BLOCKED: a handoff undelivered at 119 s, received at 121 s and next looked at by the 125 s pass fails with `handoff-unconfirmed` on 296 and stays with the successor on 297. Asked: which is right, with the counterexamples and tests that pin it.

Decision: 297's behaviour stays. A late receipt counts, as a late completion always has (`outcome` is read before either limit).
- Undoing it is worse. A failed handoff gives the queue items back first and then stops the successor, only if it has nothing beyond its first turn. Measured at 125 s on 296 and on a variant that checks the limit first: with background work, an approval or a subagent the item goes back to the old session while the successor stays in the space and keeps working (two sessions may do the same work); with a plain running turn it is stopped midway. On 297 one session has the item in all four. Whether the old session then repeats the work was not run.
- It adds no time. Both limits count from the handoff, so a stuck late first turn holds the rotation exactly as long as a stuck one delivered in time, 30 minutes, which R183 already accepted.
- `submitted` is set only after native's own receipt (Claude's plugin receipt, Codex's `turn/start` result, agy's turn start, or a matching native user message in recovered history).
- The passes run every 3 s, so in normal use "late" is one pass. Counting only a receipt seen by an earlier pass would undo a handoff delivered while the app was closed or the Mac slept.

Change: two comments in `queue-dispatch.cjs`; 10 tests in `queue-dispatch.test.cjs`. No behaviour change from `77c10ff8`.

Tests: the 15 files the 297 integration ran, 519/519 (its 509 and these 10). Red: 6 of the 10 on a limit-first variant and 5 of the first 9 on 296's dispatcher; the no-turn-id test on a variant that needs a turn id. The other four hold what must not change: a completed turn confirms, a successor whose process is gone rolls back.

Review: one read-only session, two rounds, PASS-WITH-NOTES with nothing blocking; its notes on tests and wording are in.

Later, when seen in use: a delivery record that could not be written, plus a reopened app, plus a successor out of view, still rolls back at two minutes; a receipt that arrives after the rollback takes the old path; a successor waiting on an approval is kept at its 30 minutes while its item goes back (R183); Codex may receive the message without binding its turn and then waits out the 30 minutes.

Undo: drop this lane; the behaviour is 297's.
