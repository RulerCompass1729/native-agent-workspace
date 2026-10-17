# Shared project instructions

This file is shared by Claude Code and Codex. `AGENTS.md` points to this file.

Read `README.md`, `docs/product.md`, and `docs/readiness.md` before changing scope.
The current phase is preparation. Do not present planned integrations as working
features, install provider runtimes, or start paid model runs as a side effect of
editing these documents.

## Architectural invariants

- Native session identity and lifecycle are independent of rooms and windows.
- Joining/leaving changes collaboration membership, not native process identity.
- Never implement a GUI/TUI toggle by silently launching a second agent.
- Preserve Claude Agent Teams and Codex native fleet behavior; ordinary SDK
  subagents are not an equivalent substitute.
- Human control, private sharing scopes, and no hidden model calls are requirements.
- Provider-specific capabilities may extend the interface. Do not force every
  provider into a lowest-common-denominator runtime or silently drop events.
- Do not infer delivery, completion, cancellation, or fleet termination from a
  successful enqueue, process write, or top-level interrupt alone.

## Evidence and public boundaries

- Read actual implementation files before making source-level claims.
- Label requirements, design proposals, source findings, and runtime proof separately.
- Keep third-party code, assets, runtime dependencies, and provider binaries out
  until their exact provenance and terms have been reviewed and recorded.
- Keep credentials, native session files, private research, personal filesystem
  paths, and raw debugging exports outside Git.
- Before every commit, scan staged content with gitleaks and the maintainer's PII
  rules. Before every push, also scan all outgoing commits, patches, authors, and
  commit messages. Review findings before publishing.
- Never upload private task content for analytics or error reporting by default.
- Keep provider credentials under their native authentication mechanisms.

Use only checks appropriate to the changed surface. Documentation checks do not
prove runtime compatibility. Record untested requirements explicitly.
