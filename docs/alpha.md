# macOS alpha trial

As of 2026-10-17. Version 0.1.0-alpha.1. Suitable for a small technical trial with
synthetic or low-sensitivity work; not a general consumer release. Product name
is still a working name.

## Start

1. Install and sign in to your own Claude Code or Codex CLI using its official
   native flow. This project does not distribute either provider binary or copy
   their credentials. Install Python 3 as well.
2. For the public source alpha: clone this repository, run `npm ci`, then
   `npm start`. Building requires Node.js 22.19+ on 22.x, or 24+.
3. On an Apple Silicon Mac, `npm run package:mac` builds an app/zip in `dist/`.
   The app uses Electron's bundled Node runtime; no separate Node/npm is needed
   to launch the app. The installed provider may have its own runtime needs.
4. Open **检查安装与版本**, then create a session. The terminal handles native
   folder trust, login and provider-specific controls. Creating a session does
   not send a model task.

The local build is ad-hoc signed, **not notarized**. There is no automatic binary
upload or auto-updater. Do not disable Gatekeeper globally. Before distributing
a downloaded app, review its exact artifact, licensing/provider conditions and
platform signing plan; a successful local build is not that approval.

## Continuing your work

Closing or quitting the interface leaves managed native processes running. Opening
the same application/profile again restores selected session, view and saved draft.
Repeated launch focuses the existing instance. An explicit **独立窗口** is allowed.

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
