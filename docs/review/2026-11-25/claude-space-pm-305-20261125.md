# The space project manager on alpha.304

The space project manager (recorded in `docs/review/2026-11-25.md`) was written on alpha.298. This is that change merged with alpha.303's head and then with alpha.304's locked head, and what the merge made wrong. The changes since alpha.298 that touch the same code include the rotation that waits for an old session in use, the held messages of `session-wake.cjs`, the change of model, the operation rows made once and the exit records.

Nineteen files conflicted with alpha.303 (several merge bases): fifteen of code and tests, two review records, `package.json` and `package-lock.json`. A three-way merge of the same two heads with the base the change was written on, alpha.298, differs from the result in 17 files: those fifteen, one review record, and one test without a conflict that named the removed queue secretary. The package files take alpha.303's version. Alpha.304's head had no conflict.

## Behaviour that did not conflict in the text

- A rotation that has handed the work over may now wait for hours until the person leaves the old session, and the session that has the work may itself be replaced meanwhile and logged as done. `earlierSessions` read only the rotation whose successor was that session, so an item the waiting manager had added could have gone to the successor's successor. It now follows the whole chain of done and unfinished rotations.
- The former secretary is retired once, with no space when it is in none. A waiting old session may be in none because it left its spaces for a stop that did not go through. That decision now waits until its rotation puts it back or names its successor. The person can still set a manager by hand.
- Two desktop scripts, which the test suite does not run, still called the queue secretary and looked for its menu item.

A test was added for each of the first two; each fails on the merge without its repair. Seven mutations of the new conditions: seven caught.

Known, and stated in `docs/space-project-manager.md`: while the old session is in use after the handoff the role stays with it, so the successor cannot add to the queue and is not limited until the old session is ended or the person sets the successor. Not repaired, as found by the reviewer:

- A waiting manager that has left its space is shown as manager but is limited by no space, and other spaces' agents can reach it. It can add nothing, and it ends with the rotation.
- A former secretary that has left its space in mid-rotation is retired without its rotation being seen when the dispatcher did not start or its rotation record was rejected. The person then sets the manager.
- What a session continues from is computed for each candidate of each item, and reads the log each time.

## Checks

- 226 test files related to the changed modules at b917f9e9: 5,976 tests, none failed, none skipped. The same set, extended with the tests of alpha.304's changes, on the merge with alpha.304: see the delivery note on the board.
- A hidden run of `test-steward-entry.cjs` passed on this branch and on alpha.303. `test-background-control.cjs` does not run to its end on alpha.303 either: a catalog assertion that names commands it does not exclude, and a button that is now named 「确认」. Its part with the manager was run in a private copy up to the record line, which needs a page the earlier parts prepare; the designation, the manager's own item, the refused withdrawal and the manager's withdrawal ran through the real MCP path.
- Not run: the full suite, the installed app, a real rotation.

## Independent review

The reviewer of the original change, resumed twice (read-only tools, no MCP). At b917f9e9, before alpha.304: the conflict places and the later commits, PASS with the three notes above. It did not read the conflicts in the tests to the end, how a wholly unreadable rotation record is treated, or the stop and restore code of the model change, and ran nothing. At 514497ea: alpha.304's change of `app/` against this one, and this record, PASS with corrections to the record's wording, which are made; alpha.304's own correctness was not its subject. The head and the working tree were unchanged after the second.
