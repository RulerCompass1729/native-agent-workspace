# A click wakes the butler at once only for the holder that raised the card

The integration review of release 300 found that a click kept for the butler was recognised by its workspace session id alone (B4; the earlier change is in `claude-click-now-20261125.md`). The same workspace session can go on as another native session, and the person can designate that one: a click kept from before would then pass its usual checks for a card it never raised.

Now a click passes them only when the card was raised by the session designated, as the same native session, or by one it continued from through recorded rotations, matched by workspace and native session at each step. Any other answer is an ordinary event: it stays in the record, waits the usual checks and is then told. The event record and the state files are unchanged. The event names the workspace session and the operation; the native session that asked is read from the background control record of that operation, which is kept across restarts and in its history.

An answer whose operation is not found, cannot be read, or was used again by another native session is an ordinary event.

## Checks

On the unchanged code 7 of the 9 new tests fail, among them the case the review named: the same workspace session, another native session, across a restart. The two that pass assert what must not change: the same holder, and a session that only shares the native id. The tests use the real record, intake, designation, wake and dispatcher, closed and opened again from disk. The earlier click tests pass with the new reading of the asker. Mutation and related-suite results are in the lane's evidence. No model was called and the daily app was not touched.

## Known limits

- A person who deletes the history of an operation makes a click still waiting for it an ordinary event.
- A session whose native session changed in place, and the successor of that one, wait the usual checks for cards raised before the change.
- The migration quiet window is still passed by any act of the person, as before.
- Not yet operated in the daily app.
