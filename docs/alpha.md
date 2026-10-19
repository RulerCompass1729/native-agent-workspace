# macOS alpha trial

As of 2026-10-18. Version 0.1.0-alpha.23. Suitable for a small technical trial with
synthetic or low-sensitivity work; not a general consumer release. Product name
is still a working name.

## Alpha.23 core acceptance

One visible recipient control replaces the separate @/recipient controls. Advanced
context and bounded checking are in the composer menu. Reply exchange requires an
explicit task/participant preview, a 2–6 reply cap and consent to transfer root
replies despite unknown descendant state. The 10-minute deadline stops later
handoffs, not already-running native tasks or their billing. Strict native-state
checks remain distinct. Human input, membership/permission changes, known native
activity, repetition, failures and limits stop further routing. Service recovery
pauses the saved exchange and never replays it.

A source-app native test with Claude Code 2.1.303 / Haiku 5.5 and Codex 0.163.0 /
GPT-6 Luna completed a three-reply read-only check of a synthetic local file.
Both computed 20 cells; the third reply ended handoffs. Claude then detached by
pointer drag and continued privately with the same native ID/process and the
previous result. Archive/restore and UI reopen retained both native identities,
shared record, notes and distinct unsent drafts without another submission.
A fifth parent task spawned exactly one GPT-6 Luna/low native Codex child; native
events recorded its start, completion and interruption/close request. This does
not prove every descendant process terminated or active-fleet recovery.

That trial exposed a Codex event-name mismatch in native activity guards. The
subsequent mapping fix is covered with saved event shapes through the real
adapter/workspace. It has not been represented as having been active during the
already-completed native child trial. The final artifact contains that mapping;
its actual-shaped regression passes with source-to-package equality verified.

Native usage is not equal to parent task count: tools and the native child make
additional requests. No expensive-model fallback was used. Existing Claude Teams
evidence retains its original scoped version/idle-continuity limits.

The final local regression result is **191 passed, zero failures/skips**. The
installed room runner passes seven groups with nine synthetic submissions; the
installed solo runner passes eight groups and the broader collaboration runner
covers drag/cancel/detach, context, filtering, ownership, archive and reopening.
Those hidden runners are UI/service tests, not physical input or native-model
proof. The final rebuild changes Python discovery only; affected native-lifetime
and discovery checks, the installed room runner and guest startup were rerun.

On a separate macOS 26.6.2 guest, Safari downloaded the final DMG from a controlled
VM-only HTTP server. The downloaded quarantine attribute was present and SHA-256
matched. Finder drag-install was checked on the initial candidate. The final
candidate replacement retained quarantine and required app-specific **Open Anyway**
and administrator approval; the system-wide App Store-only setting was not changed.
This is a network-download/Gatekeeper check, not a GitHub release download or
notarization claim. The final host install matches all **9,181 file/link entries**
in the mounted DMG and passes strict ad-hoc signature checks.

The fresh profile initially detected neither agent nor usable Python. Session
creation stayed blocked with setup actions. Python.org's signed 3.15.0 installer
was completed through its GUI; Claude Code 2.1.303 used the reviewed official
installer and Codex 0.163.0 used its official release archive with matching digest.
No host home, credentials or auth files were copied. This exposed and fixed a real
Finder-PATH bug: an uninstalled system Python shim hid a later usable Python.
After rebuilding, **自动查找 / 重新检查** finds the real installation. The native
file chooser also saves a selected executable privately. Both native terminals
reach their own first-use/login screens. Account authorization and the first
paid reply in this guest were not performed; authenticated native work was checked
separately on the host. Missing-one-agent startup does not require the other agent.

The visible final app was then driven with guest OS mouse/keyboard events:
drag in both members; type `@` and select one; send exactly once; save shared notes;
rename the room; authorize three synthetic replies and observe the limit; drag
one member out retaining identity; archive/restore the room; quit/reopen with
notes, timeline, recipient and distinct private/shared drafts intact. Four
synthetic submissions, zero native/model tasks in this UI fixture. System
Pinyin/WeChat evidence from alpha.22 is reused for unchanged input paths.

Live test usage for this increment: **five parent submissions (Claude three,
Codex two), plus one observed native Codex child**. Tools can make multiple model
requests; these are not total call/token counts. No full fleet-stop guarantee,
new-account sign-in certification or equal-task cost/latency claim is made.
Public binary distribution, notarization, broad hardware/VoiceOver compatibility
and complete native descendant recovery remain outside this local trial gate.

## Alpha.22 single-conversation OS acceptance

The local daily single-conversation TUI workflow now passes the controlled
acceptance below. This is the maintainer's daily-use alpha milestone, not a claim
of universal terminal compatibility or a general consumer release. The later core milestone resumes collaboration work.

A visible installed app on a separate macOS 26.6.2 guest was driven through real
OS mouse/keyboard events, with System Pinyin and WeChat Input 3.0.0. This exposed
one additional defect: clicking Stop hid the focused button, leaving subsequent
typing on the page. Send and Stop now return focus synchronously to the composer;
no later asynchronous response can steal it from a newer view or dialog.

The final installed guest checks cover:

- Both input methods: preedit, confirmation, cancellation, session switching with
  a composition in progress, and exact input bytes delivered to the original
  session. Confirming a GUI composition does not submit a task; a subsequent Enter
  does. Mouse Send/Stop accepts immediate Chinese input and retains the next draft.
- OS pointer selection and Copy, toolbar paste and Command-V, arrow/Control-C,
  app foreground return, and dialog focus during a state update. Multiline paste
  is rejected when native bracketed-paste protection is absent; when enabled it
  is delivered once, bracketed, without an extra submission Enter.
- Terminal history: actual mouse-wheel scrolling through 180 lines, copying a
  historical line, retaining that position through view/session switching, then
  delivering input only to the selected terminal.
- Normal Command-Q and reopening: the same service, session/native IDs, history,
  distinct per-session drafts and selected view survive. Immediate keyboard input
  works; a further 12.5-second idle check finds no draft loss or replay.

The OS event driver uses CGEvents, not a physical person's keyboard. CDP only
inspects DOM/state and positions the OS pointer actions; it does not inject text
or composition in these cases. Candidate windows and exact backend bytes were
inspected. Some observed compositionend events have isTrusted=false even though
start/key events are true; a temporary dispatchEvent observer found no JavaScript
composition dispatch. The cause remains unknown and the original trace is retained;
no claim depends on treating that flag as hardware-origin proof.

Provider transport in this guest is synthetic. Four fixture tasks exercised GUI
send/stop; zero real Claude/Codex processes or model calls were added. The native
runtime/adapter/PTY layers are unchanged, so their earlier scoped native replies,
recovery and unsent-input evidence is reused. Source and final packaged solo
checks pass eight groups; 162 local checks pass with zero skips. Prior reading and
multi-window draft results remain applicable to the unchanged paths.

The host installed alpha.22 matches all 9,180 file/link entries in the mounted
DMG and passes strict ad-hoc signature verification. Guest version and seven
runtime/generated-UI hashes match that installed artifact. The host's three
original native sessions, history, drafts, views and diagnostics are unchanged;
the host user UI was not activated. A rollback copy remains local.

