# Everyday graphical workflow — M3

As of 2026-10-20. Alpha.46 source, installed-artifact and independent review
passed within this workflow's scope. This is a graphical client over native sessions,
not synchronization with the official Claude/Codex Desktop applications.

The person can start a small non-coding task, see native progress and permissions,
use the same session's terminal when needed, find the result, explicitly share a
selected part, keep a local decision and return later. Saving, searching, renaming,
archiving and reopening do not generate another model turn.

## Reproduced friction and repair

A directed task can finish privately after human terminal intervention invalidates
its sharing permission. The shared row reported that state but hid its existing
**查看会话** action. Finite exchanges use a different path: a permission pause
record had no link to the session awaiting a reply.

The existing action now opens the exact referenced session in conversation view.
New pause records retain that stable session reference, including after local
record recovery. They remain system-authored; the reference identifies the
waiting session, not necessarily the cause of a pause or a completed result.
Archived sessions open read-only. Missing targets do not redirect by name or
resume another session. Ordinary membership events gain no extra controls.

Opening a conversation preserves its reading position. Use existing local
search to locate a result further down a long history; the button does not claim
to jump directly to a particular reply. The recovery action is visible and
keyboard reachable without requiring a mouse hover.

## Actual application acceptance

The deterministic runner drives the actual Electron/DeepSeek Harness interface,
native adapter, IPC and storage. Provider responses are controlled fixtures.
It covers a three-person travel budget, with the prechecked expected result:
3 × 18 + 3 × 7 = 75 total, 25 per person. These new results are fixtures;
the actual native calculation evidence below is reused from M1.

- Directed send → native permission → terminal input → private result. The
  original session and unsent draft remain intact; the result is not silently
  inserted into shared records.
- Edit the existing share preview and choose the exact recipient. Only the
  selected conclusion is dispatched, without private notes or previous history.
- Filter and copy the shared result, save a shared note and find the decision
  locally. These operations dispatch no task; notes reach an agent only when
  explicitly included in a later message.
- Authorize two replies → pause on native permission → open the waiting session
  → approve once in the graphical UI → find its private result with local search.
  The assertion checks the result inside the scrolling viewport, not just its
  presence in the DOM. The old sharing authorization remains invalid.
- Archive → open the private result read-only → explicitly restore → reopen the
  application. Native identities, received history, notes and the draft survive.

This runner uses four authorized synthetic submissions and zero model calls.
It runs in one hidden, non-focusable test window, then closes that window and
only its own test service. Existing preview-race and search regressions pass.

## Native evidence and boundaries

The actual installed Haiku/Luna/Haiku non-coding budget task from
[M1](desktop-workflow.md#observed-outcome--alpha44) is reused. Its three root
submissions, native tool/permission operation, correct result file, copy,
detach/archive/reopen and recording are retained privately. The provider adapters
and native submission protocol have not changed for M3, so another paid task
would not add evidence for this navigation repair. The new deterministic checks
prove the graphical follow-through, not a new model execution.

Old pause records without a stable session reference are not backfilled by
guessing. Retained old backends are not hot-patched; their existing native views
and histories remain usable. Native errors/permissions still pause collaboration;
this is not unattended permission handling, universal fleet restoration or a
hard monetary cap. Physical macOS IME/accessibility behavior is not newly
certified by this hidden UI run.
