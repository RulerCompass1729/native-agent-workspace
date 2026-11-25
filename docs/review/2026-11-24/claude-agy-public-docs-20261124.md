## The public documents describe Antigravity members (lane/claude-agy-public-docs-20261124)

296 added Antigravity (`agy`) terminal members; README, `docs/privacy.md` and `docs/readiness.md` did not mention them. Asked: who receives a member's content, what NAW stores, what the hook does, whose settings apply, the known limits, and what was not audited.

Change, documents only: a section each in `docs/privacy.md` and `docs/readiness.md`, one sentence in README, Google in README's non-affiliation paragraph, readiness's "later work" line now says providers beyond those named there, and its follow-up table row says the same for agents.

Source: each sentence about NAW was read in the source at `7f4cfdc9`. The vendor is not in NAW's source or in the program's version and help text; it comes from the code signature of the installed 1.5.16. What Antigravity sends, keeps and defaults to is listed as not audited.

Found while reading, not changed here: `agy_hook.py` says it does nothing outside NAW, but without its token or socket it still answers `allow` to the tool call it was run for, any `call_mcp_tool` included. The privacy section states that. The plugin folder is per session and passed only to that session.

Checks: `docs-size.test.cjs`; the new links' headings exist.

Review: one read-only session, four rounds. Round 1 had four blocking sentences (token boundary, two on the hook, `/mcp`), round 2 none, round 3 two (reply condition, message checks); all fixed, round 4 PASS with nothing blocking. Rounds 1 to 3 went over their read budgets. Not checked by it: the signer and version (author-run), README's first lines in full, two long readiness lines.

Undo: revert this commit; no code depends on it.
