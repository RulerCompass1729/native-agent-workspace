# Tell the butler about each of its saved messages that did not go out

Two of the butler's messages were withdrawn after its call had answered that they were saved, and nobody knew. The person: 「一旦错过就不再继续,这个肯定不行」. Only a held message whose sender is the butler now, or on its rotation chain, was recorded.

Every message whose call was told it is saved is now one butler event if it does not go out: withdrawn before its turn ended or while it waited for a quiet window, withdrawn while held, refused or lost at its one attempt, not confirmed, or settled as a backend starts again. An earlier butler's message counts by the rotation chain or by the role record; without either, nothing is guessed. The event carries the recipient, the message id, the outcome with a reason code and the time it failed, never the text. A message refused when it was called, and one from a session that never was the butler, make none. Nothing is sent again and what withdraws a message is unchanged.

A message refused as the recipient took it (a gap in what NAW saw of the sender, a permission question) used to read as unconfirmed with the reason gone. The refused take now leaves its code and the names of the changed fields on the row. The butler is told:

- `cancelled:<code>` or `not-sent:<code>`: it did not go out and cannot later; it may be sent again.
- `unconfirmed:<code>`: the recipient may have it; check before sending again.

What the person and the sender see and the row's status are unchanged, and so are messages to the butler, except that a withdrawn one's reason code is the cause's too.

A withdrawn message with no code of its own now gives the code of its cause: a gap (`observation-gap`), a takeover in a space (`human-control`), a stop for a handoff or maintenance (`disconnecting`) and a native session going away (`native-unavailable`) were all one code. A person's plain stop ends as `native-unavailable`, as a crash does, and a takeover outside a space as `source-identity-changed`: the code alone does not say the person stopped it.

## Checks

The branch was moved onto the repair that tells a sender of its lost messages (`claude-held-told-20261124`); the two changed the same lines and both stay. On the first base 23 of the 24 tests of the first two commits fail on the unchanged code (several only because the event now also carries the message id); the one that passes asserts that a message refused when called makes no event. The sample-six tests: 7 of 23 fail on the first commit. 113 related test files on the final code: 3041 passed, none skipped; the queue dispatch tests passed (365) on the code before the last one-line repair. The full suite was not run (another lane held its lock). The cause codes: 8 tests fail without the change. Mutation runs over the new conditions leave one equivalent mutant. No model was called by the tests and the daily app was not touched.

## Independent review

A non-author read-only review of both commits: PASS, nothing blocking. Its notes led to saved evidence and the limits below; no code of those two changed after it. The cause codes and the move to the new base were reviewed as an increment by the same reviewer: PASS, on the condition of the related run above. Its note on a message whose save failed while its recipient was in a quiet window is fixed, with a test, and that fix was reviewed too.

## Known limits

- A direct designation turns event waking off, and turning it on starts from the newest event: an event in between is in the ledger but wakes nobody.
- A backend from before this change leaves no marks: its refused-at-attempt rows are not recorded, and a refused take still reads as unconfirmed.
- A message still registered or being sent when its backend stops reads `unconfirmed:restored`, also when it never left.
- If saving fails as a message is sent, its row stays as it is until the backend starts again; the storage warning shows.
- A call whose save failed after the file was replaced, or a failed-save row that could not be rendered, can make one extra event after a restart.
- A stray refused take during an attempt that then fails can leave its code as the reason; the outcome stays right.
- Not yet checked in the daily app.
