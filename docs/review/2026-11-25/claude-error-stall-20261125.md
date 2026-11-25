# Continue a Claude turn whose stream went idle, and tell the butler of a member that stays in error

A member's turn ended because the native client's own idle timer gave up on an open response after part of the answer. NAW did not know that cause, so nothing continued it; and a sent queue item is settled only once its member is idle, so the item stayed open in `error` with nobody told.

## Change

- `claudeFailureCause` also reads a saved error row with no HTTP status and `apiError: stream_idle_timeout` as `connectionFailed`. The same 2/5/10 minutes, limit of three, cancellations and words as a lost connection; one budget for both. No other new value, no error text.
- The dispatcher tells the butler's record once per delivery when a sent item's member has stood in `error` for three minutes with no automatic continuation scheduled or going out (`blocked`, reason `error-stalled`, with the member, the item and since when). Only told: nothing is settled, sent again or continued, and what counts as idle is unchanged.
- Not told: while the session holds a draft or the person was at it in the last two minutes, while its state is not known (backend or transport away, a native context change, an input going out), for a Codex usage limit, and when the turn's spent retries already have their line.

## Checks

- Real Claude 2.1.331 and 2.1.332 against a loopback synthetic API, outside network closed, no cost: one whole content block, then silence until the native timer ended it. The saved row is the incident's, without its text. Old code: the turn ends failed with no cause and nothing is scheduled. New code: `connectionFailed`, scheduled; also after three tool steps and after 60 text blocks. With the timer driven forward the continuation went out and the turn completed.
- 36 of the new and extended tests fail on the old sources, 0 on the new ones. 36 mutations: 35 killed at first, the one that survived (the line not read back after a restart) by a stronger assertion.
- 257 test files that name a touched source: 6174 passed, none failed or skipped.

## Known limits

- A turn with more than 64 text blocks is not scheduled: its display is marked incomplete, which clears the named error row (real 2.1.331, 70 blocks). That check is unchanged; the three-minute line covers the case.
- If the stall comes inside the first block, the native client falls back to a request without streaming; that is not an error and nothing here applies.
- A Claude usage limit or refused sign-in has no line elsewhere and its kind is not in the snapshot, so it is told as `error-stalled`. It is never continued.
- The three minutes are kept in memory: an app restart starts them over. A line already written is not repeated.
- A continuation the person ended (a draft, taking over) leaves `error`; the line then comes three minutes after the continuation was last seen scheduled.
- Passes come at most every thirty seconds in quiet, so a line can come up to half a minute late.
- If a spent-retries failure is cleared by a draft and the app restarts before the member leaves `error`, that failure can get this line as well.
