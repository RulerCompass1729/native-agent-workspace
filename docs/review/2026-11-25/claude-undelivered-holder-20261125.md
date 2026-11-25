# Report an undelivered message by who held the butler role as it was sent

A follow-up to `docs/review/2026-11-24/claude-lost-held-dispatch-20261124.md`. The integration review found that record choosing by who is the butler now: after a change of butler a former butler's message was lost when its recipient was the new one, and a message the present butler sent before it was designated was reported as the butler's own.

The role held as the message was sent now decides first, by session id, native identity and time:

- Its sender held the role: the message is the butler's own, also when it ended unconfirmed and also when its recipient is the butler now.
- Its sender is the butler now but did not hold the role then: not its own, and not a message to the butler either.
- A session on the rotation chain counts as before.
- The role record cannot say (it could not be read or written, or does not reach back that far): a sender on the present chain still counts as own, anyone else's message to the butler is reported as that, and nothing is attributed to another session.
- One message makes one event.

One expectation of the earlier change is different on purpose: a message taken without confirmation, whose recipient is designated afterwards, is now the sender's own.

The move to alpha.300 conflicted only in the designation handler of `app/main.cjs`: that release's handoff check and this branch's sync before a designation both stay. The sync runs before `designated`, so a chain the record has not seen yet is written before the new line.

## Checks

On the previous head 6 of the 33 tests in `own-message-undelivered` fail and 27 pass; the two synthetic cases from the integration review are red there and on alpha.299, and green here. 93 related test files on the merged code: 2744 passed, none failed or skipped. 45 mutations of the new conditions: 44 killed, one equivalent (the same event id is recorded once). Trial merges: no conflict with the five other lanes checked, and with the card-click lane only the frozen-day review file. The full suite, Electron and an install were not run. No model was called by the tests and the daily app was not touched.

## Independent review

A non-author read-only session reviewed the fix and the increment: PASS twice, nothing blocking; its two should-fix notes and three others were taken. The merge with alpha.300 was sent to the same reviewer as an increment.

## Known limits

- A session between two lines of a former chain that never had a line of its own is not recorded.
- While the record cannot be read, the butler's rows that failed before this intake started wait until it can be, and so does a former butler's message to a third session.
- If the role moved along the chain unseen by the record, the chain cannot be read as the person designates its newest session, and the sync is skipped, that session's earlier messages are not its own.
- After a failed record write and a restart, what a replaced session sent up to the first line written after it can still count as own.
- A message refused as it was called, to the session that is now the butler, is still reported as one to the butler.
