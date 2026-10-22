# Native Agent Workspace

**Working repository name. Product name is still being explored.**

A desktop workspace where people can use their existing agents individually or together, without rebuilding their habits around an orchestration tool.

The central idea: **a native agent session has its own life. It can join a collaboration, leave it, and keep working.** A conversation view, terminal, window, and collaboration membership are different things.

Initial target: macOS, Claude Code + Codex + a human. Windows, Linux, and additional agents remain architectural extension points.

## Status

This is a **macOS source alpha** for a small technical trial. It supports native Claude Code and Codex sessions, conversation/terminal views, joining and leaving a shared room, and bounded handoffs. Real native replies and UI restart checks have passed; this is not yet a signed installer or a production compatibility guarantee. See [tested behavior and limits](demo.md).

Alpha.70 repairs retained Claude output recovery when the whole app closes with
input queued. The same native process keeps working; reopening restores buffered
input and output without resending the task or restoring expired sharing grants.
Source and installed native verification pass, including upgrading the previous
released hook while preserving customized copies. Exact recovered input confirms
its shared receipt; replies with expired sharing remain reachable in the original
session through the existing session link.

Alpha.69 extends the same retained Claude native waiting queue to its shared
composer. The room distinguishes waiting from native acceptance; only the queued
instruction's verified reply is shared, preserving prior private work and drafts.
Shared waiting now preserves the already-public running reply until its native
boundary. Moving one member no longer freezes another member’s stream. Source
checks pass for both new and retained connections, and the installed retained
workflow passes. Force-send and full native parity remain open.

Alpha.68 repairs working-turn input for retained Codex connections and extends
its existing native steering path to the shared composer. Only newly attributed
native items enter the room; old private items do not. Late native acknowledgements
and saved-draft cleanup have explicit regressions. Source and installed native
checks pass independent review; this is not forced interruption or a second native turn.

Alpha.67 applies the same explicitly addressed shared-reader behavior to retained
Codex 0.163.0 connections. It preserves the loaded native thread, history, settings
and process; permission/private-input boundaries stop further sharing. A completed
tool keeps its completion status while explaining a later sharing stop. Source
and installed native checks pass; full native parity remains open.

Alpha.66 brings explicitly addressed replies from inspected retained Claude
2.1.302 sessions into the shared main reader. Native text, tools and completion
update in attributed blocks; original private history is not automatically shared.
Permission waits, private input and departure stop further sharing. No extra
model call or terminal panel is added. Source and installed evidence pass independent review. Full native parity remains open.

Alpha.65 adds solo waiting input to those retained Claude sessions, preserving the
current task and newer drafts. Native and installed checks verify the queued text
only enters the next request once. It does not add force-send or retained room
waiting.

Alpha.64 connects inspected retained Claude 2.1.302 sessions to the main reader:
accepted input, display batches and tool text use the original native process.
Dual-window, reopen and ended-history native checks pass in source and installed
builds. Alpha.59–63 also add Claude waiting input, Codex shared steering and
independent recipient sending. Complete native transient-state parity and Claude
force-send remain open; see the current [readiness](docs/readiness.md) and
[testing boundaries](docs/testing.md).

Alpha.58 adds working-turn input for Codex 0.163.0 when its native turn identity
is known. It steers that existing turn, preserves drafts, and stops prior room
sharing before private instructions. Actual native/Electron and installed retained
checks pass; Claude queue/force-send and shared working input remain open.

Alpha.57 adds reply threads inside that same shared reader, with member trajectory
filtering and preserved discussion drafts. Source and installed interaction checks
pass. It also fixes a blank page after repeated startup, verified against the
original retained profile without restarting native sessions. Working-turn input
and complete native-state mapping remain open.

Alpha.56 replaces terminal-camera panels with native content in the
main reader. Authorized shared replies stream as attributed message blocks;
expand a sent message to inspect its recipients and exact payload. Retained
Codex history and live text/tool updates reuse the original connection. Source
checks and installed reader/quiet-reopen checks pass. This does not yet cover every
native transient state or working-turn input. See [evidence](docs/testing.md).

Alpha.55 preserves expanded running results and their reading position when
switching sessions, GUI/TUI views or collaboration membership. A newer reading
gesture wins over a delayed restore. This adds no agent request or sharing;
temporary process records remain bounded and are not a persistent archive.

