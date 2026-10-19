# Local desktop demo

As of 2026-10-18. The product name is still a working name.

## What to use

Run `npm ci` and `npm start` from this checkout. The app uses installed,
unmodified native agents and their original authentication; it does not install
provider binaries or ask for account tokens. The initial platform is macOS.
Node.js and Python 3 must be installed and discoverable. This is a source demo,
not a signed app download.

1. Choose **新会话**, an agent and a working directory. Start with **原生终端**
   if you prefer the provider's usual interface. Complete native trust/login there.
2. Switch **对话 / 原生终端** to use the same underlying session. A newly created
   Codex terminal session needs its first native message before conversation input
   becomes available; the app does not send a bootstrap model prompt for you.
3. Use **加入协作**, or drag a sidebar session onto **共同工作**. Joining alone
   does not publish its private history. Select material and a recipient to share.
4. With two members, **开始一轮核查** sends the task to the first member, with a
   ceiling of three replies and ten minutes. Current adapters cannot certify
   complete native fleet status, so alpha.6 pauses after the first reply and
   retains it for **选择并分享** or **定向发送**. Automatic continuation requires
   authoritative state; missing information is not zero. Pause or directly
   intervene to stop subsequent automatic handoffs.
   An already delivered task is not recalled. Native teammate/tool usage is extra
   work inside the provider, not bounded by the room's root reply count.
5. **脱出协作** retains the native session. **独立窗口** adds a view; it does not
   start another agent. Only one view controls a session's input at a time.
6. Quit/reopen the interface to return to your view, saved draft and live session.
   The persistent local service keeps native sessions running. Closing a window
   is different from ending a native session.

Use native commands in **原生终端**. Session controls and the native ID are in
**会话与原生团队**. First-time permission requests remain subject to the native
provider; an app room is not an operating system sandbox.

For Claude, **结束这个原生会话…** waits for confirmed exit of the owned main
process. A timeout leaves the session available for inspection/retry; it is not
reported as ended. This does not certify that every native teammate has stopped.
For Codex, **断开本应用连接…** closes this app's terminal and unsubscribes it.
The native server may retain the thread or background work, so the app displays
**已断开 · 原生尚未释放** until native closure is confirmed. Native history is
preserved; disconnecting one session does not kill the shared server.

## Implementation boundaries

- DSH Web profile, UI slots, theme and Markdown are reused through the client
  plugin. Electron provides the desktop window. DSH's model loop does not route
  Claude/Codex conversations.
- A persistent local service owns the original Claude CLI/PTY and the Codex
  app-server/terminal connections. Window and room changes do not own their lifetime.
- The frontend connects to its own loopback UI service; private local sockets
  connect the session service. App metadata/drafts use private local files.
  Original provider credentials stay under provider authentication.
- Titles, routing, polling, restoration and copying selections do not call a
  model. Providers still make their own network requests and may run configured
  native integrations. This is not an offline-agent guarantee.
- Runtime source is copied to a versioned private directory so updating the UI
  does not replace a live native process. Existing services keep their loaded
  version until their sessions end; not every backend fix applies on UI reopen.

## Evidence and limits

| Behavior | Observed result |
| --- | --- |
| Claude and Codex native terminal input and conversation input | Real responses received through both views, with original native identities retained |
| Bounded two-agent handoff | Historical three-reply native check passed before alpha.6. The stricter unknown-state gate now pauses after the first reply; human-directed sharing remains available |
| Join/leave | Native IDs and PIDs unchanged; detached Claude continued independently |
| Claude native team | One named teammate, one claimed/completed shared task, and mailbox exchange observed in native UI/hooks/history; named team creation was unsupported by the tested build |
| Idle team across room changes and UI reopen | Root native ID/PID and captured fleet events retained, terminal view restored, zero additional dispatches; no post-reopen teammate model prompt was sent |
| Duplicate UI launch and explicit extra view | Repeated launch focused the existing app; an intentionally opened second view shared the same native service |
| UI quit, crash, reopening, and quit during loading | Lifecycle regression passed; owned UI host exited, native session/draft/view retained, load cancellation no longer opened a fatal URL dialog |
| Human takeover, pending send, draft recovery and room routing races | Local synthetic regression checks passed; these are not extra native provider trials |
| Stop confirmation | A real empty Claude session transitioned through stopping to ended and its process exited; no prompt was sent. The app button was exercised, with the OS confirmation dialog automated rather than manually mouse-tested |
| Codex disconnect | An empty Codex 0.163.0 thread remained loaded after unsubscribe; the adapter correctly returned disconnected. No model turn was started |

The latest draft/pending-send and stop/failure fixes are covered by local checks.
The empty-session lifecycle checks used a separate new service, closed afterward.
The already
running test session service retains its older runtime snapshot until safe
shutdown; its earlier live results do not prove those newer branches. Reopening
its UI does not hot-patch that service. No redundant paid run was added for that
distinction.

Not yet verified: active Codex fleet migration, every Claude teammate lifecycle,
permission-race behavior across all native tools, external running-session attach,
and screen-reader completeness. Controlled guest System Pinyin and WeChat input
now pass the [alpha.22 acceptance](docs/alpha.md#alpha22-single-conversation-os-acceptance);
other input methods/devices remain unverified. Saved native
Claude history was located, but cross-app history visibility in the providers'
desktop GUIs has not been certified. Claude Desktop Chat and Claude Code are not
assumed to share all sessions.

Machine reboot or session-service failure does not restore live native fleets.
Local app/DMG packaging exists. Public binary delivery, automatic updates, a full
cost/latency parity benchmark and a completed distribution/privacy audit remain
unverified. Unknown usage is not
reported as zero. See [privacy](docs/privacy.md) and [licensing](docs/licensing.md).

## Test without spending model tokens

`npm test` runs local state/lifetime checks. `npm run test:desktop` opens a real
window and checks UI lifecycle without prompts, provider login changes, or new
native sessions. It uses one private test profile and refuses competing runners.
It can briefly open a second view and intentionally crash its own UI process.
If the profile has no selected session, session-specific assertions cannot prove
native continuity. Existing live sessions are retained, not killed by cleanup.

Keep raw screenshots, session IDs, local paths, histories and diagnostics private.
Public results contain synthetic tasks and conclusions, not raw native evidence.
