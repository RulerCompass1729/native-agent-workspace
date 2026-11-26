# Shared project instructions

This file is shared by Claude Code and Codex. `AGENTS.md` points to this file.
A maintainer may keep a private overlay of their own process rules outside Git
(Claude loads it as `CLAUDE.local.md`). Where this file names the maintainer
overlay, follow the overlay when it is present.

## Vision first (the person, 2026-11-04)

All development serves the vision at the top of `docs/product.md`: 一个入口，用好所有 agent。你只管说要做什么，NAW 去找到或者新开对的 agent 接住它。
- A new feature or design proposal states which part of the vision it serves: the problem, the approach, who it is for, its form, or a success marker. Repairs and maintenance need not.
- When a feature, a requirement or the vision itself seems wrong or in conflict, do not choose silently. Add a row with the reason, evidence and a suggested resolution to 「与愿景的张力」 in `docs/product.md` (public-safe facts only), and ask the person on the task board. Like spending or publishing choices, this waits for the person's explicit answer; no default takes effect after a timeout, unless the maintainer overlay sets a default-answer process for that kind of choice. Existing requirements otherwise stay in force until the person decides.
- The vision is direction, not implementation authorization. Privacy, cost and approval rules still apply.

Read `README.md`, `docs/product.md`, and `docs/readiness.md` before changing scope.
The current phase is a local desktop demo built on DeepSeek Harness. Preserve
that foundation and the native session service when improving either GUI or TUI.
Do not present planned integrations as working features, install provider runtimes,
or start paid model runs as a side effect of editing documents.

## Task-led collaboration

