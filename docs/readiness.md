# Readiness and next gates

As of 2026-11-02. This is a local Apple Silicon macOS technical trial.
The single-agent dogfood milestone remains open; a passing candidate is not
permission to update the person's running app or a claim of full-day use.

Current daily GUI: alpha.162, committed build source `23f76b3b`. It closes the
wake route the alpha.161 review found: a prompt that the person's own settings
hook blocks no longer becomes the prompt a later turn can stage a wake under.
Only a prompt the hook lets through counts, and only for the first turn that
starts after it; any later turn under it is treated as ambiguous and refused. By
reading the code, a prompt typed while a turn is running and let through is
still linked to the next turn, so a `!` command after that turn ends could stage
a wake under it, as in alpha.161; this has not been checked on real 2.1.316.
Like alpha.161, it reaches a session only after a backend running alpha.162
restarts it. In the author lane, on real Claude Code 2.1.316 with local fixed
replies, a blocked prompt followed by a `!` command staged a wake before the fix
and was refused after it, while a typed turn's wake still arrived; probes there
found that /cost, /context and `!` raise no prompt-submit hook. Unverified:
inputs that are let through but start no turn, such as /compact or Esc before
the turn starts; a real Claude Code 2.1.312 session, which the main session
uses, covered only by a unit fixture. Five more GUI scripts were brought up to
date; in the author lane room waiting still stops at one assertion that shows a
real issue, the space filter hiding the current-position frame. Both changes
were reviewed in their author lane and are integrated with identical changed
lines. The full unit suite passes 2,156 checks, and the membership navigation,
terminal selection, native blocks, compact header and session wake GUI scripts
exit 0; native blocks runs real Claude Code 2.1.316 against three local fixed
replies with no paid calls. The signed bundle passed one isolated launch. The
ordinary visible update kept fourteen session records with their native IDs,
live processes and drafts; the empty active backend was replaced in place, and
the seven other backends kept PID, start time and version, also 150 seconds
later, long enough for two automatic-move checks, with no move started. Before
it, at 16:20, the secretary's backend was moved to alpha.161 after the secretary
asked the person to move it. An author-run check afterwards found the shared
folder's compatibility hook rewritten at 16:20 with alpha.161's output and one
wake record in the secretary's session with status cancelled; the secretary
reports that this was its wake to the main session, no longer refused, and that
it was cancelled with the generic reason that the native observation or control
boundary had changed. Its cause is not yet known, the secretary's wake to the
main session has not been delivered, and T-100 stays open. The secretary runs
alpha.161's wake check and the main session alpha.159's; as of the install no
session runs alpha.162's bridge.

The prior alpha.161 task, source `9c78f558`, remains qualified. It removes the
refusal that blocked agent wakes from the secretary. At that delivery the
secretary's running process, started at 15:28 on an alpha.160 backend, kept the
stale copy loaded, so its wakes stayed refused until its session restarted on an
alpha.161 backend. Its working folder still held a compatibility plugin that NAW
had written there for retained sessions, Claude Code loads it too, and its hook
refused every wake. That copy now leaves the wake tool to the plugin NAW
launches Claude with. Whenever an alpha.161 backend starts or resumes Claude in
a folder, or an alpha.161 window connects input to a retained Claude there,
NAW's own byte-exact old copy in that folder is refreshed; a launch never
creates one; connecting a retained Claude still installs it as before, and
edited or unsafe copies are left alone. After that, any later process in the
folder loads the new copy, whichever backend starts it. Only the turn linked to
the last submitted prompt can stage a wake, so a `!` command after a typed
prompt that already started its turn no longer can; one route stays open by
reading the code: if the person's own settings hook blocks a prompt, the next
turn without a prompt of its own, such as a `!` command, can still stage one.
Sessions started on alpha.159 or alpha.160 backends keep the wider `!` hole
until a backend running alpha.161 restarts them. For the secretary that meant
moving its backend again, after it ended its own background wait and scheduled
wakeups; that happened at 16:20. At that delivery a real installed wake from the
secretary, on Claude Code 2.1.316, to the main session, on 2.1.312 and another
backend, had not run, nor has a wake from a task-notification or
scheduled-wakeup turn, and wakes do not yet appear on the space timeline. The
change was reviewed in its author lane, which ran real Claude Code 2.1.316
against local fixed replies before and after the fix, and is integrated with
identical changed lines. The full unit suite passes 2,154 checks; the session
wake GUI script exits 0 but runs no real provider, so it covers neither the
refresh nor the new check. The signed bundle passed one isolated launch. The
ordinary visible update kept fourteen session records with their native IDs,
live processes and drafts; the empty active backend was replaced in place, and
the seven other backends kept PID, start time and version, also 150 seconds
later, long enough for two automatic-move checks, with no move started. The
update itself started or resumed no Claude, so it refreshed no copy; an
author-run check at 16:14 found no session on the alpha.161 backend and the
shared folder's compatibility hook still the one written on 10-26.

The prior alpha.160 task, source `0f3a541a`, remains qualified. It carries six
reviewed changes. For Claude Code 2.1.316 sessions, the conversation view shows
Claude's explanations between steps, which 2.1.316 records as thinking blocks
and the terminal draws as text, where the terminal shows them; it shows a `!`
command typed in the terminal, with its output, as the person's command; the
turn divider sits above the terminal input that started the turn; and each turn
ends with the duration Claude reports and the time it ended. A notice with a
button still stays until dismissed, but a press anywhere outside its buttons now
clears it, without reaching the control underneath. A paste from the text-field
menu that arrives after the person switched away and back is dropped. When a
backend is older, the session's own ⋯ menu offers 结束并更新这个后台… first, and the
old-sessions menu names up to three sessions for each backend. Four stale GUI
scripts run to the end again.

