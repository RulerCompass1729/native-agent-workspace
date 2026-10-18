# Shared project instructions

This file is shared by Claude Code and Codex. `AGENTS.md` points to this file.

Read `README.md`, `docs/product.md`, and `docs/readiness.md` before changing scope.
The current phase is a local desktop demo built on DeepSeek Harness. Preserve
that foundation and the native session service when improving either GUI or TUI.
Do not present planned integrations as working features, install provider runtimes,
or start paid model runs as a side effect of editing documents.

## Test costs and instances

- Default to checks that do not call a model. Use real Claude/Codex turns only
  when a changed critical native capability cannot be verified locally.
- Reuse an existing passing result when its runtime, adapter, and relevant
  behavior have not changed. Do not repeat marker replies or test both providers
  for an unrelated UI change.
- Before a live test, state the unresolved question, a finite turn/teammate
  limit, and the stop condition. Use the smallest synthetic task that answers it.
  Include native teammate activity when reporting usage; root-turn count is not
  a complete token or cost measurement.
- Stop after the required evidence arrives. No polling prompts, automatic
  retry, extra acknowledgement loops, or fleet tests merely for completeness.
  Unverified capabilities remain explicitly unverified.
- Use the least expensive suitable model available in isolated Codex tests
  (verify current availability/pricing); use Sonnet for Claude tests. Override
  only the test session, never the person's normal agent settings.
- Use one desktop test profile and one test launcher. Repeated launch must
  focus the existing instance; extra windows require an intentional test case.
  Clean up only processes owned by that test, preserving native user sessions.

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
  commit messages, ref names, and annotated tags. Run the local publication guard
  proactively, show its result, and review findings before committing or pushing;
  hooks are a second check. See `docs/publication.md` for the commands.
- Never bypass a publication block, suppress a matching private rule, or switch
  to GitHub API/UI, an archive, a release asset, or another upload path to evade
  checks. A failed or unavailable scan is not a pass. Keep private patterns outside
  the repository and never echo matched values into logs, issues, or comments.
- Treat personal, financial, identity, health, customer, employer, and native
  session data as private. Use synthetic fixtures; do not reuse private research
  or real user conversations in examples, screenshots, or test artifacts.
- Never upload private task content for analytics or error reporting by default.
- Keep provider credentials under their native authentication mechanisms.
- Before adding a dependency or network destination, inspect its telemetry,
  authentication, data handling, and applicable terms. Privacy requirements in
  `docs/privacy.md` are release conditions, not claims that an app is already safe.

Use only checks appropriate to the changed surface. Documentation checks do not
prove runtime compatibility. Record untested requirements explicitly.