- Every agent keeps its full implementation and verification capabilities. Roles
  such as project manager, researcher, tester and integrator describe the current
  work, not permanent limits. The project-manager role neither adds nor removes
  native tools; a V12 default secretary keeps its default tool limits. Within existing
  authorization, any agent may claim a
  ready, unowned complete user outcome without waiting for a new dispatch,
  except as a member of a space whose NAW queue the person uses (automatic
  messages on): there it works on NAW dispatches (【NAW 派活】, one item to one
  member) and on what the person asks it directly; another agent may ask it only
  about its current item (questions, reviews, handoffs), and the asking agent
  leaves new tasks for the person. New tasks enter the queue only through the
  person, the person-designated project manager of that space (项目经理, its own
  space's queue only), or the person-designated butler (大管家). The butler queues
  only the person's own requests; a project manager, those and the steps needed
  to finish work the person gave its space, not new outcomes; other agents cannot
  add items. Cancelling and marking items complete
  are for the person and the butler; NAW records which of them did it. Neither
  claims board tasks itself (the person, 2026-11-08:
  agents claiming the same task by themselves). A session is such a member once
  a 【NAW 派活】 has reached it, or once the person or that space's project manager
  says so through NAW. The designated integrator stays outside queue spaces, since
  its work starts on its own; if it receives a 【NAW 派活】, it replies 「需要你决定：」
  asking the person to move it. A project manager is a member of its space.
- Keep one owner responsible for each outcome through reproduction, necessary
  implementation, relevant checks and usable delivery. A helper may claim and
  finish an independent dependency; the outcome owner keeps responsibility for
  interfaces and acceptance, without becoming an approval step for ordinary
  authorized work. An owner continues implementation, not only coordination.
- Before claiming, exclude missing authorization, task-specific stage gates and
  conflicting live work. Then prefer an actionable blocker of a current delivery,
  a ready-to-finish outcome, and the next highest-priority independent task, in
  that order. Familiar context breaks ties. Do not interrupt a productive author
  to reshuffle work; change hands at a saved checkpoint.
- Record the outcome and acceptance condition, current owner and stage, worktree,
  directly affected functions/interfaces or shared resources, and the next step
  or evidence pointer on the existing task board/lane. Recheck the current claim
  before editing. Same-file names alone do not establish conflict; overlapping
  behavior, interface contracts, uncommitted work or daily runtime operations can.
  Resolve only that conflict and continue other authorized work.
- Stages belong to tasks: one may await a design decision while another proceeds
  to implementation or acceptance. Reuse decisions and checks for unchanged
  content; check only the new risk. Each author checks the requested outcome and
  side effects on other views before delivery. Required independent review stays with someone
  who did not author that patch, under the shared risk-based review gates.
- Integration is one bounded shared operation at a time, not a gate on independent
  development. The current batch keeps its explicitly designated integrator until
  an explicit saved handoff. Use the committed canonical main checkout's
  `scripts/integrator-lock.cjs run`, not an older lane/release copy, with a current
  authorized task/handoff reference in `--delegation`; it is a reference to
  existing authority, not a request for new approval. Do not hold the
  Root integration lock across model turns, dependency/reviewer waits, isolated
  implementation, tests or builds. Prepare a clean committed release worktree,
  release the shared-write lease, then build/check it independently. Reacquire
  only for the next necessary shared mutation or authorized daily activation.
  Keep other named resource locks only for their actual conflicting operation.
  Never steal a live/unknown lease or infer permission from elapsed time.
- Each space's project manager finds that space's ownerless actionable blockers,
  delivers necessary context and verifies actual receipt/progress; it does not approve each normal claim and
  may itself own an authorized complete task in an isolated worktree. Do not
  treat idle/working labels as task eligibility or accomplishment. Measure useful
  work left waiting, time to a usable result, and avoidable handoffs/rework from
  existing records instead of creating polling/model activity to look busy.
- For each space the person designates at most one project manager, a member of
  it, through the member's or the space's menu, and can replace or revoke it; a
  space the person creates arranges one by default, which the person can leave out.
  The role grants only queue addition in that space, not execution tools, model
  calls, or other queue controls; the separately metered native-session, consent
  and cost conditions in product V12 remain in force. What it reads through NAW is
  that space, not other sessions' private conversations, and agents' messages from
  other spaces are refused. It
  invokes `spaceAction` with `[roomId, "queueAdd", [text, null]]`, normally omits
  the assignee and lets NAW select an idle member, never itself or another project
  manager. If a request is unclear or belongs to another space, it asks the person
  in its own conversation before adding it. It does not route new work from another
  agent. The role follows a single unambiguous handoff only when
  its rotation log says `event=done`; `kept` and branching successors do not
  transfer it. No automatic heartbeat or routing model is added. NAW tells an idle
  manager who joined or left its space and what became of the items it added,
  only after such a change and at most once a minute (R253).
- NAW-owned collaboration tools and provider-native execution tools remain
  separate. Task ownership does not grant native session control, permission,
  model/budget changes, publication, spending or access to another user's draft.
  When a real dependency remains, keep its existing event wait in the original
  native execution path; do not replace it with repeated no-progress goal turns.
- Send every message to or between NAW sessions through NAW's own channel: NAW's
  workspace message tools, or an @ in the target space (by GUI or computer use).
  This applies to agents inside NAW and to coordinators outside it. Do not use a
  provider's session-to-session messaging to or between NAW sessions: it leaves no record
  in the space and does not reach other providers. A native team's internal
  messaging (Claude Agent Teams, Codex fleets) stays as the provider runs it.
  Computer use in the daily app types only into the target space's composer after
  confirming the single recipient and that no draft is present, starts the message
  with its sender's name, prefers the workspace tools when available, keeps
  screenshots private, and follows the daily-app rules below.
  Writing a board or lane entry records a message; it does not prove the
  recipient received it.

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
- For ordinary non-interactive tests, keep complete output in private logs and report a summary at completion. Use the longest bounded wait supported by the current tool and each enclosing layer; avoid repeated one-second empty polls. Handle errors, interaction and cancellation promptly, and keep existing progress updates.
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
- Installed native tests must start through normal service bootstrap, which
  copies writable provider plugins into the private runtime directory. Do not
  directly fork the signed bundle's daemon for real providers: native plugin
  initialization can generate files beside the plugin. Verify the installed
  bundle's strict signature after native testing, not only before it. Synthetic
  transport fixtures may boot directly when they never initialize a provider.
- The independent reviewer, when the shared risk gates require one, is a separate headless Claude Code session,
  not a subagent of the main agent. Start each new checkpoint in a fresh session,
  saving its UUID with that checkpoint's private evidence. Point the brief only to
  relevant rows/sections of the review record (`docs/review/`, see "Evidence and
  public boundaries"), not its whole history. Apply the
  shared review budget: a reproduced local repair defaults to three minutes and
  eight read/search calls. Name the exact diff, direct callers, raw failure/fix
  evidence and remaining risk; expand only for a concrete missing check. These
  are bounds on investigation, never automatic approval or a reason to omit
  required evidence. Each invocation exits. Run it from this
  repository as an unsandboxed background shell job (not `claude --bg`), with the
  brief on stdin and output in private files:

  ```sh
  claude -p --session-id "$NAW_REVIEW_ID" --model "${NAW_REVIEW_MODEL:?}" \
    --max-turns "${NAW_REVIEW_MAX_TURNS:-6}" \
    --permission-mode bypassPermissions --output-format stream-json --verbose \
    --tools "Read,Grep,Glob" --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --disallowedTools Bash Agent Task Skill Workflow ToolSearch ScheduleWakeup \
      ListAgents ReportFindings Edit Write NotebookEdit \
    < "$BRIEF" > "$OUT" 2> "$OUT.err"
  ```

  `NAW_REVIEW_MODEL` names the reviewer model; when it is unset the command
  stops instead of falling back to a default. Set `NAW_REVIEW_ID` from
  `uuidgen` once for the new checkpoint. For fixes to
  that same checkpoint, use `--resume` with its saved UUID. Keep the former
  `.local/reviewer-session-id` session as a backup; do not run paired reviews by
  default. For the next few checkpoints, retain the reported cost and findings
  to check this choice. The six-turn default bounds the CLI loop; it is not
  eight tool calls or a wall-clock timer. Set a larger explicit turn budget for
  broader reviews before launch, and the author watches the time/read budget.
  A timeout, turn-limit result, nonzero exit or `"is_error": true` is not a pass.
  At a limit, retain the same checkpoint and request a bounded verdict or the
  single most important missing fact; do not start a fresh full review.
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
  the review record, fix them, then send only the delta to the same session. If
  Claude is unavailable, keep the checkpoint open rather than self-approving.
  Reuse relevant evidence and avoid frequent handoffs.
- A member of a space whose NAW queue the person uses ends each turn idle once
  its current item is done: no background command (it waits inside the turn,
  with long waits, until its reviewers or tests exit), no active native goal and
  no running teammates. NAW sends idle members their next item and replaces long
  sessions with new ones, and it does neither for a session with a background
  command, an active goal or running teammates. A turn whose final message
  starts with 「需要你决定：」 leaves its item open as 等你决定 for the person;
  the member takes its next item meanwhile, in the same session, where the
  person's answer arrives (2026-11-13, a held member left four items waiting).
  An open decision does not stop NAW from replacing that session when it is
  due (the person, 2026-11-23): the successor's handoff gives each open
  decision whole (the item id, its text and the member's question; where NAW
  has only the start of a question left, the handoff says so), the item
  then names the successor, and the person's answer arrives there. The
  successor acts on the answer; it does not decide for the person or ask
  again. A session stays only while its open decisions cannot all be handed
  over: together too long for one message, or one of them in a space the
  session has left.
  When the work on the item ends in commits, the turn's final message has,
  after its first line, one line of its own with exactly three words
  separated by single spaces: `READY <branch> <commit>` (the branch that holds the work and its
  head commit, 7 to 40 hex characters; plain text, with no quotes, backticks,
  bold, list marker or closing period). NAW keeps the line on the item and
  records the delivery in the space; an item without commits has no such
  line. The line only reports a delivery: it does not merge, install or ask
  for anything. When the person
  starts using a queue in a space, they or its project manager tell its members once,
  through NAW, to end any background wait. An idle member does not see the
  board, so a board entry does not reach it: work meant for an idle member goes
  to it through the queue (see Task-led collaboration for who may add items).
- Otherwise, a Claude agent working from a task board does not end a turn idle;
  nothing reliably wakes an idle session. Before ending a turn, either be
  working on the next item it can take, or leave exactly one background command
  that exits on a specific event: a newer READY entry in a lane log (for the
  main session, also a new board note that names it), a reviewer or test
  finishing, or a fixed wait while a hard-gate question is pending with the
  person. Do not use `/loop` or timed polling prompts for this. Ask the person
  as the next item describes and keep working meanwhile. If nothing on the
  board is doable, say why
  before ending the turn. A background wait counts as background work and blocks
  moving the agent's backend: when the person asks to update it, end the wait
  first.
- Questions for the person: hard gates. A hard gate never defaults; it waits
  for the person's explicit answer. Examples, not a complete list: pushing,
  uploading, publishing, or messages to other people; spending money;
  connecting to the real DeepSeek service; deleting data or anything else
  irreversible; switches only the person may use (the automatic-messages
  switch, automatic migration, authorizations, designating a project manager,
  the integrator or the butler); loosening permissions or confirmation gates; ending
  sessions or backends, exposing this machine, or quitting or restarting the
  daily NAW other than for an installation; the person's own financial or
  career decisions, including proposals made for them; a conflict with the
  vision or a requirement (see Vision first). Write a hard-gate question as
  「需要你决定：…（硬门，不按默认）」; the butler collects it into the
  person's list. First do any part of the current item that does not depend
  on it. Then a queue member ends its turn with a final message whose first
  line is that question (NAW marks the item 等你决定 and sends the member its
  next item). An agent outside a queue (the integrator, an
  agent on a task board), Claude or Codex, keeps working within existing
  authorization or leaves one background command that waits for this answer,
  and does not end the turn idle. Other questions also wait for the person's
  explicit answer, unless the maintainer overlay sets a default-answer process.
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
  machine-checkable problem a judgment review finds becomes a test. Not traded
  for speed: the pre-push privacy and secret scan, no self-review, asking before
  irreversible or outward actions, and requirements the person stated. In
  practice: use the shared risk-based review gates once per delivery checkpoint,
  quoting the person's words and checking side effects on other views when a
  review is required; integration review covers only the batch interactions and
  edits made while integrating, reusing unchanged approved patches.

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
  The one exception to private sharing scopes is the butler (大管家) the person
  designated: it sees what every collaboration space holds; each read through
  NAW is a step in its record.
- Provider-specific capabilities may extend the interface. Do not force every
  provider into a lowest-common-denominator runtime or silently drop events.
- Do not infer delivery, completion, cancellation, or fleet termination from a
  successful enqueue, process write, or top-level interrupt alone.

## Evidence and public boundaries

- Apply the shared risk gates before starting an independent review; this
  project does not require a review for every task. When required, review the
  affected product path. Keep user feedback, reproduced findings, fixes and
  evidence in the review record; review actual source and raw local evidence,
  not just the author's summary. Reuse the reviewer after fixes. Keep private
  evidence outside this public repo, and do not add model tests simply to make
  a review appear more thorough.
- The review record is one file per lane and day,
  `docs/review/YYYY-MM-DD/<lane>.md` (`date +%F`; `<lane>` is the branch without
  `lane/`), so merges do not conflict there. Older day files stay put, and
  `docs/review.md` stays frozen since 2026-11-13 (2 MiB push limit): a
  correction to an entry in either is a new record naming it. Merges keep both
  sides' records; when a branch changed `docs/review.md`, restore main's frozen
  copy and move its additions into your lane file.
  `app/tests/docs-size.test.cjs` fails when `docs/review.md` differs from its
  frozen copy or another file under `docs/` passes 1.5 MiB.

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


## Push rules

- Ask the person before pushing, unless the maintainer overlay grants a
  standing authorization.
- Never push `backup/*` or `lane/*`.
- Never use `--no-verify` or bypass hooks or publication checks.
- Before pushing, run `python3 scripts/privacy_guard.py history` (see
  `docs/publication.md`). Its privacy/PII checks and gitleaks must cover the
  complete unpushed range: every patch, content added then removed, commit
  messages, author/committer identities and outgoing refs. Show the full
  scan output to the person, inspect findings and resolve every block first.
