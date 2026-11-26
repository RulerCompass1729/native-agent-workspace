# A space's header, four tabs, 总览 and 信息流: follow-up 2 (lane/newreq-space-ui-20261125)

Requirements: ledger R247 and R248. Trigger: the independent review of `60353358` (session 4897c409, round 2) passed with non-blocking findings. The PM chose N1, N4 and N5 for this follow-up; N2 and N3 change no code. This follow-up starts from `60353358`.

## Correction to the 11-25 record

- `docs/review/2026-11-25/newreq-space-ui-20261125.md`, side finding 1, says "This lane did not change the sidebar's layout." That is wrong for the list inside a space.
  - On the base, the list inside a space was a plain list of its members, with no group headings.
  - R247 keeps the grouped list inside a space, so the sticky heading covered the member rows there too.
  - Outside a space, the sticky heading was already there before this lane.

## What changed

- N1: a space heading sticks only while the list has room for it.
  - `fitSidebarStickyHeadings` (`renderer.js`) measures the tallest space heading against the list's height. It sets `data-sticky-headings` to true only while that heading takes at most 40% of the list.
  - 40% is VS Code's limit for its tree's sticky scroll (`maxWidgetViewRatio = .4` in the installed VS Code workbench bundle).
  - It runs after each sidebar render, and whenever the list's size changes (the existing ResizeObserver).
  - `sidebar-hierarchy.css` makes the heading sticky only under that attribute. In a shorter list, the heading scrolls away with its rows.
  - The folder view's heading is unchanged. It is one 32 px line, so at 850×600 it leaves part of each row clickable.
- N1 test: `test-sidebar-collapsed.cjs` now opens the member by mouse, in place of the keyboard.
  - It first checks that the point at the centre of the row hits the row.
  - Expanded, the heading must be static at 850×600 and sticky at 1240×820.
- N4a: `elsewhere` is replaced by `marks`.
  - `marks` lists every element in the page marked as the open space (`.current-space`) or as one of its members (`.in-current-space`), with where each one is.
  - Grouped by space, it must be exactly the open space's group, inside the sidebar list.
  - Each run also adds a stray mark outside the list and checks that `marks` reports it, so the check is shown to fail when it should.
- N4b: `test-space-speech-stream.cjs` checks each line's accessible name again.
  - It reads the name Chromium's accessibility tree gives each line's summary, through CDP.
  - For each of the seven 说的话 lines, the name must start with the time, contain who spoke (and `→` the recipient), and contain the text.
- N5: deleted after a grep for every caller.
  - `returnRoomRecordMember`, its click handler, the `#room-record-return` button and the four lines of `renderTimeline` that set it.
  - `roomRecordSelections`: nothing ever wrote to it; only `returnRoomRecordMember` read it.
  - `filteredTimeline`. Its callers were in the old 记录 view, which R248 removed (`ROOM_SURFACES` has no 'records'; the toolbar and `#room-messages` are always hidden). So these went with it:
    - the drawing of the hidden `#room-messages` list in `renderTimeline`;
    - `#timeline-count` and its CSS;
    - `#copy-timeline` and its click handler.
  - Text keys, zh and en: `room.conversation`, `room.returnMember`, `room.recordCount`, `room.filteredRecordCount`, `room.copy`, and `speech.all`, `.names`, `.list`, `.you`, `.to`, `.newMessages`, `.expand`, `.collapse`, `.empty`, `.emptyMember`.
  - Kept: `speech.unverified` and `speech.unknown`, which `space-feed.js` still uses; `timelineParticipants`, which `spaceMessagePreviewRows` still uses.
  - Unit tests that cut these functions out of the renderer were updated:
    - `room-navigation` and `room-member-navigation` no longer load the deleted functions.
    - `space-message-preview` cuts up to `getActivityStream`.
    - `operator-ui` now tests `timelineParticipants` directly: a report's sender and initiator are participants, and the row gains no native attribution.
- Interface text: none added or changed. Only the unused keys above were deleted.

