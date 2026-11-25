# Tell a sender once of every message answered as held that was lost

Findings 1 and 2 of the integration review of the seven-change candidate. A sender's next call says which of its messages, answered as held, did not go out.

- The mark that a loss was told was set after the save of that answer. A backend that ended before its next save told the same loss again, and the sender could send the message twice. The answer is now saved first; then the mark is set and saved, before the answer is given. If the first save fails the call fails, whatever it left on disk, and nothing is marked. If the second fails the answer still tells the loss.
- A message answered as held for the butler's minute or for a quiet window, and lost while still registered (the recipient stopped, the sender's turn interrupted, the connection lost), was never told of: only one that something had held, or that waited for a recipient at work, was. The row now keeps that its call answered it as held, for all three.

What withdraws a message, resending, the limits, the counts and the texts are unchanged. An ordinary message, answered as checked or deferred, is told of as before.

The first version of this repair marked the loss and saved it with the answer, and took the mark back in memory if that save failed. Independent review found that a save which replaced `workspace.json` and then failed on the room records left the mark on disk: after a restart the loss was never told. No single save can avoid this, since it writes two files one after the other and nothing is written after a failure. The second save happens only in an answer that tells of a loss.

## Checks

Second version: three of its four new tests fail on the first version (a save that fails on the room records, and the save of the mark failing before or after `workspace.json`); the fourth pins that an answer telling of nothing is saved once. One expectation of the first version changes: the mark is no longer set while the answer is being saved. A test of two losses in one answer is longer by one call. 9 mutants of the change are killed. 28 related test files: 1001 passed, none skipped. First version:

Seven of the eight new tests fail on the unchanged code; the eighth asserts what must not change, with rows from before the mark. The reviewer's two reproductions and the three further cases are among them, each told once. 53 related test files: 1451 passed, none skipped. All mutants of the changed conditions are killed. No full run. No model was called and the daily app was not touched.

## Independent review

Not by the author: the increment goes to the integration review's own reviewer, separately from the other repair. The first version was not accepted for the save described above; its second finding, messages answered as held, was. The second version goes to the same reviewer.

## Known limits

- A backend that ends after both saves and before its answer reaches the sender has told nothing, and does not tell it again: the price of never telling it twice.
- If the save of the mark fails, or the backend ends between the two saves, a restart tells that loss once more: the sender could send it twice, and hears of it at least once.
- If the save of the answer fails after replacing `workspace.json`, the file keeps the new message as registered although its call failed, as before this change.
- A row from before the mark, answered as held for the butler's minute or a quiet window and lost before anything held it, is not told of.
