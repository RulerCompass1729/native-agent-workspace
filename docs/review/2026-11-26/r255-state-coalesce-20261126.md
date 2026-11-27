# R255: main process saturated by per-frame combined snapshots

## Failure (the person, 2026-11-26)

- 20:13 PT: 「而且 NAW 的内存在不断上涨,必须要修,而且这会打字已经变得非常卡了」.
- 20:5x PT, after a restart: 「而且越来越卡了,打字完全卡的不行」「NAW 的内存占用也上去了,到底怎么回事」.
- Daily observation (read-only): the main process at about one full core after every start, including alpha.314;
  one busy backend's daemon dropping its main-process connection every one to two minutes with
  `write-queue-frames` (over 1024 unread frames, `app/service-transport.cjs`).

## Cause (source, then a synthetic Node replay)

- `app/workspace-client.cjs` `bindEntry`: every `state` frame of any backend rebuilt the combined snapshot of all
  backends (`snapshot()`) and emitted it. Each window has its own `WorkspaceClient` connected to every backend,
  agents' background windows included (`app/main.cjs` background `connect`).
- `app/main.cjs` `bindClient`: on each such event the page context runs `displayState`, and every context runs the
  butler observers, of which `observeHumanInputs` and `observeWakeUndelivered` read every session's messages.
- R230 (alpha.230) already keeps background windows from computing `displayState` and from receiving IPC. It
  does not cover the combined snapshot or the observers, which every window still ran on every frame.
- Replay at the daily shape (counts only: 25 backends, 324 sessions, 289,344 messages, synthetic text), real
  `ServiceClient`, state encoder and `WorkspaceClient`, with a stand-in for the listeners' message passes:
  per state frame and window, decode 0.1 ms, `snapshot()` 2.8-2.9 ms, listener passes 2.2-2.6 ms; a terminal
  frame 1.5-2.5 us. The cost is per frame, without a bound on the frame rate (the daemon sends at most one
  state frame per 35 ms per backend).
- Timed replay, four busy backends at the 35 ms cadence plus terminal output, 6 s: one window 73 snapshots/s
  and CPU share 0.76; three windows 159 snapshots/s, CPU share 1.06 (saturated: the replay could not keep the
  frame rate).

## Change

- `WorkspaceClient.stateChanged()` / `emitState()`: the first change emits at once; later ones within
  `STATE_EMIT_WAIT` (250 ms, the page's own spacing `STATE_PUSH_WAIT`) emit once, with the snapshot as it is then.
  Each entry's `state` is still updated on every frame. Nothing waiting is emitted after `close()` or `retire()`.
  A snapshot that throws closes the view as before, at the emit.
- `app/tests/workspace-client.test.cjs`: the cache-gap test waits for the coalesced emit before counting two
  updates; what it checks (a second backend's gap does not disconnect the window) is unchanged.

## Checks

- `app/tests/workspace-client-state-coalesce.test.cjs`, 2 tests. Before the change both fail (83 emits for 83
  frames; a frame after the first emitted at once). After: 2 pass.
- The 72 test files that use `WorkspaceClient`, `service-client.cjs`, the mobile broker or the butler service
  driver: 1497 pass, 0 fail, 0 cancelled, 0 skipped.
- Timed replay after the change: one window 4 snapshots/s, CPU share 0.31; three windows 12 snapshots/s, CPU
  share 0.37, with the full frame rate kept (259 frames/s). The remaining share is mostly the replay's own
  daemon-side encoding, which runs in the same process.
- Compared, read-only, with lane `claudeb-main-state-fanout-20261126` (uncommitted, same function, spacing three
  times the last emit's cost, at once below 20 ms): three windows 161 snapshots/s, CPU share 1.02. At the daily
  shape one emit costs about 6 ms, under that threshold, so it does not coalesce.
- Not measured: the real `displayState` and observers (a stand-in made the message passes); terminal and
  progress frames forwarded to the page over IPC (`webContents.send`); the daily frame rate (no instrumentation of
  the daily app); memory after the change (this change targets CPU and typing lag, not memory growth); and the
  daily app after installation. All figures are from the Node replay.

## Independent review (2026-11-26 21:46-21:48 PT)

- Fresh headless session, Read/Grep/Glob only and no MCP servers (checked in its initialization record), 15 turns,
  14 tool calls. `fable` was requested; the session reported `claude-opus-5-5`. Lane HEAD, index and worktree
  unchanged after it.
- VERDICT: PASS, no blocking finding, for 15d4b9bf.
- Non-blocking, recorded: a terminal dialog or native question that opens and closes within one 250 ms window
  now leaves neither its open nor its ended record (as a pair, so no open record stays behind); queue dispatch's
  vacancy timer can start up to 250 ms later; the legacy-input path still emits directly (at most one extra emit).
- Suggestions taken: this section's list of what was not measured; the code comment cut to two lines (no
  behaviour change). Not taken now: a test for a pending emit across a backend `closed` and `replaceService`
  (add when either path changes).
- The reviewer did not read the related-test log; the 72-file result rests on the author's run.