The guest used a prepared vanilla macOS image, not a factory-clean Mac. Its local
DMG first-open/missing-prerequisite checks do not establish internet-download
quarantine, provider installation/sign-in, or notarization. Screen readers,
long-duration resource use, full provider fleet/configuration parity, complete
network privacy and equal-task cost parity remain separate gates. Reopening a UI
is not recovery of live fleets after a machine/service failure. The DMG remains
unnotarized and unpublished. Independent final review is recorded in review.md.

## Alpha.21 reading continuity

Conversation and shared-timeline updates retain unchanged message rows. Reading
older content, selecting its text or focusing a Copy action no longer loses that
position/selection/focus when a different reply streams. Copy actions read the
latest text. Only readers already at the bottom follow new output automatically.

Each window saves bounded per-conversation reading geometry locally, restoring
it through GUI/TUI changes, conversation changes and normal UI reopening. The
main process receives scroll metadata immediately, coalesces disk writes and
flushes received state on normal close/quit. Only IDs and geometry are retained;
selected text is not saved. A process kill before event delivery or power loss is
outside this guarantee. Filtered shared-timeline context jumps keep the target
visible while preceding Markdown finishes rendering, until the reader interacts.

The installed alpha.21 passes eleven reading checks using actual Electron/DSH,
IPC and service with synthetic provider transport. The same 240-message workload
on installed alpha.20 reproduces lost selection, focus, scrolling and reopening.
Across 24 streamed updates, removed message-list nodes changed from 5,783 to zero.
In this local run the renderer working-set sample at the end was about 499 MiB
on alpha.20 and 301 MiB on alpha.21, starting from about 283/285 MiB after history
loaded. These bounded samples support the specific fix; they are not long-duration
memory/leak, native-provider performance or equal-task cost guarantees. Full service
snapshots remain unchanged. Later samples after UI reopening use new processes.

162 local tests and six source collaboration groups pass, including long-Markdown
context visibility, pointer drag, explicit takeover and archive/resume. The installed
input regression passes eight groups; ten installed two-window draft/recovery
checks also pass. No native providers or model requests were
started in this round. System clipboard contents were left untouched: the reading
test captures application Copy payloads internally.

The installed app matches all 9,180 files/links in the mounted DMG, matches source
and passes ad-hoc signature verification. The original three native sessions,
history, drafts, views and diagnostics remain unchanged. The normal user UI was
not launched; tests remained hidden and non-focusable. The DMG is unnotarized and
unpublished. Independent source and final artifact review passed for this bounded repair.

**Not daily-use sign-off:** hidden rendered UI and screenshots do not certify
visible desktop use, System Pinyin/WeChat IME, OS focus/Spaces, clean-Mac install,
active fleets or full privacy/cost parity. These remain explicit acceptance gates.

## Alpha.20 draft continuity

Taking control in another window now reads the session's current draft. Reloading
a window no longer writes its old backup into the session. The new backend rejects
draft writes from a former controller. Existing live backends retain their loaded
version; they are not silently replaced to acquire that backend check.

Window recovery copies are stored separately by session, with acknowledgement
status. Failed or legacy unconfirmed copies remain available in a collapsed,
copyable section beside the composer; they never replace or send the current
draft automatically. Unresolved copies survive further editing and UI reload;
explicit deletion is respected even if an old save acknowledgement or another
window's state arrives later. Copies appear only after their local save succeeds.
After service loss, a differing acknowledged copy is also offered for recovery,
because an in-memory acknowledgement is not disk durability.

Source validation: 160 local tests and nine existing late-send/draft groups
passed without model requests. Ten two-window checks preserve the original failing
results and cover takeover/reload, former-owner rejection, legacy copies and
recovery persistence/deletion with delayed successful acknowledgements. The same
ten checks passed using the final packaged renderer, main process and service.
The installed app also passed eight input regression groups with zero provider
processes or model tasks. Foreground-app return is explicitly skipped; physical
IME, visible desktop use and the broader daily-use milestone remain unverified.

The installed copy matches all 9,179 files/links in the final mounted DMG, its
runtime matches source, and its ad-hoc signature verifies. The original three
native sessions, history, drafts, views and diagnostics remain unchanged; the
normal UI was not launched. The DMG remains unnotarized and unpublished.
Independent source and final artifact review passed for this bounded draft
continuity fix; the wider daily-use acceptance gates remain open.

## Alpha.19 single-conversation interaction work

An unavailable graphical send now offers **Open native terminal** in the existing
primary action. Saved text stays readable and copyable; it is never automatically
pasted or sent. The same fallback works for an unavailable shared recipient.
Ended sessions expose explicit recovery only when the backend supports the safe
recovery path. A still-connected error opens the existing terminal instead of
attempting to resume a duplicate native process.

View changes are serialized per session. Late acknowledgements cannot switch a
newly selected session or steal an open menu/dialog's focus. A queued choice is
cancelled when refreshed state shows a newer controller or control revision.
Tabs can inspect another window's session without taking control; **Take control**
is explicit. This does not add an atomic conditional-claim protocol: a controller
change after the refresh but before the native claim remains a protocol race.

Sidebar selection and graphical-view switching now focus an editable draft
immediately. Native control acknowledgement still gates sending. An already
connected owned terminal accepts keys during its control acknowledgement, keeping
a bounded local queue tied to that exact intent. Cancellation, failed control or a
new owner preserves a copy without submitting it. Initial attachment keeps its
loading gate. Chinese composition stays with its originating terminal; confirming
a candidate does not emit the Enter that sends a native task. Unconfirmed input
has a copyable notice, temporary to the current window; copy before app close.

Source validation passed 155 local tests with no skips. The final installed build
passed eight input groups and eight single-conversation groups using its packaged
UI, daemon and workspace. These final runs use hidden Electron renderers with
CDP input and synthetic native transport. They check exact text/origin, send and
interrupt, unavailable-send fallback, ownership changes, and DOM/main/disk/service
drafts after reopen and 12-second idle windows. They made one synthetic send and
started no native providers or model tasks. Physical macOS IME, visible desktop
interaction and foreground app return were not established by these runs; the
foreground-return case is explicitly skipped by default.

A separate final installed check resumed two existing synthetic Claude/Codex
histories using the real native runtimes. It verified unsubmitted Chinese
composition and immediate GUI/TUI typing, exact historical replies and drafts,
and unchanged native PIDs through UI reopen. Each terminal was attached once;
app dispatches and native task inputs stayed zero, and no model task was sent.
The hidden test answered only the exact native-resume confirmation in code; that
OS confirmation UI and physical IME remain unverified. Both test-owned native
processes exited after cleanup.

Test startup previously switched Spaces, and an inactive visible window could
still appear above fullscreen Chrome. Isolated tests now validate their parent
and canonical private profile before locking, use accessory policy before app
readiness, and keep all windows hidden/non-focusable, including restored,
startup-error and duplicate routes. The final installed launch/reopen/duplicate
probe observed hidden windows, 185 unchanged foreground-app PID samples and zero
active-Space notifications. This is a bounded observation, not a guarantee about
all macOS desktop behavior. Normal user launches retain their usual behavior.

The final DMG copy matched all 9,178 files/links, its runtime matched source and
its ad-hoc signature verified. It remains unnotarized and is not a public
installer release. Source and final installed evidence passed independent review for this bounded
local trial. Original user native identities, three live native PIDs, histories,
drafts, views and diagnostics matched the post-exit baseline after another
12-second idle check. The normal user UI remains closed for manual launch;
preservation checking did not open or activate it.

