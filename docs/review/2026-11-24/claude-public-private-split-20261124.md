## Maintainer rules move out of CLAUDE.md (lane/claude-public-private-split-20261124)

A replay of `9af328bd` (reviewed on 2026-11-23) on main `7f4cfdc9`. `CLAUDE.md` 34,774 B → 28,287 B (Codex reads at most 32,768 B of project files; main's file was cut, so a Codex session could not see the Push rules at its end). The maintainer's own process rules now live in an overlay outside Git. Only conflict: the paragraph `8230df91` added to main; it is in the overlay.

Change since the 2026-11-23 reviews: two sentences stay public. The rule for computer use in the daily app and the rule against quitting, hiding or restarting the daily app were to move; a session without the overlay would then be less careful than before, so both stay here. Commits: `8810bbc8`, `2b185811`, `8e6c0b2c`.

Why the overlay was not readable by Codex before: Codex cuts a SessionStart hook's output to about 10,000 bytes (head and tail). The hook now gives the overlay whole, the titles of the pinned lines of the shared memory index and the index path, and gives both as paths when even that does not fit. The hook and the overlay live outside this repository.

Tests: `app/tests/docs-size.test.cjs` and `queue-monitor-events.test.cjs` 23/23; `scripts/test-competitor-watch.py` 13/13, also under `TZ=Asia/Tokyo`. The hook's 41 tests pass; the same tests on the old hook fail 5. One Codex turn (cheapest listed model, no tool calls) in the lane answered the first, a middle and the last overlay heading; the session log shows the injected block whole (8,929 B), byte-identical to the overlay, and the lane `CLAUDE.md` last line present. 39 compactions in 4 earlier Codex sessions were each followed by the hook block again.

Review: one headless read-only session, four rounds (an earlier session was stopped before any verdict). Round one BLOCK (two findings: the hook fell back to the old cut output if the overlay grew by 328 B; the earlier proof that the overlay reached the model would also pass with the middle missing). Both fixed; rounds two to four PASS-WITH-NOTES, the last with nothing blocking. Notes that are still open, all recorded in private evidence: a Codex session opened before the hook was installed needs a compaction or a new session; `resume` and sub-sessions forked from a session without the block are not checked; a third-party model session has not run for real.

Undo: revert the three commits; the overlay and the hook have a backup and an `undo.sh` outside Git. If main changes `CLAUDE.md` before this merges, compare the moved paragraphs again.
