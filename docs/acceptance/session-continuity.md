# Existing-session continuity — M2

As of 2026-10-20, alpha.45. This acceptance concerns local GUI/TUI continuity,
not arbitrary native fleet restoration or unlimited history size.

## The user workflow

Read an earlier paragraph in a long conversation while output continues, keep an
unsent draft, switch to another conversation and back, switch GUI/TUI, quit and
reopen, then recover after the local service is interrupted. The expected result
is the same conversation identity, complete saved history, draft, membership and
reading position, with no automatic task replay.

The actual Electron/DeepSeek Harness application runs against an isolated local
service. Test windows are hidden and non-focusable to avoid interrupting the
person's desktop. Pointer, keyboard and application actions use the rendered UI;
the provider output is synthetic so the local failure can be reproduced without
model latency, fees or private conversations. This is not physical OS IME proof.

## Findings and fixes

- About 19.5 MB of synthetic history disconnected the original client. Its receive
  limit was applied before separating messages; the sender also disconnected at
  8 MiB of socket backlog. Alpha.45 parses complete UTF-8 frames independently
  and waits for socket drain. Only queued complete state snapshots supersede each
  other; terminal bytes, progress and RPC responses retain order. Replaced states
  go after intervening replies, preventing an older initial response from winning.
- The actual long-history workflow exposed a visible GUI/TUI choice that was not
  saved until native control acknowledgement. Quitting in that interval could
  reopen the previous surface. The displayed preference now saves independently;
  input and ownership still wait for their existing guards.

## Verification

`node scripts/test-long-continuity.cjs` exercises the real app with 80 large
records, approximately 19.5 MB. It verifies the entire saved history hash, draft,
room membership and native ID; earlier reading survives live output, conversation
and view roundtrips, reopening and cold service reconnection. A held control
request verifies that the displayed choice reaches disk before acknowledgement.
The final run also closes the app while that request is pending, then rejects the
test-held request and reopens the app. Recovery remains explicit and dispatches
stay zero. Source and final installed outcomes are recorded in [testing.md](../testing.md).

The transport tests use an actual paused TCP reader to exceed the former send
backlog threshold and the former receive cap, then verify exact terminal bytes,
RPC response and latest state ordering. Boundary tests cover malformed frames,
UTF-8 byte limits, multiple frames in one read, and finite reliable backlog.
An actual alpha.44 service with 100 short synthetic records also stays alive
when the installed alpha.45 app creates its current backend slot. Normal reopen
keeps the old PID, native identity, exact history, draft and reading position.
Existing service-reuse tests cover guarded old-service continuation and refusal
to replace an active or unconfirmed native service. Input/focus regressions check
that early view persistence does not grant control or redirect input.

## Explicit limits and follow-up triggers

- Responses still contain complete history, with a 64 MiB per-frame boundary.
  The 128 MiB writer queue bound excludes the one frame already accepted by Node,
  parsed objects, DOM and serialization temporaries; it is not a total RAM cap.
  Reaching a boundary disconnects rather than truncating or replaying data. If
  ordinary workloads approach it, page history and send incremental state before
  increasing the supported scale. This increment does not claim infinite history.
- A retained old daemon keeps its old transport behavior. Installing the new UI
  does not hot-patch it. Existing guarded continuation remains the supported way
  to change a backend after its native work is confirmed ended. U05 remains open
  for arbitrary live-version migration; U17 for unavailable historical screens.
- Cold recovery restores saved local records and offers explicit native resume;
  it does not certify restoration of every running native teammate or subagent.
  Physical IME, foreground Spaces behavior and provider inference were not rerun
  in this local transport test. Existing relevant evidence retains its scope.