The explanation, `!` command, turn head and clock changes run in the bridge
plugin and the backend, so they reach only 2.1.316 sessions started on an
alpha.160 backend. After this update that is only the empty active backend,
which was replaced in place; at that delivery the secretary's and the main
session's backends ran alpha.159 and recorded terminal input, and the main
session's backend also holds a Codex session, so neither moves automatically and
each needs the click again; the click is refused while a Claude session there
has a background task or scheduled wakeup, including an agent's own background
wait, so that agent must end its wait first. The menus, notices and paste guard
are window code and apply to every session, and Codex rows that read You ran are
labelled 你 in session views; on alpha.160 backends shared replies also leave out
every provider's own-command rows, Codex included. Unverified: none of the
2.1.316 changes has run on a real `!` command or a real multi-step turn; their
checks used the real plugin with synthetic engine events and no model. The cost
of the new drawing hook to terminal responsiveness is unmeasured. Explanations
are not shown in spaces or for turns the terminal does not draw, and earlier
turns are not filled in; messages inserted while Claude works are still not
shown on 2.1.316. Each change was reviewed in its author lane and is integrated
with identical changed lines. The full unit suite passes 2,144 checks, and
eleven GUI scripts exit 0, the column input script in all four of its cases. The
signed bundle passed one isolated launch. The ordinary visible update kept
fourteen session records with their native IDs, live processes and drafts; the
seven other backends kept PID, start time and version, also 150 seconds later,
long enough for two automatic-move checks, with no move started. None of this
batch's behaviours has yet been used or checked in the daily app.

The prior alpha.159 task, source `cc2c4f5c`, remains qualified. It carries six
reviewed changes. Sidebar rows take two lines, with the name and version mark
first and space badges, a short status and the activity time below; each space
group, independent sessions included, folds on its own and keeps that choice
after a reload; and the session menu lists the session's facts before its
actions, updates them in place while it stays open and opens beside its button.
A person's action now voids only the staged agent wakes whose sender or receiver
it touches; the explicit pause of all follow-up handoffs, turning wakes off and
a backend upgrade still withdraw every wake, and moving the pointer over a
fullscreen terminal no longer counts as a person operating it. Terminal text can
be selected again: native snapshots keep the mouse encoding, so a drag in a
rebuilt view reaches Claude, which selects and copies; views that cannot send
input, and views of older backends, select locally and copy with Cmd+C;
Option-click no longer types arrow keys. In the old-sessions menu, an old
backend whose sessions are all idle offers 结束并更新…: after one confirmation NAW
ends those sessions, restarts that backend on the current code over the same
records and reconnects them with their native IDs, owners, drafts and spaces,
sending nothing to them. An automatic variant, on by default with a switch in
the same menu, runs only where every idle session is a Claude session whose
runtime proves no terminal input of any kind since its process started (a key,
click, drag to select text or wheel all count), no background or scheduled work
in the last report and no child agent or teammate seen; a backend with an idle
Codex session always needs the click, which also ends its Codex program. A turn
made only of notifications for tasks the session reported running is shown as
后台任务通知 with its summary and no longer pauses collaboration or counts as the
person, so it no longer resets an agent's limit of three consecutive wakes; one
that displaced a desktop send still pauses collaboration. The collaboration
overview GUI script runs to the end again.

The sidebar, menus, local selection, Option-click and the move menu are window
code and apply to every session. The wake narrowing, the pointer rule, the
snapshot mouse encoding, the notification rule and the input record that
automatic moves rely on run in the backend, so they reach only sessions on an
alpha.159 backend. A wake also survives unrelated input only once every backend
in the profile runs alpha.159: until then, any input or native prompt in a
session on an older backend still cancels every staged wake. At delivery every
daily backend that held sessions ran older code, which cannot prove the move
conditions, so no move was automatic and each needed the click; on the main
session's backend that click also ends and reconnects Codex · NAW 开发, and that
backend will keep needing the click on later updates while it holds an idle
Codex session. From the next update on, other alpha.159 backends can move
automatically only if nobody has used their sessions' terminals since those
processes started. Unverified: on main only the cancel path of the move has a
GUI check; the author moved one fixture backend for each of four older daily
runtimes and the current code, with no model, and ran one clicked and one
automatic fixture move in a hidden-window check; Agent Teams teardown and
whether a reconnected Codex thread resumes its goal are untested. The
notification rule was checked on Claude Code 2.1.316 only, against the format of
fifteen real notifications and in one hidden-window check that predates its last
change, not on a real hook run; scheduled and loop wakeups on 2.1.316, and
notifications for tasks no earlier report listed, still count as the person, and
a notification turn in a session that is in a running relay still pauses that
relay. Selection was tested on Claude Code 2.1.316 only; Codex, the space member
column, and right-click and wheel in old-backend views are untested. Each change
was reviewed in its author lane and is integrated with identical changed lines;
the one textual conflict was resolved by keeping both sides. The full unit suite
passes 2,121 checks. Ten GUI scripts exit 0 on the batch before two sidebar
follow-up fixes; after them, sidebar density, compact versions, version info,
member header menu, multispace and collaboration overview exit 0, and the
session menu and sidebar scripts stop at assertions that predate this batch. The
signed bundle passed one isolated launch. The ordinary visible update kept
fourteen session records, archived ones included, with their native IDs, live
processes and drafts; the empty active backend was replaced in place, and the
seven other backends kept PID, start time and version, also 150 seconds later,
long enough for two automatic-move checks, with no move started. Apart from no
automatic move during that wait, none of this batch's behaviours had been used
or checked in the daily app at delivery; since then the person moved the
secretary's and the main session's backends to alpha.159 with the click.

