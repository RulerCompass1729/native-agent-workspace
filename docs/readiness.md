# Demo readiness and milestones

As of 2026-10-17. Current phase: **macOS source alpha and locally tested Apple Silicon app/DMG build**, with DSH as the UI
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

## Next milestone

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
embedding. Preferred-terminal integration below is a follow-up after this path
works; it must not replace finishing installation and basic TUI use.

Every commit/push still requires proactive secret/PII scans and review, including
outgoing history, author identities and commit messages. Raw test evidence stays
local. The guard and written privacy requirements are not a global compliance
certification. See [publication](publication.md) and [privacy](privacy.md).

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
