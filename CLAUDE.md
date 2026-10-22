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
- In native command tests, inspect the actual edit line and completion menu
  before pressing Enter. Browser typing completion or IPC acknowledgement is
  not proof that the native command UI has settled. If another command runs,
  stop the owned trial and retain the native evidence; do not retry blindly.
  Portal dispatch counters exclude direct native input. Account for native
  model responses and tool results separately before claiming zero model use.
- For both Claude and Codex, use the least expensive suitable available model
  in isolated tests. Verify current availability/pricing and the selected model
  before sending a task. Never silently fall back to a more expensive default;
  stop the trial if the selected model is unavailable. Override only the test
  session, never the person's normal agent settings.
- Use one desktop test profile and one test launcher. Repeated normal user
  launches focus the existing instance; isolated test launches and their repeated
  launches remain hidden. Extra windows require an intentional test case.
  Clean up only processes owned by that test, preserving native user sessions.
- Keep one daily launchable installed app in `/Applications`. Build bundles are
  temporary; keep distribution/rollback archives, not extra discoverable `.app`
  copies. Do not leave test/backup bundles registered as ordinary applications.
  Verify application-search entries separately from processes and window count;
  removing a duplicate launcher must not stop or migrate native user sessions.
- Installed native tests must start through normal service bootstrap, which
  copies writable provider plugins into the private runtime directory. Do not
  directly fork the signed bundle's daemon for real providers: native plugin
  initialization can generate files beside the plugin. Verify the installed
  bundle's strict signature after native testing, not only before it. Synthetic
  transport fixtures may boot directly when they never initialize a provider.
- Current development preference: the main agent implements and tests directly.
  Keep one independent reviewer at delivery checkpoints; do not delegate coding
  or routine testing again unless requested. Reuse relevant evidence and avoid
  frequent handoffs. This does not resolve model-service capacity errors.

## Architectural invariants

- Before changing primary interaction, information organization, or system
  architecture (including messaging and state synchronization), inspect
  established products, protocols and actual implementations first. Compare their
  fit against the user's native fidelity, usability, privacy and cost requirements.
  For each substantial capability, check current competitors for overlap and
  reusable mechanisms before building. Overlap is not disqualifying; do not
  reinvent a mature mechanism or claim novelty without evidence. Verify source,
  compatibility and license obligations before importing code or dependencies.
  Present material limitations and tradeoffs to the user before implementing a
  new design. Record what is reused, what needs adaptation, and what remains
  unverified. Research or a design proposal is not implementation authorization.
  Do not substitute extra monitoring panels or a newly invented interaction for
  the requested seamless conversation/terminal experience. This gate applies to
  design changes, not routine repairs within an already agreed interaction.

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

- Use an independent reviewer for the affected product path. Maintain
  `docs/review.md` with user feedback, reproduced findings, fixes and evidence;
  review actual source and raw local evidence, not just the author's summary.
  Reuse the reviewer after fixes. Keep private evidence outside this public repo,
  and do not add model tests simply to make a review appear more thorough.

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
