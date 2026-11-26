# R250–R252 follow-up 1 (lane/newreq-board-ui-20261125)

This follow-up fixes findings N1–N10 from the first non-author review of d2e0f112
(reviewer session 5c41fd9e, round 1, verdict PASS with non-blocking findings) and the
wording review (⑥). It continues the record in `docs/review/2026-11-25/newreq-board-ui-20261125.md`.

## Fixes, by finding

| # | Change | Check |
|---|---|---|
| N1 | English counts of one: `taskBoard.needOne` ("1 needs you") and `taskBoard.totalOne` ("1 task"). | The button and total tests assert the literal text in both languages. |
| N2 | `settle()`: if the board is marked open but its popover is no longer open, it is closed first. This covers a click outside, whose toggle event arrives after the click. `show(id)` then opens fresh: grouped by status, with an empty search and a new order. | A test hides the popover without a toggle event, then calls `show`. |
| N3 | An item that waits for the person and arrives while the board is open is never hidden behind 再显示. Other arrivals still page by eight. | A unit test covers both. The first version showed every arrival: the GUI check of 24 queued items arriving on an open board caught it (1240 px), so the rule was narrowed to waiting items and that case became a unit assertion. |
| N4 | New unit test replacing "ten rows grow to twenty". | A status update on an open board keeps focus, `scrollTop`, the same answer form and its half-typed text. |
| N5 | Screenshots retaken after these fixes, with the raw GUI output kept. | `en-waiting-light-850-open.png` no longer shows the "Approval"/"Approval" duplicate. |
| N6 | `discoveries.terms`: the $0.01 budget is daily again. In English, it is the usage that may be unclear, not the budget. | Unit and GUI checks compare the text. |
| N7 | The ⌄/⌃ mark moved into its own `aria-hidden` span. | Unit test, plus a GUI check that the button's accessible name is exactly 设置 / Settings. |
| N8 | Removed 145 unused keys in each language. `taskBoard.*`: the old tabs, sort, completion range, views, regroup, state help, actions, people section, `by.member` and `status.sent/queued/failed/done/cancelled`. `discoveries.*`: `location`, `activateHelp`, `enabled`, `privacy` and `budget`. | Each removed key has zero references in `app/` and `scripts/` outside the catalog, as a quoted literal or a prefix built by `task-board.js` / `regular-popup.js`. The zh and en key sets are still equal (4129 each). |
| N9 | Observation only; unchanged. | — |
| N10 | Did not reproduce. Every caller ran `relayout()` before `drawPanel()` read the scroll position, so the list already returned to the top. The reset is now an explicit flag, which also covers `drawPanel`'s own relayout. | The test passes on d2e0f112 too: it guards against reordering the calls; it is not a red-to-green check. |

## Red on d2e0f112

The new and changed tests were copied onto a detached d2e0f112 checkout: 33 tests, 6 fail. The failures are N1 (two tests), N2, N3, N6 and N7. The N4 and N10 tests pass there, as noted above. The N3 queued-burst assertion was added after this run.

## Evidence (author-run, no model calls)

- Unit: 28 files (the 14 the PM ran, other `regular-popup*`, and the catalog and locale tests): 295/295.
- GUI on the isolated test instance (synthetic transport, zero native inputs or model sends):
  - `test-task-board`: 198/0/0 in zh and in en.
  - `test-regular-popup`: 29/0/0 in zh and in en. The script now follows `NAW_TEST_UI_LANGUAGE`; it was zh-only.
- Raw output stays private, in the lane's evidence folder, under names starting with `followup1-`.

## Interface text changed (for the ⑥ delta)

| Key | zh | en |
|---|---|---|
| `taskBoard.needOne` (new) | {count} 件等你 | {count} needs you |
| `taskBoard.totalOne` (new) | 共 {count} 件 | {count} task |
| `discoveries.terms` | 启用后，你保存的关心句和公开网页摘录会发给 DeepSeek；每天最多一次请求，预算每天 $0.01，超了或用量算不清就停。原始任务记录、会话和记忆不发。 | Once enabled, the interests you save and excerpts of public pages go to DeepSeek: at most one request a day and a $0.01 daily budget; it stops when the budget is exceeded or the usage is unclear. Raw task records, sessions and memory are not sent. |

The settings button keeps its visible text, but screen readers now read only 设置 / Settings.

## Not verified

- `test-native-nonblocking-question` changed one count-of-one key but was not run: it starts a real native runtime.
- `test-task-board-people` was not rerun. Its button count is 4, so the singular key does not reach it.
