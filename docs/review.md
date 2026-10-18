# Review and issue record

As of 2026-10-18. This is a working acceptance record, not an independent security
certification. Private transcripts, screenshots, paths and account details stay
outside the public repository. Use synthetic reproductions here.

The author and independent reviewer have separate roles. The reviewer reads the
actual change, callers and complete evidence, then checks the original feedback
and plausible counterexamples. The maintainer verifies those findings and owns
the final delivery decision. Small changes need one short review; complex fixes
are reviewed again when new evidence is available. No automatic model-test loop
or standing background agent chat is required.

Issues move through **reported → reproduced → fixing → awaiting review → closed**.
An untested case remains **unverified**. A code change, mock or skipped test alone
does not close a native-user-experience issue. Reopen the same item when evidence
contradicts it; keep the former result's scope and date.

| ID | Source / trigger | Priority / owner | Status and evidence | Remaining check or trigger |
| --- | --- | --- | --- | --- |
| U01 | User: repeated test launches created extra windows/processes | High / desktop maintainer | Same-profile app lock, UI-host lease and exclusive test driver exist; `ui-lifetime.test.cjs` covers host cleanup. Initial alpha.8 upgrade/reopen had one window | Repeat affected lifecycle checks after lifecycle changes; retained native services are distinct from UI instances |
| U02 | User: raw startup failure showed an access URL; plugin/theme startup failed | High / desktop maintainer | `ui-errors.cjs` uses safe messages, with token/URL regression coverage; pinned DSH UI composition and earlier visible startup checks are documented in alpha.md | Clean-machine download/Gatekeeper and dependency setup remain unverified |
| U03 | User: native TUI input and unified GUI/TUI experience must be reliable | High / adapter maintainer | Current source routes input to the same native session; alpha.8 visible test sent an unsent terminal draft only to its old target | Codex mixed drafts, physical IME/VoiceOver and full native permission races remain unverified |
| U04 | Maintainer: wrapper overrides native permission defaults | High / adapter maintainer | Alpha.7 removed overrides; real native Plan/Read Only startup evidence in alpha.md | Complete native configuration parity and managed-policy matrix remain unverified |
| U05 | User: updates must preserve existing sessions while enabling current features | High / desktop maintainer | Closed for app-update continuity after independent review: visible old/new-session path and installed alpha.8 with three retained alpha.2 sessions passed; IDs/PIDs, membership, history counts and view preserved | OS restart/fleet recovery is separate; no automatic replay or live migration |
| A08-1 | Reviewer: start run, then human input before the 35 ms state broadcast | High / upgrade fixer | Closed after independent review: shared run intent precedes the first await; delayed JSON snapshots, other-window input, closed originating window and real registered IPC handler regressions pass | Local control/transport proof; no claim of retracting a native submission already accepted |
| A08-2 | Reviewer: repeat updates with live sessions, then end older sessions | High / upgrade fixer | Closed within scope after independent review: ended service slots are reused; only empty inactive services retire, retaining history/drafts otherwise | Services holding ended history remain resident; create limit does not impose a total backend/resume limit |
| A08-3 | Reviewer: new backend ready but routing-table publication fails | Medium / upgrade fixer | Closed after independent review: pending ownership is saved before spawn; activation/pause/write failures reuse the tracked slot; rollback reuses an existing live version | Covers process/operation failures; routing-file power-loss durability is not verified |
| A08-4 | Final regression: socket closes before shutdown has released its owner record | High / upgrade fixer | Closed after independent review: confirmed all-ended shutdown waits for socket, lock and known PID release; close callbacks no longer resave old state | Final suite 90/90; delayed-lock regression passes; timeout refuses replacement without killing the old process |
| U06 | User: cannot rename a conversation | Medium / session-label fixer | Closed after independent review: rename/cancel/validation, sidebar/title/room, two windows and reopen passed; installed alpha.2 live-session rename/reopen/restore preserved native identity and history | Local display name only; physical IME/VoiceOver not covered |
| U09 | User: permanent rename button adds clutter; use a session context menu and review similar controls | Medium / desktop maintainer | Closed after independent review: one DSH menu for row ⋯ and right-click; header actions consolidated. Installed alpha.9 covers target identity, mouse/keyboard, repeated-trigger closing, two windows/reopen and long names. Existing three live sessions and current view preserved; normal reopen shows one window | Retain primary controls; other design findings below. No new native prompt or dispatch |
| A09-1 | Headed test: initial DSH portal focus remains on trigger, so keyboard cannot select menu actions | Medium / desktop maintainer | Closed after independent review: focus after layout only if still on opener; state refresh retains the row, terminal startup cannot steal menu focus. Installed focused-item, End/Enter, Tab/ShiftTab and Escape checks pass; full local suite 90/90 | Physical IME/VoiceOver remain unverified; repeat affected focus checks when updating DSH |
| U09-F1 | Source/UI review: selected-text sharing remains clickable without a selection | Low / desktop maintainer | Open design follow-up; currently toasts a request to select text. No unintended dispatch observed | Next sharing-path change: enable by valid selection, preserving whole-message sharing |
| U09-F2 | Source/UI review: installation check is prominent even after setup is ready | Low / desktop maintainer | Open design follow-up; first-use/missing-dependency visibility remains useful | Next onboarding/sidebar change: reduce ready-state emphasis, retain discoverability |
| U09-F3 | Source/UI review: automatic check is the primary room action despite unknown-fleet pauses | Medium / desktop maintainer | Open design follow-up; routing safety guard remains in place | Next room-composer change: prioritize human-directed sending and explain automatic-run eligibility |
| A08-F1 | Reviewer: close an observer window while another window awaits run authorization | Low / desktop maintainer | Safe but conservative: closing a connection invalidates pending profile-wide run intent; already accepted native work continues | Next control-UX change: narrow invalidation to the affected view without restoring stale authorization |
| A08-F2 | Reviewer: separate backend slots happen to report the same version | Low / desktop maintainer | Automatic runs are blocked across all backend slots; the current notice describes different versions | Next related UI update: say different backends to cover same-version slots |
| U07 | User: verify privacy, security and cost; prevent sensitive publication | High / maintainer | Local disclosure panel and proactive source/history publication guards exist; no shell title/summary/router model calls | Full egress audit, independent security review and equal-task cost comparison remain unverified |
| U08 | User: Claude/Codex can cooperate after the human leaves | High / adapter maintainer | Human sharing works within documented guards; automatic routing pauses on unknown native background/fleet state | Authoritative native fleet state required before claiming unattended completion; cross-version automatic routing is disabled |

Before a commit or artifact handoff, review the affected rows and record the
actual verification. High-risk issues relevant to that delivery cannot be closed
by a summary or an author-only approval. Unrelated findings stay scoped to their
next trigger; they do not justify expanding the current task.
