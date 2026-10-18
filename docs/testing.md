# Bounded testing

The maintainer explicitly requires restrained use of Claude/Codex tests. The goal
is confidence in important behavior, not maximum live-test volume.

## Order of evidence

1. Inspect the changed implementation and reuse relevant passing evidence.
2. Check state transitions, routing and failure handling with local synthetic tests.
3. Exercise changed desktop behavior in a visible app, without sending prompts.
4. Use a real native model turn only when the unresolved question requires it.

Every live trial needs a concrete question, a small synthetic task, a finite
root-turn/teammate allowance, and a stop condition. Stop when the evidence arrives.
No status prompts, automatic resubmission, repeat acknowledgements or multi-agent
debates just to make a test feel thorough. Native subagent/tool work must be counted
as usage too; root-turn limits are not provider token/cost limits.

Use the cheapest suitable model currently available for both Claude and Codex
in isolated tests. Verify availability, current pricing and the actual selected
model before sending a task; a fixed alias is not a permanent cheapest-model
claim. If that model is unavailable, stop rather than silently falling back to
a more expensive default. Apply model/effort overrides only to test sessions,
never to the person's normal configuration.

For changes to the Claude bridge, run `claude plugin test app/claude-bridge`
and `claude plugin validate app/claude-bridge` as well. The native test kit executes
the real mod dispatcher with mocked external boundaries, without login, network
or a model turn. Node mocks alone missed a native dispatch difference during
alpha.5 development. Neither kind of local check replaces a visible native test.

## Reuse and retest

An unchanged provider does not need another marker response for a CSS, window,
draft, or packaging change. Retest a native path when its adapter/protocol changes,
the provider version changes materially, or a real failure invalidates the result.
Name untested capabilities instead of expanding live tests merely for completeness.

Use `npm test` for local logic and `npm run test:desktop` for lifecycle behavior.
The desktop runner has one stable private profile and an exclusive runner lock;
parallel launches are refused. Only intentional multi-view checks may create an
extra window, and they close it afterward. Cleanup owns specific child handles,
never broad process-name kills.

## Initial demo evidence

