# Native Agent Workspace

**Working repository name. Product name is still being explored.**

A desktop workspace where people can use their existing agents individually or together, without rebuilding their habits around an orchestration tool.

The central idea: **a native agent session has its own life. It can join a collaboration, leave it, and keep working.** A conversation view, terminal, window, and collaboration membership are different things.

Initial target: macOS, Claude Code + Codex + a human. Windows, Linux, and additional agents remain architectural extension points.

## Status

This is a **preparation repository**, not an installable application. It contains product requirements, interaction proposals, architecture decisions, source-backed comparisons, implementation gates, and local publication safeguards. No agent integration, native session migration, or performance claim has passed runtime acceptance yet.

DeepSeek Harness is the first integration candidate. This repository is independent; it does not currently contain or depend on DeepSeek Harness or competitor implementation code.

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
