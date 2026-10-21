# Readiness and next gates

As of 2026-10-20. Version 0.1.0-alpha.44 is a **local macOS technical-trial alpha**.
The accepted core increment is defined in [core-milestone.md](core-milestone.md).
It preserves DeepSeek Harness UI composition and the persistent native service.
The earlier solo-only pause is superseded by this accepted collaboration work.

**Current increment:** alpha.44 adds graphical text-material preview, explicit
draft insertion and result copies, plus selected/ordered subsets of 2–6 native
sessions on one capable backend. The installed three-session native task produced
a correct result and retained identity/context/drafts through detach, archive and
UI reopen. Native permission intervention still keeps the subsequent reply
private; automatic room return is not claimed for that path. See the
[observed workflow and limits](acceptance/desktop-workflow.md). This scoped M1
passed final independent source, installed-artifact and evidence review.

## Execution queue after alpha.44

As of 2026-10-20. This orders the remaining product work; it does not mark it
implemented. M1 passed its scoped graphical material-to-result acceptance path;
M2 is the next execution item. The maintainer implements,
tests the actual affected interface and obtains independent review; later rows
remain queued. Existing accepted checks are reused unless a change invalidates
their evidence. Planning itself authorizes no new provider test call.

| Order | Milestone | User outcome and exit condition |
| --- | --- | --- |
| M1 — accepted within scope | Reliable collaboration among independent sessions | Local checks cover both three-session provider arrangements; the installed native task covers material → selected participants → result preview/copy → detach → archive/reopen. Each session retains identity and context. Native Teams is optional; full active-fleet restoration and permission-to-room automatic return are not claimed. |
| M2 — next | Existing-session continuity for daily work | Long conversations, normal restart and supported update/reconnect keep history, drafts, reading position and native identity. Old backends retain honest capability limits and a safe continuation path. U05/U17 are checked against specific supported versions rather than declared universally closed. |
| M3 — queued | Complete everyday graphical workflow | A person can input, understand progress, handle supported confirmations, inspect results and continue in GUI/TUI without redundant controls or lost context. Improve demonstrated friction in existing navigation, search and timeline; use one real non-coding task as acceptance. This is our graphical client over native sessions, not synchronization with official Desktop apps. |
| M4 — queued, depends on M1 | Bounded unattended work | Extend the existing finite reply exchange only when lifecycle evidence can support the intended controls. A declared small goal stops at completion, human intervention, permission, error or its enforceable limits; uncertain native work is never called stopped. No unlimited agent conversation or unsupported hard monetary cap. |
| M5 — conditional | Bring outside sessions into this workspace | After the everyday flow is usable, verify each provider's supported history-resume or live-attachment contract. Distinguish those modes, retain identity and prohibit a competing live resume. Missing upstream attachment support is a named blocker, not permission to copy context into an unrelated session. |

M1 proceeds as one acceptance batch: provide a local text material, choose
participants, inspect a result, detach and continue, then reopen with records intact. Provider kind, independent session and
that session's native teammate/subagent are different identities. A room may
contain several sessions from the same provider, without any native team enabled.

Current source already creates distinct same-provider sessions and addresses
mentions by session ID. Alpha.43 limited automatic handoffs to exactly two sessions.
Alpha.44 adds explicitly selected, ordered subsets of 2–6 sessions on the
same capable backend, with a total cap of six replies; it does not migrate old
backends or authorize cross-backend automatic routing. Runtime acceptance is
recorded separately in [desktop workflow](acceptance/desktop-workflow.md). The demo's active-session
limit is checked both in the aggregate client and per service; it is not a
one-per-provider rule.

1. **Graphical material-to-result and independent multi-session workflow.**
   Use the minimal file preview to inspect local UTF-8 text, explicitly append it
   to a draft and save a result copy. No folder crawl, silent upload, binary
   conversion, document editor or hidden model call. These are part of M1; M3
   retains broader format support and polish after demonstrated demand. Use three independent sessions to
   test same-provider names, exact `@` targets, per-session native progress and
   histories, drag-in/out, archive/reopen and draft retention. Cover both
   two-Claude/one-Codex and one-Claude/two-Codex arrangements with local checks
   first; necessary live evidence has its own finite budget. No native Teams
   prerequisite and no mandatory lead or fixed roles.
