## The phone's 「等你」 list (lane/ext-phone-gap-20261125)

Asked (R43): the phone should work like the desktop, and the person should get things in time and be able to reply. A source-level comparison of desktop and phone found that the phone had no list of what is waiting for the person. The push 「有事等你决定」 opens phone home. Home showed the butler, sessions and spaces, but nothing that waits. The waiting queue items were only on each space's queue page, unfiltered. The confirmation list page had no link to it, and the bell lists records only.

Change: phone home starts with a 「等你 · N」 section when something waits; when nothing waits, home looks as before.
- It uses the desktop rules in `app/task-stream.js` `waitingItems`.
- Order: decisions first, then confirmations, approvals, questions, and 要你看看 last. Within a kind, newest first.
- Held reasons count as 要你看看.
- A decision whose session was archived or ended does not count.
- Only actionable confirmation cards count, and a batch is one row.
- A card whose deadline passed on the phone clock is left out.
- Each row opens the existing phone page that acts on it: the space queue with that item scrolled into view and flashed, the confirmation card or batch, or the chat.
- Tags use the desktop words.
- No new action, authority, server route or network change.
- The summary gains two read fields on waiting queue items, `time` and `ownerEnded`. The phone cannot see archived sessions to apply the ended rule itself.

Differences from the desktop, from what the phone summary holds:
- A queue item's time leaves out its room events.
- Approvals use the session state `approval`.
- Open questions are one row per session, not one per question.
- The question tag drops 「不阻塞本轮」.

Not covered: the butler's own 「需要你决定」 reply (`butler-question`) and operator-creation cards. The phone summary carries no message bodies for them.

Tests:
- `app/tests/mobile-waiting-list.test.cjs`. It includes a check that fails when the desktop's held reasons or rank order change.
- One projection test in `app/tests/mobile-workspace.test.cjs`.
- `scripts/test-phone-waiting-list.cjs`: real phone assets in headless WebKit with `page.route`, no listener. It runs zh and en, at 390×844 and 320×568.

On the previous code all three fail. Ten mutations of the key lines are each caught.

Undo: revert the commit. Nothing else depends on the new export or fields.