## Evidence (private, `.local/evidence/newreq-space-ui-20261125/`)

- Red: `followup2-n1-red-en.log`, with the new tests on the unfixed code. 103 pass and 2 fail, both "850 light/dark expanded inside a space a member row takes a mouse click". The point at the row's centre hit the heading's `sidebar-space-meta`, and the list was 56 px tall.
- Unit tests: `followup2-related-tests.log`, the 125 test files that read `renderer.js`, `index.html`, `ui-messages.js`, `styles.css` or `sidebar-hierarchy.css`. 1578 of 1578 pass, 0 skipped.
- GUI, hidden isolated instances:
  - `followup2-sidebar-collapsed-{en,zh}-2.log`: 105/0 each. This includes the mouse check, the heading's position and the `marks` check with its stray-mark proof.
  - `followup2-speech-stream.log`: 15/15. It prints the first two names, e.g. 「▸ 01:02 说话 大管家 → Claude B B，文档进度怎么样？」.
  - `followup2-feed-ui.log`: 14/14.
  - Failed runs are kept: `followup2-speech-stream-run1-fail.log`, where the name check expected the time first (side finding 6).

## Not run, and side findings

- The full suite was not run. An install check on the daily app had just been stopped by memory compression (board 11-26 00:40), and the brief asks only for the changed tests.
- The daily app was not touched.
- Side finding 3: four older GUI scripts still drive the 记录 view that R248 removed. They are `test-room-navigation.cjs`, `test-room-member-route.cjs`, `test-native-addressed.cjs` and `test-graphical-followthrough.cjs`.
  - They click `#room-record`, which this lane hid (it was visible on `650a3805`), then use the filter, `#room-record-return` or `#copy-timeline`.
  - None is in `package.json`. From the source (not run): `#room-record` is hidden (its handler now opens 信息流), so each would stop waiting for it at that first click, with or without this follow-up.
  - Matters when someone runs them for room navigation or addressed delivery; they need rewriting for the four tabs, or retiring.
- Side finding 4: the rest of the old 记录 view is still in the page, hidden. That is the search box and member filter, the record context, the thread heading, `#room-messages`, the saved `roomRecordScope`/`roomRecordReturn`/`roomFilterHistory`, `lastRoomMessages`, and the 记录 restore in `search-view.js`. Removing it touches search and saved views, so it is left for its own item.
- Side finding 5: `test-space-speech-stream.cjs` takes the GUI slot under its own checkout's `.local`, not the main checkout's as the other GUI scripts do. That predates this lane, and the script still runs on its own. Before running it from a lane worktree, check the main slot by hand.
- Side finding 6: in every disclosure list, a line's accessible name starts with the ▸/▾ drawn by `styles.css:1357` (`summary::before`, from `c2625213`).
  - The native disclosure state is announced anyway, so screen readers also read out a triangle character.
  - A fix would be CSS alternative text (`content: '▸' / ''`). It is shared CSS that changes every disclosure list, so it is left for its own item. The new name check allows the marker.

# Follow-up 3: four GUI scripts on the new space UI

Requirements: R247 to R249. Brief: `newreq-r247-249-followup3-20261126.md`, queue item 0e51786a. Trigger: follow-up 2, side finding 3. This follow-up starts from `29e1fa70` and changes tests only: the four scripts and `scripts/fixtures/room-navigation.cjs`.

## Results (hidden isolated instances, run one at a time on the main checkout's GUI slot)

| Script | Result | Log (`.local/evidence/newreq-space-ui-20261125/`) |
| --- | --- | --- |
| `test-room-member-route.cjs` | 6/6 pass | `followup3-member-route-6.log` |
| `test-graphical-followthrough.cjs` | 7/7 pass | `followup3-followthrough-2.log` |
| `test-room-navigation.cjs` | checks 1–5 pass; exits 1 on 2 open product gaps (gaps 1 and 2) | `followup3-navigation-4.log` |
| `test-native-addressed.cjs` | not run: it stops at its version gates, which were there before this lane | `followup3-native-addressed-1.log` |

