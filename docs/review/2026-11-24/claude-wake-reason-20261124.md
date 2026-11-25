# Say what really holds the butler's wake while it works

The person found it strange that the butler had reported that NAW could not tell whether it had background work. That was not what held it: for part of the time a migration quiet window did. The butler reads its wake state in its own turn, where Claude's background report is always stale, and the check for a stale report comes before the quiet window. The turn's own delivery in flight hid the window as well, as `not-idle`.

During a turn, `heldReason` now leaves out the stale report and that delivery. The read says `quiet-window` with its deadline, another reason that will still hold the butler after the turn, or `not-idle`. `sessionReady` is unchanged, so nothing is sent or held differently. `blocked.since` and `blocked.minutes` belong to the current reason; `waitingSince` and `waitingMinutes` keep the whole wait, which the person's banner, its ten minutes and the record still use. The butler's own read lists the open quiet windows: backend, deadline, sessions and the number of queued items waiting behind each.

## Checks

On the unchanged base, 14 of the 17 new tests fail; the three that pass assert behaviour that must not change. Mutation runs over the new conditions leave no survivor except one equivalent mutant; the other early survivors got an assertion, and one redundant check was removed. The 128 related suites ran on the first version with nine failures. Seven, in `decision-notice.test.cjs`, also fail on the base. The other two passed on the base and on the change with the normal temporary directory. The core suites passed again on the reviewed version (766 of 766). The checks called no model and the daily app was not touched.

## Independent review

A non-author review found nothing blocking and no path newly sent or held. Its notes led to these changes: a turn with an approval or question flagged on the session keeps reading `not-idle`, an item whose assignee left its space is not counted, a deadline shows only beside its own reason, and the catalog says when the count was taken. The same reviewer accepted the changes and pre-approved the final wording.

## Known gaps

- A native Claude permission prompt sets no busy flag, so in a quiet window the read names the window while the prompt waits for the person.
- A queued input during a turn still reads `not-idle` until it is taken.
- The count of queued items is as of the last dispatch pass, and a background count from an earlier turn is not shown while the butler works.
- No event tells the butler that a window opened; it has to read.
- Not yet checked with a real window in the daily app.
