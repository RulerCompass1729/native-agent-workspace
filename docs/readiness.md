# Readiness and next gates

As of 2026-10-19. Version 0.1.0-alpha.26 is a **local macOS technical-trial alpha**.
The accepted core increment is defined in [core-milestone.md](core-milestone.md).
It preserves DeepSeek Harness UI composition and the persistent native service.
The earlier solo-only pause is superseded by this accepted collaboration work.

**Current increment:** alpha.26 adds retained Codex input and the same existing
terminal in conversation/room views, plus explicit directed sharing for retained
Claude/Codex sessions. Alpha.25 repairs the retained Claude input and snapshot path. Alpha.24 adds private native TUI observation and bounded
rewind/tool traces to both solo and room views. Protocol, real Electron and visible
native-task evidence are described in [live-progress.md](live-progress.md).
The native terminal remains the authority; not every structured tool payload or
native Desktop interface is mapped. Observation is volatile and explicitly bounded.

**Acceptance correction after actual retained-session feedback:** the person still
sees only final replies in conversation mode and cannot compose/send there while
their original terminal works. U17 is reopened for this user path. Passing a new
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
