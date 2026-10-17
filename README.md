# Native Agent Workspace

**Working repository name. Product name is still being explored.**

A desktop workspace where people can use their existing agents individually or together, without rebuilding their habits around an orchestration tool.

The central idea: **a native agent session has its own life. It can join a collaboration, leave it, and keep working.** A conversation view, terminal, window, and collaboration membership are different things.

Initial target: macOS, Claude Code + Codex + a human. Windows, Linux, and additional agents remain architectural extension points.

## Status

This is a **planning repository**, not an installable application. It contains product requirements, interaction proposals, architecture decisions, source-backed comparisons, and implementation gates. No agent integration, native session migration, or performance claim has passed runtime acceptance yet.

DeepSeek Harness is the first integration candidate. This repository is independent; it does not currently contain or depend on DeepSeek Harness or competitor implementation code.

## Start here

| Document | Purpose |
| --- | --- |
| [Product](docs/product.md) | Confirmed requirements, boundaries, and what success means |
| [Interaction](docs/interaction.md) | Solo use, collaboration, moving sessions, and taking control |
| [Architecture](docs/architecture.md) | Session ownership, native adapters, routing, privacy, and recovery |
| [Foundation decision](docs/foundation.md) | What to reuse from DeepSeek Harness and what remains unproved |
| [Competitors](docs/competitors.md) | Relevant overlap and focused reference products |
| [Licensing](docs/licensing.md) | Upstream permissions, commercial use, attribution, and open decisions |
| [Naming](docs/naming.md) | Naming directions; no brand selected or cleared |
| [Preparation and next steps](docs/readiness.md) | Current deliverables and the first technical proof |
| [Source register](docs/sources.json) | Dated evidence and pinned source references |

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

The license for this repository's original material is **not yet selected**. Public visibility does not constitute an Apache-2.0 or MIT grant. See [COPYRIGHT](COPYRIGHT) and [licensing](docs/licensing.md).

Provider names identify intended compatibility. This project is not affiliated with, endorsed by, or an official product of Anthropic, OpenAI, or DeepSeek. Their software, services, and brands retain their respective terms.
