# R254: a space's project manager moves at the confirmed handoff

The person, 2026-11-25: 「项目经理交接失败,这也是个 bug」, then 「貌似 NAW 新需求的项目经理继任又失败了?」「为啥也没修复也没提醒」.

## What happened (source findings)

- A manager's rotation was confirmed at 18:44 PT. The person kept talking in the old session, so the old session waited at `person-message` and then `person-quiet`. The successor's addition (`context:supplement`) went out only at about 20:33, and the `done` line came after it.
- `SpaceManagers.all()` followed `successor()` in `app/queue-secretary.cjs`, which moves only on a single `done` edge. While the old session waited, the log held only `waiting` lines, so the role stayed with the old session.
- Dispatch had already moved the work to the successor at confirmation (`carryDecisions`, `restSuccessor`). For about two hours both sessions acted as manager. The successor's `queueAdd` was refused with `error.queue.managerOnly`.
- A real `kept` (`keepOld`) never moved the role either.

## Change

- `queue-dispatch.cjs`: `noteHanded()` writes one `handed` line when a confirmed handoff starts waiting for its old session. It is called from `holdOld`, and from `advanceWaiting` for a rotation that was already waiting under an older version. The line is retried when it cannot be written, and `validLogEntry` accepts it. The done path writes no new line.
- `queue-secretary.cjs`:
  - `handoffChain()` is the manager's rule. A single `handed`, `kept` or `done` edge moves the role.
  - A `failed` line after a `handed`-only edge, from `dropSuccessor` or `failRotation`, which give the work back, removes that edge.
  - These still keep the role where it is: a branch, two parents, a changed old native id, or an unknown successor native id.
  - `rotationEdges(file, { handoffs: true })` also returns `handed` and `failed` lines. The default return is unchanged, so `successor()`, `follow()` and the butler and integrator rules see the same lines as before.
- `space-managers.cjs`:
  - `all()` follows `handoffChain`.
  - `handedTo()` says who holds the role now, when the caller held it earlier in that space's chain.
  - `creator()` refuses such a caller with `error.queue.managerHandedOver`, 「项目经理已经交给 {name}，由它在这里加任务。」. The name is the trusted label, then the session's name.
- The sentences in `CLAUDE.md` and `docs/space-project-manager.md` now describe the new rule.

## Checks

- Red first, on main 650a3805, with the tests only:
  - `space-managers.test.cjs`: 2 R254 tests failed. The role stayed `{ sessionId: 'manager' }` where `next` was expected.
  - `queue-dispatch.test.cjs`: the R254 test failed with `a` where `new-1` was expected.
  - The guard test, which checks that the butler and integrator rule is unchanged, passed both before and after.
- Green after the change, at 18758c08 (on alpha.308). This record is the only file changed since.
  - The 33 test files that name the rotation log, the managers record or the changed functions: `queue-dispatch.test.cjs` 627/627, and the other 32 files 782/782.
  - None failed and none were skipped.
- Two mutations of `noteHanded` each make the new retry test fail: with no retry in `advanceWaiting`, and with a line that failed to write still marked as written.
- The dispatch test drives a real `QueueDispatcher` through creation, handoff and confirmation, then six rounds of the person talking in the old session. After every round:
  - the successor is the only manager;
  - its `queueAdd` passes, and the old session's is refused with the successor's name;
  - only one `handed` line is written.
  After the person stops, the addition goes out and the rotation ends `done`, as before.
- Not run: a real rotation in the daily app, or the full suite.

## Base and other lanes

- The lane was rebased from main 650a3805 onto the alpha.308 head 856fe698.
  - alpha.308 carries 015592d0 (R220.2), a test that pinned the old rule: after `kept` the seat stayed with the old session, and the departed session got `error.queue.managerOnly`.
  - That test now asserts R254's rule. `kept` hands the seat to the one successor, and the departed session, in both `kept` and `done`, gets `error.queue.managerHandedOver`. Its branch assertions are unchanged.
- Trial merges with `git merge-tree`:
  - No conflict with R220.2 (889caf97). `creator()` gets its check before the `if` that R220.2 changes inside, and the message keys sit two lines apart.
  - R253 (lane/newreq-pm-wake-20261125) conflicts in `CLAUDE.md` only, because the two edits touch adjacent lines.
    The fix is to keep both: this rule first, then R253's sentence at the end of the same paragraph.
