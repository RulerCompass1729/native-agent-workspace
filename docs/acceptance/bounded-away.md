# Bounded work while the window is closed — M4

As of 2026-10-20. Alpha.47 source, installed checks and independent final review pass within this scope. This scope hardens the
existing explicitly authorized reply exchange; it does not implement arbitrary
autonomous goal completion.

The person selects participants, a task, order and a total reply cap, and sees
the ten-minute deadline before starting. Closing the window does not revoke
that authorization. Human intervention, permission/error boundaries, limits or
the deadline pause subsequent handoffs. An accepted native task can still run;
pausing handoffs does not cancel that task or stop its billing.

## Reproduced defect

The timer alone was insufficient. If a native submission was held until the
deadline, or a reply arrived before a delayed timer callback, another handoff
could occur after authorization expired. A late reply could also be shared
before checking expiry.

Delivery and completion now check the same deadline before proceeding. The
interval only supplies a wake-up; the visible paused state can follow the cutoff
by its next timer callback, while delivery/sharing checks reject at the cutoff. Expired replies remain in their original
private session. Stale guards cannot pause a later authorization; a new explicit
human instruction does not renew the old exchange.

## Actual application evidence

Six local counterexamples cover exact cutoff, late cutoff, before-cutoff
continuation, held submission, stale authorization and the actual Claude adapter
completion method after an accepted native acknowledgement. The complete local
suite passes 400 checks with zero skips. These use controlled data, not models.

`scripts/test-bounded-away.cjs` operates the actual Electron/DeepSeek Harness
interface and persistent service with controlled provider responses:

- A two-reply learning plan continues after closing the window, stops at its
  exact reply cap and reopens with the same session identities and results.
- A native error while the window is closed pauses handoffs. A later result
  remains private; reopening does not retry it.
- Clicking pause leaves the accepted native task working, then retains its
  private result without any implicit interrupt.
- Source `--real-deadline` waits a full ten minutes with the window closed,
  without changing the clock. It verifies deadline expiry, no extra handoff,
  a private late result, the visible reason after reopening and a new explicit
  instruction that does not resume the expired exchange.

The source run has six synthetic submissions. The installed alpha.47 run repeats
all three ordinary lifecycle scenarios with four submissions; it does not repeat
the ten-minute wait. All 40 installed application payload files match the source
used in the timed run. The installed six-group graphical follow-through regression
also passes. Each runner uses one hidden, non-focusable window, then cleans up
only its own sessions and service. No new provider/model task is sent.

The archive hash, strict installed signature after testing and unchanged normal
profile root files are verified. An initial installed-runner launch used an
incorrect executable filename and failed before opening a window; the corrected
run passed. Screenshots, complete logs and this failed setup attempt stay private.

## Limits

The deadline uses wall-clock time. System sleep, clock rollback and a hard native
token or money cap are not certified. Native child/fleet completion is separate
from the end of root-reply handoffs. Backend recovery pauses a saved exchange
without replay; an old running backend is not hot-patched by replacing the UI.
Full active-fleet cold restoration and official Desktop synchronization remain
outside this increment.