2. **Explicit bounded handoffs.** Address the two-session restriction together
   with participant/recipient/order previews, a total reply limit, membership
   changes, failure and human
   takeover guards. Support a selected subset and a bounded three-or-more-session
   path; joining must not automatically broadcast history, activate everyone or
   start an all-member reply loop. Do not equate removing a length check with
   implementing safe multi-party collaboration. For A43-3, recheck the existing
   view-session/select-share route and fix demonstrated result-navigation gaps;
   invalidated automatic sharing authorization stays invalidated.
3. **Lifecycle and optional native capabilities.** Distinguish window closure,
   transport loss and backend exit; retain records without task replay or forced
   migration. If a participant uses Claude Teams or Codex subagents, preserve its
   native behavior and keep parent readiness separate from child activity.
   Actual active Teams tasks/messages/window continuity remain a separate missing
   compatibility proof, not a reason every room must create a team. Unsupported
   cold team restoration remains blocked/disclosed and never becomes a pass.

Every milestone includes privacy/sharing boundaries, native permission/config
preservation, input/accessibility, local resource use and cost visibility. Check
that portal navigation creates no model tasks; report native child/tool usage
separately and keep unavailable totals unknown. Stronger privacy/egress and
same-task cost claims require their own evidence, not merely the existing panel.
Necessary native tests receive a finite scenario budget before execution; prefer
local counterexamples and reuse prior evidence. Raw task evidence stays local.

Installer/public distribution stays deferred at the user's request. Official
Desktop-state synchronization and an iTerm2 connector require supported interface
and licensing checks; more provider types, rooms and operating systems follow actual
need and the Claude/Codex multi-session acceptance. These are retained goals, not current work.

## Earlier accepted increments

Alpha.43 repairs retrying an exited Codex display without replacing its thread
or server, replaying input or losing first keyboard focus. Installed synthetic
regressions and a real native display exit/reopen pass with zero additional model
tasks. The [registration task](acceptance/registration.md) also confirms one
actual Claude Agent Teams task/message/shutdown workflow and a correct independent
Codex result; it does not prove full active-team cold restoration.

Alpha.42 distinguishes the main reply from observed native
child activity in solo and room views. A real Codex child retained identity and
activity across joining/leaving the room and reopening the UI; no task was replayed.
These are partial recent observations, not complete fleet inventory or termination
proof. Transport/service gaps and old backends without freshness evidence show
unknown state. Alpha.41's full local regression and first-turn permission repair
remain the core baseline. See testing.md and review.md.


Alpha.40 connects the existing sharing action to the
selected text in the visible native pane as well as conversation text. Empty and
hidden selections are rejected; sharing still requires the original preview and
explicit recipient. Five installed selection groups, six native-progress groups
and seven sharing-preview groups pass final independent artifact review.

Alpha.39 preserves keyboard control focus during native
history updates. Header, member, permission and advanced controls remain stable
while their action is valid. Changed permission/owner state remains guarded;
removing a focused member returns to dialog completion. Seven source/installed keyboard groups, four native-confirmation groups and
six collaboration groups pass final independent artifact review. No new native-provider model
task was run.

Alpha.38 keeps later sharing-preview edits and reopened
previews when an older send succeeds or fails. Empty/pending sends are blocked,
and a departed recipient never silently becomes someone else. Seven actual
source preview groups and the existing directed/finite-exchange regressions pass;
seven installed preview groups and five installed daily-use groups pass final
independent artifact review. Closing a preview does not cancel accepted
native work, and no failed request is automatically replayed.

Alpha.37 restores a saved window to an available display
when its title bar is no longer reachable. Usable positions, including negative
coordinates and intentionally partial placements, remain. Undersized records
cannot reduce the usable minimum unless the current work area itself is smaller.
The source and installed restart checks retain both windows, drafts and native
identities with zero provider activity. Four restart groups and six installed
save-failure regressions pass final independent artifact review.
This does not move windows in response to live display hot-plug events.