The first desktop check used seven completed top-level native requests for
Claude/Codex terminal/conversation replies and a three-reply bounded handoff,
followed by one Claude native team task with one teammate. The team generated its
own native work and mailbox turns; eight top-level requests are not eight total
model calls and are not a token/cost total. An earlier separate Codex continuity
probe also used one native request. Subsequent stop checks opened one empty
Claude session and one empty Codex metadata thread, without sending prompts;
the alpha packaging/recovery checks likewise sent no model tasks. A later,
explicitly requested fresh-install walkthrough used one bounded Claude request
to verify the first reply after installation, then stopped model testing. It
observed no tool or teammate activity; see [the walkthrough](alpha.md#fresh-install-walkthrough).

Twenty-four local state/lifetime/submission checks and the visible lifecycle regression
passed. They consume no model tokens. The native fleet coverage remains limited
as described in [demo](../demo.md); a synthetic test is never labelled native proof.

The stop checks distinguish a closed PTY stream from a reaped process, an
unsubscribe acknowledgement from a closed native thread, and a failed stop from
a successful one. The visible Claude check verified stopping → ended and actual
process exit; the native OS confirmation dialog was automated, not manually
mouse-tested. The Codex metadata check observed the thread still loaded after
unsubscribe. Both checks cleaned up only their own processes; the original two
sessions kept their native IDs/PIDs, with zero new dispatches on UI restoration.

The protocol distinction follows the official
[Codex app-server unsubscribe contract](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread).
It does not establish fleet termination or an exact billing total.


The alpha build can be exercised by the same visible lifecycle runner:
set `NAW_APP_EXECUTABLE` to the built app's executable and run
`node scripts/test-desktop.cjs`. It uses its own stable test profile and launches
no model tasks. A fresh profile has no native sessions; identity/draft assertions
on that empty profile do not replace the separate live-session evidence in alpha.md.

The runner now checks rendered foreground/background contrast in both light and
dark themes. Playwright's default light appearance previously hid a real system
dark-mode failure; the check explicitly switches themes and then restores the
system preference. It sends no native inputs or model prompts.

The runner also checks the privacy/usage panel, unknown-usage wording, shared-task
drafts and preference validation. With an existing idle terminal owned by the
test view, it verifies font/palette persistence and focus on returning to that
session; an empty profile does not prove those native-terminal checks. Test-only
shared drafts and display settings are restored on cleanup. Native clipboard
typing/selection is a separate bounded check on an inspected empty prompt, using
synthetic unsubmitted text and restoring the original clipboard.

The room check runs only with exactly two controlled, empty idle terminals and an
unused room. Otherwise it reports SKIP, never native coverage. It joins through
the UI, switches both member terminals, checks that viewing does not change
collaboration/control revisions, opens one intentional read-only second view,
exercises explicit takeover and detaches/rejoins the same session. Native identity,
history and dispatch counts must remain unchanged. Room/member selection survives
reopening; cleanup restores original membership and view settings. A small-window
check also verifies that sidebar and pause controls remain usable. Screenshots
are optional via `NAW_EVIDENCE_DIR` and must stay outside the public repository.

`npm run build:ui && node scripts/test-session-menu.cjs` checks the session menu
in a visible Electron window with a new private fixture of two ended records.
It creates no native session and sends no provider task. The check covers an
unselected target with duplicate names, click/right-click/keyboard, focus across
a real service state update, cancellation, rename validation, another window,
room names, light/dark contrast, small-window positioning and reopen persistence.
`NAW_APP_EXECUTABLE` also selects an installed build; `NAW_EVIDENCE_DIR` captures
screenshots outside Git. Ended synthetic records prove UI behavior, not live
native input, fleet lifecycle, physical IME or VoiceOver behavior.

## Late send acceptance and GUI drafts

Run `npm run test:drafts` for a headed desktop regression. It uses one isolated
profile and a delayed synthetic provider transport; the DSH UI, Electron IPC,
service and draft persistence are production code. No provider process or model
request is started. Both provider labels cover retyping identical text, whitespace
edits, failed acceptance, unchanged-draft clearing, switching sessions and UI
reopen. The runner stops only its own fixture service. `NAW_APP_EXECUTABLE` can
select an installed matching app, and `NAW_EVIDENCE_DIR` stores private screenshots.
This verifies the desktop draft boundary, not native TUI draft or turn ordering.

## Terminal connection readiness

`npm run test:terminal` opens a real desktop window with synthetic terminals whose
initial snapshots are held by the runner. It verifies that loading never exposes
an editable terminal or enables paste, including during service state updates.
After readiness, the first input reaches the intended session exactly once. A
late snapshot from another member or an older connection cannot steal focus or
activate stale input. Failure stays noninteractive; explicitly selecting the view
retries. Room and solo views use the same terminal. No native provider process or
model request is started. The installed-build and private-screenshot options match
the draft runner above. Native draft continuity remains separately documented.

## Room composer regression

`npm run test:room` opens one visible Electron/DSH window with an isolated profile,
real IPC and workspace state, and a delayed synthetic provider transport. It
starts no native provider processes and makes no model requests. The check
verifies default form submission, pointer/keyboard activation, explicit automatic
runs, unknown-fleet pauses, pending/blank/ended-recipient guards, late failure and
reopening without replay, saved/legacy/invalid recipients on restart, and
recipient departure in both sharing selectors.
The textarea keeps Enter as a newline; focused buttons support Enter normally.
Set `NAW_APP_EXECUTABLE` to verify a packaged app; do not run desktop runners in
parallel. Synthetic provider labels do not constitute native model/fleet proof.

`npm run test:focus` controls terminal snapshot and view-control timing with the
existing synthetic terminal fixture. It verifies the real desktop focus/input
path when a room snapshot is ready before its control acknowledgement, including
late responses after selecting another member, menus/dialogs, shared drafts,
failure/retry and a simulated competing owner. It opens one window and makes no
native provider or model requests; the owner scenario is not a native two-window
concurrency or permission test. The existing `test:terminal` readiness cases
remain separate coverage for delayed/stale/failed snapshots.

## Complete daily-use regression

`npm run test:daily` uses one visible desktop window and an isolated profile.
It exercises setup appearance, both themes, Codex first-attachment history across
pages, solo conversation/terminal switching, exact input and GUI drafts, rename,
directed two-agent sharing, detach/continue, repeated launch and reopen, privacy
and usage disclosure, and a compact window. Assertions cover actual rendered
replies as well as recipients, message identity, dispatch counts and persistence.
The Codex adapter/Workspace/IPC are real; provider startup, terminal transport and
Claude replies are synthetic. It creates no native provider or model task.

For an installed build, set both `NAW_APP_EXECUTABLE` to the app executable and
`NAW_TEST_APP_ROOT` to its `Contents/Resources/app` directory: the fixture then
loads the packaged daemon and adapters too. Optional `NAW_EVIDENCE_DIR` stores
private screenshots. Run desktop scripts sequentially and preserve the person's
normal UI/session state. This runner reports a single owned-process RSS/CPU sample
and launch timings, not a steady-state or native-agent performance guarantee.
Observed renderer requests are not a complete egress/privacy audit.

`codex-history.test.cjs` separately covers paging, live/history arrival in both
orders, same text with distinct identity, own GUI echoes, overlapping deltas,
working/approval races, closed/stopped reads, malformed data and failed/cyclic
pagination. History imports neither dispatch work nor impersonate human input;
a real human notification must still take precedence even if already displayed.
