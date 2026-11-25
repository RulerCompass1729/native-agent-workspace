# A click wakes the butler at once only for the holder that raised the card

The integration review of release 300 found that a click kept for the butler was recognised by its workspace session id alone (B4; the earlier change is in `claude-click-now-20261125.md`). The same workspace session can go on as another native session, and the person can designate that one: a click kept from before would then pass its usual checks for a card it never raised.

Now a click passes them only when the card was raised by the session designated, as the same native session, or by one it continued from through recorded rotations, matched by workspace and native session at each step. Any other answer is an ordinary event: it stays in the record, waits the usual checks and is then told. The event record and the state files are unchanged. The event names the workspace session only; the native session that asked is read from the background control record the answer belongs to, matched by the event's own id, which is of the whole answer. Those records are kept across restarts and in their history. An answer whose record is gone or cannot be read is an ordinary event.

## Checks

On the unchanged code 8 of the 10 new tests fail, among them the case the review named: the same workspace session, another native session, across a restart. Those that pass assert what must not change. The tests use the real record, intake, designation, wake and dispatcher, closed and opened again from disk. The earlier click tests pass with the new reading of the asker. Mutation and related-suite results are in the lane's evidence. No model was called and the daily app was not touched.

## Independent review

A non-author review of the first version found one blocking item: it looked the record up by the operation id the event carries, and an id that is not plain (a space, a slash, Chinese) is not carried, so the holder's own answer waited like any other event. It also noted that an id used by two native sessions made the later holder's answer ordinary. The record is now matched by the event's own id, which tells both apart; tests for those ids fail on the first version.

Its second round found that the module which matches the record was then loaded by the background control module, which a backend loads from its own copied files without it: a new backend would not have started. The two existing tests of those files that fail on that version had been left out of the related run. The match is now made by the main process only, and they pass.

## Known limits

- A person who deletes the history of an operation makes a click still waiting for it an ordinary event.
- A session whose native session changed in place, and the successor of that one, wait the usual checks for cards raised before the change.
- The migration quiet window is still passed by any act of the person, as before.
- Not yet operated in the daily app.
