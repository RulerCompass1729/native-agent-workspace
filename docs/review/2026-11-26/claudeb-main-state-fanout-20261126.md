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
  15 s apart (an 18 MB store: about every 15 s instead of every second). Below 1 MiB nothing changes.
- `persist()`, for records that must be on disk, is not spaced; the next timed checkpoint is spaced from it.
- Trade-off: if a backend process dies without `close()`, a store over 1 MiB can lose up to about 15 s of changes
  that were not saved through `persist()` (before: about 1 s). `close()` still saves last.

## Checks

- `app/tests/workspace-save-pacing.test.cjs`, 4 tests. Against the unchanged sources 2 fail (spacing; spacing
  from `persist()`); 2 pass on both sides and keep what must not change (`persist()` at once; under 1 MiB the
  one-second deadline). With the change: 4 pass.
- The 8 test files that exercise checkpoints (`persistLater`, `saveDeadline`, `storeSnapshot`, `.later.tmp` and so
  on) plus the new file: 365 tests, 365 pass. A full suite (11,892 tests, all passing) ran on an earlier candidate
  of this lane that also held the state changes below; `workspace.cjs` changed once more during it, so it is not
  counted for this commit.
- Isolated R50 harness scaled to 36 members x 1200 rows (37 MB state), during a streamed conversation: daemon CPU
  11.49 % before, 5.96 % with the earlier candidate (its only change to the daemon was this one).

## Not in this lane

- Main-process state fan-out: owned by R255 (b068f69c, `lane/r255-state-coalesce-20261126`, 15d4b9bf). An earlier
  candidate here also paced `WorkspaceClient` state events and `state-push` snapshots; b068f69c measured that its
  pacing threshold did not coalesce at daily size (about 6 ms per frame) and asked for it to be removed. Removed.
  The state-push round-trip pacing is not proposed until a measurement shows page deliveries still dominate the
  main process after R255's change.
- `persist()` still writes the whole store synchronously; how often it runs at daily size was not measured.
