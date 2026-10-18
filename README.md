# Native Agent Workspace

**Working repository name. Product name is still being explored.**

A desktop workspace where people can use their existing agents individually or together, without rebuilding their habits around an orchestration tool.

The central idea: **a native agent session has its own life. It can join a collaboration, leave it, and keep working.** A conversation view, terminal, window, and collaboration membership are different things.

Initial target: macOS, Claude Code + Codex + a human. Windows, Linux, and additional agents remain architectural extension points.

## Status

This is a **macOS source alpha** for a small technical trial. It supports native Claude Code and Codex sessions, conversation/terminal views, joining and leaving a shared room, and bounded handoffs. Real native replies and UI restart checks have passed; this is not yet a signed installer or a production compatibility guarantee. See [tested behavior and limits](demo.md).

Claude conversation/room sends now use its native structured submission API,
with a draft check and no terminal paste/Enter injection. This requires Claude
Code 2.1.302+ and enabled session-local mods. An older retained backend keeps its
native sessions available, while the new UI blocks its unsafe Claude send path.
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

5. In the window, open **检查安装与版本**. Then choose **新会话**, your provider,
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

After an update, new sessions use the current backend while existing sessions
keep their original processes. Both appear in the same workspace. Older sessions
retain their actual capability restrictions; see [update continuity](docs/alpha.md#updates-with-live-sessions).

Next time, open a terminal in the same project folder and run `npm start`; you do
not need to run `npm ci` again unless dependencies changed. Keep the project folder
while its source-launched sessions are running. Quitting the interface leaves
those native sessions running; see [how to stop or fully exit](docs/alpha.md).

Use **加入协作 / 脱出协作** to change membership without replacing the native session.
Inside **共同工作**, switch between **共享记录** and each member’s original terminal;
**参与者…** manages invitations, and **暂停交接** remains visible. Detaching returns
to independent use of that same session. **开始一轮核查** has a ceiling of three replies within ten minutes. Automatic handoffs require complete native background/team status. Current adapters cannot certify this, so a run pauses after its first reply; use **选择并分享** or **定向发送** to continue with human control. A reply limit does not mean the task or its descendants finished. Native tools and teammates can incur their own usage. Quit/reopen the UI to return to live sessions while the local service remains running. After service loss, records and drafts remain available and an explicit action can resume native history. This does not restore a live fleet or replay an interrupted task.

`npm test` runs local regression checks without model calls. `npm run test:desktop` runs a visible UI lifecycle check without sending prompts; it reuses a single private test profile and refuses a second test runner. See [test policy](docs/testing.md).

## Local macOS app build

`npm run package:mac` produces an Apple Silicon `.app`, drag-to-install `.dmg`,
and zip in `dist/`, using
Electron Packager and a clean production dependency tree. The app itself does not
need a separate Node/npm installation; native CLI and Python prerequisites remain.
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