Alpha.36 keeps a window open when its local view/draft save
fails, including application quit. The existing warning and retry control remain
available independently of the native service connection. A post-acceptance disk
failure no longer mislabels an accepted message as a failed send; storage events
received during initialization remain visible. Six installed save/lifecycle
groups, ten draft checks and three read-failure regressions pass final independent
artifact review. Forced termination and power loss remain outside this guard.

Alpha.35 refuses to overwrite an unreadable or malformed
window record. Startup stops before launching a new service, keeps the original
file, and offers local-data access and an explicit retry after repair. The source
checks cover exact-byte preservation, real filesystem read denial and restoration
of two windows with legacy drafts and recovery copies. The installed artifact,
normal-draft and reading regressions pass final independent review. This does not certify all disk-write failures
or power-loss recovery.

Alpha.34 reserves readable space for conversation text
alongside native live panes in a minimum-size window. Shared drafts have a
responsive resize limit; expanded draft recovery remains scrollable without
pushing the editor outside the window. An ended session without a held temporary
frame shows an accurate empty state. Five source/installed layout groups, six installed raw-progress groups and eleven
installed reading checks pass, with independent final artifact review.

Alpha.41 adds verified first-turn local Codex approval and cancellation, and
same-thread native-terminal attachment while that turn is still waiting.
Old backends do not inherit unsupported decision capabilities. Real native
runtime checks use a local synthetic model endpoint, not paid model inference;
see testing.md for request/decision/resolution evidence and the 23-scenario audit.

Alpha.33 keeps collaboration and utilities reachable with long session lists and
reveals the selected session after search, restoration or reopen. Its six source
and installed navigation groups, search/daily collaboration regressions, and
independent artifact review pass.

Alpha.32 synchronizes native Codex confirmation resolution,
keeps sent decisions pending until native acknowledgement, and rejects obsolete
or ambiguous decisions. The same compatibility path no longer resurrects cached
old-backend approvals. Ordinary command decisions show the complete command,
directory and reason; unrepresented permission scopes cannot be approved here.
Retained backends without native-confirmation synchronization keep their original
session and terminal, but cannot receive GUI permission decisions. Source and
rendered synthetic-protocol checks, actual retained alpha.31 backend with the new
GUI, installed empty-profile cold boot and final independent artifact review pass. No new native-provider model task or live native permission
round-trip is claimed.

Alpha.31 allows an explicit reconnect when the graphical
Codex connection is lost but its owned native backend remains alive. The existing
terminal, native identity, configuration, history and draft are retained. Only the
selected session is subscribed; old tasks and sharing authorizations are not
replayed. Permission decisions bind to their original connection and request.
The actual installed native no-task check and six renderer groups pass; final
independent source and installed-artifact review passed. This does not cover native login/setup
before a thread identity exists, active-fleet recovery or every retained backend.

Alpha.30 prevents continuously streaming output from
postponing all local saves. It keeps short-burst coalescing and adds a one-second
checkpoint scheduling target. Actual process-crash/UI reconnect checks preserve
saved records and drafts without replay. Failed writes have an explicit retry
after storage is restored; unread originals are never overwritten by that action.
Recovered partial replies are labeled as received fragments rather than active
work. Malformed non-object service frames no longer crash the daemon.
Independent source and final installed-artifact acceptance passed; unsaved
increments and power loss remain separate limitations.

Alpha.29 repairs continuation after a confirmed owned
Codex backend exit. Records and drafts remain; recovery is explicit, and stale
connections cannot overwrite the new runtime. Native no-task and local UI checks
pass; independent source and final installed-artifact review passed. The installed
real native check restores the same completed test identity without a new task.
Alpha.28 adds local find with exact-context navigation,
archive reading and return, plus explicit reconnection of a disconnected owned
Codex thread. Source tests, real native no-task UI checks and installed artifact
checks passed independent review. Native configuration, drafts and identity are retained.
Alpha.27 verifies native Claude prompt identity before automatic
reply transfer and repairs duplicate legacy Codex input rows on cold recovery.
A two-reply real native check, installed same-identity recovery, and two installed
lifecycle cycles passed independent review.
Alpha.26 adds retained Codex input and the same existing
terminal in conversation/room views, plus explicit directed sharing for retained
Claude/Codex sessions. Alpha.25 repairs the retained Claude input and snapshot path. Alpha.24 adds private native TUI observation and bounded
rewind/tool traces to both solo and room views. Protocol, real Electron and visible
native-task evidence are described in [live-progress.md](live-progress.md).
The native terminal remains the authority; not every structured tool payload or
native Desktop interface is mapped. Observation is volatile and explicitly bounded.