- Language: each script runs as before. Navigation reads both the zh and en `collab.contextUnknown` labels; the others drive the zh interface.
- native-addressed:
  - Codex 0.172.0 is not qualified for `addressedTool` (line 22).
  - Claude 2.1.332 is outside the 2.1.309–311/322 pattern (line 26).
  - Both gate lines are unchanged. No provider, fixture or GUI was started.
- Failed runs are kept:
  - `followup3-member-route-before-fail.log`: the old script stops at its first member tab (line 80).
  - `-member-route-1` to `-4`.
  - `-navigation-1` to `-3`.
  - `-followthrough-1`.
  - `-wake-probe.log`.
- Assertion and wait calls, counted against HEAD:
  - followthrough 78 → 80;
  - native-addressed 132 → 133;
  - member-route 68 → 75;
  - navigation 108 → 106. Two of the old 记录 view's restore checks have no 信息流 counterpart; see the table.

## Product gaps (reported on the board, not fixed: product code waits for the PM)

1. An unverified wake loses its warning in the 信息流.
   - `workspace.cjs:1309` writes 「无法核对发送方的原消息，投递结果未确认。」 before the wake's body when the sender's original is missing.
   - The 信息流 line takes `wake.body` (`task-stream.js:177`), so the line reads as an ordinary delivered message.
   - Evidence: `followup3-wake-probe.log`, and navigation check 2's `OPEN GAP` line.
2. 返回 from a search result does not bring back the 信息流's names and search words.
   - `seek` (`space-feed.js:173`) clears the people, the group and the search to show the found line.
   - `returnToReading` (`search-view.js:175`) restores the surface but not those filters.
   - Navigation check 2 prints `pressed [], search ""` after 返回, where A was pressed and the search was 'Synthetic'.
   - This conflicts with the brief's 「搜索框里的字保留」.
3. The 信息流 does not tell same-name members apart.
   - The name buttons show only the name (`space-feed.js:85`), and so do the lines (`space-feed.js:114`). No short id appears.
   - V13/U22 had the sidebar tell same-name sessions apart (`docs/product.md:116`).
   - native-addressed's three-member run now checks this on the 信息流 (`gap()`), but it cannot run here. This finding is from source only.

## Old step → new entry, or where it is verified now

