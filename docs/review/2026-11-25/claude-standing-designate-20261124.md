## The organizing permission goes with a butler the person designates (lane/claude-standing-designate-20261124)

The person (2026-11-24): the permission to organize work on this Mac should follow the new butler. It is bound to the designation, so it followed a finished handoff; a butler designated by hand, after a handoff that kept the old session, silently lost it.

Change: the designation dialog has one line, 「也允许新大管家直接整理本机工作」, only while the permission is on for the butler being replaced, checked by default. Left checked, it moves to the new designation; unticked, it is turned off. `steward-standing.cjs carry` is asked before the designation moves and writes after it, both inside the join queue, and needs the person's current window. The done-chain handoff is unchanged.

Choices:
- "On" means effective for the butler being replaced, not only `on: true` in the file. A permission left over from an earlier designation is not offered: offering it would widen it by default. The person turns it on once in the butler's record; from then on it follows.
- The very same butler designated again (the duty statement sent again, a done-chain successor included) keeps it; before, that lost it silently. Its session in another native conversation is asked.
- A caller that does not ask leaves the file as before. The hourly count is kept.
- A permission that did not follow (not saved, or turned off elsewhere meanwhile), or an untick that could not be saved, is said with the duty statement's own failure. What is said is judged by what holds afterwards.
- Reading the switch no longer tells every window; the dialog reads it each time it opens.

Tests: 39/39 in the three files; 9 of the 39 red on the base (`d3a2a08a`, the 298 main-process-heap head; only the handler's signature cut differs). 46 mutations of the new conditions, none left. Related: 242 files, 5109/5109 on `cb824e9d`, and again on the last code head. Hidden Electron with synthetic sessions: no line while off; one line, checked, for another session only; confirmed, it is on for the new one; unticked, it is off. No crash report was added.

Review: one read-only session, three rounds, PASS-WITH-NOTES, nothing blocking. Fixed from it: the session in another native conversation, the notice hidden behind the dialog, the unsaved untick, the notice judged by the exception instead of the result, and the entry script's wait.

Left: designating again the session an old file is still bound to turns the permission on without the line (the older binding rule). After a failed untick, the record's switch already reads off for the new butler; clearing the file takes turning it on and off. A permission turned on in another window while the dialog is open is not offered. `scripts/test-steward-entry.cjs` still stops at line 125, on the row's tooltip wording, which comes from the base.

Undo: drop this lane; the file keeps its format.
