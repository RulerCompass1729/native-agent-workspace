## A quiet window that cannot end in its move closes early, and what finished inside it is settled (lane/claude-quiet-window-waste-20261124)

Report: five of the first eleven migration quiet windows ran to their deadline without a move and held work back for 281 minutes. While one was open, two items whose turns had ended also stayed `sent` until it closed.

What each of the five waited for (from turn times and message roles only):
1. The person, typing in a member's terminal from the first minute on. Two automatic messages from senders on older code also came through, and one started a turn that lasted past the window.
2. Two members' turns that ended 14 and 35 minutes into it (one with background commands); five automatic messages from senders on older code between minutes 18 and 59; and one input by the person 41 minutes in.
3. One turn that ran through the whole window.
4. One turn that ended 8.5 minutes before the deadline, 91 seconds short of the 10 quiet minutes; another member was idle and held for 51 minutes meanwhile.
5. Opened on a background timer; then the person kept writing to that session from the fifth minute on, while the other member was idle for the whole hour.
Eleven windows is a small sample.

Change
- `quiet-windows.cjs`: a window closes as `person` when a session the person used after it opened is at work, and as `still-busy` when a session is still at work 30 minutes after it opened. The sessions are free at once. The two-hour pause for that backend still counts from the window's deadline, and until that deadline, while the backend still waits for its sessions, no other window opens: the next windows come when they would have, or almost. The 10- and 30-minute quiet rules, the window's length, running turns and the migration switch are unchanged.
- `queue-dispatch.cjs` `view()`: a session held only by a window counts as idle for settlement. `sessionReady` still says `quiet-window`, so no item, notice or wake is sent there. `openWork()`: no patrol is due inside a window, as before; once it closes, the idle time inside it counts, so one may be due at once.
- `version-events.cjs`, `main.cjs`: the butler and the secretary are told of an early close once, with why, when, and from when the pause counts.

Why not smaller: the person rule alone leaves window 4 at 60 minutes; the 30-minute rule alone leaves window 5 at 30. A hand on an idle session's draft does not close it (an existing test keeps that window to its move). Not opening unless the running turns are likely to end helped one window of eleven. A shorter total would have cut off the sessions that need 30 quiet minutes. Without the kept place, the first two early closes would have brought the next windows for those backends forward by 30 to 40 minutes, into turns that the recorded windows missed; projected on the record, the two later moves might not have been made (found by the independent review).

Replay of the eleven, each from its recorded opening: 329 minutes as recorded, 325 replayed on 297's code, 131 on this; the three that moved and two that ended by themselves are unchanged, one that ended by itself at 18 minutes ends at 9. Limits: the person's typing is taken to start one minute before the sent message, background work is inferred from its notices, the two that ended by themselves end when they did, and work sent earlier would have changed later turns.

Chained, on 400 synthetic 14-hour days with one to four old backends and turns that do not depend on the windows: 2176 windows on both codes. On 386 days every window opens at the same minute; on the others the first that differs opens one minute sooner (1 day) or 2 to 41 minutes later (13 days; by the author's reading of each, a backend that stopped waiting after an early close). 50,975 minutes with sessions held instead of 116,992.

Known cost. A window that would have ended in its move can close early when a turn ends more than 30 minutes after opening but in time for its quiet, or after one input or answer by the person (an approval counts) whose turn then ends. The move may then wait for the next window. None of the eleven; in the synthetic days 16 of the 200 windows that ended in their move (7 after the person, 9 after 30 minutes). A backend that stops waiting after an early close waits out the pause from the deadline, not from that moment. The same holds when migration is turned off and on again, or NAW is closed through the deadline, after an early close: the next window there may come later than before (not tested; the move itself does not need a window).

What else reads the idle time inside a window: an already requested rotation takes its handoff and finishes on the new backend (tested); the integrator's handoff already sent is settled, and a new one is held by `sessionReady`; the answered-decision mark is cleared; the butler's wake, answers and notices are held by `freshReady`.

Tests: 21 in `migration-quiet-window.test.cjs`, one added in `queue-dispatch.test.cjs` and one in `steward-patrol.test.cjs`. On 297's code 6 of the 21 and the other two fail. 36 of 36 mutations are caught. Related: 74 files, 1487 passed, none skipped, on the second round's code; after it only the `wait === null` case of `placed` and one sentence of the event changed, and the four files they touch passed again (58). On the tree merged with the wake-reason lane (`3c7b7d2e`, no conflict), with the final code, 12 files, 644 passed. The full suite was not run.

Review: one read-only session. Round 1 BLOCKED by two findings: the first version let later windows open sooner, and the record misdescribed two of the five windows. Both were fixed (the kept place, this list). Round 2 PASS-WITH-NOTES, nothing blocking; its notes are in. Round 3, on the final code: PASS, nothing blocking.

Undo: revert the commit; no stored format changes. A record with the new codes read by older code only loses their pause.

## On 43bd89bf (alpha.300), 2026-11-25

The commit was rebased from 297's base onto 43bd89bf without a conflict (`5583bd99`); the code is what was reviewed, the author of this part is another session.

The six tests named when the earlier combination was tried (one in `steward-wake-card-click`, five in `steward-wake-person-window`) do not fail here: 113 of 113 in the wake, patrol and window tests. They fail only with the R209 card click (`68fa0ee7`, now `be1f6cd3`), which is not in 300. All six are right and stay as they are; the code is what changes, and it is one line of that lane. With it the wake of the person's act reads the idle clock whenever one runs, and since this change one runs inside a window too:
1. `where no idle clock runs, the eight seconds after its turn end …`: a turn that no pass saw at work left the clock running, and the butler was woken at once. A real fault, the one asked for as a counter-example.
2. `the butler's own last activity is its quiet there …`: the same.
3. `two answers on queue items within a minute …`, `the two minutes after the person used the butler …`, `the butler gone by the read right before the send …`: the clock starts at the first pass after NAW starts, so an act on a butler that has long been idle waited eight more seconds and said `not-settled`.
4. `an act that is no answer …`, its last row: the hold read `cooldown` where `send-not-sent` was due, and reads it again with that line; the step between was not traced.

Found while judging, and fixed here: an event for a butler in a window, or an answer owed to an agent in one, was counted as settled and led to a full read of every backend on each pass (20 synthetic minutes with one event waiting: 0 reads on 43bd89bf, 41 with no other activity and 398 at the three-second tick on `5583bd99`; 0 again now). `wakeSteward` and `notifyOwed` now leave a session that a window holds before they read. What waits, and what it says, is unchanged. The comment there said no idle clock runs in a window; it says what holds now, and that a window may close before its deadline.

Two lanes change the same three comment lines and the `idle` line of `wakeSteward`. Resolved: take the R209 lane's block with `this.idleSince.has(steward.sessionId) && !listed.quietWindow ?` and the last two sentences of this comment. Whichever lands second carries it. On that tree (`be1f6cd3`): 172 of 172 in the wake, patrol, window and answer tests; with its line left as it is 8 fail, the six and the two new ones.

New tests: an event and an answer waiting in a window read nothing (red on `5583bd99`: 398 and 97 reads); a click right after the butler's turn ended in the window waits its eight seconds, whether a pass saw that turn or not (red on the unresolved combination).

Related: 78 files that name the dispatcher, the windows, the wake, the version events or the answer notices, 2,174 of 2,174, none skipped; 6 of 6 mutations caught. The full suite was not run, nor a real NAW window. How often a real turn goes unseen by every pass was not measured. Review of this part: pending, on the increment after `5583bd99` only.
