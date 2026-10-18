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

Use the cheapest suitable model currently available for isolated Codex tests,
and Sonnet for Claude. Apply model/effort overrides only to test sessions, never
to the person's normal configuration. Verify availability and current pricing
before selecting a model; a fixed alias is not a permanent cheapest-model claim.

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
