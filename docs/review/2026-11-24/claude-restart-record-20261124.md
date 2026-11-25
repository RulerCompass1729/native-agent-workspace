# The restart record says how the last run ended (2026-11-24)

The main process died of V8 heap exhaustion and the restart record a minute later read like any restart. The record now says one of three things about the run before it, beside "installed" or "restarted": ended normally, did not end normally, or no record.

## What changed

- Right after the single-instance lock a run judges what the last one left, removes it, and leaves `main-running.json` (pid, start, version). `will-quit` renames it to `main-exited.json`. A running mark says abnormal, an exited one normal, neither says there is no record. A second instance leaves and renames nothing.
- `before-quit` is not used, because it can be refused. Every app quit, the service quit and the installer's terminate request pass through `will-quit`.
- The abnormal line gives the pid, the start time and the system's crash-report folder. The crash report is not read, and the text has no user name or path with one.
- The event reason becomes `version-restarted-after-abnormal-exit` or `version-installed-after-abnormal-exit`, with kind `failure`. The other reasons, the kind of a normal start and the record's delivery are unchanged. The wake message's own wording is not part of this change.

## Checks

On the unchanged base all the first tests fail. The first version answered four of four of the reviewer's scenarios wrongly and the final one answers them as wanted. 24 mutations of the new conditions leave no survivor. Of 3354 tests in the 119 related suites 7 fail, the same 7 as on the base (`localPages is not defined`). One isolated hidden instance was really killed, killed right after its mark appeared, quit normally and sent SIGTERM; the next start read as expected each time, and no crash report was added. The checks called no model and the daily app was not touched.

## Independent review

A non-author review blocked the first version: on a full disk the earlier run's normal sign outlived it, and a crash before the version record was constructed read as normal. Both ends now need a mark of the run itself. The same reviewer passed the rework with notes; one note (a death before `ready`) led to leaving the mark right after the lock, and the reviewer passed the final version with notes.

## Known gaps

- A run that dies before it holds the lock, or whose main file cannot load before that point, leaves the last run's mark, so the next start repeats that run's answer.
- If removing an old mark, writing the new one and writing the seen record all fail, the old answer is repeated. Whether a completely full APFS volume refuses the removal was not tested.
- A crash is told by the next start's first announcement, about a minute in. If that run ends before it, the crash is not told; its own end is.
- A failed read or rename at quit reads as abnormal; the line says only that no normal sign was left.
- SIGTERM goes through Electron's quit and reads as normal. One that arrives before Electron handles signals reads as abnormal.
- With the clock set back, a normal quit can read as no record. An older version that ran and died before announcing can leave a normal sign. A running mark that cannot be read says abnormal even if an older version ran since.
- A failed write can leave its temporary file, as version-seen.json's did. A directory or a pipe at the mark's path is not handled; only a program with access to the private profile could put one there.
- Not yet checked in the daily app.
