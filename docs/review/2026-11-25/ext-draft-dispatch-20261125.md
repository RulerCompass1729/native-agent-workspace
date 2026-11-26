## Sending queued work beside an unchanged draft (lane/ext-draft-dispatch-20261125)

The person reported that a "/" left in a member's composer stopped it taking work (R42), and said a draft should not block dispatch (R44). Before this change, any non-empty NAW composer draft kept the member out of the queue: it was not a vacancy, and every item waited until the draft was cleared. Twice the draft was in the NAW composer, not in a native terminal prompt.

This is a port of the 11-19 lane (8415668d, 044ab433), which was reviewed on 11-20 and then left out of a batch by omission. It was reapplied onto 307.

Queue items. `sessionReady(..., allowDraft)` in `app/queue-dispatch.cjs` lets a member with a draft be a vacancy and take an item. It does this only on a backend that has `queueDispatchInputV1`.
- The dispatcher sends `{ itemId, expectedInput }` with the input it read: the native id, draft revision, control revision and connection revision.
- `Workspace.send` in `app/workspace.cjs` compares that input on entry, and again at the native write. It never reads or changes the draft. If the input changed, it refuses with `error.queue.personTyping` and writes nothing.
- The dispatcher then gives the member the person's full 2-minute quiet and requeues the item without using up its attempts.
- The person's 2-minute quiet after they type or act is unchanged.
- Rotation, notices and the integrator still go without `expectedInput`, so a draft still refuses them. A member with a draft is not rotated (R207); a draft member due for rotation takes the item, and the gate is said.
- A backend with only `queueDispatchV1` gets no queue items and is named in the queue's update warning (044ab433), as reviewed on 11-20.

The butler. This follows the person's default of 2026-11-25. An event wake or a patrol goes beside an unchanged draft through the same packet, once the person has been quiet for 2 minutes. A click on its card with a draft also waits for those 2 minutes; without a draft a click still wakes it at once (R209). On a backend before the checked input, the draft still holds it, as before. Undo: the `beside` hunk in `wakeSteward` and `heldReason`'s third parameter.

Native prompts are unchanged.
- The Claude native prompt still refuses an item while the person has unsent text there (`app/claude-submit.cjs`, status `draft`). The item waits, but the row shows only the general wait 「正在给你最近的操作让路」 (person-recent, from the refusal setting the person's last act); the specific 'native-prompt-draft' wait is never produced. Follow-up: name the native prompt draft on the row.
- The agy TUI refuses unless its editor is empty.
- Codex receives the item as an app-server `turn/start` with the item text only (`app/adapters.cjs`). NAW cannot read the Codex TUI composer, and that path is unchanged.
- dsh takes no queue items.

Windows. A queued row now says why it waits for each member it could go to (`queueOutcomeNode`): the member's name, then its hold in the words the butler's wake already uses, or a queue line (`queue.wait.*`). Nothing from the wait but the codes is shown.

Not verified here: a real provider turn, the GUI in a real window, the Codex TUI composer, and a real PTY.
