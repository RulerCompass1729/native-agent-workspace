## Events recorded around a designation made by hand wake the new butler (lane/claude-wake-position-20261124)

The person (2026-11-24): work that is missed once and never picked up again is not acceptable. Designating a butler by hand turns the event wake off, and turning it on again started from what was recorded then: an event recorded in between was announced to nobody.

Change: a designation made while the wake is on keeps the position it had reached (`steward-wake.cjs reached`, `redesignated`; `main.cjs` steward handler, read before the designation moves). The next time it is turned on, one wake covers everything recorded since. Designated twice in a row, the earliest position is kept.

Unchanged: a designation still turns the switch off, and the person or the butler turns it on. The person turning it off and on, revoking the butler, and a replaced event record all start from what is recorded then.

Choices:
- A wake being sent while the designation moves or the switch is turned off does not move the position that left: the new butler hears what was being sent to the previous one.
- The kept position is the state file's existing field; its format is the same, and an older build starts from then.
- A kept position past the end of the same record (an older copy was put back) starts from then, as before.

Tests: 54/54 in the two files; the 4 new ones are red on the base `4fb97f10` (three on the behaviour; in the third, everything that must not change holds until the first call of the new method). 0 mutations of the new conditions left. Related: 152 files, 4108/4108 on `c32dde20`; the later commit changes one condition and comments.

Review: one read-only session, two rounds, PASS-WITH-NOTES, nothing blocking. Fixed from it: the position past the end of the record, and comments that said more than holds.

Left: a crash or a failed save between the two files of a designation, and a wake state already failed, lose the position. An older build's file that was turned off during a wake can start one wake from an older position. A record put back and grown past the kept position is not told apart. The banner's count of undelivered messages since the last wake can include the previous butler's. The limit on wakes about refused control calls is not reset by a designation. Found and unchanged: an off-write that fails during a wake can be undone by that wake's own write.

Undo: drop this lane's two code commits; the state file keeps its format.
