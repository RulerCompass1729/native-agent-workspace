# R250–R252 task board, settings grants and 每日发现 (lane/newreq-board-ui-20261125)

Requirement: dispatch from the space's project manager, 11-25 21:31 PT, implementing the
batch2 proposal with page-bottom choices A–F as recommended and notes ①–⑥.
Commits: 1a0ce069 (R250–R252), 32815003 (merge of main 856fe698), and the follow-up
commit that holds this record (board fixes, GUI script ports, this file).

## What changed

- R250: the task board lists tasks only. It has search, status/agent/space groupings
  (status by default every opening, 等你 first, 已完成/已取消 folded: F). Waiting items
  (cards, questions, operator creations) open in place in their row (A). Failures and
  old dispatches have no top-bar count and appear only under 异常 (B, C). Rows keep
  their order while the board is open (③). The footer states the 300-per-space
  retention (④). The separate 等你 strip under the stream is gone.
- R251 D: agent session-creation grants move to settings (`#setup-grants`).
- R252: 每日发现 shows content first with settings folded. × and outside click close
  it (`closedby="any"`, ①). An unsaved draft survives a dismissal and a status push,
  and the next opening shows its settings marked 未保存 (E). The arrival card stays
  `popover="manual"` and listens for an outside click only while open (②).

## Findings fixed in this lane (author-found, each with a check)

| # | Trigger | Fix | Check (red before, green after) |
|---|---|---|---|
| 1 | Card countdown in a board row stopped: the shared ticker keeps lines only under a node whose id is the card's id, and the row carried the row key | slot carries `card.id` | task-board-dialog "an open card sits under its card id…" (red: `actual: undefined`); activity-stream GUI probe: the countdown changes within 1.6 s |
| 2 | A closed board kept a hidden open card ticking | closing the board collapses the open row | same unit test; consent-cards GUI first-open check |
| 3 | Grant card in settings, English, 850 px: the consent checkbox took the full width (base `dialog input{width:100%}`), squeezing its sentence to one letter per line | dialog-scoped override in styles.css, as `.records-block` already does | operator-control QUOTA: "no horizontal overflow at 850px" (red: `scroll 236 > client 214`, widest INPUT), green after |
| 4 | An untitled waiting item named its kind twice (title and sub) | the sub is dropped when it equals the title | task-board-dialog "a waiting item without its own title names its kind once"; task-waiting-parity updated to match |
| 5 | A card whose kind cannot be verified had no row | listed under 异常 as unverified | task-board-dialog unverifiable-card test |

## Evidence (author-run, no model calls)

- Unit: 148 affected files, 1910 tests: 1909 pass, 1 fail. The failing
  install-state "FIFO/symlink inputs refuse promptly" also fails on main 856fe698
  (24 pass / 1 fail).
- GUI on the isolated test instance (synthetic transport, zero native input/model sends):
  - test-task-board: 198/0/0 in zh and in en.
  - test-task-board-people: 55/0/0 in zh and in en.
  - test-regular-popup: 28/28.
  - test-nonblocking-question-draft: 12/12.
  - test-operator-control: QUOTA 5/5 and CARD pass. SPACE passes.
  - test-activity-stream: a probe without the supersession step passes 17/17, covering the board countdown, cancel and confirm.
  - test-batch-confirmation: the board part passes (one row, 归档会话 · 4 项).

Screenshots stay in the private dogfood folder (r250-board).

## Not verified, and pre-existing failures

Each of these also fails on main 856fe698, at the same step, before any board code runs:

| Script | Where it fails |
|---|---|
| test-activity-stream | line 80, the supersession step |
| test-consent-cards | line 117 (the backend returns 3 records, not 2) |
| test-batch-confirmation | case 3 (the `#messages` batch) |
| test-narrow-fix | `#room-nav` hidden, line 64 |
| test-operator-control default journey | `#room-filter` |

The parts after those steps are unverified.

- test-native-blocks and test-native-nonblocking-question are ported to the board but not
  run: they start real native runtimes. They are unverified until a run that needs them.
- Removed unit files: task-board-state-help and task-board-view. The live session
  state view they covered is no longer on the board (R250: tasks only).

## For the non-author wording review (⑥)

The new and changed button and label wording is `git diff main..HEAD -- app/ui-messages.js`,
in the keys `taskBoard.*`, `operator.quota.settings*` and `discoveries.*`.
It must pass once before merging to main.
