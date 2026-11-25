## Rotating a session by hand (lane/ext-r207-rotate-now-20261125)

The person asked for a "rotate now" choice (R207): rotations only came due by size, memory, compaction or context, and then waited for quiet.

Backend. `requestRotation` and `withdrawRotation` in `app/queue-dispatch.cjs`, reached from the person's window only (`sessionRotation` in `app/main.cjs`, not among what agents can call). A request starts the rotation there already is, without the size check and the quiet wait; what a rotation never cuts still holds it (the running turn, background commands, teammates, an unsent draft, decisions that cannot be carried, settings that cannot be carried, the one slot). The person's click and what they type afterwards do not stop it: their messages go to the successor as the supplement there already is. Undo works until the handoff is written. One already handed over is finished with its own successor, never with another. Each request, undo and dropped request is a line of `rotation-log.jsonl` (`asked`, `withdrawn`, `dropped`); a request not begun is kept in `rotations.json` (`requests`). No timer, no polling, no second path.

`rotationRows` says where each rotation stands, for the person's windows only (`sessionRotations` in the state). It is computed in the pass that runs anyway, and reads no extra snapshot.

The butler's own call (a commit by itself; the person's word for this one). `stewardRotate` in `app/main.cjs`: the designated butler, outside every space, asks for its own rotation, by the check its other calls pass (`stewardCaller`). Any other caller and any other target are refused, and it has no undo. Each call is a step of its record; the rotation log says `by: steward`. Its request is dropped when it is no longer the butler before it began.

Undo: drop this lane's commits. An older NAW ignores `requests` and the three new events.
