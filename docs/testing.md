# Bounded testing

The maintainer explicitly requires restrained use of Claude/Codex tests. The goal
is confidence in important behavior, not maximum live-test volume.

## Order of evidence

1. Inspect the changed implementation and reuse relevant passing evidence.
2. Check state transitions, routing and failure handling with local synthetic tests.
3. Exercise Electron renderer/IPC behavior in a hidden app, without sending prompts.
   Visible desktop acceptance requires an explicitly wanted separate check.
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

Automated Electron launchers use a validated test parent and private profile and
remain hidden by default, including startup, restored views and duplicates. The
checks below can establish DOM interaction and real IPC/storage behavior; they do
not establish visible desktop or physical OS input acceptance. Historical visible
results keep their original dates and scope. Do not activate a test window or
reopen the normal user UI as a cleanup step.

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

## Single-conversation interaction check

`npm run test:solo` uses one hidden Electron renderer at a time against a private synthetic
transport. It covers late view acknowledgements, queued takeover conflicts,
read-only view navigation, unavailable send routes, menu/dialog focus, composition,
explicit send/interrupt, and draft persistence in the DOM, main process, disk and
service after reopening and 12-second idle windows. It waits for actual restored
UI state; the runner never signals application readiness on the renderer's behalf.

For an installed build, set both `NAW_APP_EXECUTABLE` and `NAW_TEST_APP_ROOT` (the
bundle's `Contents/Resources/app`) and run `node scripts/test-solo-use.cjs`. The
fixture then exercises the installed daemon and workspace as well as the UI.
This is Electron UI/IPC/persistence evidence with synthetic native transport,
not visible desktop, physical macOS IME or provider-model evidence. Its window
stays hidden and non-focusable while CDP delivers test input. It makes two synthetic sends
and starts no native providers or model tasks. `test:focus`, `test:terminal` and
`test:drafts` retain the relevant timing and draft regressions.

## Visible macOS input acceptance

Alpha.22 additionally used one visible installed app in an isolated macOS guest.
No host home, credentials, clipboard or user configuration were shared. The VM
window stayed off the host desktop; an OS-event driver operated its real GUI and
input methods. Host test windows retain their default hidden/non-focusable policy.

Reproduce this acceptance in an isolated desktop with the exact candidate app:

1. Verify guest app version and runtime/generated-UI hashes against the installed
   candidate. Use a private profile and synthetic provider transport; keep the
   real Electron renderer, IPC, service, storage and OS input methods.
2. Select System Pinyin, then WeChat Input. Observe candidates; confirm/cancel,
   switch sessions mid-composition, and check exact origin/text/Enter bytes. In
   the GUI, distinguish IME confirmation from task submission. Click Send/Stop
   and immediately type, without refocusing the input as a test workaround.
3. Use OS mouse selection/scrolling, Command-C/Command-V and actual guest
   clipboard. Check multiline paste both without and with bracketed-paste mode.
   Scroll a long terminal history, copy an older line and switch views/sessions.
   Return from another guest app and check the first input's destination.
4. Save different drafts, quit normally and reopen the same profile. Compare
   native IDs, service PID, history, selected view and drafts, including the DOM
   and persisted state after an idle window. Assert no task replay.

The final alpha.22 cases passed with four synthetic GUI submissions and zero
real provider/model calls. Initial test-driver failures (key naming, helpers and
assuming DOM scrollTop for virtual terminal rows) are retained separately from
product failures. The Stop-focus defect was reproduced before the fix. OS event
traces include compositionend isTrusted=false; exact delivery and candidate-window
observations, not that flag, establish the bounded input result. These are real
OS IME paths driven by CGEvents, not physical-person or universal IME certification.
Read the remaining limits in [alpha.22](alpha.md#alpha22-single-conversation-os-acceptance).
Raw guest screens, event traces and user-state comparisons remain private.

## Continuous reading and resource samples

`npm run test:reading` uses a hidden real Electron/DSH application and production
IPC/service with 240 synthetic completed history messages and subsequent output.
Pointer selection, historical action focus, latest Copy payload, bottom-follow,
reading older content, GUI/TUI and conversation switching, reopening, and late
layout isolation are checked. A held main-process disk timer verifies that normal
quit flushes already-received reading metadata. Invalid geometry is rejected
without changing the saved view. Only session/message IDs and bounded geometry
are saved; selected text is never part of reading metadata.

Copy payloads are intercepted inside the test main process: the person's system
clipboard is untouched, and this does not certify OS clipboard shortcuts. The
runner samples Electron working-set memory and cumulative CPU plus synthetic
service RSS/CPU; samples after UI reopen belong to new processes and must not be
used as a leak or steady-state comparison. The full-snapshot service is unchanged.
For installed verification use `NAW_APP_EXECUTABLE` and `NAW_TEST_APP_ROOT` as above.
This test starts zero native providers, makes zero model requests, and does not
certify physical input methods, foreground focus or visible desktop interaction.

## Immediate input and composition

`npm run test:input` clicks a session/view and types immediately, without waiting
for a terminal-focus assertion after the click. First attachments still have an
explicit loading gate. The hidden Chromium renderer check uses actual composition events,
checks exact bytes and origin IDs, and covers Enter confirmation, cancellation,
blur/refocus, GUI drafts, slow input/control acknowledgements, cancelled queues,
newer owners, error-copy paste isolation and opt-in macOS app activation. It permits
confirmed text only after an observed compositionend and rejects confirmation CR;
a separate later Enter must pass exactly once. Synthetic transport starts no
provider processes or model tasks. This is not physical System Pinyin/WeChat IME
certification or visible desktop acceptance. Deterministic CDP checks use a hidden,
non-focusable Electron window from its first construction. The existing test-parent
lease and canonical, privately owned profile select test-only accessory activation
policy before app readiness; invalid test flags fail before locking or windows. Normal
user launches retain their usual window behavior. macOS foreground-return is
skipped by default, not counted as passing. Set `NAW_TEST_FOREGROUND_RETURN=1`
only for an explicitly wanted short activation check; it checks exact input,
hides the test window immediately and suppresses raw foreground diagnostics on
failure. This isolation does not prove physical OS input or prevent every
possible desktop interaction. Both installed-build variables above are supported.

Pending control input is bounded to 65,536 UTF-16 code units and only exists for
an already-ready terminal owned by this view. New terminals and another owner's
session remain gated until authorized. Rejected/cancelled input is never retried;
the copyable error notice is temporary, and explicitly instructs the person to
copy it before closing the app. It is not a persistent native terminal draft.

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
The composer sends with Enter and inserts a newline with Shift+Enter. While the
mention picker is open, Enter selects its highlighted recipient instead.
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

## Draft ownership and recovery

`npm run test:draft-ownership` deliberately opens two hidden windows, using real
Electron/IPC/workspace persistence and synthetic transport. It checks explicit
takeover, current draft visibility, reload without stale writes, rejection of a
former owner's save, copyable recovery, and legacy window records after a full UI
restart. Unresolved copies must survive ordinary editing; explicit deletion must
survive another window's state broadcast while a successful save acknowledgement
is still held. No provider or model task is created; dispatches must remain zero.
Set `NAW_APP_EXECUTABLE` and `NAW_TEST_APP_ROOT` together for packaged validation.
Screenshots remain private via `NAW_EVIDENCE_DIR`. This is not physical IME proof.

## Complete daily-use regression

`npm run test:daily` uses one hidden desktop window and an isolated profile.
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

## Collaboration, context and archive regression

`npm run test:collaboration` runs a hidden Electron/DSH window with the production
workspace, IPC and Codex history adapter, using synthetic provider transport.
It exercises real pointer drag into/out of the room, invalid/cancelled/repeated
drops, duplicate-name mention selection by stable ID, exact outgoing text,
timeline search/filter and context visibility after long Markdown mounts, explicit shared background, local notes and conflicts,
late replies after departure, rename persistence and archive/restore after reopen.
Two windows are intentional only for the concurrent edit/ownership cases, and
the observer is closed afterward. It makes no native provider or model request.

Archive checks include an active native-status fixture, blocked new input,
unchanged IDs/drafts/history, room roster restoration excluding separately
archived members, and no replay. Unit checks additionally simulate partial
archive/restore failure and cold retry, failed disk writes, stale clear requests,
and pending input invalidated while awaiting authorization. These are not proof
of native process recovery after reboot or active fleet lifecycle.

Use both `NAW_APP_EXECUTABLE` and `NAW_TEST_APP_ROOT` as above to test the installed
artifact, not a packaged UI against source-only service code. Evidence stays
outside Git. Run sequentially; this is application pointer-input verification,
not physical trackpad, IME, VoiceOver or external-application drag certification.

`codex-history.test.cjs` separately covers paging, live/history arrival in both
orders, same text with distinct identity, own GUI echoes, overlapping deltas,
working/approval races, closed/stopped reads, malformed data and failed/cyclic
pagination. History imports neither dispatch work nor impersonate human input;
a real human notification must still take precedence even if already displayed.

## Alpha.23 core acceptance

Use `test:room`, `test:collaboration` and `test:solo` with the installed executable
and `NAW_TEST_APP_ROOT` to test the actual bundle's UI and service. Parent/child
model trials are separate and capped; alpha.23 used five parent submissions plus
one observed Codex child. Replaying native event shapes tests protocol mapping
without rerunning a paid fleet.

The visible guest core journey used actual OS pointer/keyboard events with
synthetic provider replies: drag in/out, typed `@`, one send, explicit three-reply
authorization, notes, rename, archive/restore and normal reopen. Four synthetic
submissions were checked against recipient/payload counts. Initial driver-only
errors (input-source identifier, ambiguous menu selector, wrong assertion field)
are retained in private logs and do not count as product passes or retries of
paid tasks. Final state assertions and visible screenshots establish the result.

Installer checks use a fresh app profile and a guest without the host's auth.
Keep downloaded quarantine attributes, compare SHA-256, use only app-specific
Gatekeeper approval, and verify prerequisites after installation with Recheck.
Do not use curl-only copying as browser-quarantine proof. The guest test found
the system Python shim masking a later real installation; the selection-stage
regression and final guest native startup cover that fix. Native login screens
are not evidence of completing a new account's authorization.
