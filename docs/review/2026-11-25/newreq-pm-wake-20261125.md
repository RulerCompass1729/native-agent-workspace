## R253 review 1 and its rework (lane/newreq-pm-wake-20261125)

The person (2026-11-25), R253, after two sessions they opened joined a space and were sent its manager's items while the manager sat idle: 「你咋没反应?我已经点了卡了」「或者是你没有感知到这个变动,需要修」; and, about a manager that could not reach the butler: 「说明你和大管家之间的交流不畅」.

Review 1: a headless reviewer session (not the author) read `8f89855a` and returned BLOCK, with one blocking finding, one required change and six that do not block.

### B1 (blocking): a member missing from the list for a moment was told as a move
- Cause: `manager-notices.cjs` built a space's members only from the sessions listed now, so a member whose backend was restarting, moving or updating counted as `left`. When it came back, `add()` replaced the owed `left` with `joined`, and the manager was told of a move that never happened, one model turn each time.
- Reproduced: a dispatcher-level test takes a member out of the session list for 75 seconds and puts it back. On `8f89855a` the manager was sent 「Worker（worker）离开了空间」.
- Fix: a member missing from the list counts as gone only after it has been missing for ten minutes, as `queue-dispatch.cjs` `integrationView` already counts the integrator. A session in the list is judged by its record: archived, or out of the space, it is gone at once. A `left` and a `joined` for the same member that are both still owed cancel out.
- The same test checks that a member archived in the space record is told at once, and one missing for longer than ten minutes is told after that. The existing tests still check one leaving the space in the record.

### Required: items others added to the space's queue
- Cause: the notice took only the manager's own items (`addedBy !== 'steward'`), so the butler's items in that space were never told.
- The brief asked for the butler's items. I also include the person's items: the acceptance names the queue's sends and deliveries in the space, not who added them, and the reviewer's reason applies to the person's items in the same way.
- Each line says who added it: 你加的, 大管家加的, 人加的, or 之前的项目经理加的 for a manager session that is not the current one, for example after a rotation.
- An item that was just added and is still queued is no news, whoever added it.
- A person's item can go to the manager itself, which is a member of its space. The manager was given it and answered it, so such an item is not told back. That test passes on `8f89855a` as well, which took no items from the person.

### Not blocking, fixed
- One manager of two spaces: each event keeps its space, and the message groups lines under each space's name. The same member leaving one space and joining the other are two events, not one replacing the other.
- Revoked or replaced manager: what is owed for a space whose manager has changed since the last look is dropped before sending.
- Reasons are cut to the item text's 40 characters.
- An item NAW keeps sending and its member keeps refusing is told at most three times while it goes out and back. The third says later rounds will not be told. How it ends (done, waiting, failed, cancelled) is always told.
- A call the sender's own plugin refused before NAW saw it (no root turn of its own) recorded the literal `butler`. The butler's record looks only for its own session id, so the butler never heard of it. NAW now records the designated butler's session, and keeps `butler` as written when none is designated.

### Shown to the reviewer, unchanged
- The `error.wake.noButler` text still ends 「要找人，写在任务板上。」 / "To reach the person, write it on the task board." An idle queue member does not read the board, but the person does.

### Not in this rework
- The directed-run path (`addressed-handoffs.cjs`) still does not resolve `butler`.
- Archived or unavailable spaces are still skipped.
- Unknown recipient ids are still not limited within a turn.
- R243/R244, `space-managers.cjs` and `lookupWake` are left alone.

### Evidence
- Red: the rework's tests copied onto `8f89855a` fail 8 of 16, each new test on its own assertion.
- Green: those two files and 13 others that load the changed modules pass 625 of 625, with none skipped. After the item-to-itself test was added, `manager-notices.test.cjs` passes 13 of 13.
- The whole of `queue-dispatch.test.cjs` and `queue-dispatch-agent-scope.test.cjs`, as the reviewer asked: 625 of 626 passed. The failure was 「a session the person renamed since the start has a successor named after the new name」.
  - Its sandbox runs Main's `startQueueDispatcher`, which since `5ea4a9fc` also hands the dispatcher `managerNotices`. The sandbox did not define that name, so the dispatcher was never built.
  - It passes on `650a3805` and fails on `8f89855a`, so R253's first commit broke it. The earlier run of 141 files did not include this file.
  - Fix: the sandbox defines `managerNotices` as null, as it already does for the other notice stores. No other test uses that sandbox, and the test now passes.

Undo: drop this lane's rework commit.
