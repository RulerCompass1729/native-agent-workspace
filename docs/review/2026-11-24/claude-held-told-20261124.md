# Tell a sender once of every message answered as held that was lost

Findings 1 and 2 of the integration review of the seven-change candidate. A sender's next call says which of its messages, answered as held, did not go out.

- The mark that a loss was told was set after the save of that answer. A backend that ended before its next save told the same loss again, and the sender could send the message twice. The mark is now in the same save as the answer. If that save fails the call fails and the mark is taken back, so the next answer tells it.
- A message answered as held for the butler's minute or for a quiet window, and lost while still registered (the recipient stopped, the sender's turn interrupted, the connection lost), was never told of: only one that something had held, or that waited for a recipient at work, was. The row now keeps that its call answered it as held, for all three.

What withdraws a message, resending, the limits, the counts and the texts are unchanged. An ordinary message, answered as checked or deferred, is told of as before.

## Checks

Seven of the eight new tests fail on the unchanged code; the eighth asserts what must not change, with rows from before the mark. The reviewer's two reproductions and the three further cases are among them, each told once. 53 related test files: 1451 passed, none skipped. All mutants of the changed conditions are killed. No full run. No model was called and the daily app was not touched.

## Independent review

Not by the author: the increment goes to the integration review's own reviewer, separately from the other repair.

## Known limits

- A backend that ends after the save and before its answer reaches the sender has told nothing, and does not tell it again: the price of never telling it twice.
- If `workspace.json` is replaced and saving the rooms then fails, the call fails but the file keeps the mark; a backend that ends before the next save does not tell that loss.
- A row from before the mark, answered as held for the butler's minute or a quiet window and lost before anything held it, is not told of.
