# 2026-11-25 — A rotation that misses its moment is finished (lane claude-rotation-finish-20261124)

Feedback (the person, 2026-11-24): 「这是个 bug:一旦错过就不再继续,这个肯定不行.」 A rotation whose successor had confirmed the
handoff ended as `kept` when the old session was in use at that moment. The kept record then blocked the old session from
every later rotation, the butler designation did not follow, and the handoff was lost.

Change. A confirmed rotation whose old session is not free now waits for it, for as long as it takes, and is then finished
and logged `done`; the designation follows that edge as before. While it waits it takes no rotation slot and holds neither
session, wake, quiet window nor install. What the old session did after its handoff is written by it once, told to the same
successor and confirmed there before the old one is ended. `kept` is left for a changed identity and a designation the
person moved. Every gate it waits at is logged once by name, never by content, and a long wait is told to the person and
is on the butler's record. A successor name already in use is avoided. Designate and revoke are unchanged, no timer, poll
or forced limit is added, and older kept records are read as before.

Checked without a model:

- Red first: 41 of the new tests failed on 7f4cfdc9, none by a type error.
- queue-dispatch and steward-entry 459/459; 71 related files 1,068/1,068; nothing skipped.
- 73 mutations (slot, upgrade conditions, one addition only, restart at each step, bounded holds, backend move, archived
  session): all killed, and the unchanged baseline passes. After the last change the ones on the archived path ran again.
- Trial merges: no conflict with main and 16 other heads; with ad1fd8c9 only both sides' review records. On the tree merged
  with d7ab68c5 (contains ecdde719) queue-dispatch 447/447, steward-entry and compaction-count 37/37; on the one merged with
  the alpha.299 candidate and the card click wake (bd047fa2) 447/447 and 15/15.

Independent review (a separate read-only Opus session, five rounds on one checkpoint):

| Round | Finding | Result |
|---|---|---|
| 1 | B1: the `ended` state a backend move shows for a moment was taken as a real end | Fixed, closed in 2 |
| 1 | B2: an archived old session that still runs waited for ever, untold | Fixed, closed in 2 |
| 2 | B3: while an addition was in hand or sent, the hold on both sessions had no limit | Fixed, closed in 3 |
| 3 | Notes: a send that left nothing behind held both again at each try; a successor gone while the old session was out of view | Fixed with tests, closed in 4 |
| 5 | The archived check moved out of `freshReady`, which another lane changes too | PASS |

Changed on purpose: an old session that shows ended is finished two minutes later than before, since a backend move shows the
same state; one out of view after 30 minutes. One successful addition per interruption; one that failed or came back empty
is asked for again after 30 minutes, then twice as long each time.

Verdict of rounds 3, 4 and 5: PASS-WITH-NOTES, zero blocking. Left as they are, each logged and told: a stale
backend-switch record and a successor permanently out of view hold the rotation until the person archives one; an old
session in `error` after being asked waits. A send that timed out and is delivered over two minutes later would be told twice.

Not verified: the installed app, real Claude and Codex sessions, and an interruption by a real person. The item stays open
until one such rotation has finished by itself in daily use.
