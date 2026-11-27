# One backend rewriting its whole store every one to two seconds

## Failure (the person, 2026-11-26)

- 「感觉 NAW 不断在重启且连不上，而且打字卡卡的」, with the macOS out-of-memory dialog.
- On the finding that one backend with 26 sessions rewrote its 18 MB store about every two seconds, 137 GB in
  4.4 hours, and that the main process took one full core until backends dropped it: 「这明显是个大问题，必须 fix」.

## Cause

- `app/workspace.cjs` `changed()` schedules a timed checkpoint at most 1 s after the first change (150 ms debounce,
  1 s deadline). `persistLater()` writes the whole `workspace.json` each time. While any of a backend's sessions
  streams there is always a change, so the whole store is written about once a second, whatever its size.
- macOS's disk-writes diagnostic for that daemon: 137.44 GB of file-backed writes in 15,860 s (about 8.7 MB/s),
  matching a 15-18 MB store written every one to two seconds.

## Change

- `persistLater()`: from 1 MiB on, timed checkpoints are spaced so that they write about 1 MiB a second, at most
  15 s apart (an 18 MB store: about every 15 s instead of every second). Below 1 MiB nothing changes. The size is
  the store's UTF-8 byte length (Chinese text is 3 bytes a character), and the spacing runs on the monotonic clock,
  so a clock set back does not postpone a save.
- `persist()`, for records that must be on disk, is not spaced; the next timed checkpoint is spaced from it.
- Trade-off: only when a backend dies without `close()` (SIGKILL, a crash, an out-of-memory kill, power loss;
  SIGTERM and SIGINT still close and save), a store over 1 MiB can lose up to about 15 s of what only the timed
  checkpoint saves: drafts (`setDraft`), messages in the shared space without images, and streamed replies and
  other native output. Before: about 1 s.

## Checks

- `app/tests/workspace-save-pacing.test.cjs`, 6 tests, 6 pass.
  - Against main: 3 fail (spacing; spacing from `persist()`; spacing counted in bytes).
  - Against the first commit of this lane, 1b41b200: 2 fail (bytes; a clock set back an hour).
  - On both: 2 keep what must not change (`persist()` at once; under 1 MiB the one-second deadline).
- The 8 test files that exercise checkpoints (`persistLater`, `saveDeadline`, `storeSnapshot`, `.later.tmp` and so
  on) plus the new file, `node scripts/test.cjs` on this version: 367 tests, 367 pass, 0 fail, 0 skipped.
- A full suite (11,892 tests, all passing) ran on an earlier candidate of this lane that also held other changes;
  it is not counted for this version.
- Isolated R50 harness, 36 members x 1200 rows (37 MB state), streamed conversation, main cb9a3907 against 1b41b200
  (private run `s2-final`, 21:58 PT, after that commit; not rerun on the follow-up, which changes only how the
  spacing is counted): daemon 1.39 s of CPU before, 0.72 s after (11.49 % to 5.96 %); main 9.6 % to 10.2 %,
  renderer 57.7 % to 57.9 %; on both, the last of the 162 streamed rows was confirmed on the page.

## Review

- Independent review of 1b41b200 (headless session, Read/Grep/Glob only): PASS, no blocking findings. Adopted
  from its non-blocking suggestions: byte length, monotonic clock, the trade-off wording above, a byte-counting
  test, and more slack in the timing tests (3 MiB stores). Not adopted: a test of the 15 s cap, which needs a
  store over 15 MiB and a wait over 15 s; add it when someone changes `SAVE_PACED_MAX_MS`.

## Not in this lane

- Main-process state fan-out: owned by R255 (b068f69c, `lane/r255-state-coalesce-20261126`, 15d4b9bf). An earlier
  candidate here also paced `WorkspaceClient` state events and `state-push` snapshots; b068f69c measured that its
  pacing threshold did not coalesce at daily size (about 6 ms per frame) and asked for it to be removed. Removed.
  The state-push round-trip pacing is not proposed until a measurement shows page deliveries still dominate the
  main process after R255's change.
- `persist()` still writes the whole store synchronously; how often it runs at daily size was not measured.
