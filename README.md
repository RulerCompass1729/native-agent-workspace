# Native Agent Workspace

**Working repository name. Product name is still being explored.**

A desktop workspace where people can use their existing agents individually or together, without rebuilding their habits around an orchestration tool.

The central idea: **a native agent session has its own life. It can join a collaboration, leave it, and keep working.** A conversation view, terminal, window, and collaboration membership are different things.

Initial target: macOS, Claude Code + Codex + a human. Windows, Linux, and additional agents remain architectural extension points.

## Status

This is a **macOS source alpha** for a small technical trial. It supports native Claude Code and Codex sessions, conversation/terminal views, joining and leaving a shared room, and bounded handoffs. Real native replies and UI restart checks have passed; this is not yet a signed installer or a production compatibility guarantee. See [tested behavior and limits](demo.md).

The interface runs on a pinned, UI-only DeepSeek Harness composition, with this project's client plugin inside Electron. Persistent native processes belong to a separate local service. There is no intermediate DeepSeek model call. This is an independent project, not an official DeepSeek distribution.

## Run locally

Use macOS with Node.js 22.19+ on the 22.x line or Node.js 24+, Python 3, and your existing native Claude Code/Codex installation and sign-in.

```sh
npm ci
npm start
```

Choose **新会话**, a provider, a working folder, and **原生终端** or **对话**. The native terminal handles first-time trust/login. For a new Codex terminal session, complete the first message there before using the conversation view. No model prompt is sent merely by opening the workspace.

Use **加入协作 / 脱出协作** to change membership without replacing the native session. **开始一轮核查** permits up to three replies within ten minutes; native tools and teammates can incur their own usage. Quit/reopen the UI to return to live sessions while the local service remains running. After service loss, records and drafts remain available and an explicit action can resume native history. This does not restore a live fleet or replay an interrupted task.

`npm test` runs local regression checks without model calls. `npm run test:desktop` runs a visible UI lifecycle check without sending prompts; it reuses a single private test profile and refuses a second test runner. See [test policy](docs/testing.md).

## Local macOS app build

`npm run package:mac` produces an Apple Silicon `.app` and zip in `dist/`, using
Electron Packager and a clean production dependency tree. The app itself does not
need a separate Node/npm installation; native CLI and Python prerequisites remain.
The local artifact is ad-hoc signed, not notarized or automatically published.
See [alpha trial instructions](docs/alpha.md) for startup, recovery and limits.

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