No provider adapter, native session protocol or dependency changed. Collaboration
design, physical IME and clean-Mac installation remain separate acceptance items.
The earlier unexplained profile draft change and prior mixed-input anomaly are
not retroactively explained by these checks.

## Alpha.18 single-session recovery work

Collaboration feature expansion is paused following feedback about redundant
controls and unavailable sending paths. Existing manual sharing is not a finished
agent communication experience. The immediate acceptance target is dependable
single-conversation use; see [current priority](readiness.md#current-priority-a-dependable-single-conversation).

Codex cold recovery now registers event observation before requesting resume,
keeps the same native identity, reads paginated history and reconciles persisted
partial replies and explicitly correlated submission echoes. New live events take
precedence over a late resume status. The native terminal can open while the
graphical history is synchronizing; a history-read failure preserves the terminal
and saved drafts without enabling graphical sends. An unknown active turn ID
produces an explicit terminal instruction instead of falsely claiming an interrupt
was requested. No interrupted prompt or collaboration is automatically replayed.

Validation: 154 local tests passed with no skips. The installed application
resumed existing synthetic Claude and Codex native histories, retained both
terminal and graphical drafts through UI reopen, and kept a single window.
The first native check exposed an incorrect first-message prompt and stale
connecting text; the final installed check confirmed both were gone. No new
model task was sent during these recovery checks. Native active-fleet recovery
and physical Chinese IME input were not established by this test. Older retained
backends still expose their original capabilities; this does not complete
single-conversation daily-use acceptance or the collaboration experience.

## Alpha.17 navigation hierarchy

Sessions and collaborative workspaces now have separate labelled sections,
aligned inset rows and visible dividers. All unarchived sessions remain accessible
in the session section, including those marked as participating in collaboration.
The middle area scrolls together; archive, installation and privacy tools remain
in a separate footer. The narrow icon rail retains section dividers. Archiving
the workspace leaves a clear note pointing to the archive list for restoration.
This changes navigation presentation, not native session identity or routing.

The installed build passed daily-flow and keyboard/menu checks, including narrow
windows, light/dark themes, long names and reopen. Source pointer drag and archive
regressions also passed. Independent review covered the changed source, complete
logs and screenshots. Tests used synthetic provider transport with no model tasks;
the original user sessions and saved views were preserved. Long-list scrolling
has not been exercised, and this UI change adds no native recovery evidence.

## Alpha.16 collaboration and archive checkpoint

The installed DMG now provides room/session menus, room naming, real application
drag into/out of collaboration, single-recipient @ selection with duplicate-name
disambiguation, a searchable shared timeline with member filters, manual shared
notes, explicit context preview, and archive/restore for sessions and the room.
The sidebar is more compact; advanced automatic collaboration is under the
composer's more menu. This is a local interaction checkpoint, not evidence that
every provider capability or unattended collaboration works.

`npm test` passed 130 checks with no skips. The installed collaboration runner
passed six groups covering pointer drag/cancellation, exact recipient and payload,
local notes, departure and late private replies, cross-window revision conflicts,
archive/reopen/restore including unsent drafts, and explicit shared-history
clearing. Four synthetic submissions, zero native provider processes and zero
model calls were used in that run. The separate installed daily-use regression
also passed all five groups, including GUI/TUI continuity, repeated launch and an
880×660 window, with three synthetic submissions and no model calls. These tests
use the packaged daemon, workspace, IPC and UI with synthetic provider transport;
they do not establish physical IME, native fleet or cold-resume behavior.

Archive means retain and hide, not terminate. It pauses further room handoffs and
preserves the original member IDs; separately archived sessions are excluded from
room restoration. New input to an archived session is blocked until restored.
Already accepted native tasks may continue, and their reported status remains
visible in the archive list. Restoration never replays tasks. There is currently
one shared workspace; this does not yet provide multiple archived workspaces.

Membership events and notes are local records, not model memory. A user must
explicitly send selected background for an agent to receive it; private history
is never auto-included. Already received context remains in the native session
after departure. Timeline search covers shared records, not all private/tool
activity. Sharing background consumes normal model context when sent.

Independent review found and closed concurrent-note clearing, stale-owner draft
insertion and observer-disconnect error-reporting issues. Local regressions also
cover partial archive/restore failure and cold retry. Actual pointer testing found
a dragstart layout shift, which was removed and retested. Private screenshots and
logs remain outside the repository. See [the issue record](review.md) for the
scope of each closure and the remaining release gates.

The DMG was mounted read-only and copied into Applications; all 9,178 files and
links matched, relevant installed modules and generated UI matched the source,
and ad-hoc signature verification passed. Existing local sessions retained their
native IDs, PIDs, full displayed histories, drafts, names, membership and usage
diagnostics against a fresh pre-upgrade baseline. Their saved view was restored
with one normal visible app window. This does not establish clean-machine setup
or downloaded-app Gatekeeper behavior; the artifact is still unnotarized.

## Start

1. Install and sign in to your own Claude Code or Codex CLI using its official
   native flow. This project does not distribute either provider binary or copy
   their credentials. Install Python 3 as well.
2. Follow the [complete download/install steps](../README.md#run-locally): clone
   or download this public repository, enter its folder, run `npm ci`, then
   `npm start`. Building requires Node.js 22.19+ on 22.x, or 24+.
3. On an Apple Silicon Mac, `npm run package:mac` builds an app/DMG/zip in `dist/`.
   The app uses Electron's bundled Node runtime; no separate Node/npm is needed
   to launch the app. The installed provider may have its own runtime needs.
4. Open **检查安装与版本**, then create a session. The terminal handles native
   folder trust, login and provider-specific controls. Creating a session does
   not send a model task.

The local build is ad-hoc signed, **not notarized**. There is no automatic binary
upload or auto-updater. Do not disable Gatekeeper globally. Before distributing
a downloaded app, review its exact artifact, licensing/provider conditions and
platform signing plan; a successful local build is not that approval.

For an already-built matching app, `node scripts/package-dmg.cjs` creates only the
DMG without rebuilding the application. Open the DMG, drag the app to Applications,
eject the image, then open the installed copy. Keep the same app data directory
when replacing an older copy. The DMG does not install Python or provider CLIs;
the setup screen still checks them. A locally copied app launching successfully
does not prove an internet-downloaded, quarantined app will pass Gatekeeper.

The maintainer chose the free, unnotarized route for the current trial. A downloaded
copy can trigger Gatekeeper. After checking the app's source, macOS may offer an
app-specific **Open Anyway** action in Privacy & Security; managed Macs may block
it. Do not disable Gatekeeper globally. This earlier downloaded-app path had not yet been
verified for our artifact. See [Apple's opening guidance](https://support.apple.com/en-us/102445).

Developer ID signing and notarization are a later option for smoother public
installation. The current machine has no valid signing identity. These are
maintainer credentials; users do not enroll or run signing commands themselves.
See [Apple Developer ID](https://developer.apple.com/developer-id/) and
[Electron signing guidance](https://www.electronjs.org/docs/latest/tutorial/code-signing).
Before choosing a signing account, review the public identity it will expose.
Developer ID certificates carry the subscriber's individual or organization name;
a GitHub alias does not make this certificate anonymous. See Apple's
[Developer ID CPS, section 4.2](https://images.apple.com/certificateauthority/pdf/Apple_Developer_ID_CPS_v5.0.pdf).

The local DMG was verified, mounted read-only and copied to Applications. All
9,169 file/link entries matched the source app, and the installed copy passed
signature verification and opened its actual setup screen with a fresh profile
and system-only PATH. The test used filesystem copying and visible-app automation,
not a physical Finder drag or an internet download. The empty test service exited;
the existing workspace returned to one window with its session IDs, native PIDs,
view, draft and dispatch count unchanged. No model task was sent for this check.

## Continuing your work

Closing or quitting the interface leaves managed native processes running. Opening
the same application/profile again restores selected session, view and saved draft.
Repeated launch focuses the existing instance. An explicit **独立窗口** is allowed.

To end a Claude session, expand **会话与原生团队** and choose **结束这个原生会话…**.
Review the native confirmation and wait for **已结束**. For Codex, **断开本应用连接…**
is a disconnect request, not proof that native work ended. Once all sessions are
confirmed ended, **隐私与用量 → 清理与完全退出 → 所有会话结束后完全退出** also stops the local service.
Do not delete the source directory or application data to force a running session
to stop.

To update a local app, quit its interface and replace the app, keeping its data
directory. A compatible newer frontend reconnects to existing services; an
active session does not get restarted just to upgrade backend code. Alpha.8 starts
a current backend for new sessions while retaining older live sessions in the
same interface. Each session keeps its actual backend capabilities. See
[update continuity and boundaries](#updates-with-live-sessions).
A disconnected Codex thread is not automatically treated as ended.

After a service crash/reboot, saved records become **等待恢复**. Use **继续原生会话**
to resume native history explicitly. No old prompt, failed send or collaboration
is replayed. If a previous process may still exist, recovery refuses a duplicate
and asks you to check its native state. Empty native histories may not support
resume. Running teammates, pending tools and in-memory fleet state are not
guaranteed to survive loss of their native process.

Joining/leaving collaboration changes membership, not session identity. Shared
material is explicit; three replies/ten minutes bounds handoffs, not every tool,
teammate or provider charge. See [privacy and deletion](privacy.md).

## Verified in this increment

### Alpha.4: native terminals inside collaboration

**共同工作** now has **共享记录** and member buttons. Member buttons show that
member's original terminal, with copy/paste/display and explicit takeover controls.
The pause control stays visible. **参与者…** opens membership management;
**脱出协作** returns to the same session for independent work. Reopening restores
the selected room/member view. Viewing does not share more history or start a task.
Pausing stops future handoffs; a current native task may continue.

The visible source-app check used two existing empty, idle native sessions. It
verified both member terminals, mouse/keyboard navigation, explicit control transfer
between two intentional windows, detach/rejoin, and normal/crash reopening. Native
IDs/PIDs, history and dispatch counts stayed unchanged; no model prompts were sent.
Window-local terminal focus notifications previously reached the input stream and
invalidated collaboration control. They are now filtered alongside device queries;
these observer focus notifications are not forwarded to the native runtime.
Real user keystrokes still use the existing input/priority path.
Detaching also clears the cached room-member selection immediately after native
membership confirmation, so a fast rejoin does not navigate back to a stale view.

The 850×600 window check exposed DSH's collapsed sidebar rendering full labels in a
narrow rail. Compact controls now retain session selection, new session, room,
setup and privacy entry points with accessible names and hover labels. Light/dark
contrast sampling and screenshots accompany the interaction checks; they are not
a full accessibility certification. Existing reply and fleet evidence is reused
because the runtime/adapter and routing code did not change.

The alpha.4 DMG was mounted and copied to Applications; its 9,169 file/link entries
matched and ad-hoc signature verification passed. The installed app passed the
same room, small-window, theme and lifecycle checks against the two live native
sessions. A separate installed-terminal check typed and erased one synthetic
unsubmitted marker without Enter: native input worked, no error appeared and
history/dispatch counts stayed unchanged. The backend intentionally remains on
alpha.2 while those original sessions are alive. No public binary was uploaded;
clean-machine onboarding and downloaded-app Gatekeeper checks are still open.


### Alpha.3: daily TUI use and inspectable privacy/usage

New windows default to the native terminal; existing conversation/terminal
preferences remain. In **显示…**, choose a 10–24 point font size and a neutral dark
or green palette. Settings are per window and survive reopening. Returning from
another view restores terminal input focus without replacing the native agent.

Select terminal text and use **复制** or Command-C. If the native program has
enabled mouse tracking, hold **Option while dragging** to select text without
sending those mouse actions to the native program. **粘贴** reads the clipboard on
request, respects bracketed-paste mode and does not append Enter. Multiline paste
is refused when the native terminal has not enabled bracketed-paste protection.
Clipboard operations use the pinned Electron version's asynchronous API.

The shared-task input is now saved per window. Clearing shared history does not
clear this unsent draft; clear the input separately if it is no longer needed.

**隐私与用量** shows local data/sharing boundaries, narrowly scoped dispatch counts,
available native token reports, backend/session state and app/backend versions.
Missing usage is **未报告**, not zero. The panel is not a billing meter, egress
monitor or independent audit. See [how to verify and its limits](privacy.md#inspecting-privacy-and-usage).

The visible source-app check passed settings/shared-draft persistence across
normal reopen and UI crash, terminal focus, unchanged native identities, invalid
preference rejection, theme contrast and single-instance behavior. A real idle
Claude TUI received a synthetic two-line Chinese paste without submission;
Option-drag and the Copy button returned exactly the selected marker. Backspace
removed the test input, the original clipboard was restored, both native histories
remained empty and application dispatches remained zero. Oversized clipboard text
was rejected before terminal input. No model task or native teammate was started.
This is not physical IME or broad accessibility acceptance.

The alpha.3 DMG was then mounted read-only and installed into Applications;
all 9,169 file/link entries matched, and the installed app passed ad-hoc signature
verification. The same visible settings/draft/focus, theme and lifecycle checks
passed on that installed copy with both existing native sessions retained. Its
live backend intentionally remained on alpha.2; the runtime/adapter code was not
changed. This is local installation evidence, not internet-download quarantine or
clean-machine onboarding acceptance. No new provider response was requested.

### Earlier installation and recovery checks

- Actual Apple Silicon app launch with a system-only PATH and no external Node/npm
  required by the shell; DSH client modules and setup screen rendered.
- Duplicate app launch exited while the existing single window/host remained.
- Prior synthetic Codex history resumed with the same native ID and was displayed
  in its native TUI. UI quit/reopen retained backend/native PID, view and draft.
- Forced loss of the owned test service: reconnect kept records/draft/membership,
  paused routing and refused resuming an orphan native process still alive.
- A distinct test app version preserved a live empty Claude session and its draft.
  Only after confirmed native exit did reopening replace the backend version.
- Corrupt host record and deliberately missing client plugin: safe error page,
  then actual retry restored one healthy window. No private launch URL displayed.
- Local removal preserved native/shared history; local checks cover clearing
  shared history and preventing a late reply from repopulating it.

No new model task was sent during these checks. The native recovery/stop actions
used the service control interface; their OS confirmation dialogs were not
mouse-tested. Earlier native reply/Teams evidence is reused within its original
scope; it is not a new active-fleet recovery test.

## Alpha.2 startup corrections

The original DSH integration inherited light text from the system dark theme while
keeping fixed pale panels and buttons. The workspace now uses paired foreground
and background tokens on its sidebar, cards, dialogs and collaboration surfaces.
The rendered contrast check switches both themes and rejects text below 4.5:1;
it caught the original sidebar at about 1.08:1. Background-only button animation
was also removed because it briefly combined the new text with the old background.

The installer walkthrough also exposed a native setup issue: taking more than two
minutes to answer Codex's folder-trust prompt discarded its initialization
callback. Setup now waits for the human decision, releases the creation slot on
terminal exit, and permits canceling that uninitialized terminal. A live terminal
remains viewable when the session reports an error. Local regression checks cover
delayed confirmation and cancellation without issuing a model request.

The installed alpha.2 app was opened through macOS LaunchServices using its normal
data directory. Welcome, setup, creation and collaboration screens passed the
light/dark contrast samples (lowest sampled text ratio above 5.7:1). In the actual
Codex TUI, folder trust was left unanswered for 133 seconds, then confirmed with
the keyboard: the same terminal established its native thread and became ready.
Claude also opened its native terminal. Joining/leaving changed membership while
preserving the processes. These installation checks sent zero model tasks; they
do not replace the earlier three-reply collaboration evidence or prove fresh
provider account setup. Screenshots and native output remain local.

The final DMG was mounted and installed again; its 9,169 file/link entries matched
the installed app and signature verification passed. Reopening kept both native
IDs/PIDs, membership, selected terminal view, drafts and zero dispatches. The
installed app also passed the separate empty-profile lifecycle runner, including
duplicate launch, crash recovery and quitting during load. Only one normal app
window is left open; test-only profiles do not substitute for this live continuity
check. The old app copies are recoverable from Trash; source and native histories
were not deleted.

## Fresh-install walkthrough

A separate 2026-10-17 check cloned the public repository at `df0b749`, used an
empty npm cache and a fresh application data directory, and ran `npm ci` followed
by `npm start` from a real iTerm2 window. No existing project dependencies or
generated UI files were copied into the clone. The actual visible app opened,
showed the prerequisite screen, created one Claude session, and presented its
native folder-trust prompt. After answering that prompt through the terminal,
one bounded synthetic message received its expected reply in both views.

Stopping the source launcher with Ctrl-C and running `npm start` again preserved
the same native session ID/PID, terminal view and unsent Chinese draft. The
dispatch count stayed at one; no tools or teammate activity was observed. The
README now includes download, folder navigation, environment checks and first-use
instructions. This proves a fresh app installation on an already configured Mac,
not installation of provider accounts on a new computer. Node/npm and native
authentication were already available in the normal login shell. Desktop checks
used a local debugging connection; it is not needed by users.

Skipped: full active-fleet recovery and Claude history resume; verify with a suitable
ended synthetic history or a separately bounded native trial.
Skipped: second physical Mac, physical Chinese IME, VoiceOver and complete traffic
audit; add before expanding beyond a technical cohort.
Skipped: signed/notarized distribution and auto-update installation; add with the
maintainer's distribution credentials and a reviewed release artifact.

## Feedback

Report provider/version, affected view, steps and expected behavior with invented
content. Do not attach raw transcripts, account screens, full logs, credentials or
financial/personal information. [Private vulnerability reporting](../SECURITY.md)
is available for security issues. External iTerm2/Terminal integration is a tracked
follow-up, not implemented in this alpha; see [readiness](readiness.md).

## Structured Claude submission

As of 2026-10-18, alpha.5 uses an original session-local mod against Claude Code's
public API, not the agent SDK and not terminal key injection. Tested CLI: 2.1.302.
The bridge accepts 2.1.302+; other versions and disabled/unavailable mods leave
native terminal use available but block graphical sending. Future versions still
need compatibility checks. No provider binary or SDK source is redistributed.

The bridge waits on a private Unix socket; it adds no model call, title, summary,
context replay or TCP listener. It checks the native draft, gets a current local
control/membership grant, checks the draft again and submits the explicit text
with `asUser: true`. That flag preserves provenance without adding a plugin-name
prompt prefix. Graphical input is plain text: native slash commands, attachment
expansion and `@file` behavior belong in the native terminal for now.

Visible Electron + native Claude evidence:

- Unsent synthetic native text blocked direct conversation sends and explicit
  room sharing, preserving both drafts and the native session. These blocked
  attempts created no native model turn.
- The first positive trial revealed incorrect acknowledgement: the native reply
  completed, but the app showed unconfirmed. The native mod test kit reproduced
  that a background call did not re-enter this mod's own submission hook.
  Authorization now runs before the API call. A second positive trial on the
  fresh backend confirmed submitted → complete and cleared only the sent draft.
- Native history contained exactly the explicit prompt, without the private
  draft or an extra wrapper, and one `OK` response in each positive trial.
- The corrected view transition delivered the first key immediately after
  switching to the terminal; the native editor visibly cleared on that key.
- Total live test budget used: two short Sonnet 5.5 low-effort requests, zero
  observed tools/subagents/teammates, zero Codex model requests. No global model
  setting changed. This is not an invoice or a full cost-parity benchmark.

The alpha.5 DMG was mounted read-only and its app copied into Applications.
Ad-hoc signature verification and all 9,174 file/link comparisons passed. The
installed UI reconnected to the same test native session, blocked another draft
collision without a model turn, and preserved the existing user sessions on the
old backend with the legacy-send restriction visible to the UI.

Twenty-four Node tests and two native mod-engine tests passed. The local checks
cover stale grants, timeout/late replies, no replay after reconnect, malformed
socket requests, session isolation, changing drafts, old-backend compatibility,
manual interruption and room departure. An acknowledgement timeout remains
uncertain, never permission to retry. Native prompt hooks chosen by the user may
still transform or reject a prompt, just as they can outside this app.

A UI update keeps an older live backend alive. The updated UI disables that
backend's Claude conversation/room sends and pauses its pending collaboration;
it does not replace native processes. Alpha.8 can create separate new sessions
on the updated backend without ending these. Native history remains under the provider.

Limits: atomic cancellation after native dispatch/queueing, active fleets, Codex
mixed drafts, physical IME/VoiceOver and clean-machine installation are not proved
by these checks. Private screenshots and transcripts are not shipped in Git.

## Conservative automatic handoffs

Alpha.6 records the root reply before checking whether it can be handed off.
Missing, null, malformed or active background/scheduled/fleet counts pause routing;
an unknown or active continuation hook does too. This applies even at the reply
cap. The reply remains in the shared record and its counter reflects that it was
received. Duplicate events and later status observations do not restart routing.

Current Claude and Codex adapters do not provide a complete, authoritative fleet
inventory. They explicitly report it as unknown. Thus current automatic runs
pause after the first root reply; **选择并分享** and **定向发送** remain available.
This is a deliberate restriction, not evidence of unattended multi-agent completion.
No model-based state checker, summary, polling prompt or automatic retry was added.

An updated UI also refuses automatic runs on retained services without this check
and pauses their existing run on reconnection. The service and native identities
stay alive. New sessions can use the updated backend while existing native
terminals remain available. Earlier Claude submission
restrictions on old backends still apply.

Local regressions cover invalid/unknown/active state, the reply cap, duplicate and
unrelated events, persisted shared replies, explicit sharing, and old-service reuse.
A visible Electron run exercised the production daemon, IPC and workspace with
synthetic native transports: pause explanation, retained reply, selecting and
sharing exact text, unchanged session identities, and UI reopen without replay.
These tests made zero native model calls. They do not certify active provider
fleets, native cost parity or the deferred clean-machine installation path.

The alpha.6 DMG was mounted read-only, copied into Applications and verified with
an ad-hoc signature check and 9,174 file/link comparisons. The installed UI passed
the same synthetic handoff workflow. A fresh production backend advertised the
new check without native prompts. The normal profile retained three native
sessions on its older backend; the installed UI blocked automatic runs through
both the button and IPC, with session identities and dispatch counts unchanged.

## Native permission defaults

Alpha.7 stops forcing Claude's permission mode and Codex's sandbox/approval policy
in both conversation and terminal creation. Providers resolve the permissions for
the selected directory from their own configuration and managed requirements.
The app does not edit those files, grant a bypass, or automatically approve a
native tool request. Resume continues through the provider's own resume behavior.

A real Codex 0.163.0 configuration-only check reproduced the previous bug: a
synthetic user configuration requested read-only, but the app's conversation
startup returned workspace-write. After removing the override, the same native
startup returned read-only. No model turn or file operation was submitted.
The locally generated schema still lists an obsolete approval value which this
runtime rejects at startup; schema presence alone is not runtime compatibility.

Visible native terminals in the actual desktop also passed: Claude 2.1.302 kept
the synthetic project's Plan mode, and Codex 0.163.0 `/status` showed Read Only
with zero tokens. The Codex check used an isolated configuration with an unused
local provider; it did not copy credentials or call a model. Both folder-trust
prompts were handled in the terminal for test-owned directories. Sixty-three
local checks passed. This verifies startup configuration, not every native tool's
approval/denial path or managed-policy combination.

Old live backends retain their already-running sessions. Windows block creation
and history recovery through backends lacking the permission-default capability.
Alpha.8 routes new creation to a current backend instead; existing native sessions
remain usable with their actual capabilities.

This is permission inheritance, not a claim of complete native configuration
parity. Session-local observation hooks and the Claude submission mod remain;
Claude teams use in-process display, prompt suggestions are disabled, and the
adapters retain their traffic/analytics suppression settings. Native auto-review,
if selected by native configuration, may itself use a model. The app neither
adds that reviewer nor proves its billing matches a different permission mode.
Shell aliases or custom CLI flags are not automatically imported.

The local alpha.7 DMG passed signature verification and 9,174 file/link comparisons
when copied into Applications. The installed UI refused old-backend creation
through the button and IPC while retaining the three existing native sessions;
a fresh installed backend loaded the new capability and enabled creation without
sending a model task. This was alpha.7's temporary update restriction; the next
section describes alpha.8's separate routing for new sessions.

References: [Codex configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic),
[Codex App Server](https://learn.chatgpt.com/docs/app-server), and
[Claude starting permission mode](https://code.claude.com/docs/en/permission-modes#which-mode-a-session-starts-in).

## Updates with live sessions

Alpha.8 keeps a private routing table for retained services. New sessions go to
the current backend; terminal bytes, drafts, ownership and native actions for
existing sessions go to their original service. No native process or history is
copied, resumed or replayed by the upgrade. The default working directory stays
the same. Each session's actual capabilities remain authoritative: a legacy
Claude session does not acquire safe graphical submission just because another
backend supports it.

One sidebar and shared-room view combine the retained and current sessions.
Joining and leaving still change membership only. Explicit sharing sends only
the selected text to its chosen recipient, subject to that session's guards.
Automatic runs cannot span backend generations; the interface explains this.
Current native fleet uncertainty still pauses same-backend runs after the first
root reply. This is not unattended completion or live fleet migration.

The initial visible upgrade check used an installed alpha.7 window, a live empty
Claude session and then the source alpha.8 window. It retained the native ID/PID,
membership, unsent draft and selected view; created a second native session on
alpha.8; switched both room terminals; detached the older session; routed unsent
terminal text only to that session; and reopened to the same identities with one
window. Both Claude 2.1.302 sessions used Sonnet in Plan mode. No model tasks,
assistant replies or teammates were requested. Synthetic transport checks cover
explicit cross-backend sharing; this run did not submit a real shared model task.

Independent review found and drove fixes for delayed-state cancellation and
backend lifecycle gaps. The final 90 local checks passed, including the real
registered desktop handler with a synthetic Electron transport, cross-window
human intervention, a closed run-origin window, failed publication, version
rollback and delayed shutdown lock release. Full logs and fixes were independently
reviewed; [the issue record](review.md) distinguishes this proof from native
model/fleet evidence.

Updates reuse confirmed ended service slots and retire truly empty inactive
services. Services retaining ended history still remain resident; the six-session
creation limit is not a hard cap on resumed sessions or total backend processes.
A pending routing entry is written before launching a new service, so failed
activation can reconnect it. Shutdown waits for socket, lock and known process
release; timeout refuses replacement. These checks cover process/operation failure,
not sudden power loss or a complete CPU/memory overhead guarantee.


## Renaming a session

Open **⋯** beside a session, or right-click the row, then **重命名…**. The same
menu offers **在独立窗口打开**; opening the menu does not switch or take control
of that session. The field starts with the
current name; save with Enter or the button, or cancel with Escape. Empty names
are rejected and the limit is 60 characters. Duplicate names are allowed without
merging sessions. Names are stored privately on this Mac and survive reopening.

This changes the workspace display name, including the sidebar, member tabs and
other windows. It does not rename the provider's native history or rewrite names
in already-shared messages. No title-generation model call is made. Display
metadata lives above the backend layer, so retained older sessions can be named
without restarting them.

The headed desktop check used two ended native test sessions. It verified
prefill, cancel/Escape, blank validation, trimmed Enter-save, special-character
text, title/sidebar/member-tab updates, second-window synchronization, duplicate
names and reopening. Session identity, messages, drafts, membership and dispatch
counts were unchanged. Storage checks cover failed atomic replacement, retry,
malformed metadata and unsafe file permissions. Physical IME composition and
VoiceOver have not yet been verified.


The alpha.8 DMG was mounted read-only, copied to Applications and verified with
an ad-hoc signature check and 9,177 file/link comparisons. The installed app
retained three live alpha.2 sessions while connecting a current backend for new
sessions. Renaming one retained live session, reopening with its new name and
restoring the original name passed. Original IDs/PIDs, membership, message counts,
dispatch count and saved view remained unchanged; no native model prompt was sent.
This is local installation evidence, not public-download/Gatekeeper or clean-Mac
setup acceptance. The binary remains unnotarized and was not uploaded.

Alpha.9 moves rename and independent-window actions into one session-row menu,
available by ⋯ or right-click, using the existing DSH menu component. Headed
source and installed-app checks cover duplicate names, an unselected target,
mouse/keyboard opening, repeated-trigger closing, Tab/Escape/outside dismissal,
focus across a state broadcast, name validation, another window, room names,
long-label layout, both themes and reopening. The menu's initial portal-focus
failure was reproduced and fixed before this passing result. The fixtures are
synthetic ended records; no provider prompt or native session was created.

The alpha.9 DMG was mounted read-only, copied to Applications, and matched across
9,177 files/links plus the generated UI bundle; its ad-hoc signature verified.
The installed app also opened a menu on an unselected existing live session and
canceled renaming: all three retained sessions kept their native IDs/PIDs,
membership, history counts, labels and current view, with no additional dispatch.
The native terminal did not steal menu focus. This remains local-app evidence;
physical IME/VoiceOver, clean-Mac setup and public-download acceptance are separate.

Alpha.10 fixes a reproduced GUI draft-loss race. If a person retypes the same
text while a previous send awaits acceptance, the late reply no longer clears
the newer visible or recovery draft. The service's existing revision guard is
now preserved through the desktop IPC and renderer. Both provider labels passed
headed source and installed-app checks for identical/whitespace edits, failure,
session switching, unchanged-draft clearing and UI reopen. These checks use a
delayed synthetic provider transport with real DSH UI, IPC, service and storage;
they make no model calls and do not establish native TUI event ordering.

The initial full suite exposed a cleanup race in an existing shutdown test:
after confirming shutdown, it reconnected before the daemon deleted its socket
record. A diagnostic delay reproduced failure after the actual shutdown/rejection
assertions passed. Cleanup now waits for that owned process and its files to exit,
without hiding connection errors. The delayed check and final 90/90 suite passed.

The alpha.10 DMG was mounted read-only and copied to Applications; 9,177 file/link
entries, key modules and generated UI matched, with ad-hoc signature verification.
The installed app retained all three existing sessions' native IDs/PIDs, history,
drafts, names, membership and selected view, with no additional dispatch and one
window. Clean-Mac installation and downloaded-app Gatekeeper remain unverified;
this local unnotarized binary has not been uploaded.


## Codex mixed input and human takeover

Alpha.11 fixes a reproduced native concurrency defect: when a person steered an
active GUI task from Codex's terminal, the provider received that new input but
this app omitted it from the conversation view. The adapter now identifies its
own input echo with `clientUserMessageId` and correlates answers/completion by
native turn ID. Other native user inputs remain visible, including identical text
with a different identity. An uncertain acknowledgement is never retried.

Native human input changes the control revision. A directed shared task whose
control or membership changed cannot automatically return its answer to the room;
the answer remains in the original session, and the shared request says
**分享已失效，回复保留在原会话**. This is a local routing boundary, not erasure of
content already sent or a restriction on native tools and external clients.
Directed sharing and interrupt preserve the current terminal/conversation view.

A headed Electron/DSH check with Codex CLI 0.163.0 and GPT-6 Luna low verified an
unsent terminal draft surviving explicit GUI submission. After the fixes, one
shared GUI task and one terminal steering input occupied the same native turn;
each appeared once in the conversation, the native identity stayed unchanged,
and the private reply did not enter the shared record. Raw native events, native
history and application snapshots agree. This is one bounded steering scenario,
not complete native concurrency/fleet or physical IME/VoiceOver coverage.

The investigation used seven actual native user submissions across five turns,
including a failed steering attempt caused by the view-switch defect; no native
subagent activity was observed. The native session reported 200,754 total tokens,
including 179,840 cached input tokens and 1,256 output tokens. These are cumulative
provider-reported counters, not a bill or proof of equal-task cost parity. The
wrapper added no title, summary or model-routing calls. Model testing stopped
once the required evidence was obtained.

Local protocol checks cover completion before/after acknowledgement, late unrelated
turns, unknown client identity and uncertain acknowledgements. Shared-workspace
checks cover takeover, view/device events and actual Claude hook/interrupt methods: a
Claude root Stop without a tag still releases GUI input. Independent review caught
that compatibility regression before native retesting. An initial test fixture
accidentally constructed two Claude terminals, then failed before any prompt; it
was corrected to use the adapter prototype without starting the CLI. Failed logs
are retained privately and are not counted as passing evidence. The final local
suite passed 102/102 with no skips.

The `nativeInputIsolation` capability describes these backend semantics. Older
retained services keep their native sessions and TUI. The new UI blocks Codex GUI
sends and directed/automatic sharing to a backend without this capability; older
Claude solo GUI sends still depend on `structuredClaudeSubmit`. Users can select
content from an old session and share it with a capable new receiver. Both sharing
entry points explain the restriction and retain drafts. Startup pauses unsafe old
automatic routing without stopping native work. Already accepted old directed
tasks retain the old backend's semantics; a UI update cannot retrofit that memory.
The headed source check covered both sharing entry points with synthetic services,
without provider/model calls.

The alpha.11 DMG was mounted read-only and copied to Applications. All 9,177
file/link entries, affected backend modules and the generated UI matched; ad-hoc
signature verification passed. The installed app passed the same two sharing-entry
checks with synthetic services and no model calls. It also retained the maintainer's
three existing native sessions, IDs/PIDs, history, drafts, labels, membership and
selected view, with no additional dispatch. These existing sessions had no pending
submission or automatic run at the baseline check. This is local installation
verification, not fresh-Mac or public-download/Gatekeeper acceptance; no binary was
uploaded.

Normal LaunchServices reopening and app activation showed one visible workspace
window. Preserved native services are separate from additional UI instances.

## Two native agents in one shared workspace

On installed alpha.11, a human-directed room task asked Claude Sonnet to read a
synthetic file containing two sections, with sizes 2 × 7 and 3 × 2. Its native
Read record contains that file, but its answer was `TOTAL=23`. The test retained
that incorrect answer; it did not retry or alter it. Using the shared reply's
“选择并分享” action, the test sent only that answer and an explicit verification
instruction to the existing Codex Luna session. Codex's native command record
shows it reading the same file in the same real directory and answering
`VERIFIED=20`. Both original replies appeared in the room.

This was two user tasks, each involving a native tool read, not a claim of only
two model calls. One new Claude task and one additional Codex turn were observed;
there were no native subagent events. Codex received exactly the selected text
and verification instruction. Earlier private test content remained in its own
native history and did not enter the room or Claude's submitted task.

After the replies, Codex detached and rejoined with the same native identity and
PID. Both unsubmitted terminal drafts, the shared-task draft, messages and the
selected room member survived closing/reopening the UI. Dispatches remained two;
no task was replayed and only one test window was open at a time. This verifies
sequential human-directed cooperation, not unattended completion, simultaneous
file modification, active native teams, or clean-machine installation.

The native counters for this check were 66,261 additional Codex tokens (62,720
cached input, 66 output) and 43,342 Claude tokens across its two recorded model
responses (30,964 cache-read input, 12,247 cache-creation input, 4 other input,
127 output). Counters describe the synthetic test and retained native context;
they are not a bill or proof of cost parity. Provider-internal activity may not
be fully exposed by these records. No further model tasks were used for the UI fix.

The same run exposed a first-mount input defect: a terminal's input surface could
exist before its initial snapshot was applied, and early characters were ignored.
The first draft assertion failed; retrying only the unsubmitted draft after the
view settled succeeded. Alpha.12 adds a visible connection state and gates input,
focus and paste until the current terminal is ready. It does not queue keystrokes
or send them later. Delayed synthetic snapshots reproduced the old readiness gap
and now cover state updates, late completion after changing members, connection
replacement, failure and explicit retry. Failed test logs remain private evidence.

The final alpha.12 DMG was mounted read-only and installed: 9,177 file/link entries
matched, the generated UI matched current source, and ad-hoc signature verification
passed. The installed app passed the delayed-terminal fixture, then reopened the
same two live native sessions on their retained alpha.11 backend. The product
automatically focused each ready terminal; the first unsubmitted suffix reached
its intended existing draft. A further UI reopen preserved both drafts, native
IDs/PIDs, histories, shared draft and selected member, with dispatches still two.
No paid task was repeated for this frontend-only change. Independent review passed.

The normal profile's three existing native sessions, messages, drafts, labels,
membership and selected view were restored unchanged with no new dispatch. Normal
app activation showed one visible window. The artifact remains a local,
unnotarized build; no binary was uploaded and clean-Mac setup is still unverified.

## Directed sending is the room default

Alpha.13 makes **定向发送** the primary/default form action. It sends only to the
selected member; **开始一轮核查** remains a separate explicit action with the same
three-reply/ten-minute limit and unknown-fleet pause. Enter in the shared textarea
still inserts a newline. There is no new automatic routing or model request.

The composer blocks blank, pending and unavailable-recipient submissions. A late
failure keeps the current draft and does not retry. The selected recipient is
saved alongside the shared draft; reopening restores both. If the recipient has
left, or an older saved draft has no recipient ID, sending stays disabled until
the user selects one. Both the room composer and selected-reply sharing dialog
clear a departed recipient instead of silently selecting someone else.

The old default form failed a one-member headed reproduction. Final source and
installed checks cover exact payload/recipient and dispatch counts, pointer and
keyboard activation, the separate automatic action, unknown-state pause, repeated
submission, late failure, UI reopen, legacy/invalid saved recipients, and removal
from both selectors. Seven synthetic dispatches per successful run, no native
provider processes and no model calls. The actual Electron/DSH interface, IPC,
workspace and storage were exercised; provider transport was synthetic. The
existing nine-group draft regression and 102 local checks also passed, with no
skips. These results do not extend the earlier native fleet/IME coverage.

The final alpha.13 DMG was mounted read-only and installed. All 9,177 file/link
entries matched the mounted app, affected source and generated UI matched, and
ad-hoc signature verification passed. The normal profile's three existing native
sessions retained their identity/PIDs, history, drafts, names and membership,
with no additional dispatch. The original view was restored. Independent review
verified the recipient-loss and restart counterexamples. This is a local,
unnotarized alpha; no binary was uploaded and clean-Mac setup remains unverified.

## Room terminal focus after control acknowledgement

Alpha.14 fixes a reproduced timing gap when opening an already-owned conversation
as a room member terminal: if its terminal snapshot arrived before the control
state, the picture appeared but keyboard focus was not restored. The room view
now waits for acknowledged control state before focusing, and verifies that the
user is still looking at that same member and view. It does not take control from
another owner or start a native session.

A headed reproduction held the actual workspace claim until after the snapshot;
the old code failed to focus after release. Source and installed alpha.14 passed
seven cases: first input after acknowledgement, late acknowledgement after moving
to another member, an open dialog, another session's menu, editing a shared draft,
failed claim with explicit retry, and a simulated intervening owner change. The
original four terminal readiness cases and 102 local checks also passed, without
skips. Electron/DSH, IPC, workspace state and keyboard input were real; provider
transport and the competing owner were synthetic. No native provider processes
or model tasks were started. This does not prove physical IME/VoiceOver or native
permission/fleet concurrency.

The DMG was mounted read-only and installed: all 9,177 file/link entries matched,
affected source and the generated UI matched, and ad-hoc signature verification
passed. This remains a local unnotarized alpha; no binary was uploaded.

The normal profile was reopened after the update. A fresh service connection
confirmed that its three existing native sessions retained IDs/PIDs, full history,
drafts, names, membership and dispatch counters. The saved view and shared
recipient were unchanged, and one normal app window remained visible. Independent
review verified the installed change and closed A12-F1.

## Complete local daily-use checkpoint

Alpha.15 was installed from its local read-only-mounted DMG and checked as one
continuous workflow: setup appearance and themes; solo conversation/terminal
use; invite two sessions; direct a task and share one reply for verification;
detach and continue; rename; repeat launch; quit/reopen with session identity,
private/shared GUI drafts, membership and intended recipient retained. The
privacy/usage panel and compact window were checked in the same run.

The headed check loads the installed renderer, daemon, workspace and Codex
adapter. Provider startup/terminal transport and Claude replies are synthetic:
three exact fixture submissions, zero model requests, one UI window and no page
errors. It does not prove native login, live PTY draft fidelity or model/fleet
behavior. The previously documented native results retain their original scope.
A single test-process resource sample is retained privately as a baseline; it
is not a claim of zero overhead or steady-state cost parity.

The workflow closes two reproduced product defects:

- First Codex terminal attachment previously stopped at 100 items, including
  tool items. The new backend reads pages in ascending order, then merges history
  once by stable item IDs while preserving newer live content. History does not
  simulate user input, trigger a handoff, or overwrite working/approval state.
  A first live human-input notification still takes control even if its message
  already appeared in a history page. Only repeated live notifications are ignored.
- Shared-message attribution now follows current local session names using stable
  sender/recipient IDs. Stored names and message bodies remain unchanged. Old
  directed records without recipient IDs retain their saved labels; identity is
  never guessed from text.

Fifteen added protocol/workspace cases and the full 117-check local suite passed
with no skips. The desktop fixture imports 105 history messages, including a
live overlap, and verifies rendered replies and exact recipient/payload/count.
A separate real Codex CLI 0.163.0 metadata process read a prior synthetic test
record over nine pages, importing 14 unique chat items. Its RPC allowlist permits
initialization and read methods only: no resume, turn/start or model task.
The protocol is documented in [Codex App Server](https://learn.chatgpt.com/docs/app-server#list-thread-items).

When a history item has no live delta watermark, the app shows its snapshot and
waits for the authoritative completed item rather than appending possibly
overlapping deltas. Failed/malformed/cyclic pagination imports no partial history
and leaves graphical sending unavailable; the native terminal remains the way
to continue. A 1,000-page bound also fails explicitly rather than silently
truncating. This change applies to first attachment on the new backend. Existing
retained backends are not hot-patched; cold history recovery remains separate.

All 9,177 installed file/link entries matched the mounted DMG, affected source
and generated UI matched, and the ad-hoc signature verified. After reopening the
normal profile, all three existing native sessions kept their IDs/PIDs, full
history, drafts, names, membership, dispatch counters and saved view. One normal
window remained visible.

Independent review of the installed code, full logs, screenshots and preserved
user state closes this local workflow checkpoint, not the external first-install gate.
The DMG remains unnotarized and unpublished. Exact public artifact review,
download/Gatekeeper and a clean Mac with missing prerequisites remain outstanding.
Physical IME/VoiceOver, full egress audit, equal-task cost comparison and active
fleet/unattended completion also retain their documented acceptance gaps.
