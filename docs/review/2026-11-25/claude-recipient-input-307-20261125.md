# R238: ordinary input into a recipient leaves the message on its way to it

Branch `lane/claude-recipient-input-307-20261125`, on `b6541b3b`.

**Problem.** An automatic message named its recipient by raw control and peer revisions, so one key typed into the
recipient withdrew it, while the same input into the sender has not since 2026-11-24 (3b/3c). The person agreed on
2026-11-25 that ordinary input into the recipient no longer withdraws it and Esc/Ctrl-C still do.

**Change.** The recipient's backend counts ordinary input per session record (`session-wake.cjs` `recipientInput`) and
publishes the counts with a random epoch in its snapshot; they are never saved. `recipientIdentity`
(`peer-handoffs.cjs`) takes them off the revisions and marks the proof with the epoch. Registration, relocation, the
preflight, every check at the recipient, `receive`'s entry proof and the send guard use it. Without readable counts on
either side the proof stays raw: the old rule. Not counted, so still withdrawing: a reconnect, another agent's background
send, queue, steer or keys, a superseding machine input, gaps, other control boundaries, and a piece of terminal input
with an Esc in it.

**Half-typed text.** Claude's mod already refuses a message while its prompt holds unsent text; that refusal, and the
person's input that reached native first, now hold the message (the existing 2 hours and 32 messages) instead of ending
it. Claude's prompt is asked again only after input there, or after 10 minutes. Codex takes a message through its server;
its terminal's prompt is not touched.

| Finding | Severity | Owner | Status |
| --- | --- | --- | --- |
| Input into the recipient withdraws a message on its way to it | High | author | Fixed; 13 acts at 3 moments: red before, green after |
| The person's input between the reservation and native made the message's own ticket stale | Medium | author | Fixed (`budgetIssue`) |
| `steward-entry.test.cjs` names the counters `session-wake.cjs` may keep | Low | author | Extended with `recipientCounts` |

**Checks.** New tests 151/151 (old code 99/151); `session-wake` 217/217, `session-wake-busy-hold` 77/77 and 143 related
files 3918/3918 after the one guard above was extended; 54 mutations red. Old and new code on either side, in both
directions: 12/12. Real CLIs without a GUI or a paid model: Claude 2.1.332 idle and mid-turn, Codex 0.172.0 idle, at work
and steered (steer is closed for 0.172 and was opened by the test): the half sentence stayed as typed, entered no request
before the person sent it, and the message arrived once, on its own.

**Limits.** An Esc and one letter in one piece of terminal input is an Option key, as it is to both CLIs. The sender's own
rule still reads a mixed piece such as `abc` + Esc as ordinary input. Writing to the recipient through a space's queue or
steer still withdraws. Mouse clicks and drags in a terminal count as ordinary input, as they do for the sender.
`queue-dispatch.test.cjs` was not run on this branch: the alpha.306 batch had the machine. Independent review: pending.
