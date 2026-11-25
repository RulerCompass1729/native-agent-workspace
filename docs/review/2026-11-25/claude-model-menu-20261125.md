# Change the model of one session from its menu

The person asked for a way to change a running session's model without typing into its terminal, and approved a design for it. A session's ⋯ menu now has 「换模型…」 with the model it runs. The dialog offers a model and a reasoning effort and changes only that session; the person's own defaults stay as they are.

- **Claude.** NAW stops the session once nothing would be cut off and resumes the same native session with the chosen model and effort, for the window that had it. While it is answering, waits for an answer, holds a queued item or an automatic message, is used by the person or its backend is away, the change waits, the menu and the dialog say for what, and the person can withdraw it. A running teammate, background or scheduled task refuses it with its reason, at once or when the turn ends with it running. A session that could not come back, with its directory gone or no conversation yet to resume, is refused before anything stops. Text that may be left in the terminal is saved first and the notice names the copy; without the copy nothing is stopped.
- **Codex.** `thread/settings/update` with a model and effort that Codex lists for this thread, from its next turn on, without a restart and also while it works. Codex takes a model it does not know without a word, so only listed ones are sent, and the change counts only when Codex reports the new settings.
- **An agent, the butler included,** can ask for it through NAW's background control (`modelChoices`, `changeModel`). Every call is a card that the person confirms, also for the asking session itself, and no standing permission covers it. What cannot be changed is refused before a card is shown. Nothing types `/model` into a terminal. Agents cannot withdraw a change.

The stop is the one an update of NAW's backend already uses (`maintenanceStop`), against the exact idle state that was read. It differs in two things: for a caller that saved the terminal, text left there does not refuse it, and it pauses only what this session takes part in. The resume is the session's ordinary one, and pauses no more than that either.

A change is done when the session is back and live and its record holds what was chosen, not when the resume was asked for; which effort a Claude session really uses shows only in its next turn. An answer that was lost (a timeout, a closed connection, an outcome the backend does not know) leaves it open: the session is looked up for up to two minutes, and the report is done, stopped (with what to press; only where its end is known) or not confirmed; it is never made a second time. An error before the stop began is its own reason and leaves the session as it was. Anything that moved between the read and the stop makes it wait again, five times at most. What waits is kept for a day in a private file (session, model, effort and time) and then said to have ended, also when the app was closed meanwhile; one that was being made as the app closed is only looked up after it starts again, and after more than a day is not confirmed.

A session in bypass that its person left for another mode, without a turn since, is resumed in the mode they left it in: the resume asks for bypass only when the session's own transcript does not end in another mode. Never the other way.

While a change waits, the queue sends that session no new item and does not rotate it. After a model change a Codex thread names its ordinary mode `default`; the queue's rotation now reads that as the ordinary mode, and any other mode still stops a rotation.

## Checks

The related 293 test files pass on the reviewed fixes (6141 tests); after the last small ones the 26 files that touch the changed modules pass (525). The window and native checks below ran before the last small ones, which show in neither. Mutations: 95 of the first version's conditions are all caught, after two simplifications and seven tests; of 78 of what the review changed six were left, which led to two simplifications and three tests, and the one that remains is the length of the two minutes, which the tests read from the code; seven of the last ones are caught, one of them after a test was added.

A hidden test window ran the real page, preload and main process over synthetic sessions: the menu, the dialog with its choices, an idle change, waiting and withdrawing, the refusals, a session that stopped and did not come back, Codex, the 850 by 600 window and English. It found that the page's bundle had a list of its own without the new module, which left the real window half drawn while every unit test passed; a test now compares that list with the page.

With the installed Claude and Codex programs and a local stand-in for their model service (no account, no network, no cost), outside the daily app:

- Claude: all four listed models, the native default and an effort alone. Each was reported done only once the session was idle again, kept its native session and history, and the next request carried exactly the chosen model and effort.
- A Claude session with no turn yet is refused, in the dialog and as a request, and stays usable.
- Permission modes: default, accept edits, plan and auto come back by themselves; bypass comes back as bypass, and one left with a key and no turn after it does not.
- After `/clear` the change waits for the report of background work and is refused when none comes in 20 seconds. The first version reset those 20 seconds at each look and waited without end.
- Codex took the settings in the chat and in its own terminal, reported them, and used them from the next turn; plan mode stayed plan mode.

No real model was called.

## Known limits

- A running background task refuses the change, so a session that always keeps one, such as a timer, can be changed only between two of them.
- A Claude session that has had a native team is refused as long as a backend update would refuse it.
- Claude's list is fixed in NAW, with the model the session runs added when it is not in it; Claude names no list to ask for. Another name is refused.
- NAW does not know which model a native default stands for, so choosing it is always a restart, and after a lost answer it is called not confirmed.
- A backend update still asks for bypass again in the case that the model change now avoids; that resume was left alone.
- The choices are read without a card; only the change is one.
- Without a transcript to read, a bypass session is resumed in bypass, as before. A transcript that is gone counts as a conversation that has not begun.
- A session deleted while its change waits or is made is shown as waiting for its backend, for a day at most; nothing is done to it.
- A backend started before this version has none of it and says so in the dialog; nothing falls back to typing a command.
- With no window open, a change waits.
- A Codex version without `thread/settings/update` refuses the change; the fallback of naming the model with the next turn was not built.
- A Codex session on another vendor's profile, and other providers, are refused.
- Not yet used in the daily app.

## Independent review

The first pass blocked on two things. A change whose outcome was lost, or that had stopped the session, could be reported as not made. And the resume could leave the permission mode other than it was, without evidence that native keeps it. Its eight notes led to the limit on model names, the true reasons for an archived session and a storage warning, the pause of only what the session is in, the vacancy list, the end of waiting after a day and the Codex plan-mode check; two are known limits above. It also asked for four wording changes, all made. Running the real programs for the second point found two more: a session without a conversation cannot be resumed, and the 20-second wait started over at each look.

The second pass, on the fixes, passed with nothing blocking and passed the wording. Three of its eight notes changed the code: a session whose end is not known is not called stopped, what waited longer than a day while the app was closed is said, and only a regular file is read as a transcript. The third, on those, passed with nothing blocking.