| Script | Old step | Now |
| --- | --- | --- |
| member-route, navigation | member tabs `#room-member-tabs button` | left-list rows `#session-list .session-row .session-link` (R248 ③); the row of a space member has `in-current-space` |
| all four | `#room-record` (记录) | the `#room-stream` tab (信息流), after R248 ② merged the 记录 view into it |
| all four | `#room-filter` | the 信息流's name buttons `.feed-person` (`aria-pressed`) |
| member-route, navigation | `#room-search` | `.feed-search`; its words stay across tab switches (member-route 1, navigation 1) |
| member-route, navigation | `#room-record-clear` / `#room-record-restore` and the saved history filter (`roomFilterHistory`) | removed with the 记录 view (R248 ②); clearing is emptying the search and releasing the names. A saved filter is not restored on reopen, which lands on the 总览 (R248 ①) |
| member-route, navigation | `#room-record-return` after 相关记录 | the `#room-member` tab 「成员 · <name>」 (R248 ③; follow-up 2 N5 deleted the button). Reading position, selection, caret and drafts are checked after it |
| member-route, navigation | removed member: 返回 disabled | the 成员 tab no longer names the member, and opening it gives a current member (member-route 6, navigation 4) |
| member-route, navigation | reload keeps the related scope | reload lands on 总览 (R248 ①); the 成员 tab returns the member in its saved native mode (member-route 3) |
| navigation | the wake row's warning | fixture kind `notice` → `agent-wake`, the product's shape; the warning → gap 1 |
| navigation | 返回 after a search result restores the scope | 返回 lands on the 信息流; the names and words → gap 2 |
| navigation | `kept.roomFilter` / `kept.roomSearch` | the 信息流's search words captured right after 返回 |
| navigation | member tab boxes inside the window at 820×720 | each left row inside the window after `scrollIntoViewIfNeeded`; the four tabs take End and exactly one has tabIndex 0 |
| followthrough | 「分享已失效，回复保留在原会话」 on the request row | no line shows delivery states (side finding 3). Checked by the script's wait for `reply-private` and `shared-replies.test.cjs:163` |
| followthrough | 「查看会话」 on the request and pause rows | each line's 「打开原会话」 (`.feed-original`); contrast 18.9 light / 13.3 dark; Tab reaches it with `:focus-visible` and Enter opens the session with the approval |
| followthrough | pause row author 「协作」 | the line's kind is 通知 and it names no speaker |
| followthrough, native-addressed | `#copy-timeline` and the copied text | no copy in the 信息流 (R248 ②; N5 deleted the hidden button). The content check reads the filtered line's text (followthrough 3). In-memory clipboard writes: 1 → 0 |
| followthrough | `#room-notes` in the hidden toolbar | the space's 「⋯」 menu `#room-header-more` → 共享笔记 |
| followthrough | note search result row | the `record:<id>` line with `data-search-target` |
| followthrough, native-addressed, member-route | `#terminal-tab` in a member view whose terminal is closed | `#open-native-terminal` 「打开终端」 (followthrough 1, member-route 3) |
| native-addressed | `[data-session-id=X]` | `#session-list .session-link[data-session-id=X]`, because the 总览 table and the status row carry that attribute too. Same selector as followthrough's `selectSession` |
| native-addressed | `#room-messages` text (7 places) | the 信息流 list text; same reading as member-route 1/6 and navigation 1/2 |
| native-addressed | native turn notices' heading has the participant's short id | the 信息流 skips a member's mirrored stream rows (`spaceFeed`, `sharedStream`); each member's reply line must carry its short id → gap 3 |
| native-addressed | `#collaboration-overview` statuses with short ids | the same check after the `#room-overview` (网格) tab; not run |
| native-addressed | copied and forgotten authors and recipients keep short ids | the 信息流 text → gap 3 |

## Side findings

- Side finding 1: the 信息流 has no copy.
  - The brief lists 「复制下来的内容是对的」. Copying went with the 记录 view under R248 ②.
  - If the person wants copy back, it is a new item for the 信息流.
- Side finding 2: `scripts/fixtures/waiting-stream-dom.cjs:30` still looks for `#stream-waiting`.
  - It is loaded only by `app/tests/task-waiting-parity.test.cjs` and `task-waiting-classification.test.cjs`, not by these four scripts. It was not changed.
- Side finding 3: no view in a space shows a request's delivery state, such as 「分享已失效，回复保留在原会话」 (`reading.status.private`).
  - `reading-list.js:939` draws it only into the hidden `#room-messages`, and no unit test checks the label.
  - The member's reply itself is a 信息流 line.
- Not run: the full suite, and native-addressed past its gates. The daily app was not touched.

# Follow-up 4: the three 信息流 gaps and side finding 3, fixed

Requirements: R247 to R249. Brief: `newreq-r247-249-followup4-20261126.md`, queue item ad8b284e. This follow-up starts from `638e55ab`. It changes product code only at the four places the brief names, plus their tests. It does not touch delivery logic.

## What changed

1. An unverified wake keeps its warning (gap 1).
   - `app/task-stream.js:177`: a wake line keeps its record's own text and `uiMessage` for every state short of native receipt (`wakeStatus` other than `submitted`). A received wake still reads as its body.
   - The missing-original case (`workspace.cjs:1309`, `notice.wake.senderRemoved`) is the gap the brief names. The same condition also covers unconfirmed, not sent, held and cancelled wakes: their text states their delivery too, and the line showed only the body.
   - Desktop: `space-feed.js:70` renders the text through `uiMessage`, so zh and en both use the existing key. The phone (`mobile-workspace.cjs:69`) gets the record's text, which is zh-only like the phone's other rows.
