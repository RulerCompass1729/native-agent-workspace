# A title that arrives after its window is destroyed (2026-11-25)

Reported: an uncaught "Object has been destroyed" dialog from the main process,
at the `page-title-updated` listener in `app/main.cjs`. The step that destroyed
the window in that case was not established; there is no log of it.

- Cause: when a window is destroyed while its page reloads, a title event can
  still arrive, and `win.setTitle` on the destroyed window throws. The listener
  in `app/local-pages.cjs` was written the same way.
- Fix: both listeners set the title only while the window exists. They still
  prevent the page's own title.
- Tests: one in `local-pages.test.cjs`, two in `main-window-title.test.cjs` (the
  actual line from `main.cjs`). On the base, two fail with the reported message.
  Six mutations (guard removed, guard inverted, `preventDefault` removed, for
  each listener) all fail. The 119 test files that read either source:
  3,512 of 3,512, no skips.
- Hidden Electron 44.9.0, actual listeners, a page on 127.0.0.1, 60 rounds of
  reload then destroy each:

| | late title events | uncaught | title kept |
|---|---|---|---|
| base, main window | 15 | 15 | 60 of 60 |
| base, page window | 19 | 19 | 60 of 60 |
| fixed, main window | 14 | 0 | 60 of 60 |
| fixed, page window | 28 | 0 | 60 of 60 |

Not run: the packaged application.
