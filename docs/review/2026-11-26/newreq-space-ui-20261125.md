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
