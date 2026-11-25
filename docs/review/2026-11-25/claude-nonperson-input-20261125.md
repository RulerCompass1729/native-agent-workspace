# Three changes that stop nothing no longer withdraw a turn's automatic messages

The person approved three cases, each recommended in the earlier follow-up to the withdrawal reasons. Until now each withdrew what the running turn had registered and refused what it registered afterwards, though nobody had stopped anything.

- **Reconnect.** The window that controls a Codex session reconnects to it, the native process lives on and the same native turn is still running. The control and connection changes the reconnect itself makes are now counted like the person's own words: they neither withdraw nor renew. Another window's reconnect, one through background control, one that fails, one that comes back in another turn or with no running turn, and one with a takeover, stop, interrupt or pause around it withdraw as before.
- **Another agent's queue or steer through NAW's background control.** Counted as message input. Its typing and key sequences, sending, interrupting, taking over and pausing still withdraw, and a control call of that session (the caller's own scope) still ends on the queue or steer. The caller says that the input is an agent's; a native input event is never taken for one because of where its connection was opened.
- **The wheel and focus reports in a terminal.** SGR buttons 64 and 65 without modifiers, and the focus-in and focus-out reports, are now treated like hover: not the person's operation, so they pause and withdraw nothing. Clicks, drags, releases, the sideways wheel and any key in the same write still are.

Esc, Ctrl-C, interrupt, takeover, the switch, pause-all, stop, migration and identity changes are unchanged, and so is anything unnamed.

The recommendation was to compensate the two counters. That alone changes nothing for a real Codex reconnect, because the adapter clears its running turn and no later event names it again. So after a successful reconnect by the window that kept control, the adapter asks native once for the thread's latest turn (`thread/turns/list`, one entry, no items, on a qualified version only, three seconds at most) and keeps its turn only when that is the same one and still in progress. An error, no answer, an end or another turn arriving meanwhile, or a replaced connection leaves it unknown, as before; so does a reconnect by anyone else. The kept turn is not announced as a new one, so keeping it renews no permission. Its end is reported like any turn's, and what NAW does at a turn's end follows, including the retry after a capacity failure.

The queue dispatcher's own list of terminal replies keeps counting the wheel as the person using the session; only its comment changed.

## Checks

On the unchanged code 17 of the 612 tests in the three changed files fail and 595 pass; the new ones that pass assert what must not change. All 612 pass on the new code. 42 mutations of the first version's conditions leave three that change nothing observable (a space's queue or steer is withdrawn by its own pause anyway; a guard before the native question that is repeated after it) and one in a label that existed before; 11 more of what the review changed are all caught. No model was called and the daily app was not touched. The Codex reconnect ran against the real adapter with synthetic native answers, not a native process.

## Known limits and proposals, not done

- A message registered before the connection is lost is withdrawn by the loss itself, which the approval does not cover; a test records that. Whether a lost connection should withdraw is a separate question.
- A window opening a session that nobody controls also withdraws the running turn (the reason reads "opened"). It is the same kind of change and was left alone.
- The earlier plan also listed another agent's plain typing through background control; the question put to the person named only queue and steer, so typing still withdraws.
- A rolling wheel that the terminal turns into arrow keys is still keys.
- The wheel and focus reports also no longer pause an open handoff; that is the same one condition, not a separate change.

## Independent review

The first pass found no path that loosens a stop or an unnamed change. It blocked on evidence only: a wide run taken before the last edit still showed one failing source-shape test, and the old-code run used earlier tests. Both were run again. Three of its notes changed the code: only the window that kept control asks native to keep the turn, another agent's input is marked by its caller, and a control call's connection is compared as it was before.