2. 返回 after a search restores the 信息流's names, group and search words (gap 2).
   - `search-view.js:16` saves `feed.filters()` when the search starts from the 信息流; `search-view.js:181` hands them back on 返回.
   - `space-feed.js:200` applies them when that space's 信息流 next draws. Pressing a filter or a new `reveal` drops them (`space-feed.js:211–216`).
3. Same-name members are told apart (gap 3).
   - `space-feed.js:26, 86, 121`: the name buttons and each line's speaker and recipients add the short id only when the name repeats. This reuses `sameNameSessions` and `sessionShortId` (`renderer.js:5189`). No new style or text.
4. A request line shows its delivery state (side finding 3).
   - `reading-list.js:44`: the status map from line 939 is now `readingMessageStatusKey`, used by the hidden record list (`reading-list.js:944`) and by the 信息流 (`renderer.js:5190`).
   - `task-stream.js:326` attaches the space record to a person's request line. `space-feed.js:129` writes the state into the line's existing `.disclosure-end`.
   - `space-feed.js:58`: the feed's change key includes request and wake states, so a state that settles after newer lines still redraws.

## Results

| Check | Red (before the fix) | Green |
| --- | --- | --- |
| `app/tests/speech-stream.test.cjs` | 11/12 (the new test fails: the line has the body only) | 12/12 |
| `app/tests/space-feed.test.cjs` | 11/12 (the new test fails: the line has no `request`) | 12/12 |
| `app/tests/mobile-space-speech.test.cjs` | 5/6 (the new test fails: the phone has the body only) | 6/6 |
| 226 test files that read a changed source | not run | 5209/5209 |
| `scripts/test-space-feed-ui.cjs` (new check 12) | 11 pass, then check 12 fails on statuses, the warning and the names | 15/15 |
| `scripts/test-room-navigation.cjs` | follow-up 3: 5/5 with 2 OPEN GAPs | 5/5, 0 gaps |
| `scripts/test-room-member-route.cjs` | 6/6 (follow-up 3) | 6/6 |
| `scripts/test-graphical-followthrough.cjs` | 7/7 (follow-up 3) | 7/7 |
| `scripts/test-native-addressed.cjs` | stops at its version gate | stops at its version gate: unverified, not passed |

- Logs, in `.local/evidence/newreq-space-ui-20261125/`:
  - unit tests: `followup4-unit-red.log`, `-unit-green.log` and `-related-tests.log`;
  - GUI scripts: `followup4-feed-ui-red.log`, `-feed-ui-green.log`, `-navigation.log`, `-member-route.log`, `-followthrough.log` and `-native-addressed.log`.
- The failed run `followup4-feed-ui-red-1-testbug.log` is kept. The test called `sessionShortId`, which is not a page global, and now reads the short id from the left list's own `.session-short-id`.
- The feed-ui red run used the bundle built at 02:13, before these edits. It still had the old `text: String(w.body ?? '')` and no `readingMessageStatusKey`. `node scripts/build-ui.cjs` was rerun before the green runs.
- The feed-ui fixture adds two synthetic requests: `h-a-private` (`reply-private`) and `h-b-failed` (`failed`). Its wake `w-pm-a` has no original in the sender's session, so its line now shows the warning. Check 12 asserts this.
- No model was called. The daily app was not touched. At most one GUI instance ran at a time. Memory stayed at pressure 2 with the compressor at 62–69%.

## Not done, with triggers

- Side finding 1, copy in the 信息流: do it if the person asks for copy back.
- Side finding 2, `waiting-stream-dom.cjs:30`: do it the next time the two task-waiting tests change.
- native-addressed is unverified, not passed. Codex 0.172.0 is not qualified for `addressedTool` (line 22), and Claude 2.1.332 is outside the script's version pattern (line 26). Unlock: rerun it once those versions enter the qualification table. The gates are unchanged. Same-name short ids are checked locally by feed-ui check 12.