The prior alpha.158 task, source `403f6b6e`, remains qualified. It lets an
enlarged member card return to the whole space, which completes the maximize
work, and binds Claude Code 2.1.316 in the native bridge. With that binding, a
2.1.316 session's own conversation view shows intermediate text and tool output
again, and an agent wake between two 2.1.316 sessions completed in the author's
local fixed-reply run. The bridge change reaches only Claude sessions started by
an alpha.158 backend. When such a session answers a message from a space it
belongs to, that turn's intermediate text and tool rows, including commands and
output, also go into the space, as with 2.1.307 to 2.1.312; today's 2.1.316
sessions share only final replies, and turns started in the session's own
terminal stay private. Stopping one of their turns from NAW returned it to idle
in 256 ms in the author's run. From the source, Esc in its terminal has the same
effect, and NAW sends and wakes to it are then refused until a prompt submitted
in its native terminal starts a new turn. Any native input still cancels every
pending wake; that second checkpoint is open. Fork, permission, plan, image,
Agent Teams, model and usage, and question modes other than the conversation
view are untested on 2.1.316. Both changes were reviewed in their author lane
and are integrated with identical changed lines. The full unit suite and three
related GUI scripts pass. Correction to alpha.157: Claude Code 2.1.316 does not
pass the prompt source to the hook, so the injected-turn label has no effect on
real input, and injected turns still show as the person. The signed bundle
passed one isolated launch. The ordinary visible update kept fourteen session
records, archived ones included, with their native IDs, live processes and
drafts; the empty active backend was replaced in place, so new Claude sessions
started there load the 2.1.316 binding when Claude Code is 2.1.316, which is not
yet observed in the daily app; and the seven other backends kept PID, start time
and version.

The prior alpha.157 task, source `901004fb`, remains qualified. It shows
reported background work instead of a ready dot after a Claude turn ends; that
was GUI-checked by its author. A label for machine-injected native turns,
checked only with simulated hook input, has no effect on real Claude Code
2.1.316 input, so those turns still show as the person. It also carries four
Codex 2 fixes with source and earlier lane component evidence only, and unit
tests only for the reopen fix: reopening closed windows from stale
notifications, keeping nearby focus when a read-only member region disappears,
keeping the compact list's jump-to-latest control inside its reader, and a
visible drag grip on member names. Existing sessions stay on older backends
after the update: they show only the reported count, without task types; an
interrupted or resumed session there can keep showing its last count until its
next turn ends; and an idle session with stale child records can keep a hollow
ring. The full unit suite and seven GUI scripts pass. The signed bundle passed
one isolated launch. The ordinary visible update kept fourteen session records,
archived ones included, with their native IDs, live processes and drafts; the
empty active backend was replaced in place and the seven other backends kept
PID, start time and version.

The prior alpha.156 task, source `4a20d988`, remains qualified. A terminal
view, the session's own or a read-only one, rebuilt from a native snapshot keeps
scroll regions, origin-relative cursors, pending-wrap cursors and
background-erased pending rows; only sessions on an alpha.156 backend get it,
and the daily's empty active backend was replaced in place so new sessions do.
Terminal rows keep full-width punctuation on the grid, and both maximize buttons
show a restore graphic once maximized; the member-card enlarge link is a
separate user question (T-121). The native confirmation GUI test now matches the
same-screen interface. All four changes were reviewed in their author lanes and
are integrated with identical changed lines. The full unit suite passes. The
punctuation change passes its GUI script; for the maximize buttons the
member-header script passes and the compact-header script stops at line 124, so
its 850x600 group is unverified. The confirmation and read-only scroll scripts
serve synthetic snapshots, and browser rendering of the restored terminal states
is unverified. The signed bundle passed one isolated launch. The ordinary
visible update kept fourteen session records, archived ones included, with their
native IDs, live processes and drafts; the seven other backends kept PID, start
time and version, and no pause was sent: the upgrade branch did not run, since
the active backend kept its key, and no shared relay was running after the GUI
quit.

The prior alpha.155 task, source `d4b37047`, remains qualified. Refused joins
into a new collaboration space now explain themselves. A session whose backend
cannot record other spaces is refused before any backend call, with its backend
version, the kept session and draft, and the condition for updating that backend:
every session on it, archived ones included, must end first. The invite dialog
keeps such sessions reachable with that reason and shows any failed join inside
the dialog. The full unit suite, the existing multispace GUI, a new two-backend
synthetic GUI and one isolated launch of the signed bundle pass. The ordinary
visible update kept fourteen session records, archived ones included, with their
native IDs, live processes and drafts. The non-empty alpha.154 backend kept
running for its sessions; a new alpha.155 backend serves new sessions. Its
sessions now show an old-backend badge yet can still join spaces. Sessions on
older backends still cannot
join other spaces until their backend is updated, and whether the user's own
join attempts now succeed is unverified.

The prior alpha.154 task, source `86faf397`, remains qualified. Rich snapshot
cursor placement now matches the current source grid, and revealed collaboration
List names retain readable original lines and saved reading positions. One hundred
seventy-eight affected checks, the build, four signed cursor flows and six signed
list-name flows pass. The ordinary visible update preserves ten native IDs, eleven
positive before-live process starts, twelve view/draft scopes, reported settings
and the separately checked original active goal. Six nonempty old backends retain
their old PID/start/version. Source-grid shrink truncation is still open: matching
the current grid does not preserve text already lost there. Initial wide/alternate
screens, saved pen, origin mode, real native producers, physical input, original
lifecycle, full-day use and the shared goal remain open.

The prior alpha.153 task, source `0d59d3d`, remains qualified. Read-only
terminal views consume live resize events even when the output sequence does not
change. One hundred three affected checks, the UI build and four signed renderer
flows pass. The ordinary visible update preserves ten native IDs, eleven positive
before-live process starts, twelve view/draft scopes, reported settings and the
separately checked original active goal. Six nonempty old backends retain their
PID/start/version. Initial wide snapshot reconstruction, saved pen, owner echo
transients, old backends, real native producers, physical input, original lifecycle,
full-day use and the shared goal remain open.

The prior alpha.152 task, source `1c67a70`, remains qualified. Native OSC
hover targets follow rendered row replacement or erasure, preserving unrelated-row
and same-cell fast paths. Ninety-six related checks, the UI build and four signed
renderer flows pass. One renderer shutdown/reentry and two reloads preserve full
cells and synthetic identities, owners, positive drafts, epochs and sequences.
The ordinary visible update preserves ten original IDs, eleven live process
starts, twelve draft scopes, reported settings and the separately checked active
goal. Six nonempty backends retain PID/start/version and old code. Pre-render,
asynchronous-provider, physical pointer, native-producer, column/saved-pen,
original lifecycle, full-day use and the shared goal remain open.

