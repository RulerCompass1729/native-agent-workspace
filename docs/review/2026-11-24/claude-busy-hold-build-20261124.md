# Keep an automatic message whose recipient is at work

An automatic message refused because its recipient is in a turn it cannot join was not sent, and the sender had to notice and repeat it. The sender's backend now keeps it, looks once a minute, and the recipient takes it only when idle, never inside a running turn. It keeps at most 32 such messages, each for two hours, then records it as not sent. The sender is told once, with its next call to the message tool. The designated butler is told through its existing wake. No new store, timer or page was added; the 60-second and three-in-a-row limits and the recipient's checks are unchanged. A recipient on an older backend still refuses at once.

The person decided that ordinary text typed into the sender, and another agent's message to it, no longer withdraw a held message. This also covers messages held for the butler's 60-second limit and for a migration's quiet window. Esc, interrupt, takeover, the off switch, pause-all, the person acting on the recipient, a changed identity and a backend restart still withdraw it, with their existing assertions unchanged. The existing assertions that ordinary input withdraws a held message were reversed with the decision, and one test now shows that words such as "Do not send that one." no longer withdraw it.

Not approved and not here: a reconnected terminal and background input into the sender still withdraw a held message. Text sent to the sender from the phone also still withdraws it, and so does writing to the sender through a space. Scrolling and focusing the sender's terminal share the path of typed text, so they no longer withdraw a held message.

## Checks

The new tests failed on the unchanged code first: 47 of 195 in the three wake suites and one in the butler suite. The mutation run over the new conditions left two survivors at first; one was covered by an existing suite and one got a new assertion. No model was called and no real Claude or Codex session was used. The label's wording was not checked in a real window, and backends of two versions were not run against each other live.

## Independent review

A non-author review covered the permission boundary field by field and found no path into a running turn, no double send and no loosened limit. It returned two blocking findings. A message answered as held could end before its turn did without the sender or the butler being told. An unknown outcome was told as not delivered, which invites a second copy. Both have tests that failed before the fix.

It also found that the person writing to the sender through a space during an offer no longer withdrew the message, and that a notice could be lost with a failed save. Both are fixed with tests that failed first. A mutation run over these fixes left no survivor.

## Known gaps

The one-minute look misses a shorter idle moment, and a later message may enter a running turn ahead of a held one. A recipient that took an automatic message within the last 60 seconds refuses for that limit first, so a message to it is not held even when it is also at work. A Codex recipient that starts a turn while its goal is being read ends the message as not sent. A held message counts as in flight at the install gate, so it can delay an install; messages held one after another can delay it longer than two hours. The gate is unchanged.
