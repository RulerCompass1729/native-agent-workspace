# The butler's wake names how NAW last ended

The wake message said 「有新事件」 and a position whatever had been recorded, so after a crash the butler could not tell from its own wake that the last run had not ended normally.

A wake that covers a start of NAW now ends with that start's own reason code, 「原因含 version-restarted-after-abnormal-exit。」. The four codes are those version events already record: `version-installed`, `version-restarted`, and each with `-after-abnormal-exit`. Several starts give each code once, in the order recorded. 「含」 because a wake covers everything since the last one and other events may be there too. Without a start in it the message reads as before, and the position, the switch, the minute between wakes, the refusal limit and the answer on the butler's own card are unchanged.

## A condition that changes

Condition (1), set by the butler then designated on 2026-11-13, says a wake carries only a position. The request of 2026-11-25 asks for a reason in it. The reading taken: only these fixed codes, from events with a version event's own id. No text, name, version, time or id that was recorded is in the message, and another event whose reason reads like a code is not named, since such a reason can be anyone's words. The condition's comment says so.

## Checks

On the unchanged code six of the eight new tests fail, the abnormal exit, the normal exit and the new version among them; the two that pass assert what must not change. An existing test found that a wake of refused calls only would read one page more than its bound; such a wake holds no start and is not read again. Twelve mutations of the change are each caught. Related suites: 2567 tests pass, none skipped. The real exit marks, version events, event record and dispatcher are used; no process was crashed and no model was called.

Trial merges, each in a temporary clone: c12ed342 and 85119452 merge without a conflict and give the same tree (85119452 adds nothing to c12ed342 but release 300), 667 tests pass on it. 9f66fdab, in the next release, renames a method of the version events that the first version of a test here called; the test now records such an event without it. It also conflicts with the base in `queue-dispatch.cjs`, which this change does not touch.

## Known limits

- Other events (a failure, a refused call, an answer) still wake with the generic wording.
- A start beyond the first twenty pages read is not named; the wake still covers it.
- A start recorded after a page that cannot be read is not named.
- Not yet operated in the daily app.