**Acceptance correction after actual retained-session feedback:** earlier screenshots
showed only final replies and blocked graphical input while the original terminal
worked. That feedback reopened U17; the inspected retained paths now have direct
native input, live panes and explicit sharing, plus same-identity cold recovery.
Broader old-version and active-fleet compatibility remains unverified. Passing a new
backend trial is not evidence of seamless use of an existing conversation. Visible
tool work, permission waits, errors, timing and results must remain accessible
across presentation changes; an optional raw pane does not establish complete
structured coverage. Input continuity must also be verified on that same session.

Alpha.25 adds an explicit same-process input connection and readonly snapshot
observation for retained alpha.2 Claude sessions. Click the connection action,
then run native `/reload-plugins` once if needed; never automatically force a
reload. This preserves the live PID, native ID, history and drafts. Alpha.26 adds an explicit connection to the already loaded native Codex thread,
without model/permission overrides or another agent process. Its GUI live pane
borrows the existing terminal; it never calls the old snapshot API to create one.
Both retained providers support explicit directed sharing; their replies require
human selection before further sharing. Old automatic handoffs remain gated. Older
missing intermediate frames cannot be reconstructed. These are bounded repairs,
not a claim that every retained backend supports all current features.

| Area | Current evidence | Boundary |
| --- | --- | --- |
| Single conversation | GUI/TUI use, draft/identity retention, input focus and normal reopen; visible System Pinyin/WeChat evidence from alpha.22 | Controlled guest OS events; no universal terminal or accessibility guarantee |
| Live native progress | Read-only per-session raw output, structured tool states, bounded rewind, two private room panes, gap/overflow notices | 19–20 ms synthetic paint P95 under declared load; volatile retention, no Desktop synchronization |
| Shared work | `@` selection, one visible recipient, timeline/search/filter, notes, room/session rename/archive/restore, pointer drag and detach | One room; private history is not automatically copied |
| Native collaboration | Claude→Codex→Claude completes a three-reply file check; detached Claude continues privately with same native identity | Explicit 2–6 reply exchange, ten-minute deadline; not arbitrary goal completion |
| Human control | Input, membership, permission, failure, repetition and known native activity stop further handoffs; uncertain sends never auto-retry | An accepted native task and its billing may continue |
| Native fleets | Historical Claude teammate/tasks/messages and idle continuity; current Codex Luna child start/completion/close request observed; current event mapping tested | No complete descendant inventory, termination or active-fleet recovery claim |
| Native setup | Fresh guest missing-dependency actions, Python installer, automatic/custom discovery, both native login screens; host authenticated work | Fresh account authorization in the guest was not performed |
| Download/install | Final Safari network download with quarantine and matching hash, app-specific Gatekeeper approval, installed source/signature checks | Controlled VM-only download server; not a public GitHub release or notarization |
| Privacy/cost | Private local state, explicit context transfer, native auth, no title/summary/router model calls; publication guard | No independent security certification or total-task cost/latency parity claim |

See [alpha.23 evidence](alpha.md#alpha23-core-acceptance), [testing](testing.md) and
[review record](review.md). A mock, document or skipped case is not native proof.
The current result combines complementary evidence rather than pretending one
uninterrupted clean-account journey was performed on a physical customer's Mac.
The subsequent [recorded native task](testing.md#recorded-native-collaboration-trial-2026-10-19)
combines a visible guest interface with real native agents through an isolated
test bridge; its four submissions and repeated lifecycle checks passed independent
review. It does not add a supported remote connection feature.

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