The prior alpha.151 task, source `64420d2`, remains qualified. The existing
collaboration background preview now supports selected spaces. Bounded original
shared notes and membership/status facts can be edited and explicitly appended
to the existing draft. Editing freezes scope; combined-limit refusal preserves
both texts. Eighty-six related checks, the build and six signed renderer flows
pass. Copy bytes reuse source evidence; signed checks cover preview and controls.
The ordinary visible update preserves ten IDs, eleven live process starts,
twelve draft scopes, reported settings and the separately checked active goal.
Six nonempty backends retain their old PID/start/version. Native fleet, physical
input, locale, original lifecycle, full-day use and the shared goal remain open.

The prior alpha.150 task, source `6ef55cf`, remains qualified. Native OSC8
targets survive ordinary snapshots and output/row-resize checkpoints through an
isolated, pinned serializer extension. Eighty-six affected checks, the UI build
and four signed synthetic flows pass. Six hover targets retain their original
URIs across three renderer-shutdown reopens and two observer reloads. Finite
fallbacks preserve stock text but still lose addresses. The ordinary visible
update preserves ten original IDs, eleven live process starts, twelve draft
scopes, settings and the separately checked original active goal. Six nonempty
backends keep old code until a safe update; this fix is not loaded there yet.
Column-reflow cursor, saved-pen and stationary-pointer cases, actual native
producers, physical input and full T79 remain open, as does the shared goal.

The prior alpha.149 task, source `0b0e031`, remains qualified. The new passive
cross-space reader counts each nonarchived original session once while preserving
all space references, status uncertainty and observation age. Exact source/member
return retains reading context and distinct space drafts. Eighty-five affected
checks and five signed synthetic flows pass; two owned GUI starts retain 100
synthetic identities and drafts. This is not native-fleet scale or physical input
proof. One earlier pre-daemon test-script failure remains recorded. The ordinary
visible update preserves ten original IDs, eleven live process starts, twelve
draft scopes and the original active goal; six old backends retain their versions.
Coordinator preview, locale, OSC8 snapshot addresses, original lifecycle, full-day
use and the shared goal remain open.

The prior alpha.148 task, source `3006825`, remains qualified. Snapshots that
advertise `cursorModesVersion: 1` now use the adopted steady fallback; explicit
native cursor controls retain precedence, including during live link hover.
Unadvertised or unknown frames keep prior defaults. Thirty-eight affected checks
and four signed synthetic-transport groups pass without product inference. Four
renderer-shutdown reopens and two observer reloads preserve mode state, identities
and positive drafts. This is not physical blink timing or iTerm parity proof.
The ordinary visible update preserves ten native IDs, eleven live process starts,
twelve draft scopes and the original active goal. Six nonempty backends keep
old code and defaults. Snapshot OSC8 address loss remains open; reconstructed
hyperlink interaction, original-fork lifecycle and the whole milestone are open.

The prior alpha.147 task, source `19ced47`, remains qualified. The existing
three-attempt recovery now has a specific sidebar cue and a guarded desktop
notification request. All 118 affected checks and four signed groups pass with
synthetic transport and no product inference. Another selected session and its
draft survive exhaustion, repeated state and one renderer-shutdown reopen;
editing the original draft cancels recovery without another send. One native
notification request is logged, alongside an OS authorization refusal. API
scheduled/displayed callbacks do not prove visual delivery. The daily app shares
the bundle identifier; permission was not inspected, so it may also be affected.
The ordinary visible update preserves ten IDs, eleven live process starts,
twelve draft scopes and the original active goal. Six nonempty old backends
retain their versions and generic status. Native atomic goal restore, locale,
visible notification delivery/click and the whole milestone remain open.

The earlier alpha.146 task, source `5874b29`, remains qualified. Completed
native cursor controls survive snapshots and four renderer-shutdown reopens in
four signed mode-state groups. Eighteen affected checks pass without skips.
Public xterm observers feed the three existing snapshot writers; no new parser,
panel or dependency is added. The ordinary visible update preserves ten original
IDs, eleven live process starts, twelve draft scopes and the same active goal.
Six nonempty backends retain their old serializer until a safe update. This is
control-state proof, not visible bar shape, blink timing or physical-input proof.

The earlier alpha.145 recovery task, source `e348db4`, remains qualified. Its
buttons remain readable after moving into message headings. Source checks pass
(63 related and 20 archive checks, no skips); four signed installed groups pass.
Directed and paused links measure 5.80 light and 12.11 dark, above the 4.5 floor.
Private results, explicit approval, read-only archive/restore and one owned process
reopen retain two synthetic identities, histories and private/shared drafts with
the explicit recipient. No real provider or product inference runs. The accepted
ordinary visible update preserves ten original IDs, eleven live process starts,
twelve draft scopes and the same active goal. Six nonempty backends remain on
their previous versions. Physical input, real provider permissions, native-process
recovery, original-fork lifecycle and full-day development remain open.

The earlier alpha.144 build, source `91ef94d`, remains evidence for unchanged paths.
Fresh/reset
terminal text uses 13-point type and line height 1, preserving valid saved fonts.
The existing theme callback covers the viewport's fit remainder. All 74 related
source checks and four signed GUI groups pass, with 20 sampled pixels across ten
layouts. Saved 14, 20 and manual 13, native synthetic colors and actual mouse
selection remain correct. Three renderer-shutdown reopens preserve one synthetic
identity and positive draft; they do not qualify ordinary close, geometry or
native snapshots. Independent review accepts the bounded installed workflow.
The ordinary visible daily update preserves ten original IDs, eleven live
process starts and twelve draft scopes, plus the same active goal. Six nonempty
backends retain their earlier versions. Physical input, native cursor snapshots,
original-fork lifecycle and full-day development remain open.

