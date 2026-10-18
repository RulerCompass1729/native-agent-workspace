# macOS alpha trial

As of 2026-10-17. Version 0.1.0-alpha.1. Suitable for a small technical trial with
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

Normal public distribution needs a Developer ID certificate and Apple notarization.
The current machine has no valid code-signing identity. This is a maintainer setup
requirement; users should not need to enroll or run signing commands themselves.
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
confirmed ended, **隐私与数据 → 所有会话结束后完全退出** also stops the local service.
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
