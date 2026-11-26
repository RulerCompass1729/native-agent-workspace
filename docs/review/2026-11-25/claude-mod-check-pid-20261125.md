# claude-mod-check: the closing test asks the program for its PIDs (R235.2)

## Failure

- Source: the alpha.307 full suite (head 650a3805). `app/tests/claude-mod-check.test.cjs:291`,
  "The program is running", failed after 247 ms, then a record write hit ENOENT. The same file
  passed on the earlier head, alone and five times in a row. The machine was under heavy memory
  pressure (swap about 28.6 of 29.7 GB, compressor near 85%).
- What 291 checked: a `ps -axo command=` line holding the fixture path and not `sandbox-exec`.
  The loop at line 290 stops at the first listing that matched, then line 291 runs `ps` again.
  So the failure was a second listing that did not match. It was not the 3 s budget running out,
  and a longer wait would not change it.
- The fixture is `#!/bin/sh`. On macOS `/bin/sh` re-executes `/bin/bash` in the same PID, about
  115 ms after it starts (probe in the private evidence). `ps` takes the arguments from the
  process's memory or swap. Its man page calls this inherently somewhat unreliable, and when the
  arguments cannot be located it prints only the bracketed name. A listing without the path makes
  line 291 false while the program is still alive.
- ENOENT does not show that the program died early. After the failed assert, `stop.abort()` never
  ran and `f.running` was unset. The fixture's cleanup then removed the directory while the run was
  still going. Its save failed whenever `/bin/sleep 30` ended. Whether the program exited by itself
  or was killed is not in the saved evidence.

## Fix (test only)

- The fixture writes `$$` and its sleep child's PID to `$HOME/child-ready`. The test waits with
  `readyFile` and checks liveness with `process.kill(pid, 0)`. This is the pattern the time-limit
  test in the same file already uses. `f.running` is set, `t.signal` aborts the check, and
  `finally` awaits it, so cleanup no longer races the run. "The program is gone" uses the same
  bounded 5 s PID loop as the time-limit test.
- If the program really dies before it reports, `readyFile` now fails with the run's record
  (exit, signal, note) instead of a bare false.

## Checks (author-run, no model calls, this file only)

- Fault harness (a preload that drops the program's arguments from one `ps` listing after a first
  match). Old test: fail 1, "The program is running", the same ENOENT after-test activity. New
  test: pass 1.
- Plain: the new test 5/5 pass; the whole file 13/13 pass.
- Mutations of `app/claude-mod-check.cjs`, restored afterwards:
  - Closing kills only the leader: fail, at `Date.now() - before < 5000` (30.2 s).
  - The group is killed 50 ms after start: fail, "The run ended before fixture readiness" with
    `"signal":"SIGKILL"`.
- Raw output: `.local/evidence/claude-mod-check-flake-20261125/` (private).
- Not verified: a rerun of the full suite under the same memory pressure. The cause is the most
  likely one, reproduced by the fault harness, and was not observed directly.
