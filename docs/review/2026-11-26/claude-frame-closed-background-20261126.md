# Install frame gate: background windows Electron already dropped (alpha.309)

## Failure

- Source: the alpha.309 strict pre at 00:07 and 00:08 PT. `scripts/install-electron-frames.py:109`
  (`len(offscreen) <= 1`) refused the running alpha.308 GUI. It had four hidden layer-0 windows that were
  neither registered nor among Electron's BrowserWindows (v4 list).
- One is the 500x500 window at (0, 940). The gate already accepts it: 287's window 1071, `SYSTEM_BOX` in
  `scripts/fixtures/test-install-electron-frames.py`. It has been there since the GUI started.
- The other three were 1240x850 at (660, 295) on a 2560x1440 display, with consecutive window numbers.

## Cause (source and read-only observation)

- That frame is NAW's hidden background window, exactly. `app/main.cjs:2117` makes it with
  `windowOptions()` and no view, so it keeps the default 1240x850 (`app/main.cjs:536`). Electron centers
  it, at (2560-1240)/2 = 660 and (1440-850)/2 = 295. It is never shown or moved.
- A live background window is registered at `app/main.cjs:2150` and leaves the registry on `closed`
  (`:2151`). The proof listed no hidden background windows and none of the three in the Electron list,
  so those BrowserWindows had already been destroyed. Background control closes them after five idle
  minutes (`app/background-control.cjs:577`, since 11-12).
- The native windows outlived them for minutes. The same three numbers were present at 00:06:32 and
  00:08:18. They were gone by about 00:12, and two new ones at the same frame had appeared.
- Why AppKit keeps them listed was not reproduced. An isolated, hidden Electron 44 probe could not start
  its window in this environment (exit 133).
- Not new in alpha.308: `app/main.cjs`, `app/background-control.cjs` and `app/window-frames.cjs` did not
  change from alpha.307. The one-window rule dates from 11-23 (ef31bfc6). Whether an install trips depends
  on agents' background activity in the minutes before it.
- State pushes: `sendToPage` and `pushState` skip background contexts (`app/main.cjs:1066`, `:1082`).
  The dropped windows are no longer in the registry either, so no state goes to them.

## Change

- `install-electron-frames.py` records a hidden layer-0 window outside the v4 Electron list whose frame is
  exactly the background default, centered on a known display, as `closed-background`. Such windows do
  not count toward the one outside window, and at most 64 are accepted.
- A live BrowserWindow NAW forgot to register is still refused by the v4 list. So are any other size or
  position, an on-screen window, and a GUI without the v4 list.
- `check-install-state.cjs` accepts these rows before and after install. It keeps at most one other
  outside window, which must carry the v4 proof after install.
- A test ties the size to `windowOptions` and to the background window constructor in `app/main.cjs`.

## Checks (author-run, no model calls)

- On the base sources the new Python case fails at `install-electron-frames.py:109`, the alpha.309
  refusal. With the change: the Python gate tests pass 23/23. `install-offscreen-window` passes 6/6
  (one new test, red on the base), `install-electron-frames` 16/16 and `install-menu-inference` 22/22.
- Not run: a strict pre against the daily GUI. That is the release operator's step.
- Later, if needed: the GUI could report the window numbers it closed (a v5 proof) instead of geometry.

## Review follow-up (00:26 PASS on c2f3fe47, three non-blocking notes)

- `offscreenInference` in `check-install-state.cjs` capped only the total (65), so 65 closed background
  windows alone passed while Python stops at 64. The new case failed on c2f3fe47 ("Missing expected
  exception: 65 closed alone"). JS now has `CLOSED_BACKGROUND_LIMIT = 64` and keeps at most one other
  window. A test reads the Python constant, so the two limits cannot drift apart.
- `scripts/test-install-windows.cjs` asserted at most one offscreen window in total. It now applies the
  gate's rule and lets closed background windows through.
- The pre and compare table rows now name the 64 closed background windows next to "max 1".
- `install-backend-version.cjs` (`check-install-state.cjs:207`) is resolved next to the gate itself, as
  `install-state-reused-slot.test.cjs` asserts. Run from a checkout, both come from the same commit. A
  copy of the gate run elsewhere without it refuses ("Backend version unconfirmed"), so it fails closed.

Checks (author-run, no model calls): `install-offscreen-window` 7/7 (5/7 on c2f3fe47),
`install-electron-frames` 16/16, `install-menu-inference` 22/22, `install-state-reused-slot` 21/21,
`install-state-review` 10/10, `install-state` 25/25, `install-version-count` 11/11,
`install-window-frame` 9/9, `runtime-closure-definition` 26/26, and the Python gate tests 23/23.
Not run: `scripts/test-install-windows.cjs` needs a real Electron GUI. It was syntax-checked only.
