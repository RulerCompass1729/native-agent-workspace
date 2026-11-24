## 0.1.0-alpha.293 release batch (lane/claude-release-291-20261124)

The person (2026-11-23): 「不只是 290,以后要尽可能快的把修复 push 上线,而不是一次等一堆,否则错误累积会引起越来越多的问题」, 「现有规则需要改动,你需要根据紧急程度提高效率」 and 「凡是影响 NAW 开发效率和功能的问题都是优先级高的问题」. The batch was cut as 291; the rotation hotfix `d0468416` shipped alone as 292, so this batch became 293 and includes that hotfix.

Merged on 289's `2b01dea7`, in order: steward-rotate `12f72ca7`, steward-notidle `480f7a0a`, the installed 290 head `0f6047a0`, sidebar space members `f871e250`, card gaps `5e495328`, bind-after-resume `4196bd76`, space role `8429b164`, R141 part 2 `4be45147`, the 292 hotfix `d0468416`, the rule change `8230df91` (below), the version bump `50094af8`, W3 `afe40d24`, handoff-step `6fbe93d2`, and the rotation stall notice `d5aa28b0`. Each lane had its own non-author review; W3 and handoff-step have their own files in this folder.

Conflicts:
- `docs/review/2026-11-23.md` (notidle, 290, `d0468416`, stall notice): every record from both sides kept.
- `package.json`, `package-lock.json` (W3 still carried 291's version): 293 kept.
- `app/butler-ingress.cjs` (stall notice): both sides added a Set and a method next to each other (291's `unbound` / `observeUnbound`, the lane's `rotationStalls` / `rotationStalled`). Both kept; the constructor's ledger replay already filled both.
- Merges with no conflict were still checked: each merge's delta against its first parent equals the lane's own delta (W3 and handoff-step byte for byte).

Rule change (`8230df91`, and the maintainer overlay outside Git):
- Release cadence: "Fixed per-version overhead ... otherwise batch, except urgent items" became three tiers by urgency. Tier 1, daily use broken or stuck or anything hurting NAW development or function: each fix with READY and a non-author PASS is installed alone within about 2 hours. Tier 2, other fixes: a new version once the last is installed, no batching. Tier 3, improvements: the next version. Push main after each install; all gates stay. Same text in CLAUDE.md and the overlay.
- Review records (R158 step 1): one file per lane and day, `docs/review/YYYY-MM-DD/<lane>.md`, so merging lanes does not conflict there. Existing day files stay where they are.
- `app/tests/docs-size.test.cjs`: the PM asked for the header comment only; its failure message also changed, because it pointed new records to the day file. The check is unchanged. Red: a 1.5 MiB probe file in a lane folder fails; green 2/2.
- CLAUDE.md is 34774 bytes, 4 fewer than in the installed 290. Codex reads only its first 32 KiB, and since 290 (`0f6047a0`, 34778 bytes) that cut falls at the start of "Scope agent and reviewer file searches", which main still shows almost whole. This batch makes it no worse; the fix belongs with the public/private split (R144) or a separate trim.
- Loaders: `codex debug prompt-input` in the worktree shows both new paragraphs; Claude `/memory` lists `./CLAUDE.md` and the lanes overlay; the SessionStart hook output carries the overlay's tier text in its last 4.9 KB, the part Codex keeps.

Tests on `4b5515b1`: the whole suite, 618 files, 10220/10220, temp guard passed. 29 files around rotation, dispatch, wake and the butler record: 809/809.

Window checks (hidden synthetic GUI):
- People 62/0; collapsed sidebar zh 97/0 and en 97/0.
- Task board: one assertion, "the header shows the three non-card waiting items once", fails intermittently: 2 of 5 runs on `4b5515b1`, 1 of 4 on `c2233c1b`, 3 of 4 on `5f27bb36`, and 3 of 4 on the installed 290 tree. Not caused by this batch; every other assertion passed in every run.
- Scripts that already failed before 291 and still do: steward-entry (expected order at its line 87, stale since 11-18), steward-wake (an extra queue-empty event at line 173), notes-density (`#room-notes` not visible, same on the 290 tree).
- Not run: test-phone-workspace.cjs.

Batch review: one fresh read-only session over the merge interactions and the rule change, not the lanes' own diffs. Round 1 reached its 40-turn limit; a bounded verdict in the same session gave CHANGES_REQUIRED for one docs item, with no blocking defect in the combined code:
1. W3 and handoff-step had no review record in the repo. Fixed: the two files in this folder. Blocking for the push only.
2. Tier 1 dropped 「功能」 from the person's words. Fixed: "or function", in CLAUDE.md and the overlay, with CLAUDE.md trimmed to stay smaller.
3. "Push main after each install" was stated only for Tier 1. Fixed: one sentence for all tiers.
4. The docs-size failure message changed beyond the PM's request. Stated above.
5. The comment above `schedule()` in `app/queue-dispatch.cjs` reads as if the old behaviour were current. Wording only; left for the stall-notice lane.
6. A rotation-stalled line makes the butler's wake chip due, so a butler that cannot be woken shows "wake stalled" where it showed nothing. Accurate and one line per gate; the chip neither reopens nor re-announces. No change.
Checked with no finding: the butler-ingress resolution; running the dispatcher pass outside the caller's scope against W3's input policy and every pass entry; W3 against dispatch sends and R141 part 2's answered replies; the hotfix's join retry against the stall notice, steward-rotate's quiet hold and notidle.
