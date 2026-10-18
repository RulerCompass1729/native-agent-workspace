# macOS alpha trial

As of 2026-10-18. Version 0.1.0-alpha.4. Suitable for a small technical trial with
synthetic or low-sensitivity work; not a general consumer release. Product name
is still a working name.

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
it. Do not disable Gatekeeper globally. This downloaded-app path has not yet been
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
directory. A compatible newer frontend reconnects to the existing service; an
active session does not get restarted just to upgrade backend code. The version
screen shows when an older backend is still retained. After **all** native
sessions are confirmed ended, a subsequent launch can replace the backend.
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
