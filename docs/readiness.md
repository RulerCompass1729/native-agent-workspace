# Demo readiness and milestones

As of 2026-10-18. Current phase: **macOS source alpha and locally tested Apple Silicon app/DMG build**, with DSH as the UI
foundation. The maintainer authorized implementation and real use, then explicitly
limited Claude/Codex tests to important unresolved native behavior.

| Milestone | Status and evidence |
| --- | --- |
| Product boundaries and public repository | Done: session/room/view distinction, Apache-2.0 original work, source register and publication guard |
| Single native session with GUI/TUI views | Local demo: both providers have real replies through both surfaces; native trust/login remains native |
| UI reopen without re-login/session replacement | Normal exit, crash recovery and loading-window exit checked with live native sessions; view/draft/identity retained while the service remains alive |
| Intentional multi-window, no accidental duplicate app | Same-profile lock, one DSH UI host, exclusive test launcher and owned-process cleanup checked |
| Honest stop/disconnect state | Claude waits for process exit; Codex unsubscribe remains disconnected until native closure. Empty-session checks and local failure tests passed without model prompts; live services retain their loaded version |
| Two agents and human-directed collaboration | Join/leave and explicit sharing implemented; real three-reply check stopped at its limit; local control/race checks passed |
| Cross-view draft/submission safety | Alpha.5 replaces Claude paste/Enter with a structured native API. Visible draft-blocking and exact-payload reply checks passed on Claude 2.1.302; cancellation/replay checks passed locally. Codex mixed-draft and full concurrency coverage remain |
| Native fleets | Claude single teammate/shared task/messages observed; idle team retained across room changes/UI reopen without a new model prompt. Active Codex fleet and full failure/termination semantics remain unverified |
| Single-session alpha delivery | Implemented: local app packaging, prerequisite/version screen, safe startup retry, explicit history recovery, draft retention and safe backend replacement; tested details in alpha.md |
| Broad consumer release | Not yet: notarized distribution, broader input/accessibility/network/native fleet coverage and release-specific provider terms remain |

See [demo instructions and exact limits](../demo.md), [test policy](testing.md), and
the historical [first continuity result](native-continuity.md). Do not turn a
successful root reply into a claim that all descendants finished or stopped.

## What can be tried now

Run `npm ci` then `npm start`. Use one session, switch conversation/native terminal,
invite another session, explicitly share a task, and detach either session without
replacing it. Native providers must already be installed and authenticated through
their own mechanisms. No provider binaries are distributed by this repository.

The frontend reuses DSH's Web composition and UI components; the separate native
service deliberately outlives its windows. Updating frontend source does not
silently replace a live backend. Service loss preserves records for explicit native-history recovery, not running
fleets. No interrupted prompt or collaboration is automatically replayed.

**Claude submission boundary:** a session-local mod checks the native draft and
requests a current control/membership authorization before explicitly submitting
text. It never writes the terminal editor. A draft, missing mod, unsupported
version or disconnected bridge blocks graphical sends. Existing live sessions
on an older backend remain usable in their native terminal; end them and reopen
the app to start the updated backend. Do not assume a UI restart updates a live
service. An uncertain acknowledgement is never automatically retried.

The local authorization is the dispatch boundary. Later human input can interrupt
native work; it cannot retract an already accepted submission. This does not prove
an atomic cancellation across native queues or termination of all descendants.
Codex uses explicit RPC input and still needs its own mixed-draft verification.

## Next milestone

The product is a unified Desktop + TUI workspace. TUI daily use remains the first
delivery path, while both interfaces share session identity, input safety,
permissions, control and recovery acceptance. Keep the DSH foundation and native
service. A complete conversation-first experience follows daily-use feedback;
its needs already constrain today's architecture and tests. Clean-machine
installation testing still waits for disk space.

