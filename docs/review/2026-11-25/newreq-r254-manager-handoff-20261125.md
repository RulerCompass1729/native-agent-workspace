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

## Increment 2: the butler's three acceptance items (queue item 4f0c8c68)

The person, 2026-11-25 21:48, on the 21:42 handover of 〔新需求〕's manager: 「感觉没地方改,这个 bug 很关键,一定要修」. The label and the hover card named 续2 as manager, its menu offered only 「撤销项目经理」, while `space-managers.json` still named the archived session (last written 21:16) and the space had no line saying the role had moved.

### What the records showed (read only)

- In the daily data, the rotation log has `done eca0dbcb -> 8091f4fb` at 21:42:14. The record still names eca0dbcb, the person's pick at 19:47.
- On alpha.307, `successor()` follows that `done` line, so `all()` already gave 8091f4fb. The label (`activeManagers` in `main.cjs`) and the permission (`creator` -> `roomOf` -> `designated` -> `all()`) read that one source.
- PM 续2 confirmed it by a real call on the board at 21:58: at 21:57 its `spaceAction queueAdd` returned complete, item e51a9b84.
- The confusion came from a record that keeps the person's pick while the holder is derived, with no line in the space.

### ① The record names the successor, and the label and the permission read one source

- `SpaceManagers.settle()` writes, for each space, the last step of the chain reached through `kept` or `done` lines only. It returns `{ roomId, from, to }`, and `apply: false` only reports.
  - A step reached through a `handed` line only is followed but not written. A later `failed` line gives it back, and a record with a source field could not be read by older builds: `identity()` accepts exactly two keys.
  - A branch writes nothing. A successor that another space's record already reaches is left as it is, because one session manages one space.
- `handoffSteps()` in `queue-secretary.cjs` is `handoffChain()` with a `final` flag on each step. `handoffChain()` returns what it returned before.
- `handedTo()` now walks from the caller itself, so the old session is still told who holds the role once the record names the successor.
- `main.cjs` gains `settleManagers()`. It runs from the client's state handler, beside `retireSecretary`, at most every ten seconds, in `roomState.serial`. It writes the record and one space line, `notice.room.managerHanded`: 「{name} 接任这个空间的项目经理」.
- On the first run after installation, a space whose role already moved through `kept` or `done` lines gets its record written and that one line.
- `docs/space-project-manager.md` says when the record changes.

### ② Shown by actual operation, not the label

- `queue-space-action.test.cjs` drives main.cjs's own `settleManagers`, `activeManagers` and `spaceAction` handler, with a real `SpaceManagers` and `RoomState`. The rotation lines have the shape `appendLog` writes.
  - After `handed`: the label names the successor, the record is unchanged, and the old session's `queueAdd` is refused with the successor's name.
  - After `done`: the record and the label both name the successor, and the space has one `managerHanded` line.
  - The successor's `queueAdd` lands with itself as creator. The old session is still refused, and a fresh `SpaceManagers` reads the same holder.
  - On the old source this test failed with `settleManagers is not a function`.
- The real-dispatcher R254 test in `queue-dispatch.test.cjs`:
  - while the handoff waits, `settle()` writes nothing;
  - after `done`, it writes the successor, the successor adds, and the ended old session adds nothing (`managerOnly`, as before).