The earlier alpha.143 build, source `dc7a578`, remains evidence for unchanged paths.
The existing
terminal display form opens inside its native pane without a modal backdrop.
Seventy related checks and four signed GUI groups pass, including grid stability,
validation, compact control layering and two owned process reopenings with
positive drafts. Native transport is synthetic and viewport sizing is emulated;
render-key guards, API refusals and simulated save failure reuse source evidence.
The ordinary visible update preserves ten native IDs, eleven live process starts
and twelve saved view draft scopes. Six nonempty backends remain unchanged.
Read-only goal witnesses preserve the original identity, objective, creation
and active status. Real native frames, physical input, original-fork window-only
recovery and the complete dogfood milestone remain open.

The earlier alpha.142 build, source `632e7d1`, remains evidence for unchanged paths. Six source and
six signed GUI groups pass for the compact member terminal, including maximize
and restore in three responsive bands, permission focus, ended frames and draft
recovery. It reuses existing card, toolbar and split styles. Signed sizing matches
the source CSS viewport; physical input and real native migration remain open.
The ordinary visible update preserves ten native IDs, eleven live process starts
and twelve saved view draft scopes. Six nonempty backends keep their earlier
versions. Read-only before/after witnesses preserve the original goal's thread,
objective reference, creation time and active status.

The earlier alpha.141 build, source `8a023aa`, remains evidence for unchanged paths.
Six signed GUI
groups cover compact per-session version notices, unique-session counts, guarded
update choices and the collapsed sidebar. Seven synthetic identities and positive
private/shared drafts remain intact. Native transports are synthetic; no product
inference runs. OS cancel and clipboard checks reuse source-fixture evidence;
window sizing is renderer emulation. Actual old-backend updates remain unqualified.
Earlier full source checks are reused for unchanged paths; 17 relevant checks
pass after metadata changes, with 18 related rail checks and four source GUI groups.
The ordinary visible update and signed evidence pass independent review.

The earlier alpha.140 build, source `3305174`, remains evidence for unchanged paths.
Eight signed GUI
journeys cover recoverable space snapshots, independent drafts, partial failures,
explicit recovery, undo and reopening. Three work-copy checks cover non-mutating
preview, committed checkout and the resulting GUI status/draft. Positive work-copy
creation uses backend setup; the real OS chooser and positive GUI create path
remain source-fixture-only. Native transports are synthetic; no product inference
runs. All 1806 source checks pass without skips, and source, signed evidence and
visible-update operation pass independent review.

The visible update preserves ten native IDs, eleven live process starts, owners,
reported native setting fields and all twelve saved view draft scopes. Private drafts are empty; one
shared draft contains text. A read-only goal check after the update shows the original thread and creation
time still active.
Only the GUI and empty active backend update; six nonempty backends stay at their
previous versions. Real OS clipboard/clear confirmation, native trust, physical input and the
full dogfood milestone remain unqualified. Automatic work copies refuse linked
selected paths; existing-directory mode remains available.

The earlier alpha.139 build, source `c9800cc`, remains the evidence for unchanged paths. Fourteen signed
installed groups cover multiple spaces, membership views, independent drafts,
scoped delivery and same-profile reopening. Three more cover the existing
tool-silence status, progress and completion. These use stand-in native runtimes;
the real Codex detector is covered by source tests. All 1711 source checks pass.
OS chooser/clear-confirmation steps reuse source-fixture evidence; real OS
notification delivery and count remain unqualified. Source checks verify that
extra-room operations refuse older backends lacking the capability. Actual extra
rooms on retained backends remain unqualified.

The ordinary visible update preserves ten native IDs, eleven live process starts,
owners and draft hashes in all twelve saved views, including the shared draft,
its recipient and additional-room scopes. Private drafts are empty; one shared
draft contains text. Only the GUI and empty active backend update. Six earlier
backends remain at their original versions and process starts. The original Main
goal remains active with the same identity, objective and creation time.

The unchanged Codex settings path reuses four signed alpha.138
installed flows verifying effective Codex model/effort on opening and same-thread
reconnection, newer settings winning over a delayed reply, and unreported effort
remaining unknown. They use the actual adapter with synthetic native responses,
zero provider/model calls, and preserve identity and draft. The retained reader's
same response projection passes Unix WebSocket checks; original native recovery
is not newly qualified. The existing reader path reuses six signed alpha.137
flows that verify local wheel reading of oversized read-only native grids,
ordinary xterm history and an empty reader following native approval state.
Reading keeps the original owner, grid and unsent draft, with zero native input. Geometry is
renderer viewport emulation; physical input and real second-window control are
not newly qualified. Compact native-only
requests and existing member-title menus reuse 44 related checks and twelve signed
alpha.135 flows with three synthetic members. Original fields remain available;
these requests still use the native terminal for decisions. The default installed
window, positive private/shared drafts, owners and ordinary reopening are checked;
source-only narrow windows and intercepted copy retain their earlier scope.

The disabled local prepared-command slice passes 351 related checks, a corrected
20-check cold-bootstrap suite, signed GUI cold boot and one signed Unix scenario.
Both new modules reach the writable runtime; original-connection commit,
deduplication and disconnect cancellation are checked with synthetic native work.
No product pairing, phone/HTTP entry or same-app GUI broker is enabled. This is
local transport evidence, not live-provider or whole-phone acceptance.

The unchanged overload/refinement path reuses 251 checks and five signed alpha.134
GUI flows with synthetic transport. Real native overload, goal reactivation and
retained-backend activation remain unqualified by this update. Local refresh
reports progress and completion separately from native usage report times.
Canceled dialogs clear transient edits, preserve saved work and reject late
responses belonging to an earlier opening. This unchanged dialog and refresh code
reuses 27 checks on alpha.133, twelve alpha.132 source journeys and eleven signed
alpha.133 installed journeys. Deep delayed-IPC, busy-import
and chooser-simulation evidence is from the source run. Original file links,
recorded clocks, known native-turn boundaries and 50-record paging remain.
Actual OS viewers, clipboard, choosers, IME and VoiceOver are unqualified.

