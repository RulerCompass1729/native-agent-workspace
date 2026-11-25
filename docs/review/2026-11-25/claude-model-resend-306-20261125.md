# A send planned before its session's model change (2026-11-25)

Branch `lane/claude-model-resend-306-20261125`, base `b6a4fe81`; fix `47f399fb`.

Found by the alpha.303 cross review (narrow point 1): the dispatcher reads the
sessions whose model the person is changing once per pass, when it plans. A
change asked for while that pass was sending (its fresh read, or an earlier
send to another member) still let the planned queue item or the rotation's
handoff request go out, to the model the person was leaving.

`dispatch` and `requestHandoff` now ask again right after their fresh read and
before anything is recorded or sent. The item stays queued with the wait reason
`model-change`, as a planned hold has; the rotation is left to the next pass
and is not told as a rotation that waits. Butler wakes, notices and supplements
are unchanged: the plan does not hold them either.

Checks, without a model call:

- The new tests: three fail on the old code; all pass with the fix. The fourth
  (a value that is not a list holds nothing) keeps the plan's own rule.
- Eight mutations, all red (no check in either place, the check before the
  fresh read in either place, any change holding every member, no wait reason,
  a rotation told as waiting, a non-list value).
- `queue-dispatch` 569/569; the other 69 files that use the dispatcher or the
  model changes 1848/1848; none skipped.

Not checked: a running app, and a session of either provider. Independent
review: pending, by someone other than the author.