- `space-managers.test.cjs`:
  - handed only, then failed: nothing is written, and the role is back with the old session;
  - a `kept` step in the middle (the panel's 10:28 case), then `done`, then `handed`: the record is written up to the last final step and the role continues to the waiting successor;
  - when that waiting step fails, the role returns to where the record now starts;
  - each earlier session is told the holder's name;
  - a branch, or a successor another space already names, writes nothing.
- In the daily app, PM 续2's 21:57 `queueAdd` on alpha.307 is real evidence for the `done` case. The `handed`-only case and the new record writing need the next installed version.

### ③ `recipient-identity-changed` is a different cause

- The key is thrown in `app/session-wake.cjs` only: at :301 (`relocate`, after a backend move, when the native id differs), :765 (`recipientIssue`, `same(s, intent.targetProof)`) and :831 (`receive`, when the identity changes while the message is taken).
- The proof (`peer-handoffs.cjs` `identity`) holds `nativeId`, `owner`, `memberRevision`, `controlRevision`, `connectionRevision`, `peerRevision` and the backend's pid and start time.
  - R238 subtracts only the recipient's ordinary input from these.
  - The note at `session-wake.cjs:148-150` says a reconnect, and another agent's background queue or steer, still withdraw a message.
- Nothing in this path reads `space-managers.json` or the rotation log; a manager refusal is `error.wake.managerSpace`. So it is not R254's bug.
- Leaving a named space does not change `memberRevision`: `collaboration-spaces.cjs:68` changes it only for the default space. So a rotation taking 35d97763 out of 〔新需求〕 does not explain its 21:49 refusal either.
- Which field changed in each of the three refusals is unknown. A recipient-side refusal records no field names, while `source-identity-changed` does (`session-wake.cjs:213`). Suggested as its own number: record the changed field names on `recipient-identity-changed`, then decide from the next case.

### Checks

- 43 related test files: the 42 besides `queue-dispatch.test.cjs` first ran 966/967.
  - The one failure was `state-push.test.cjs`, whose wiring fixture lists each call of the state handler. It had no `settleManagers` stub; with the stub, that file passes 33/33.
- `queue-dispatch.test.cjs`: 627/627 on the same source, run alone (1123 s). None skipped.
- Not run: the full suite, a real rotation in the daily app with this version, or a model turn.

## Review 1 of e7e6f5a8 and rework 1 (queue item fb89f9cc)

Review 1 (reviewer session saved with the private evidence) returned BLOCK on B1, with non-blocking N1–N7. PM 续2 8091f4fb decided B1: 「人手动设的那一位立刻生效，一直算数」. The decision can be reversed: if the person would rather 「拒绝设已交接的旧会话，并说明现在是谁」, that is the other way.

### Findings, reproduced on e7e6f5a8 with the new tests

- **B1:** after `handed` or `kept`, the person designates the old session again (`main.cjs` `designateManager`; `midRotation` checks only `newId`). The space says it is set, but `all()` still walks the earlier edge to the successor. After `kept`, `settle()` writes the successor back. The log only grows, so that designation can never hold. Red: label `next`, record `manager`.
- **N1:** `dropSuccessor` deletes the rotation before its `failed` line, with no retry. A lost line leaves the role with a successor that is gone. Red: the rotation is gone while the line is unwritten.
- **N2:** `handedTo()` walked forward from any session. A plain member that rotated into a later-designated session was told 「已经交给 Y」. Red: `managerHandedOver` instead of `managerOnly`.
- **N3:** `settle()` wrote the last final step and named it in 「X 接任」, while a later handed step held the role. Red: notice 「Manager 续2」, label `third`.
- **N4:** a docs clause said the record format had gained a source field.
- **N5:** `settleManagers` runs only from a window's state handler (`!context.background`). With no window open, the record and the space line wait. The label and the permission read `all()` from the log in the meantime, so behaviour is right. Not changed.
- **N6:** `noteHanded` marked a line without the successor's native id as written. A confirmation itself waits for that id (`rotation-handoff.cjs` `outcome`), so only a record restored without it reaches this. Red: `[null]` written and marked.
- **N7:** increment 2 had only author-reported counts. This rework keeps raw red and green logs.

### Change

- **Designation line.**
  - `SpaceManagers.set()` first appends a line to the rotation log: `{event: 'designated', spaces: [room], old: <pick>, new: null, before: <previous pick>}`. It opens with `O_APPEND|O_NOFOLLOW`, checks owner, mode and one link, and fsyncs. A line that cannot be written means no change (`error.manager.save`).
  - The record file is unchanged, since `identity()` takes two keys.
- **Designation cut.**
  - `handoffSteps(selected, entries, since)` takes the place of that line (`designatedAt`).
  - `handed` and `kept` lines out of the pick logged before it are not followed, nor later ones on the same edge. A `done` line is followed, before or after: the old session is ended, and an ended session holds nothing. (First written to cut `done` before the line too; `integrator-role.test.cjs:43` designates after a logged `done` chain and caught it, 972/973.)
  - New edges are followed as in R254.
- **Settled line.** `settle()` writes only when the chain's last step is final, so the record and 「X 接任」 name the holder (N3). It appends `{event: 'settled', spaces: [room], old: <from>, new: <to>}` before the record.
- **Who is told the holder's name.**
  - `handedTo()` asks `holders(room)`: the current pick's chain, plus for each `designated`/`settled` line the chain of the pick it replaced, read up to that line (N2).
  - So a successor is told who has the role after the person re-designates the old session, also when the first record came from an older build with no line.
- **Old readers.**
  - `rotationEdges` returns the two new events only with `handoffs: true`.
  - The dispatcher's `validLogEntry`, `successor()`, `follow()` and the butler record skip events they do not know, as older builds do.
- **N1:** `dropSuccessor` writes the `failed` line first when a `handed` line was written. Until then it gives nothing back, and it is tried again on the next pass (gate `log-unwritten`).
- **N6:** `noteHanded` writes nothing and marks nothing while `newNativeId` is not valid.
- **Docs.** `docs/space-project-manager.md` and the `CLAUDE.md` sentence. No interface text changed.

### Red and green

- Red (code e7e6f5a8, new tests): `rework1-red-code-e7e6f5a8.log`.
  - Nine new or changed R254 tests fail, each at the assertion its finding names: space-managers 5, queue-space-action 2, queue-dispatch 2. The changed N3 assertion in the existing settle test is one of the five.
  - The R254 tests that did not change pass.
- Green, on this commit's source, the same 43 related files as before (the list is kept with the logs):
  - the 42 besides `queue-dispatch.test.cjs`, at concurrency 1: 973/973 (`rework1-green-rest42.log`);
  - `queue-dispatch.test.cjs` alone: 629/629, 457 s (`rework1-green-queue-dispatch.log`).
  - None skipped or cancelled.
  - Taken with `fullsuite.lock`; the compressor stayed at or below 71.6% of its segment limit.
- The first green run, before the `done` change above: 972/973 (`rework1-first-rest42-972of973.log`).
- Not run: the full suite, a real rotation or designation in the daily app, or a model turn. In the daily app this needs the next installed version.
