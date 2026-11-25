## Stop cards merge, and a merged-away card leads to the one to answer (lane/claude-stop-resume-batch-20261124)

The person, 2026-11-24: 「点了(但是这几个卡没有合成一个,算是个 bug ,记录下以后修)」 about stop cards, and 「我没找到点卡的地方」. Base: 295's `60e5f40c`. Serves the vision's one entry: several waiting confirmations are one card, and the person finds it.

Reproduced on `60e5f40c`:
- Four `stop` cards from one sender stay four cards; `resume` cards already merge.
- Parked at the bottom, the merged card is out of view and each merged-away card looks like one to answer (amber, badge) with no button. The composer timer, the header timer and the header list do lead to the merged card when clicked; none of them says so.

Changes (`2c2e3ed1` and the commit that adds this record):
- `stop` joins the methods one "Confirm all" may answer, if its action is known. Ending a session and disconnecting Codex never share a card, nor do questions with different buttons. No other method changes. The main process still checks and receipts each card by itself.
- The merged card says once what is stopped. The phone's merged page shows the question's own text once above its rows, from waiting cards with current proof only; each card is still confirmed by its own passkey check.
- A merged-away card is one plain line: its sentence, 「已并入「全部确认（N）」」 and 「去确认」, which scrolls to the merged card and marks it. The composer timer reads 「去确认 · 剩余 m:ss」. The header is unchanged.
- The person saw the stop picture and said 「图没问题」; the archive picture follows the same design by the five-minute recommendation. Chinese text in the pictures is unchanged since. The phone's merged stop page (picture in the private evidence) was not shown to the person before this record.

Tests:
- Unit, red on `60e5f40c`: 28 pass, 7 fail; after: 82/82. After the review notes: 187/187 for the affected files, and 1035 for the mobile, locale, batch and timer files with one failure in a test fixture (it wrote every computed attribute into the text), fixed before the 187.
- Real Electron window, isolated profile, synthetic sessions: `test-batch-confirmation.cjs` 0/3 on `60e5f40c`, 3/3 after (the script's checks depend on each other, so the unit red is the precise one); `test-session-timers.cjs` 4/4.
- Real phone page with a virtual passkey: `test-phone-batch.cjs` 36/36; red once for the missing text and once for a target name left in it after the first answer. One earlier run stopped on its existing one-second countdown assertion and was not counted.
- Whole suite on `6a752cca`, all 623 files in six parts: 10352/10352, no skips.
- Trial merges with the 296 and 297 heads and the lanes waiting for 298 have no conflicts.

Review: one read-only session, three rounds. Round 1 (`2c2e3ed1`) PASS-WITH-NOTES, nothing blocking: phone page without the consequence, button without its own accessible name, English wording that lost "confirm", a missing-summary guard; all fixed. Round 2 PASS-WITH-NOTES: the target name left on the phone after the first answer; fixed. Round 3 PASS.

Not verified: the phone page with the real dialog text; jumping from a split pane other than the main conversation; a real VoiceOver reading. `test-archive-confirmation.cjs` and `test-consent-cards.cjs` fail the same way on `60e5f40c` and here, so they give no coverage. The tool row above a card still reads 「调用 stop」.

Undo: remove `stop` from `METHODS` and the `stop` lines in `confirmation-batch.js`, and `folded` with `renderMergedCard` in `renderer.js`.
