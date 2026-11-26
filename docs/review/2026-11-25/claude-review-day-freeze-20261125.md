# Shared day files frozen (R158/R159)

- Source: the external check of R158/R159 found docs conflicts in the
  alpha.294, .298 and .299 merges after the rule of one review record file
  per lane and day (8230df91, on main since 50094af8).
- Reproduced by replaying the 87 merges from 50094af8 to e42aa85b with
  `git merge-tree`: every docs conflict was in a shared day file
  (`docs/review/2026-11-23.md`, `2026-11-24.md`, `2026-11-25.md`). By the
  first release containing the merge, docs conflicts in release-lane merges:
  alpha.294 4, .295 2, .296 3, .298 3, .299 2, .300 3, then 0 for .301 to
  .306. Lanes merging main into themselves hit 3 more (.302 2, .306 1).
- Cause: lanes kept appending to the shared day files. The three 2026-11-23
  writers were based before the rule; the 17 later writes (13 lanes: 5
  Claude, 7 Codex including the alpha.303 release bump, 1 external) were in
  checkouts whose CLAUDE.md already had it. No script, template or brief
  writes these files. The last write was the alpha.303 bump (1c896b1c).
- Fix: `app/tests/docs-size.test.cjs` pins the sha256 of each shared day file,
  as it already pins `docs/review.md`. Adding, changing or removing one fails;
  a lane file passes. The old test passed an appended day file (3/3).
- Severity: low (merge conflicts only). Status: READY, needs a non-author
  review.
