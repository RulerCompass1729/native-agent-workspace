# Tell a sender once of every message answered as held that was lost

Findings 1 and 2 of the integration review of the seven-change candidate. A sender's next call says which of its messages, answered as held, did not go out.

- The mark that a loss was told was set after the save of that answer. A backend that ended before its next save told the same loss again, and the sender could send the message twice. The answer is now saved first; then the mark is set and saved, and the answer tells the loss only if `workspace.json` was replaced by that save. If the first save fails the call fails, whatever it left on disk, and nothing is marked. If the second replaces no `workspace.json` the mark is taken back and a later answer tells the loss.
- A message answered as held for the butler's minute or for a quiet window, and lost while still registered (the recipient stopped, the sender's turn interrupted, the connection lost), was never told of: only one that something had held, or that waited for a recipient at work, was. The row now keeps that its call answered it as held, for all three.

What withdraws a message, resending, the limits, the counts and the texts are unchanged. An ordinary message, answered as checked or deferred, is told of as before.

The first version of this repair marked the loss and saved it with the answer, and took the mark back in memory if that save failed. Independent review found that a save which replaced `workspace.json` and then failed on the room records left the mark on disk: after a restart the loss was never told. No single save can avoid this, since it writes two files one after the other and nothing is written after a failure. The second save happens only in an answer that tells of a loss.

The second version told the loss also when the save of the mark failed. Independent review found that, when that save failed before it replaced `workspace.json`, a restart told the loss again. The third version tells it only with the mark on disk. Taking the mark back also drops the session's kept save JSON (`edited`), which a later checkpoint would otherwise write with the mark.

## Checks

Third version: two of its three tests of a failed save of the mark fail on the second version; the third (only the room records fail) passes on both. The reviewer's reproduction, with its expectation turned round, passes; as written it fails, since it asserts the duplicate. 28 related test files: 1002 passed, none skipped. 10 mutants of the change are killed; the eleventh, without the `changed()` before the save, changes no result, since `persist()` writes everything. Second version: three of its four new tests fail on the first version (a save that fails on the room records, and the save of the mark failing before or after `workspace.json`); the fourth pins that an answer telling of nothing is saved once. One expectation of the first version changes: the mark is no longer set while the answer is being saved. A test of two losses in one answer is longer by one call. 9 mutants of the change are killed. 28 related test files: 1001 passed, none skipped. First version:

Seven of the eight new tests fail on the unchanged code; the eighth asserts what must not change, with rows from before the mark. The reviewer's two reproductions and the three further cases are among them, each told once. 53 related test files: 1451 passed, none skipped. All mutants of the changed conditions are killed. No full run. No model was called and the daily app was not touched.

## Independent review

Not by the author: the increment goes to the integration review's own reviewer, separately from the other repair. The first version was not accepted for the save described above; its second finding, messages answered as held, was. The second version was not accepted for the save of the mark described above; the first finding it fixed was confirmed. The third version goes to the same reviewer.

## Known limits

- A backend that ends after both saves and before its answer reaches the sender has told nothing, and does not tell it again: the price of never telling it twice.
- If the backend ends between the two saves, a restart tells that loss in a later answer; the first had not been given.
- A rename that takes place and still reports an error cannot be told from one that did not: the loss is then marked on disk and not told.
- After a failed save of the mark the storage warning stands, and no message is accepted, nor the loss told, until the save is retried.
- If the save of the answer fails after replacing `workspace.json`, the file keeps the new message as registered although its call failed, as before this change.
- A row from before the mark, answered as held for the butler's minute or a quiet window and lost before anything held it, is not told of.
