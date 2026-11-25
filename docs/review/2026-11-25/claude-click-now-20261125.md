# A click on the butler's own card wakes it at once

The person clicked a card the butler had raised and again nothing happened. The migration quiet window had already closed; which gate held it was not recorded. A click waited like any other event for the two minutes after the person used the butler, the quiet before a compaction rotation, the minute between wakes and the butler's own background timer, and nothing was shown before ten minutes.

Now the person's answer on a card of the butler's, or of a session it continued from through rotations, confirmed or cancelled, waits only for:

- a turn, a permission or question of its own, teammates or an active goal; it goes out within about eleven seconds of the turn's end;
- an input on its way: a draft, a queued message, or keys typed in its terminal in the last twenty seconds;
- a rotation or handoff under way, a space it joined, the person's switches, the model rule, a state or backend that cannot take it (a failed or ended session, an interrupt or context change under way);
- a minute after an attempt that failed.

It no longer waits for the two minutes after the person used the butler, the quiet before a compaction rotation, the quiet window, the minute between wakes, or the butler's own background command or timer, reported or not. A click is looked at by the next three-second tick even when it changes no session. What holds it, unless it is its turn, a permission or question of its own or the eight seconds after a turn, is shown on the desktop and recorded at once; the phone's alarm keeps its ten minutes. Other events, the person's other acts, other agents' cards and expired cards are as before, and a patrol passes nothing more.

## Checks

On the unchanged code (the earlier quiet-window change included) 22 of the 30 new tests fail, the four cases the person's request named among them; the eight that pass assert what must not change. Five tests of the earlier change that clicked the butler's card where they meant any act of the person's now use another act. Mutation and related-suite results are in the lane's evidence. No model was called and the daily app was not touched.

## Independent review

A non-author review of the first version found one blocking item: a butler stopped in another state than idle (failed, ended, recoverable) or with a context change, an interrupt or a queued message pending was read as at work, so a click it held stayed silent for ten minutes. Only a real turn, a question of its own and the eight seconds after a turn are silent now; tests for each of those states fail on the first version. Its notes on the idle clock, on the unconfirmed background report and on a rotation record that cannot be read were taken too.

## Known limits

- The wake can arrive before the confirmed operation has finished; the separate answer message tells the outcome later, under its own holds.
- The turn a click starts makes a compaction rotation and a migration wait for their quiet again.
- After a turn it still waits eight seconds to know the turn ended; a turn's own permission or question is not shown as holding a click before ten minutes, being on screen itself.
- A butler the person designates anew does not answer for cards of the one before it, only for those of sessions it continued from.
- Text pasted into a native terminal input, with nothing typed, is seen only by the native client, which refuses the message where it can tell (Claude).
- Not yet operated in the daily app.
