# The designated butler may switch the permission to organize itself (R234)

The switch 「允许大管家直接整理本机工作」 was the person's only: an agent's call was an unknown command. The person asked that the butler be able to switch it itself. It serves "you only say what you want done": the butler no longer waits for a click to do what the person already allows it.

- `stewardStanding` is now an agent command, answered by this desktop, in the pattern of `stewardWake`. Only the butler designated now passes (`stewardCaller`: current, present, in no space), and only as a step of its record; anyone else is refused, as is a window that is not the person's.
- Once the person turned it off, the butler cannot turn it on; only the person can. Their off in the designation dialog counts the same. Off because another butler was designated is not the person's off. A file from before says no who: off counts as the person's, on does not. Who switched it is tied to the file's revision, so a switch by an older NAW does not keep an earlier answer.
- What the butler asks for that already stands changes nothing: no revision, no line, and an action under way keeps its grant.
- Each switch is one line of 「大管家的记录」 and one of the bell (kept in the file of the switch, the last 15). The butler's lines count until 「知道了」; the person's own are listed under 「全部」 and not counted. The dialog, the bell and the phone say that the butler turned it on or off, and when.
- What it allows is as before: the same actions, 30 an hour, creation equal or stricter. It is bound to the person's designation, so it goes on after an automatic handoff; that was already so and is only tested here.

After the independent review of the first head:

- A refusal before anything was written (the person's off, a caller or argument that is not allowed, no step in the record, a file that cannot be read or saved) is `not-executed` with a code (`HandlerRefused`), not an open outcome. A row of the record says 「它打开了/关掉了」 only for a step that says it switched; otherwise 「它要求…」, with its own sentence when it already stood so. The mark is the outcome's reason (`switched`, `already`), which an older NAW reads as before. The answer carries `changed`.
- A save that fails after the file was replaced is read back: when the revision moved it is a switch, recorded, rung and told. When it cannot be read back, the outcome is open and nobody is told that nothing changed. Windows that cannot be told afterwards do not undo a switch or its line.
- A permission that cannot be read is not one without switches: 「知道了」 stays, and the lines last read stay while the app runs. After a restart with a file that still cannot be read, the waiting lines are not shown until it can be.
- Off because the butler changed or turned it off: the dialog says that the butler can turn it on again, and leaves out 「你关掉后只有你能再打开」; the phone's line of the butler's off says so while it is the last switch.
- More than one argument is refused, as `stewardPatrol` does.
- Revoking a designation is not the person's off (only their manual off is): on for A, A revoked, B designated, B may turn it on. An explicit off outlives a revocation and is tested.

A NAW from before cannot read a `standingSwitch` line of the record (as with the kinds added earlier).

The checks: `app/tests/steward-standing-butler.test.cjs` (18; each fix is also taken out once and the tests fail), with the changed expectations in `steward-standing-follow`, `steward-entry` and `scripts/test-steward-standing.cjs`.
