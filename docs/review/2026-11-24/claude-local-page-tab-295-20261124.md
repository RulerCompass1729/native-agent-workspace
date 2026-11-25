# Local pages as main-window tabs, ported to alpha.295

Independent review of the ported feature passed with no blocking finding and seven notes. Three were fixed with regression tests that fail on the reviewed commit:

- A page that closed itself left its tab selected and dead, reproduced in a hidden Electron run. The window now returns to the workspace and the tab opens the page again.
- A changed declared origin kept showing the old page, or a released page resumed on the old origin. The new address now loads when the tab is shown.
- A notification that opens a record, and a menu mode switch, acted behind the page. Both show the workspace first.

Closing a window also finishes its own cleanup before its tab pages are closed. The same reviewer passed this change with no blocking finding and four notes; the first version of this record overstated the last two fixes and sat in the shared day file, and this file corrects both.

Not changed:

- A declarations file with an error hides the strip without a message.
- Control-Tab switches tabs in the main window whenever a tab page is declared, also from a terminal.
- The result of opening a page names the declared address when the page resumed elsewhere.
- An edit that keeps the origin and changes only the path is not loaded while the page or its last address is kept; a changed origin takes effect when the tab is shown again, not on reload.
- Notices that only bring the window forward (a waiting tool, capacity, rotation, migration, handoff), and the quit and disconnect toasts, leave a shown page in place.
- After a page closes itself the keyboard may need one click to return to the workspace.
- The new call stays off the list of calls that do not hurry a waiting state: it is sent only on focus, a tab action or a change of strip height.

Checks: 27 unit tests, 619 in 43 related source files with none skipped, and 37 hidden desktop checks with synthetic pages, an isolated profile and no model call. The 20-minute release ran with a shortened timer. Physical key presses and the installed app were not exercised.
