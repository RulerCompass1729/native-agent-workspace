## A stop card for an archived session reaches the person (R231.1, lane/claude-archived-stop-card-20261125)

The person (2026-11-25): 「我没看到你说的卡」. An agent asked to stop a session that had been archived. Archiving keeps the process running, so the stop was what ended it. The card never showed: one expired, and another stayed waiting until the session was restored, which held a backend move for about half an hour.

Cause: `confirmationState` (`app/background-control.cjs`) judged every card whose guarded session is archived as not actionable. The bell, the reminders list and the task board list only actionable cards, so the card was hidden.

Change: a `stop` whose guarded session is the stop's own target is judged as before, except that the target may be archived. Unchanged:
- Any other method against an archived session.
- A stop asked by an archived session.
- A stop whose target was archived after the person was asked. Its guard changed, so it stays unverifiable.
- The click path (`carryOut` and `perform`), which never checked archiving.

Tests: `app/tests/background-archived-stop.test.cjs`, 3 tests.
- On `650a3805` the first test is red: the card is `unverifiable` and the bell shows 0.
- With the change it is green, the card is in the bell, and confirming it runs the stop handler once.
- A mutation that drops the archived check makes the second test red, because interrupt and rename become actionable.
- 28 related test files run one at a time: 671 of 671 pass.
- No full suite ran (a release run was in progress); no model, the daily app or a card was used.

Review: required, since a confirmation gate is a permission boundary. A non-author reviews after READY.

Undo: drop this lane's commit.