The ordinary visible update retained all 10 native IDs, live process starts,
owners and both draft scopes. Only the empty active backend restarted on 137;
six retained backend records are unchanged: 129×1, 120×4, 118×1. The earlier
replay-clock adapter fix applies to new backends, not these retained processes.
The actual production reader matches the build-bound installation record.
The developer session's native goal is unchanged by this update. The single-agent
dogfood milestone remains open: full-day use, window-only lifecycle, external-terminal
escape, Claude's active goal, native shell-command ingestion, Claude native clocks,
native error activation, exact footer availability and historical process gaps
are not certified. See the
alpha.129–137 acceptance records in [review](review.md).

Local builds now use the existing named signing certificate and verify its
certificate-bound designated requirement; a missing identity stops the build.
The first certificate update required one Desktop consent. The next real update
kept the same requirement with a different CDHash: actual native README/Git reads
pass, and a continuous TCC capture spanning update through cleanup shows no new
prompt and an allowed Desktop read. This is one verified permission-continuity
case, not a guarantee against every filesystem stall. No Full Disk Access or
system-trust change was made.

## Current priority: a dependable single conversation

Use the installed product for real Claude/Codex development. Preserve the native
conversation, draft and objective through window reopening, app updates and
explicit recovery. The GUI reflects native facts; complex interactions stay in
the same-screen native TUI. Do not rebuild the entire TUI in a second interface.

The current candidate includes the reviewed native large-frame repair, compact
reader layout work, unchanged-size terminal fitting, shared screenshot entry and
the Claude lane's recovery posture. Functional witnesses use actual native
Codex 0.164 / Claude 2.1.310/311/312 and signed application bundles with fixed local
responses. Physical system clipboard/IME coverage is separate.

