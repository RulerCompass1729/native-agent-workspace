# A message whose recipient ended before it was offered is not sent

A held automatic message whose recipient had ended, for example because a rotation replaced it, was recorded as unconfirmed. The sender was then told that it may have arrived and not to send it again, although nothing had been written to any session. Following that lost the message.

The recipient's side looks up the session and its runtime before it takes the message from the sender. Either lookup failing now answers not sent, with the reason the lookup gives. Nothing else in the delivery path changed: a failed take, a write that fails, a lost answer or an unreachable backend still leaves the outcome unknown. The change is in the recipient's backend, so it applies once that backend runs the new version.

An ordinary automatic message, not only a held one, also changes from unconfirmed to not sent when its recipient ended before the turn did. Its row reads "Automatic message was not sent" with the reason, and the reader labels it not sent. Only a sender whose message was held is told with its next call, once, as before. The butler's event for such a message reads `not-sent:session-ended` instead of `unconfirmed:delivery-failed`; it is still one event per message, and the wake it causes is unchanged.

## Checks

Eight new tests failed on the unchanged code with the recorded status unconfirmed. Three more pin what must not change and passed on both: after the take, the recipient ending while it is written, a lost answer, and a lost take answer all stay unconfirmed and are not sent again. Six mutations of the change each fail at least one test. The 18 related files pass, 432 of 432. The full suite was not run. No model was called, no real Claude or Codex session was used, and backends of two versions were not run against each other.

## Known gaps

A message is not redirected to the session that continues from its recipient. A message offered while a rotation is under way still goes to the old session. A backend that is gone or cannot be reached still leaves the outcome unknown, although nothing was written. The readiness check at registration throws a TypeError when the recipient's record disappears between the lookup and the check; this came with the held messages, predates this change and is not fixed here.
