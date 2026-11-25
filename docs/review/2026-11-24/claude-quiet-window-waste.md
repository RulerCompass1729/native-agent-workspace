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
