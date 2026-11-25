# Continue a Claude turn whose stream went idle, and tell the butler of a member that stays in error

A member's turn ended because the native client's own idle timer gave up on an open response after part of the answer. NAW did not know that cause, so nothing continued it; and a sent queue item is settled only once its member is idle, so the item stayed open in `error` with nobody told.

## Change

- `claudeFailureCause` also reads a saved error row with no HTTP status and `apiError: stream_idle_timeout` as `connectionFailed`. The same 2/5/10 minutes, limit of three, cancellations and words as a lost connection; one budget for both. No other new value, no error text.
- The dispatcher tells the butler's record once per stop when a sent item's member has stood in `error` for three minutes with no automatic continuation scheduled or going out (`blocked`, reason `error-stalled`, with the member, the item and since when). Only told: nothing is settled, sent again or continued, and what counts as idle is unchanged. A pass that saw the member at work, in an approval, in the background or at rest ends the stop; the next one has its own line. A lost connection or a starting backend does not.
- Not told: while the session holds a draft or the person was at it in the last two minutes, while its state is not known (backend or transport away, a native context change, an input going out), for a Codex usage limit, when the turn's spent retries already have their line, and when the person stopped the continuation the last pass saw scheduled (the stop button, or Esc or Ctrl-C in the terminal, as the workspace reads them). Opening, scrolling, other typing, taking over, a draft, or Esc with nothing scheduled is no such stop.

## Checks

- Real Claude 2.1.331 and 2.1.332 against a loopback synthetic API, outside network closed, no cost: one whole content block, then silence until the native timer ended it. The saved row is the incident's, without its text. Old code: the turn ends failed with no cause and nothing is scheduled. New code: `connectionFailed`, scheduled; also after three tool steps and after 60 text blocks. With the timer driven forward the continuation went out and the turn completed.
- 36 of the new and extended tests fail on the old sources, 0 on the new ones. 36 mutations: 35 killed at first, the one that survived (the line not read back after a restart) by a stronger assertion.
- 257 test files that name a touched source: 6174 passed, none failed or skipped.

## Review round

The first head was blocked by its reviewer:

- Once a continuation had gone out and its turn failed without a named end (a refused sign-in or a usage limit on an unclassified row, or more than 64 blocks), its record stayed `sending`, which held the three minutes back for good. Now only a scheduled continuation or an input going out holds them; the record itself is kept, since the limit of three counts on it.
- A continuation the person stopped was told after three minutes. Now it is not.
- Also changed: a clock set back starts the three minutes again instead of holding the line until the clock catches up, and the second stop of one delivery is told.

20 of the new and changed tests fail on the first head, 0 on this one; real stop paths (`interrupt`, terminal `input`, `claim`, `setDraft`) run through the workspace and the daily app's own note of them. 68 mutations: 63 killed at first, the other five by added tests. One older test that read the daily app's source text was changed with it.

## Known limits

- A turn with more than 64 text blocks is not scheduled: its display is marked incomplete, which clears the named error row (real 2.1.331, 70 blocks). That check is unchanged; the three-minute line covers the case.
- If the stall comes inside the first block, the native client falls back to a request without streaming; that is not an error and nothing here applies.
- A Claude usage limit or refused sign-in has no line elsewhere and its kind is not in the snapshot, so it is told as `error-stalled`. It is never continued.
- Everything but the line itself is kept in memory. An app restart starts the three minutes over; forgets that the person stopped a continuation, so that stop is told three minutes later; and forgets a stop seen to end, so if it comes after the first line and before the second, the second stop is not told. A line already written is not repeated.
- A continuation that ended by a draft (also one cleared again), a takeover or other words in the terminal is told three minutes after it was last seen scheduled.
- A stop counts by itself only if a pass saw the member between the two: work that begins and fails between two passes is part of the first stop.
- A continuation scheduled and stopped before any pass saw it is told.
- The phone page has no stop (its button says to use the Mac), so there is no such path to note.
- Passes come at most every thirty seconds in quiet, so a line can come up to half a minute late.
- If a spent-retries failure is cleared by a draft and the app restarts before the member leaves `error`, that failure can get this line as well.