| User task | Accepted scoped evidence | Remaining boundary |
| --- | --- | --- |
| Address one task to an idle existing agent | Signed126/126fc54 actual312 Claude to165 Codex to312 Claude completes one original MCP roundtrip after normal sender completions; identities, live processes and the receiver draft remain unchanged. Global/per-agent off switches and bounded one-time transfer use existing controls | Fixed local responses prove protocol/control, not model judgement. Claude terminal-typed initiating turns, Codex164 MCP and retained older backends are not qualified |
| Read native Codex local images and keep working through member changes | Signed126 checks actual pixel decode/expand/reload and current view/drafts/identities through detach/archive/restore and explicit navigation; source checks retain private/shared authority and reject changed files | Local file identity at observation, not immutable pixels previously read by a model. Claude images, physical clipboard/IME and older backend retrofit remain separate |
| Edit and deliver a selected recipient | Signed127/b3-equivalent runtime passes atomic partial deletion, native Undo/Redo, caret reopening and8 existing delivery/queue flows; recipient/body and native identity remain exact | Source intercepted-clipboard cases are reused; physical clipboard/IME remain unqualified |
| Continue after the native routing error | Signed127 passes4 flows: exact original error, cancel without input, one same-thread continue, and reopen without replay | Actual165 two-minute local-response evidence is reused; unrelated native errors are not silently retried |
| Read accepted native Claude images | Signed127 and byte-identical128 receiver render original accepted pixels, retain partial-image slots and report missing caches honestly. Actual312 CLI Read produces the accepted bytes displayed by the installed GUI, with unchanged native ID/PID | Two fixed local responses prove the tool/plugin/display path, not model judgement. Default314 detected separately; native media remains unqualified there |
| Use compact shared readers and member order | Signed127/128-equivalent runtime passes Grid/List, keyboard/menu order, ordinary owned reopening and original IDs/private/shared drafts | Source delayed-IPC/clipboard/failure evidence reused. Physical drag qualification remains open; keyboard/menu alternatives pass |
| Continue after upgrading Codex to 0.165 | Isolated signed123/beacc47 recovers an owned mid-goal server loss on a new PID with the same thread, full objective/budget/creation time, model/provider/effort/permissions and draft; native continuation executes repository-tree file IO and completes. 143 related unit checks pass; independent integrated review passes | Exact protocol gate only; old daily backends remain unqualified until migrated. Overload auto-continue and legacy shared replies retain their older version gates. Full TUI menus and the earlier real-work file-access cause remain unverified |
| Create sessions in separate folders | Signed122/e920cef previews each new private directory, creates it only on submit, retains files/name on collision, and keeps existing identities/drafts; unchanged folder-picker/start-failure cases reuse signed121 proof | Folder trust remains native; no OS isolation or automatic Git worktree. Existing sessions keep their original directories |
| Resize sidebar sections and read native process groups | Six installed122 task flows pass pointer/keyboard resizing, folds, exact tool originals, native completion, manual expansion and GUI reopen with identity/draft/preferences retained; narrow/wide member notices remain readable | Synthetic native transport,0models/providers; OS clipboard, physical input and screen readers not newly certified |
| Limit app-owned Node debugging | Signed122 fuse readback and normal service/UI-host boot pass; a directly started MCP script survives owned signal probes. All three own Node launch sites pass the native signal-disable option | Claude's own MCP launcher remains unverified. GUI signal can terminate it; explicit separate RunAsNode debugging remains possible. Old live backends retain old executable settings; no ASAR/same-user isolation claim |
| Find older originals and return in a long conversation | Isolated signed124/de84dd6 passes9 reading flows: all2480 source records retained,50 recent originals initially rendered, stable older/search/return/reopen anchors and drafts, whole native process groups and correct latest-follow | Included in the daily GUI. Retained native hosts need separate bootstrap acceptance. Shared room timeline is unpaged; explicit older loading grows the range, full-state broadcasts still scale. Installed clipboard actions and physical input are not certified |
| Use the same terminal | Native bytes pass through unchanged; large plugin catalogs stay connected; unchanged geometry sends no resize; current-config middle insertion passes | Original cursor cause remains unassigned; real-use confirmation stays open |
| Paste/drop screenshots | Three entry paths reach each original native TUI with unchanged pixels, no auto-send, preserved text draft and original identity | Renderer events/stubbed clipboard are tested; physical OS clipboard and other media formats are not claimed |
| Recover Claude work | Mid-goal native loss retains ID/draft/goal/bypass/effort on a new PID; no task replay; explicit continuation completes the goal | Last-hook timing, native durable-tail/warning and best-effort external-holder limits remain in the [Claude audit](u17-claude310.md) |
| Work with the window closed | Native goal continuation/completion and reopened identity/draft/output pass for both providers; Codex active-goal process-loss rehearsal also passes | These bounded fixtures do not count as a real development workday |
| Inspect questions, Plan and model state | Native originals remain visible; actual questions/multiple selection, Plan approval and model changes pass | [U17](interaction.md) distinguishes GUI facts from native-only interaction; commands/keymaps are an audit, not a per-key execution suite |
| Branch an existing Claude conversation and type multiline input | Signed candidate105 uses the native picker, preserves the parent transcript and child history/ID, and cancels without creating a transcript; native Shift+Enter keeps two unsent lines | Direct takeover is separate; inherited history remains in the same-screen TUI |
| Continue stopped external Claude history | Signed11043bcace actual312: active writer refused, sameUUID/history resumed only after the owned fixture exits, explicit GUI follow-up/reload/draft and missing-history failure pass;2 fixed main responses,0 paid | Choose the original directory and exit other connections first. Preflight is not an atomic native lock; inherited history stays in TUI, and live running-session attachment remains unimplemented. Included in the installed app |
| Queue a message during work | Prior signed105 GUI waiting paths are reused; signed125/14af236 actual312 also displays one accepted terminal mid-tool input under its original UUID, with native-session attribution and unchanged identity/PID | GUI submissions still wait for native idle. Terminal mid-tool records include native reminder framing; bare typed presentation stays in the TUI. Fresh312 bootstrap is qualified, retained backends and other queued paths remain separate |
| Continue after a live native overload | Signed105 ccea1a6 actual310/311: original529 survives, a new continuation runs once after2minutes with the window closed, same nativeID/PID/result after reopen; each12 local responses,0paid. Codex164 ordinary recovery evidence is reused; structured non-overload and control/input guard regressions pass | The installed app includes the reviewed310/311 path; retained older sessions keep their original backend. Codex stopped goals require native /goal resume, and Claude goal reactivation is not claimed. This does not prove an unattended full workday |
| Continue independent work alongside collaboration | Signed107 f736444: A capacity continuation leaves the unrelated B/C run authorized; B to C to B handoffs, identity and drafts survive; human input still pauses and late output stays private. Main1129 checks and the actual candidate GUI pass, zero models | Synthetic transport/identities, accelerated timer and empty native goal; unchanged native delay evidence is reused. New sessions include this path; retained older sessions keep their existing code |
| Read native command exploration | Signed108 b576bee groups original read/search/list actions in the existing process disclosure; full commands/results, interruption, shared context, nested search and reload/draft survive; 2,480-row reading regression also passes | Synthetic transport, zero model/provider processes; older backends that omitted metadata retain ordinary original rows. Claude312 compatibility is covered separately below |
| Use a newly updated native Claude runtime | Signed109 e1b10b1 on actual312 passes model changes/reload, native blocks/tool/shared-final reading, usage, API-confirmed abort with input restored and native clear preserving process/history/draft;193 affected checks pass | Three fixed local responses, zero paid inference; queue capability is checked, prior queue-delivery evidence reused. Unknown313 and unverified retained312 stay unqualified; image/question/permission/Plan cases are not newly certified on312. Included in the installed app; retained sessions keep their original backend/code |
| Reopen an ended conversation | Signed105 c7b4ada: saved history/draft and a received terminal frame survive; reload without a held frame reports that state truthfully; six compact-reading paths pass with synthetic transport and zero model calls | At 850×600 a long confirmation can consume the reading area; the decision/input remain reachable and a 1000×600 window restores four lines. Native-only audit rows retain their evidence limits |
| Add a development session while archived work remains | Signed106 bda7ee0 removes the fixed demo-six cap in creation/history paths. Seven synthetic live records pass archive, seventh creation, reopen and draft restore; original identities and work remain | This is bounded GUI/transport evidence, not seven real native processes or a scalability guarantee. New sessions use the installed backend; older live sessions retain their existing processes and code |
| Scroll the same-screen native program from conversation view | Signed113/06a22fa passes six VT groups and real Claude312/Codex164 old-content and return-to-latest viewport checks with native identity/draft retained | Two local task replies plus one native title,0paid inference. Physical/iTerm speed parity untested; native-program wheel follows existing human-intervention rules. Included in the installed app |
| Read and select the native terminal after resizing | Signed116 source4dfbbc9 passes24 geometry cases, six wheel groups and actual Codex164/Claude312 six-case geometry plus original-line Option-drag/native-toolbar copy; all native IDs/PIDs/owners/drafts retained | Two fixed local replies plus one Codex title,0paid inference. Physical devices/native-menu Cmd+C/iTerm speed and oversized read-only bottom-row reach remain unverified. Included in the installed app; overall T59 remains open |
| Find a local session or record | Signed112 bc65c0f passes7 complete search-flow groups: compact picker, keyboard/IME guard, scopes, archive preview/copy, shared filters, reading return and app reopen retaining draft/identity | Zero models/providers/native input; existing local index/reader reused. Physical IME and screen reader remain unverified. Included in the installed app |
| Organize sessions in the sidebar | Signed111 source0bb78aa passes drag/keyboard sorting, collapsible sections, collision-expanded IDs, full-ID copy, membership boundaries, two-window synchronization, save failure/retry and app reopen with the original draft/identity | Synthetic transport, zero models/providers/sends/inputs; narrow rail remains source-reviewed. Included in the installed app; native runtime/routing is unchanged |
| Read and copy original command blocks | Signed114 e69cc05 passes four complete code-reader flows: exact native copy payload/ACK, failure/retry, compact long-token horizontal scrolling, private/shared records and reload with identity/drafts retained | Zero model/provider/native dispatch; owned writer interception leaves all OS clipboard formats intact. Existing copy backend proof reused; physical clipboard and screen readers remain unverified |
| Read three existing collaboration members | Signed117 source2de09db passes11 installed GUI groups: separate original readers, fixed member facts, literal source excerpts, passive focus/return, search, explicit native operation/recovery, detach/rejoin and original drafts/recipient | Synthetic native events,0 product models/providers. Deliberate takeover/send/approval are exercised; passive stages retain zero input/control deltas. No busy-native, physical, screen-reader or10/100-member claim. Included in the installed app |
| Use common content menus | Signed117 passes6 installed menu groups: original private/shared text and links, Cut/Copy/Paste/SelectAll with Undo/error/stale-draft guards, modal pointer/keyboard menus, native mouse/ownership handling | OS clipboard readers/writer intercepted; physical/OS readback untested. Native plain right-click stays native; Option-right-click and ContextMenu/ShiftF10 open app menus. Numeric spin fields and native OSC8 link menus were not added |
| Read a compact session header | Signed118 source26cf8e5 passes8 complete GUI flows: same identity, raw model/effort/status, view/pane controls, menu actions, critical permission/question/recovery facts and drafts | Synthetic native facts and injected disconnect/save warnings; physical input/screen-reader/real transport faults unverified. Included in the installed app |
| Inspect failed tools without an expanded log flood | Signed118 passes7 flows: original failure/command previews, full input/output/exact copy, manual fold choices across updates/reload and shared search | Synthetic transport; no original text removed or rewritten. Command-preview regression reproduced and repaired; OS clipboard/physical inputs unverified |
| Rename in the sidebar row | Signed120/aada4fd passes7 inline-name and6 related-menu workflows; native identity/title and drafts retained, reusing reviewed119 source | Included in the daily GUI; physical input, real disk faults and atomic name CAS unverified. Broader dialog work remains separate |
| Manage existing members beside their status | Signed120/aada4fd passes7 flows: direct invitation, exact-member actions, original-session detach, full-ID copy, stale target rejection and focus return | Synthetic transport, zero product model calls. Membership does not change native identity; broader collaboration work remains open |
| Start a managed Codex terminal without its updater chooser | Signed120 real0.164 reaches the native editor with a fresh update cache unchanged and zero task/title responses; new/resume argv checks pass | Per-process `check_for_update_on_startup=false`; external terminals keep their settings. First-time folder trust remains unqualified |
| Keep a build attributable | Installed120 stamp matches clean committed aada4fd;57 runtime files match and post-native strict signature passes | Visible GUI update preserves9 original session records/live process identities and12 view drafts. Later backend migration is partial, as recorded above |

