## The public documents describe Antigravity members (lane/claude-agy-public-docs-20261124)

296 added Antigravity (`agy`) terminal members; README, `docs/privacy.md` and `docs/readiness.md` did not mention them. Asked: who receives a member's content, what NAW stores, what the hook does, whose settings apply, the known limits, and what was not audited.

Change, documents only: a section each in `docs/privacy.md` and `docs/readiness.md`, one sentence in README, Google in README's non-affiliation paragraph, readiness's "later work" line now says providers beyond those named there, and its follow-up table row says the same for agents.

Source: each sentence about NAW was read in the source at `7f4cfdc9`. The vendor is not in NAW's source or in the program's version and help text; it comes from the code signature of the installed 1.5.16. What Antigravity sends, keeps and defaults to is listed as not audited.

Found while reading, not changed here: `agy_hook.py` says it does nothing outside NAW, but without its token or socket it still answers `allow` to the tool call it was run for, any `call_mcp_tool` included. The privacy section states that. The plugin folder is per session and passed only to that session.

Checks: `docs-size.test.cjs`; the new links' headings exist.

Review: one read-only session, four rounds. Round 1 had four blocking sentences (token boundary, two on the hook, `/mcp`), round 2 none, round 3 two (reply condition, message checks); all fixed, round 4 PASS with nothing blocking. Rounds 1 to 3 went over their read budgets. Not checked by it: the signer and version (author-run), README's first lines in full, two long readiness lines.

Undo: revert this commit; no code depends on it.

## The Antigravity hook without its token, and the program's updater (same lane, commit 1)

Asked: without both NAW values the hook must make no allow or deny decision on any PreToolUse, with the with-token path unchanged; and every `agy` NAW starts must have its updater off.

What "no decision" is was measured, not read: a real `agy` in a sandbox without network, a local synthetic model server and a stub MCP server, no model call, in non-interactive runs (`-p`). 55 combinations, 50 with a hook and 5 without, of hook answer and permission setting (no rule, allow, deny and ask rule, `--dangerously-skip-permissions`) on 1.5.16 and on 1.5.17. Empty output with exit 0 and `{"decision":"allow"}` gave the same result as no hook in all five. `{}`, an empty decision, an unknown word and a nonzero exit denied the call in all five, also with an allow rule or with permissions skipped. The program's own text calls `decision` required and says `allow` allows automatically; neither version did that.

So the earlier note above was wrong about effect: `allow` without a token was not an approval in these versions. The documented meaning is still an approval, so the hook now writes nothing there. Answering `{}` would have turned it into a denial.

`AGY_CLI_DISABLE_AUTO_UPDATE` reads only lowercase `true`: in the same sandbox both versions logged the updater off with `true` and started a background update with `TRUE`, `1` and unset. `launchSpec`, the only place that starts the program, now always sets it.

Tests: on the previous code three fail (`launchSpec`, the real `NativeHost` launch and resume with a stand-in program, and the hook with neither value, one, the other, and empty ones).

Not measured: the interactive screen, MCP tools the program loads up front, other versions, switches its service sends down.
