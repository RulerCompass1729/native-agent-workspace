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
  Finish isolated installed tests before normal-profile quit/reopen checks:
  quitting by bundle ID can target an isolated instance of the same application.
- Do not quit, restart, hide or attach a debugger to the person's running daily
  app for tests or installation without their explicit permission for that operation.
  Use the isolated profile/launcher for diagnosis. After an authorized daily restart,
  reopen visibly with an ordinary launch; never leave it hidden or a debug port open.
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
- Current development preference: the main agent implements and tests directly;
  do not delegate coding or routine testing unless requested. The independent
  reviewer at delivery checkpoints is a separate headless Claude Code session,
  not a subagent of the main agent. Start each new checkpoint in a fresh session,
  saving its UUID with that checkpoint's private evidence. Point the brief to
  `docs/review.md` for earlier findings. Each invocation exits. Run it from this
  repository as an unsandboxed background shell job (not `claude --bg`), with the
  brief on stdin and output in private files:

  ```sh
  claude -p --session-id "$NAW_REVIEW_ID" --model fable \
    --permission-mode bypassPermissions --output-format stream-json --verbose \
    --tools "Read,Grep,Glob" --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --disallowedTools Bash Agent Task Skill Workflow ToolSearch ScheduleWakeup \
      ListAgents ReportFindings Edit Write NotebookEdit \
    < "$BRIEF" > "$OUT" 2> "$OUT.err"
  ```

  Set `NAW_REVIEW_ID` from `uuidgen` once for the new checkpoint. For fixes to
  that same checkpoint, use `--resume` with its saved UUID. Keep the former
  `.local/reviewer-session-id` session as a backup; do not run paired reviews by
  default. For the next few checkpoints, retain the reported cost and findings
  to check this choice. A nonzero exit or `"is_error": true` is not a pass.
  Give the reviewer the scope, commit range and raw
  evidence paths, not your verdict. Expose only Read, Grep and Glob, with
  no MCP servers, and explicitly deny non-read tools. Verify the CLI initialization
  tool inventory for each invocation; stop if it differs. A fresh session may be
  needed after changing tool scope. The reviewer cannot run shell commands, write files or clean
  temporary directories. Main runs any requested bounded no-model probe and
  returns its complete output; label that author-run evidence distinctly from
  an independent rerun. This restriction follows an actual reviewer deletion
  of unrelated temporary files. Never identify ownership by a filename or sweep
  a temporary-directory wildcard. Confirm that HEAD, the index and the worktree
  remain unchanged after each review. Reproduce and record its findings in
  `docs/review.md`, fix them, then send only the delta to the same session. If
  Claude is unavailable, keep the checkpoint open rather than self-approving.
  Reuse relevant evidence and avoid frequent handoffs.
- A Claude agent working from the private task board does not end a turn idle;
  nothing reliably wakes an idle session. Before ending a turn, either be
  working on the next item it can take, or leave exactly one background command
  that exits on a specific event: a newer READY entry in a lane log (for the
  main session, also a new secretary note that names it), a reviewer or test
  finishing, or a fixed wait while a choice is pending with the person.
  Do not use `/loop` or timed polling prompts for this. Record choices for the
  person on the board as its rules describe and keep working meanwhile; choices
  that expose the machine, end sessions or backends, spend money or publish
  still wait for an explicit answer. If nothing on the board is doable, say why
  before ending the turn. A background wait counts as background work and blocks
  moving the agent's backend: when the person asks to update it, end the wait
  first.
- Verification principles (approved by the person on 2026-11-02 for every Claude
  and Codex agent here). A check exists only when it can catch a failure the
  earlier checks cannot, and missing that failure costs more than the check; say
  what each check prevents. A reversible, local risk gets one check; an
  irreversible or outward-facing action (push, deleting data, credentials,
  publication) gets at least two independent checks and still asks the person
  first. A conclusion holds only for the content it saw: reuse it while the
  patch or template hash is unchanged and re-check only what changed, so an
  already reviewed patch merged unchanged is not reviewed again. Leave to
  programs what they can decide (tests, template comparison, hashes, counts);
  people and models judge intent, experience and design trade-offs, and each
  machine-checkable problem a judgment review finds becomes a test. Completion
  follows the person's use: after an update is installed in the daily app,
  operate each change of that version the person can see as they described it,
  by GUI script where possible and otherwise by asking the person through the
  board's secretary; the row moves to done only once that passes. Fixed
  per-version overhead (packaging, signed launch, install, records, push scan)
  stays under about a quarter of the version's cycle; otherwise batch, except
  urgent items. The rules correct themselves: daily, or every five versions, the
  secretary reports three numbers from the records to the person (at which step
  each problem the person found in daily use should have been caught, whether
  each kind of check has recently caught a real problem, and the time from
  feedback to the daily app); a step that misses often is strengthened, and a
  check with no findings for a long time whose risk is covered elsewhere is
  downgraded. Rule changes are shown to the person first. Not traded for speed:
  the pre-push privacy and secret scan, no self-review, asking before
  irreversible or outward actions, and requirements the person stated. In
  practice: each change gets one author-side review that quotes the person's
  words and checks side effects on other views; integration review runs once per
  batch and covers only the combined interactions and the edits made while
  integrating; the daily update operator is compared by program with the last
  operator that ran, allowing only version numbers and hashes to differ, and
  goes to review only when that template changes; install records are checked by
  script against commit ids and counts instead of review.

## Architectural invariants

- Avoid unnecessary secondary labels and descriptions; let the layout explain
  hierarchy, grouping and authorship. Remove repeated captions and helper text
  before adding UI. Keep concise text where it changes a decision: the actual
  recipient, delivery/permission state, failure or recovery. Preserve accessible
  names and native content; visual simplicity must not hide those facts.

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
- Scope agent and reviewer file searches to explicit project or evidence roots.
  Do not enumerate, scan or read other apps' containers under
  `~/Library/Containers` or `~/Library/Group Containers`, including links into
  them. Prune those trees before traversal; filtering results still accesses
  them. If a task needs a specific app container, record the reason and exact
  app/path in the private task row and obtain explicit user approval first.
  A denied read does not authorize retries through elevated access or changes
  to macOS privacy permissions. This instruction is not an OS access control;
  include it in reviewer briefs and verify active clients load the updated rule.
- Never upload private task content for analytics or error reporting by default.
- Keep provider credentials under their native authentication mechanisms.
- Before adding a dependency or network destination, inspect its telemetry,
  authentication, data handling, and applicable terms. Privacy requirements in
  `docs/privacy.md` are release conditions, not claims that an app is already safe.

Use only checks appropriate to the changed surface. Documentation checks do not
prove runtime compatibility. Record untested requirements explicitly.