Alpha.54 adds Claude's stored intermediate response text and textual tool results
to the existing private **运行记录**, alongside its live native terminal. It does
not share that content or call another model. Observation remains bounded and
volatile; see [coverage and limits](docs/live-progress.md#alpha54-native-claude-message-observation).

Alpha.51 shows when shared input is awaiting confirmation and lets you cancel a
waiting exchange without losing its draft. It does not claim to cancel tasks
already accepted by an agent. See [waiting and cancellation checks](docs/testing.md#visible-waiting-and-cancellation--alpha51).

Alpha.50 keeps automatic events from unrelated sessions from interrupting a
selected collaboration. Late send failures apply to their original exchange;
explicit human controls retain priority. See [six-session checks](docs/testing.md#six-session-independence--alpha50).

Alpha.49 adds **新会话 → Codex → 继续已有 Codex 会话…** for explicitly
selected, stopped native history. It retains the original ID and settings;
selecting a known or locally archived session opens its existing record. This
path currently supports the verified Codex 0.163.0 server, not live outside
attachment or external Claude history. See [entry evidence and limits](docs/native-session-entry.md).

Alpha.47 enforces the finite exchange deadline before native delivery and reply
sharing. Closing the window preserves an explicitly authorized exchange; expiry
stops further handoffs while retaining late results privately. This does not
cancel accepted native work. See [bounded-away evidence](docs/acceptance/bounded-away.md).

Alpha.46 improves the path from a paused collaboration to its original session:
use **查看会话**, inspect the private result and choose what to share. Shared
notes and local search keep decisions available without another model call.
See [graphical workflow evidence and limits](docs/acceptance/everyday-workflow.md).

Alpha.44 adds **文件…** in conversation and shared views: preview a local UTF-8
text material, explicitly add it to a draft, or save an exact result copy. **一起核查…**
lets you select and order 2–6 independent sessions on a capable shared backend,
with at most six replies. Joining does not share private history or start work.
An installed three-session calculation/check/file task passed; native permissions
can still pause automatic sharing. See the [workflow evidence and boundaries](docs/acceptance/desktop-workflow.md).

Alpha.22 passes the controlled local daily single-conversation acceptance,
including visible macOS System Pinyin/WeChat input, terminal controls and reopen
continuity. See [evidence and limits](docs/alpha.md#alpha22-single-conversation-os-acceptance).
Alpha.23 adds a tested core workflow: `@` recipient selection, explicit bounded
reply exchange, shared notes, detach/continue and archive/reopen. The local DMG
also passed Safari download, app-specific Gatekeeper approval and prerequisite
setup in an isolated macOS guest. See the [core acceptance and boundaries](docs/core-milestone.md).

Alpha.24 adds private live native output and bounded tool/rewind records in both
solo and collaboration views. Viewing does not open another agent or send context.
Old live backends retain their existing capabilities; this is not seamless active
backend migration. See [native visibility and its limits](docs/live-progress.md).

Alpha.26 adds explicit input connections for inspected retained Claude/Codex
sessions, preserving their native identities. Both can receive a selected shared
message; replies from these older backends require human selection before sharing.
Codex conversation/room previews reuse its existing terminal instead of launching
another agent. See [retained-session evidence](docs/testing.md#retained-session-continuity--alpha26).

Claude conversation/room sends now use its native structured submission API,
with a draft check and no terminal paste/Enter injection. This requires Claude
Code 2.1.302+ and enabled session-local mods. An older retained backend keeps its
native sessions available, while the new UI gates sends by each backend’s actual
capabilities. Alpha.11 also preserves Codex terminal steering messages and prevents
a human takeover reply from being returned automatically to an old shared task.
See [verified behavior and remaining limits](docs/alpha.md#structured-claude-submission).

The interface runs on a pinned, UI-only DeepSeek Harness composition, with this project's client plugin inside Electron. Persistent native processes belong to a separate local service. There is no intermediate DeepSeek model call. This is an independent project, not an official DeepSeek distribution.

## Run locally

This source alpha currently needs a terminal for installation. There is no public
one-click installer yet. You only need **one** supported agent to start.

1. Install [Node.js](https://nodejs.org/en/download) (22.19+ on 22.x, or 24+),
   [Python 3](https://www.python.org/downloads/macos/), and either
   [Claude Code](https://code.claude.com/docs/en/setup) or
   [Codex CLI](https://developers.openai.com/codex/cli/). Complete that agent's
   own sign-in. This app does not create a provider account for you.
2. Open Terminal or iTerm2 and check the prerequisites:

```sh
node --version
npm --version
python3 --version
```

If a command is not found, finish its installation and open a new terminal before
continuing. On macOS, a developer-tools installation prompt is not confirmation
that Python is already available.

3. Download this repository. With Git installed:

```sh
git clone https://github.com/RulerCompass1729/native-agent-workspace.git
cd native-agent-workspace
```

Alternatively, use GitHub's **Code → Download ZIP**, extract it, type `cd ` in your
terminal, drag the extracted folder into the terminal, then press Return.

4. Inside that folder, install and start:

```sh
npm ci
npm start
```

The first run needs network access to download dependencies and Electron. Wait for
installation to finish before starting. If npm says it cannot find `package.json`,
you are outside the extracted/cloned project folder. No GitHub login is required
to download this public source.

5. In the window, open **检查安装与版本**. It discovers conventional installation
   locations without running a login probe. **选择已有程序…** handles custom locations;
   **自动查找** resets that choice. After installing a missing prerequisite, select
   **重新检查**. Then choose **新会话**, your provider,
   a working folder (or keep the empty default), and **原生终端** or **对话**.
   If the session says **正在启动**, switch to **原生终端** to check for the native
   folder-trust or login prompt. Read and answer it there; the app does not approve
   it for you. Return to **对话** when the session is ready and send your first message.

For a new Codex terminal session, complete the first message there before using
the conversation view. No model prompt is sent merely by opening the workspace;
messages you send use your provider's own plan or billing.

New sessions inherit native permission defaults for their working directory.
Open **⋯** beside a session, or right-click its row, then choose **重命名…**
to change its local display name. The same menu offers **在独立窗口打开**.
The sidebar, room tabs and other windows update together. The name
is saved on this Mac; renaming does not call a model or change native history.

Use **查找会话与记录** to find loaded conversations or shared records on this Mac.
**⌘F** scopes the search to the current conversation or shared timeline; optionally
include archived records. Opening a result does not restore an archive or send its
content. **返回查找前的位置** returns to the original reading position and filters.
Queries are temporary; drafts and raw terminal frames are not searched.

After explicitly disconnecting a Codex session on a current backend, select
**继续原生会话** to reconnect the same thread and sync its history. This does not
start a model turn, override native settings or resume earlier collaboration.
Records and drafts stay intact if the connection needs another attempt.

After an update, new sessions use the current backend while existing sessions
keep their original processes. Both appear in the same workspace. Older sessions
retain their actual capability restrictions; see [update continuity](docs/alpha.md#updates-with-live-sessions).
If graphical sending is unavailable, use **打开原生终端** in the composer.
The saved draft stays in the conversation; it is not pasted or sent automatically.

Next time, open a terminal in the same project folder and run `npm start`; you do
not need to run `npm ci` again unless dependencies changed. Keep the project folder
while its source-launched sessions are running. Quitting the interface leaves
those native sessions running; see [how to stop or fully exit](docs/alpha.md).

Use **加入协作 / 脱出协作**, or drag a session into the workspace and a member back
to the session list, without replacing its native identity. Inside the workspace,
switch between **共享记录** and each member’s original terminal. Type **@** to
choose one specific recipient; duplicate names show the provider and short ID.
The visible recipient controls delivery; pasted @ text does not broadcast a task.
Enter sends, Shift Enter inserts a newline. Search and member filters only change
what you read, never the recipient. Shared messages and confirmed membership
changes form a local timeline; old events are not invented retroactively.

The sidebar separates **会话** from **协作空间**, with archive and setup tools below.
A collaborating agent still appears in the session section for individual use.

The workspace **⋯** menu supports rename and archive. Session menus also support
archive. **归档** in the sidebar restores the same records. Session archive detaches
it; room archive pauses routing and detaches its members, preserving its name,
messages and notes. Restore reconnects saved membership except separately archived
or missing sessions. No task is replayed and no native process is stopped by
archiving. Native work may continue; the archive list exposes reported state.
The alpha still has one shared workspace, not multiple independent rooms.

**共享笔记** stores human-edited goals and decisions locally, including saved versions
in the timeline. Saving does not notify a model. **附上背景…** previews only the room
name, current roster and those notes, then inserts editable text into the room
draft. In a solo session, **会话与原生团队 → 带上协作背景…** offers copy for explicit
paste. Only sending that text gives it to the native agent and uses context tokens;
leaving does not erase what an agent already received. There is no automatic
summary, background notification turn or private-history replay.

The default **发送** action sends only to the selected member. The draft and recipient survive reopening; if the
recipient is no longer available, choose one explicitly before sending.
Use **一起核查…** under the composer’s **⋯** to preview the task and participants,
choose 2–6 replies (default 3), and explicitly authorize transferring this round’s
replies when native descendant state is unknown. A ten-minute deadline stops
later handoffs. Human input, membership or permission changes, known native work,
repetition, failures and limits pause or end the exchange. It never automatically
retries. This is bounded reply exchange, not a guarantee that any arbitrary goal
or all native descendants have finished. Native tools and teammates incur their
own usage; stopping handoffs does not terminate them or cap their bill.

Quit/reopen the UI to return to live sessions while the local service remains
running. After service loss, records and drafts remain available and an explicit
action can resume native history. This does not restore a live fleet or replay an
interrupted task.

`npm test` runs local regression checks without model calls. `npm run test:reading` checks selection, scrolling and reading recovery with synthetic output in the actual hidden application. `npm run test:desktop` checks the hidden Electron lifecycle without sending prompts; it reuses a single private test profile and refuses a second test runner. Visible desktop and physical input acceptance remain separate checks. See [test policy](docs/testing.md).

## Local macOS app build

`npm run package:mac` produces an Apple Silicon drag-to-install `.dmg`
and zip in `dist/`, using
Electron Packager and a clean production dependency tree. The app itself does not
need a separate Node/npm installation; native CLI and Python prerequisites remain.
The `.app` is staged temporarily and included inside those archives; it is not
left as a second launchable copy in `dist/`. Keep the daily app in `/Applications`.
Test and rollback copies stay outside application search, with tests hidden by default.
The local artifact is ad-hoc signed, not notarized or automatically published.
See [alpha trial instructions](docs/alpha.md) for startup, recovery and limits.
The DMG contains the app and an Applications shortcut. It removes Git/npm from
the user's installation path, but does not install Python or provider runtimes.
The current trial uses the free, unnotarized route. A downloaded copy can trigger
Gatekeeper and may need an app-specific **Open Anyway** confirmation; managed Macs
may block it. Developer ID signing/notarization is a later distribution option,
not a prerequisite for building this DMG. No public binary is published yet.

## Start here

| Document | Purpose |
| --- | --- |
| [Product](docs/product.md) | Confirmed requirements, boundaries, and what success means |
| [Interaction](docs/interaction.md) | Solo use, collaboration, moving sessions, and taking control |
| [Architecture](docs/architecture.md) | Session ownership, native adapters, routing, privacy, and recovery |
| [Foundation decision](docs/foundation.md) | What to reuse from DeepSeek Harness and what remains unproved |
| [Competitors](docs/competitors.md) | Relevant overlap and focused reference products |
| [Licensing](docs/licensing.md) | Apache-2.0, attribution, commercial use, and upstream boundaries |
| [Naming](docs/naming.md) | Naming directions; no brand selected or cleared |
| [Preparation and next steps](docs/readiness.md) | Current deliverables and the first technical proof |
| [Native continuity experiment](experiments/native-continuity/README.md) | Runnable diagnostic and the limits of the first runtime evidence |
| [Source register](docs/sources.json) | Dated evidence and pinned source references |
| [Publication safeguards](docs/publication.md) | Local commit/push checks and contributor setup |
| [Privacy requirements](docs/privacy.md) | Data boundaries and conditions before an application release |
| [Review and issue record](docs/review.md) | User feedback, independent findings, fixes and remaining evidence gaps |
| [Security reporting](SECURITY.md) | Report a vulnerability without posting sensitive data publicly |

## Product commitments

- A complete single-agent experience comes first; collaboration is optional.
- Preserve native runtime identity, permissions, context, and supported native fleets.
- GUI and terminal views should address the same native session.
- Human intervention takes precedence over queued collaboration.
- Share deliberately; joining a room does not broadcast private histories.
- No hidden model calls for routing, titles, summaries, or polling.
- Mouse, keyboard, Chinese input, and accessibility are core interaction requirements.

These are acceptance requirements, not claims about a finished product.

## Rights and independence

Except where otherwise noted, this repository's original material is licensed under **[Apache-2.0](LICENSE)**. Commercial use, modification, and redistribution are permitted subject to its terms. See [COPYRIGHT](COPYRIGHT), [NOTICE](NOTICE), and the [licensing decision](docs/licensing.md).

The license does not generally grant rights to product names, trademarks, or logos; see Section 6. Product naming remains in progress.

Provider names identify intended compatibility. This project is not affiliated with, endorsed by, or an official product of Anthropic, OpenAI, or DeepSeek. Their software, services, and brands retain their respective terms.
