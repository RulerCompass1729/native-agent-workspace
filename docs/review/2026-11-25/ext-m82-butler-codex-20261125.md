## A new Codex session as the butler, from the butler's own menu (lane/ext-m82-butler-codex-20261125)

The person (2026-11-21): 「我怎么把你换成 codex,没地方改模型」. On 2026-11-10 they also said 「当然大管家也可以换（比如 codex/claude）」 (docs/product.md). This serves the vision's single entry: the person can choose who answers there.

Finding at `e42aa85b`: a path already existed, but it was not where the person looked.
- The person could open a Codex session outside every space, then use the butler's 「大管家换成别的会话…」 or the Codex session's 「设为大管家」 (renderer.js `stewardAction`).
- The main-process designation has no provider check.
- The butler's own menu never said Codex.
- The chooser's new-session row showed Codex as 「还不能选」, and `makeSteward` always created Claude.
- A running session's provider cannot be changed natively, so the answer is a new session.

Change:
- Menu: the butler's own ⋯ and header menus gain 「大管家换成新的 Codex 会话…」 (a Codex butler: 「大管家换成新的 Claude 会话…」), right after 「换模型…」. The item appears only where a session can be opened with settings.
- Chooser: the item opens the existing chooser with the new-session row and that provider chosen. Codex starts on its native default model and effort, and those two fields are locked, because Claude's model names are not Codex's. The person can change them later with 换模型….
- Handoff and duty: the handoff and duty statement are prefilled as for Claude.
- Codex option: the Codex choice is enabled, and the sentence under it now says what a Codex butler lacks.
- Designation: only the person designates, with the same confirm button; nothing changed in main.cjs.

What a Codex butler lacks (source; not run):
- The tools `workspace_sessions`, `workspace_open` and `workspace_report` are Claude-only (claude-message-tool.cjs, the `tools/list` branch).
- It does have `workspace_message` and `workspace_control`. The duty statement asks it to find or open agents, add queue items and watch sessions. Through `workspace_control` that is snapshot, `create` and `spaceAction` `queueAdd`, all in the background catalog for Claude and Codex actors.
- Opening a session that way needs the person's confirmation card unless the permission to organize covers it.
- `workspace_report` serves a dispatched session's report and is not part of the duty statement.

Strings: `menu.stewardToCodex`, `menu.stewardToClaude` (new), `steward.new.codex` (reworded), zh and en.
- Review of `b58c7fec`: the first label 「换成 Codex…」 read as converting the running session, so the item now names a new session. The note names the report tool as its activity label does (写进度报告 / write progress reports).

Tests (`app/tests/steward-ui.test.cjs`, `app/tests/steward-entry.test.cjs`):
- Red on `e42aa85b`: 5 of 43 fail.
- Green: 43/43.
- Mutations: 10 of 10 key lines killed, including the person-only check in main.cjs.
- `node scripts/check-gui-names.cjs`: 0 missing.
- `scripts/test-steward-entry.cjs` (hidden window, synthetic sessions) now expects the new item in the butler's header menu and opens the chooser from it in zh and en. Its run waits until the release install in progress finishes.

Not run: a real Codex start or a real Codex control call (synthetic only), a screen reader.

Undo: drop this lane's commit; no stored format changed.