The cross-view Claude submission change is locally verified as described in
[alpha evidence](alpha.md#structured-claude-submission). The next bounded item is
to make collaboration pause when native background/teammate state is unknown,
rather than treating missing information as zero. Do not add new orchestration
surfaces. Effective native permission/config inheritance remains a separate gate;
the current adapters still set some modes explicitly.

The maintainer's current milestone is the complete installation/use path, focused
on **individual and collaborative native TUI use**:

1. Download the macOS installer, install and open it without Git/npm commands.
2. Complete prerequisite detection and native login/trust, then use Claude or
   Codex alone in its terminal view.
3. Join the two sessions, explicitly share a task, observe bounded handoffs and
   retain human pause/takeover controls.
4. Detach either agent and keep using its original native session.
5. Quit/reopen the interface and retain sessions, selected view and saved draft
   without duplicate instances or replayed prompts.

The local DMG copy/launch path is verified. The current trial deliberately uses
free, unnotarized distribution; public binary download, exact-artifact publication
review and the app-specific Gatekeeper opening path remain unverified. Signing and
notarization are a later option. First use on a Mac without Python/provider installation
also remains open: current setup links to official instructions. Earlier native
single-session replies and bounded collaboration may be reused only where the
runtime/adapter behavior is unchanged; they do not prove fresh-machine setup.
See [alpha evidence](alpha.md).

Do not expand this milestone into new providers, extra chat features, or iTerm2
embedding. The [unified experience criteria](interaction.md#统一体验验收与反馈依据)
guide improvements to existing flows. Preferred-terminal integration below is a
follow-up after this path works; it must not displace installation, input safety
and basic use.

Every commit/push still requires proactive secret/PII scans and review, including
outgoing history, author identities and commit messages. Raw test evidence stays
local. The guard and written privacy requirements are not a global compliance
certification. See [publication](publication.md) and [privacy](privacy.md).

## Delivery order and interface review

Reviewed 2026-10-17 against alpha.2 source and its saved installed-app screenshots.
This section is a plan, not a new runtime acceptance result. No model calls or new
desktop instances were needed for this review. The clean macOS VM trial is paused
until the maintainer frees system-disk space; no VM image has been installed.

问题：下一步有哪些工作，以及如何改善当前界面的质感和操作。
现有机制：`renderer/index.html`、`renderer/renderer.js`、`renderer/styles.css`、
`preflight.cjs`、`platform.cjs`、`workspace.cjs`、`adapters.cjs` 和
`service-client.cjs` 已读；现有 DSH 视图和独立原生会话服务继续保留。
最小增量：先推进维护者可日常使用的 TUI 版本，随后验收朋友试用的完整安装路径；完整对话式 Desktop 体验等 TUI 使用反馈通过后开始。
不做会坏什么：用户仍可能卡在环境准备，或混淆查看会话、脱出协作与停止原生任务。

### Current milestone: a usable TUI trial

Alpha.3 adds a TUI-focused increment: terminal-first new windows, persisted text
size/palette, paste/copy controls, macOS Option-drag selection when native mouse
tracking is active, terminal focus on session return, and per-window shared-task
draft retention. The privacy/usage panel exposes scoped dispatch counts, reported
native tokens and explicit unknowns. These are not proof of complete cost parity,
network privacy or the outstanding clean-machine installation path.

Alpha.4 adds shared-record/member-terminal switching within the room, a persistent
pause entry, same-session detach, room/member restoration, and a compact sidebar
for small windows. View focus no longer counts as human terminal input. These
checks used two idle native sessions without model prompts. Active native work,
fleet shutdown and fresh-machine installation remain separate acceptance gaps.

These are workstreams within the existing installation/use milestone, not
parallel new products. Finish one testable user path before widening scope.

| Workstream | Verified starting point / gap | Exit condition |
| --- | --- | --- |
| Download and first open | Local DMG copy/launch passed; public download, quarantine and clean-machine first open remain unverified | The exact reviewed release artifact is downloaded and opened on a clean Mac/VM following the user guide; no maintainer environment or credentials are copied in |
| First-use setup | Discovery checks executable presence in PATH and conventional locations; it does not establish provider version, login or successful startup | Missing agent, unusable installation and native login/trust each have a clear next action; a user with only one agent can start; unusual install locations have an explicit fallback |
| Prerequisites | Python is still needed for the PTY bridge; current setup sends users to installation instructions | Complete the missing-Python path on the clean system. Evaluate a reviewed bundled helper/runtime only if required to remove the blocker; do not blindly replace the session architecture |
| Single-session interface | Terminal display/copy/paste/focus and the compact small-window sidebar are checked; physical IME, screen reader and daily-use feedback remain open | A compact header, readable light/dark themes, adjustable terminal text size, stable focus, selection, paste and Chinese input; no agent recreation on view changes |
| Collaboration interface | Shared-record/member terminals, visible pause, explicit takeover and detach are checked; the three-reply handoff remains bounded, not general goal completion | Invite an existing managed session, choose the material and recipient, observe handoffs, pause, detach and continue independently without needing a verbal explanation |
| Continuity and failure | Window reopen and some recovery paths are tested; alpha.3 saves the per-window shared-task draft; cold backend recovery differs from reopening a live UI | Preserve unsent input; distinguish waiting for login, disconnect, recovery and confirmed termination; never auto-replay an uncertain send |
| Release confidence | Source privacy guard and packaging allowlist exist; these do not prove full binary/network privacy | Review the exact binary/notices; use synthetic data for startup, sharing and deletion checks; retain no unexpected upload; record a small shell CPU/RSS/startup/interaction baseline rather than claiming zero overhead |

The initial clean-machine matrix is: neither provider installed; only Claude;
only Codex; both providers. Reuse a clean baseline and separate OS/setup checks
from model use. Include normal Finder launch, native sign-in, install-path fallback,
an app-only reopen and a separate system/service-recovery case. A second person's
physical Mac is an additional compatibility/usability check, not replaced by a VM.

The planned clean-machine live-model allowance is at most five short top-level
replies (one per provider plus a three-reply handoff), no spawned teammates, and
no automatic retries. Setup, appearance, input, lifecycle and missing-dependency
checks use no model prompts. Reuse unchanged native evidence. This reply cap is
not a guaranteed token/cost cap; native usage is reported as available.

### Interface direction for this milestone

The desired quality comes from hierarchy, spacing, readable type and predictable
behavior. Preserve DSH composition, theme primitives and the session service.

- **First use:** a short “choose agent → connect → start” path. Show already
  available agents first. Move installation diagnostics behind details; make a
  missing requirement actionable where it blocks the next step.
- **Single session:** a collapsible session sidebar and one compact context bar
  containing the session name, conversation/terminal switch, status and invitation
  action. Put independent-window and infrequent actions in a labelled menu.
  Give terminal/content the main area; keep advanced native diagnostics optional.
- **Collaboration:** keep the same shell. Offer shared record and participant
  tabs; selecting a participant views its private session without implying it is
  shared. Show who receives the next handoff and keep pause/takeover visible.
  Put member management and sharing details in an on-demand panel. A two-terminal
  side-by-side layout is optional and follows feedback, not the default redesign.
- **Appearance:** use coordinated neutral surfaces and one restrained accent,
  consistent typography, controls, borders and focus states. Both providers
  currently use a “C” icon; give them distinguishable, licence-reviewed labels or
  symbols. Keep the terminal palette separately selectable. Remove repeated
  marketing/explanatory text from ongoing work; keep disclosure at decisions.
- **Interaction:** provide mouse/menu equivalents for drag and shortcuts, preserve
  focus/selection/scroll position, and verify small-window layouts, IME and
  accessibility. A screenshot alone is not acceptance evidence.

Review three representative views first: setup, a real single-session TUI, and a
two-agent collaboration with messages and a pending human decision. Use synthetic
content for design fixtures. Do not spend model turns to populate mockups.

### Later work, with explicit triggers

| Trigger | Follow-up | Completion standard |
| --- | --- | --- |
| The installation/TUI trial passes and daily-use feedback arrives | Session naming/search/archive, long-session performance, terminal preferences and the preferred-terminal connector below; update/recovery polish | Daily work survives reopening and an app replacement without duplicate owners or lost input; slow paths are measured before optimizing |
| The TUI trial is stable and the next audience needs conversation-first use | Complete the GUI path: native progress/permissions, files/images and supported model/configuration controls | Routine work can be completed without an unexplained terminal detour; unavailable native capabilities retain an explicit native entry, not a simulated equivalent |
| The basic human-directed handoff is reliable | Goal-based unattended collaboration with completion, permission, repetition and usage boundaries; active fleet lifecycle validation | Human intervention invalidates queued handoffs; task completion and descendant termination are separately evidenced; unknown usage/state is not reported as zero/stopped |
| A supported provider attachment contract and an actual migration need are established | External-session discovery/selection and attach/resume distinctions | Live attachment, history recovery and imported reference text are labelled accurately; do not create a concurrent resume of an already running session |
| Two-provider capabilities and adapters are stable | More agents/rooms, Windows/Linux; broader installer distribution and update automation | Capability-specific adapters preserve upstream behavior and cross-platform lifecycle tests pass |

Native fleets are an existing product requirement, not an optional add-on.
Before claiming full support, close the remaining active Codex fleet and
stop/recovery gaps. UI-only changes should not rerun a fleet task without a
specific unresolved behavior. Current adapters also choose explicit permission,
teammate and traffic settings: audit and disclose these choices instead of
claiming every native preference is inherited unchanged.

The current “one round” is a bounded handoff ending at a reply limit, not proof
that an arbitrary goal is finished. The source has no general external-session
import UI. Long-session performance is not yet benchmarked: the service currently
broadcasts full snapshots and the renderer rebuilds message lists on changes.
Those are measured-risk candidates, not evidence of an observed performance bug.

## Follow-up: use the person’s preferred terminal

Requested 2026-10-17; analysis only, not implemented. The current xterm.js view
uses fixed fonts/colors and one copy shortcut; it does not inherit Terminal or
iTerm2 profiles. Native agent preservation is separate from terminal-emulator
feature parity.

| Option | Expected effort / fidelity | Decision and trigger |
| --- | --- | --- |
| Adjustable embedded terminal; optional font/color profile import | Small–medium; appearance only, not arbitrary shortcut/action parity | Follow actual terminal feedback; import only selected visual fields, never shell commands, SSH entries, triggers or secrets |
| Open the same managed session in installed iTerm2 / Terminal | Medium; preserves that app’s chosen profile and its own shortcuts | Follow-up after the complete installation/TUI milestone. Detect installed apps locally, let user select; retain one input owner and the same native session/fleet. Closing that terminal must only detach the view |
| Embed iTerm2 itself inside Electron | Large; native application/windowing integration and licensing review | Deferred. No supported embeddable-view contract established by the reviewed scripting APIs; do not copy/link GPL implementation into this Apache project without separate review |

The recommended later terminal integration is the external terminal view, backed by our
existing persistent PTY/service, not a new agent invocation. Codex’s supported
remote TUI can be considered separately; Claude must keep its existing PTY and
Teams, rather than background/resume migration. An arbitrary already-running
external Claude process cannot be assumed attachable. A local terminal bridge
still needs raw-mode/resize, device-query ownership, safe quoting, disconnect,
single-input-owner and relaunch tests. These are engineering estimates, not proof
of a finished connector. No terminal preferences or histories were scanned.

References: [iTerm2 scripting](https://iterm2.com/documentation-scripting.html),
[window/profile selection](https://iterm2.com/python-api/window.html),
[profile/key binding API](https://iterm2.com/python-api/profile.html),
[Apple Terminal scripting](https://support.apple.com/en-lamr/guide/terminal/trml1003/mac).
