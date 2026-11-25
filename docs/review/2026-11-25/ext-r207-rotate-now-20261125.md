## Rotating a session by hand (lane/ext-r207-rotate-now-20261125)

The person asked for a "rotate now" choice (R207): rotations only came due by size, memory, compaction or context, and then waited for quiet.

Backend. `requestRotation` and `withdrawRotation` in `app/queue-dispatch.cjs`, reached from the person's window only (`sessionRotation` in `app/main.cjs`, not among what agents can call). A request starts the rotation there already is, without the size check and the quiet wait; what a rotation never cuts still holds it (the running turn, background commands, teammates, an unsent draft, decisions that cannot be carried, settings that cannot be carried, the one slot). The person's click and what they type afterwards do not stop it: their messages go to the successor as the supplement there already is. Undo works until the handoff is written. One already handed over is finished with its own successor, never with another. Each request, undo and dropped request is a line of `rotation-log.jsonl` (`asked`, `withdrawn`, `dropped`); a request not begun is kept in `rotations.json` (`requests`). No timer, no polling, no second path.

`rotationRows` says where each rotation stands, for the person's windows only (`sessionRotations` in the state). It is computed in the pass that runs anyway, and reads no extra snapshot.

The butler's own call (a commit by itself; the person's word for this one). `stewardRotate` in `app/main.cjs`: the designated butler, outside every space, asks for its own rotation, by the check its other calls pass (`stewardCaller`). Any other caller and any other target are refused, and it has no undo. Each call is a step of its record; the rotation log says `by: steward`. Its request is dropped when it is no longer the butler before it began.

Windows. 「现在就换会话」 / 「撤销换会话」 is one item of the session's three menus (the list row's, the title bar's, a member's), for Claude and Codex sessions. The row is the handoff notice there already was (`renderSessionHandoff`), above the composer: what the rotation waits for, with 现在就换, 撤销 or 前往 beside it; above the terminal where that session shows no input. What only the person can end is in red. A gate with no words of its own uses the wakes' words when asked for, and shows no row when it only came due. The second click of a double-click is ignored, since 撤销 takes the place of 现在就换. Not seen in a real window yet: the GUI slot was taken.

Undo: drop this lane's commits. An older NAW ignores `requests` and the three new events.
