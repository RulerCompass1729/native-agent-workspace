# A space's header, four tabs, 总览 and 信息流: rework 1 (lane/newreq-space-ui-20261125)

Requirements: ledger R247, R248 and R249, including the person's words at 19:09 on 11-25: 「信息流能把所有 对应 agent 的消息包含进去」. Trigger: the independent review of `a48b1a68` (session 4897c409) returned BLOCK with F1 and F2. The PM added F3 to F9 and the fixture fix. This rework starts from `a48b1a68`, on base `650a3805`.

## What changed
- **F1** (`app/task-stream.js`): `spaceFeed` now calls `speechStream` with `every`, so every finished reply is a line, including replies said while the member's turn is still running.
  - Streaming, running and awaiting-native text stays out, as do commentary and volatile rows.
  - `lastReply(session)` gives both 总览's 「最后说的话」 and the newest reply line in the feed.
  - A member whose messages this window omits shows its `messageSummary.lastAssistant` once.
  - 全部空间: `membersOf` in `renderer.js` no longer empties the messages of other spaces' members. It passes on the session records this window already holds, so nothing new is requested or sent.
  - The phone's 「对话」 keeps the old rule (each turn's last reply).
- **F2**:
  - `scripts/test-space-speech-stream.cjs` was rewritten in place to test the 信息流 (same file name).
  - `scripts/test-sidebar-collapsed.cjs` now reads the open space from the row's `in-current-space` class, or from `.session-space-group.current-space` in 按空间分组, and reads `active` as before. Its narrow-sidebar checks are unchanged.
- **F3**: the tint is now `.session-row.in-current-space:not(.active)`, so the open member's row keeps `--selected`. `test-space-feed-ui.cjs` compares the computed colours.
- **F4**: a search result opens the 信息流 at that line (`data-search-target`, scrolled to and focused). A record that is not a line opens its original session.
- **F5**: `openSidebarRow` opens a member of the open space in its 成员 tab. Any other row opens its session alone, as on base, including a row under another space in 按空间分组.
- **F6**: the feed builds lines only while it is visible. When hidden, it drops its lines and cache and keeps its filters.
- **F7**: startup and `restoreRoomView` always land on 总览 with no member open.
- **F8**:
  - A wait the person answered becomes 「已处理」 in 派活 · 交付. Only the newest wait of an item still waiting stays 「等你」.
  - A reply that asked the same question as its wait is dropped, and its text goes into the wait's body.
  - Text changes:
    - en "Go answer" and "Last reply";
    - kind 「通知」/"Notice" instead of 「空间」/"Space";
    - 「相关往来」 without ↗.
- **Fixture**:
  - The queued item in `test-space-feed-ui.cjs` is assigned to the busy PM, so no idle member takes it mid-test.
  - The speech-stream queue notice now goes into `room-state.json` before launch. Space events live in the window process, so the service fixture's `room.events` never reached the window, also on base.
- **F9** (dead code removed): `getSpeechStream`, the `speechStream` variable, `app/renderer/speech-stream.js`, `app/renderer/speech-stream.css` (with their build and HTML entries), `openSpaceMember` and `revealSpaceMember`.
- **Pre-existing failure fixed in the sidebar script**: the butler's header cell carries `agent-steward` (from 18059caa, after the script's last green run at 5a672ade). The class comparison now ignores that role mark.

## Evidence (private, `.local/evidence/newreq-space-ui-20261125/`)
- Red, then green:
  - `rework1-f1-red.log`: 3 of 9 failing on the old model.
  - `rework1-f8-red.log`: 2 of 11 failing.
  - After the fixes, space-feed and speech-stream pass 22/22.
- Unit tests: `rework1-related-tests.log`, 57 files that use the changed modules, run whole: 858 of 858 pass, 0 skipped.
- GUI, hidden isolated instances, synthetic fixtures, zero model calls:
  - `rework1-feed-ui.log`: 14/14. Run 1 failed on the old grouped-view expectation, see F5.
  - `rework1-speech-stream.log`: 14/14. Run 1 failed on the fixture notice.
  - `rework1-sidebar-collapsed-zh.log`: 97/0.
  - `rework1-sidebar-collapsed-en.log`: 97/0.
  - Earlier failing runs are kept beside them with `-run1-fail` and `-run2-fail` in their names.
- Screenshots are in the private picture directory, in `rework1-*` folders.

## Not run, and side findings
- The full suite was not run: its lock was held by a live integration run.
- The daily app was not touched.
- Side finding 1: in 按空间分组, the space heading is sticky (`sidebar-hierarchy.css:40`). At 850×600 in English, the session list is 56 px tall and the three-line heading covers every member row, so none can be clicked; zh fits.
  - `test-sidebar-collapsed.cjs` now opens that member by keyboard for its geometry check.
  - This lane did not change the sidebar's layout.
  - Matters when someone uses a short window in English.
- Side finding 2: the phone's 「对话」 still leaves out native-block replies (`kind: 'response'`). Matters when a Claude member's final words arrive only as such a block.
- `test-space-speech-stream.cjs` no longer checks arrow-key movement across the names row (the feed's people are plain buttons) or the saved 'conversation' view (F7 removed it).