Still required for this milestone:

- Both authors complete a real development workday in NAW. Waiting and marker
  replies do not count.
- Validate window reopening, update during work and controlled native-process
  recovery on the actual author sessions, after owned-fixture rehearsal and a
  durable checkpoint. Never replay a possibly completed task automatically.
- Actual-author external escape and window-only close remain open. The accepted
  old-to-new transition retains native IDs/drafts and Codex’s active goal; Claude’s
  approved posture was seeded once after stopping its old backend. A native human
  question currently hides its goal footer; do not infer the live flag.

User visual approval, physical IME and outside running-session attachment do not
block this narrowed milestone. Unverified cases remain unverified.

## Earlier accepted increments

Historical collaboration/material-to-result, archive/search, cold recovery,
retained-backend compatibility and finite unattended-handoff scopes are recorded
in [testing](testing.md), [alpha](alpha.md), [core milestone](core-milestone.md)
and the [issue/review ledger](review.md). They are not whole-product certificates.
The current change/evidence record belongs in the ledger; README and this page
are milestone summaries rather than duplicate release diaries.

Multi-level rooms remain [future design research](scoped-collaboration.md), with
no new implementation authorized by the current single-agent goal. Additional
providers/platforms and consumer distribution remain later work.

## How the shared context works

Joining changes membership, not the native session or process. The UI records
membership changes locally. Agents learn shared notes/roster only when the person
explicitly previews and sends that context; there is no hidden notification turn.
Leaving stops future routing but does not erase material already received.
Archive hides/retains records, does not end native work, and never replays tasks.

UI reopen keeps live backends. A released version update gives new sessions a new
backend while existing sessions keep the original process and capabilities.
Cold service recovery preserves records and requests explicit native-history
continuation; it does not recreate a running team. Developer rebuilds with the
same version do not hot-patch an already-running service.

## Follow-up only when the trigger is met

| Trigger | Next scoped work | Required evidence |
| --- | --- | --- |
| Trial users have the installer | Another Mac/account onboarding, usability and failures | Exact public artifact, native sign-in, first task and recovery without maintainer credentials |
| Native providers expose stable lifecycle contracts | Full active-fleet attachment/termination/recovery | Native events and actual child state; parent completion is insufficient |
| A real external-session migration case is available | External-session discovery and supported attach/resume | No concurrent resume of a running native session; distinguish attach/history/reference import |
| Daily-use feedback identifies terminal limitations | Preferred-terminal connector and selected visual preferences | Same managed session with one input owner; no secret/config import or replacement agent |
| Consumer distribution is requested | Developer ID/notarization, release artifact review and wider accessibility/device matrix | Reviewed exact binary, Gatekeeper path and broader installed acceptance |
| Two-provider lifecycle is stable and users need it | Additional agents/rooms and Windows/Linux | Provider-specific capabilities and platform lifecycle tests |

## Preferred terminal: retained analysis

Requested 2026-10-17; not implemented. Embedded xterm.js does not inherit arbitrary
Terminal/iTerm2 profiles, triggers, SSH entries or keyboard actions. Native-agent
preservation is distinct from terminal-emulator parity.

A later connector should open the existing managed session in an installed
terminal, retaining one input owner and detaching only the view when it closes.
This still needs raw mode/resize, safe quoting, device-query ownership, disconnect
and relaunch checks. Visual font/color import is a separate smaller option.
Embedding iTerm2 itself has no established supported view contract here and needs
its own GPL/licensing review; do not copy/link it into this Apache project.

References: [iTerm2 scripting](https://iterm2.com/documentation-scripting.html),
[window/profile API](https://iterm2.com/python-api/window.html),
[Apple Terminal scripting](https://support.apple.com/en-lamr/guide/terminal/trml1003/mac).
