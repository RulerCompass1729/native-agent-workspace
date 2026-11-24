## Where the person's own step is: the wake chip opens once (lane/claude-handoff-step-20261124)

Recorded by the 293 integrator from the lane's evidence; the lane wrote no record under `docs/`.

When the next step is one only the person can take (abandon a handoff, update a backend), the top-bar 「大管家未叫醒」 chip now opens once by itself and the screen reader announces the handoff sentence once. Focus stays where it was. The chip folds back only when the person used the chip's own button; if that call fails, it stays open. The menu-item wording problem B found was already fixed in 290/291, so the lane uses that fix.

Range: `7a0d5f7c`, `a558a042`, `6fbe93d2` on 291's `641b3ee7` (rebased from 289).

Tests:
- `steward-wake-banner-step.test.cjs`: the 2 new cases fail on `641b3ee7`; 25/25 related after. The failed-click case fails on `a558a042`, passes on `6fbe93d2`.
- Whole suite on `7a0d5f7c`: 10178/10178. 126 related files on `6fbe93d2`: 1477/1477.
- Real Chromium with the real page, styles and render function on synthetic data: 36/36 (zh and en) — the details lay out, focus stays in the top-bar input, the live region gets the sentence once, the top bar keeps its 74 px height, the status node is in the accessibility tree.
- `scripts/test-task-board.cjs` on `6fbe93d2`: 297/0 (it has no case for the chip itself).

Review: one read-only session, three rounds, all PASS-WITH-NOTES with nothing blocking (r1 `7a0d5f7c` 5 notes, r2 `a558a042` 3 notes, r3 `6fbe93d2` 2 notes needing no change). Fixes from the notes: fold only after the chip's own button took the step (r1); rewrite the short text only when it changes, so it is not re-announced (r1); clear the taken mark when the call fails (r2). Left for the PM: if the person takes the step from the sidebar menu, the chip stays open without a button until the hold ends, about 0.9–2.6 seconds.

Not verified: that real VoiceOver announces the sentence exactly once.

Undo: remove the `key` / `ownStepRead` / `ownStepTaken` block at the end of `renderStewardWakeWarning` in renderer.js and the `ownStepTaken` lines in the step button's handler, and make `.wake-chip-text`'s role permanent again.
