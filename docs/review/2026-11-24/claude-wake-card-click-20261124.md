# Tell the butler about the person's click inside a migration quiet window

The person clicked a card the butler had raised and nothing happened. The click was recorded at once, but the butler's backend was in a migration quiet window, which holds every automatic message there, so no wake went out before the window ended.

A wake now passes the quiet window when an event after the last position is the person's own act (`person-actions.cjs`), on any agent's card and not only the butler's: a click on a card, a queue item answered, cancelled or marked handled, a native question or permission answered, or an authorization, grant, dismissal, withdrawal or close. A card or grant that ran out of time is not the person's act. Nothing else passes: ordinary events alone, patrols, queue items and other sessions wait as before, and every other check on a wake stays (the automatic-message switch, a paused butler, the two minutes after the person used it, a draft, a turn, background work, the minute between wakes, the model). No idle clock runs in a window, so there the butler's newest saved message has to be unchanged for eight seconds; this is not the same as eight seconds since its turn ended.

The turn such a wake starts makes the backend wait for its quiet again, so the move can happen later or the window can time out, after which NAW opens none for that backend for two hours. Each further act can do this again, at most one wake a minute. The window's deadline does not move.

## Checks

On the unchanged code 13 of the 17 new tests fail; the four that pass assert what must not change. Mutation runs over the new conditions leave one equivalent mutant and one in the catalog's wording. All 95 related test files passed (2938 tests) with the first version; what followed are tests only. A trial merge with the other open change to the windows had no conflict, and 110 wake and window tests passed on it. The checks called no model and the daily app was not touched.

## Independent review

A non-author review of the increment on the reviewed wake-reason change found nothing blocking. Its notes led only to wording, which it pre-approved, here, in two comments and in the commit message.

## Known limits

- A click within two minutes of the person using the butler's session, during its turn, or while it runs background work waits for that to end, as it does outside a window.
- The wake goes out with the next pass that finds it ready: within about half a minute, or up to about a minute and a half after the previous wake.
- The separate message telling the butler how its card was answered still waits for the window, and with event waking off so does everything.
- A wake on its way as NAW starts the move can make that move fail, and a failed automatic move is not tried again until the app restarts.
- Not yet checked with a real window in the daily app.
