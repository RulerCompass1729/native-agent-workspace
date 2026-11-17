# Shared project instructions

This file is shared by Claude Code and Codex. `AGENTS.md` points to this file.

## Vision first (the person, 2026-11-04)

All development serves the vision at the top of `docs/product.md`: 一个入口，用好所有 agent。你只管说要做什么，NAW 去找到或者新开对的 agent 接住它。
- A new feature or design proposal states which part of the vision it serves: the problem, the approach, who it is for, its form, or a success marker. Repairs and maintenance need not.
- When a feature, a requirement or the vision itself seems wrong or in conflict, do not choose silently. Add a row with the reason, evidence and a suggested resolution to 「与愿景的张力」 in `docs/product.md` (public-safe facts only), and ask the person on the task board. Like spending or publishing choices, this waits for the person's explicit answer; no default takes effect after a timeout, except for reversible local appearance or implementation-plan choices within existing authorization that the person allowed on 2026-11-16 to follow the five-minute recommendation process below. This exception does not authorize new features, grant new permissions, or relax permissions; reversible local plan choices within existing authorization follow the process in this section. Existing requirements otherwise stay in force until the person decides.
- The vision is direction, not implementation authorization. Privacy, cost and approval rules still apply.

Read `README.md`, `docs/product.md`, and `docs/readiness.md` before changing scope.
The current phase is a local desktop demo built on DeepSeek Harness. Preserve
that foundation and the native session service when improving either GUI or TUI.
Do not present planned integrations as working features, install provider runtimes,
or start paid model runs as a side effect of editing documents.

## Task-led collaboration

- Every agent keeps its full implementation and verification capabilities. Roles
  such as secretary, researcher, tester and integrator describe the current work,
  not permanent limits. The queue-secretary role neither adds nor removes native
  tools; a V12 default secretary keeps its default tool limits. Within existing
  authorization, any agent may claim a
  ready, unowned complete user outcome without waiting for a new dispatch,
  except as a member of a space whose NAW queue the person uses (automatic
  messages on): there it works on NAW dispatches (【NAW 派活】, one item to one
  member) and on what the person asks it directly; another agent may ask it only
  about its current item (questions, reviews, handoffs), and the asking agent
  leaves new tasks for the person. New tasks enter the queue only through the
  person, the one person-designated secretary, or the person-designated butler
  (大管家). The secretary and the butler may queue only the person's own
  requests; other agents cannot add items. Cancelling and marking items complete
  are for the person and the butler; NAW records which of them did it. Neither
  claims board tasks itself (the person, 2026-11-08:
  agents claiming the same task by themselves). A session is such a member once
  a 【NAW 派活】 has reached it, or once the person or the secretary says so
  through NAW. The secretary and the designated integrator stay outside queue
  spaces, since their work starts on its own; if one of them receives a
  【NAW 派活】, it replies 「需要你决定：」 asking the person to move it.
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
  existing authority, not a request for new secretary approval. Do not hold the
  Root integration lock across model turns, dependency/reviewer waits, isolated
  implementation, tests or builds. Prepare a clean committed release worktree,
  release the shared-write lease, then build/check it independently. Reacquire
  only for the next necessary shared mutation or authorized daily activation.
  Keep other named resource locks only for their actual conflicting operation.
  Never steal a live/unknown lease or infer permission from elapsed time.
- The secretary finds ownerless actionable blockers, delivers necessary context
  and verifies actual receipt/progress; it does not approve each normal claim and
  may itself own an authorized complete task in an isolated worktree. Do not
  treat idle/working labels as task eligibility or accomplishment. Measure useful
  work left waiting, time to a usable result, and avoidable handoffs/rework from
  existing records instead of creating polling/model activity to look busy.
- For queue intake, the person designates one secretary session through its
  existing session menu and can replace or revoke it. This role grants only
  queue addition, not execution tools, model calls, or other queue controls;
  the separately metered native-session, consent and cost conditions in
  product V12 remain in force. To place the person's request, use only NAW
  records already available to the secretary: spaces, members and queues, not
  other sessions' private conversations. Choose a space whose recorded work
  clearly matches the request, normally omit the assignee and let NAW select
  an idle member. Use the existing `workspace_control` command catalog:
  invoke `spaceAction` with `[roomId, "queueAdd", [text, null]]`. If the space
  or request is unclear, ask the person in the
  secretary's own conversation before adding it. Do not route new work from
  another agent. A secretary's role follows a single unambiguous handoff only
  when its rotation log says `event=done`; `kept` and branching successors do
  not transfer the role. No automatic heartbeat or routing model is added.
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
  screenshots private, and follows the
  daily-app rules below. Writing a board or lane entry records a message; it does
  not prove the recipient received it.

## Lightweight mode (the person, 2026-11-08)

Records, hashing and waiting took most agent time while product edits were a few
percent of tool calls. For local, reversible changes (source, tests or docs on a
local branch or main; not installed, pushed or published):
- The evidence is the commit plus the relevant test output: the command, pass and
  fail counts, and the failing assertion if any. Do not create per-step hash
  manifests, ready.json files, process-record files or evidence bundles for these
  changes. Keep raw test output for failures and for any change a risk gate sends
  to independent review.
- A task-board or lane entry is at most 300 characters: what changed, the commit,
  the test result and the next owner. A claim still names the fields listed under
  Task-led collaboration; put anything longer in one file and link it.
- When the risk gates require an independent review, run it once per integration
  batch over the combined diff, not once per commit. A batch is a delivery
  checkpoint in the review rules below.
- Everything else in this file still applies, including privacy and secret scans
  before every commit and push, asking first for irreversible or outward actions,
  no self-review, the risk-gate reviews themselves, signed acceptance and daily-use
  checks before a row is done, and requirements the person stated.

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
- Wait on a running command with one long tool wait that returns when it exits
  or prints (for example a 300-second yield); do not poll it with repeated
  short empty waits, since each poll is a full model call over the whole context.
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
  claude -p --session-id "$NAW_REVIEW_ID" --model fable \
    --max-turns "${NAW_REVIEW_MAX_TURNS:-6}" \
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
  person's answer arrives (NAW does not replace that session until the person
  handles the item; 2026-11-13, a held member left four items waiting).
  When the work on the item ends in commits, the turn's final message has,
  after its first line, one line of its own with exactly three words
  separated by single spaces: `READY <branch> <commit>` (the branch that holds the work and its
  head commit, 7 to 40 hex characters; plain text, with no quotes, backticks,
  bold, list marker or closing period). NAW keeps the line on the item and
  records the delivery in the space; an item without commits has no such
  line. The line only reports a delivery: it does not merge, install or ask
  for anything. When the person
  starts using a queue in a space, they or the secretary tell its members once,
  through NAW, to end any background wait. An idle member does not see the
  board, so a board entry does not reach it: work meant for an idle member goes
  to it through the queue (see Task-led collaboration for who may add items).
- Otherwise, a Claude agent working from the private task board does not end a turn idle;
  nothing reliably wakes an idle session. Before ending a turn, either be
  working on the next item it can take, or leave exactly one background command
  that exits on a specific event: a newer READY entry in a lane log (for the
  main session, also a new secretary note that names it), a reviewer or test
  finishing, or a fixed wait while a hard-gate question is pending with the
  person. Do not use `/loop` or timed polling prompts for this. Ask the person
  as the next item describes and keep working meanwhile. If nothing on the
  board is doable, say why
  before ending the turn. A background wait counts as background work and blocks
  moving the agent's backend: when the person asks to update it, end the wait
  first.
- Questions for the person (the person, 2026-11-16: a question they have not
  answered within 5 minutes goes ahead as recommended, since they can easily
  miss one, but no agent may stall on it). For every agent in NAW, the butler
  included:
  1. A question may default only when the choice is reversible, affects only
     the local repository, the current task or this machine's NAW, and stays
     within authorization the person has already given. Every other choice is
     a hard gate (item 5); when unsure, treat it as one.
  2. Do not ask a question that may default through a prompt that blocks the
     turn (AskUserQuestion). Write one line in the reply and one on the board:
     「请你定：<问题>；推荐 <X>，因为 <一句理由>；<HH:MM> PT 前没回就按推荐做」,
     with the deadline 5 minutes after sending. Do not start it with
     「需要你决定：」, which NAW records as an open decision for the person.
  3. While waiting, do not end the turn. First do the parts of the current item
     that do not depend on the answer (a queue member works only on items NAW
     sent it and on what the person asked it directly, and takes no other board
     work; an agent outside a queue works only within existing authorization).
     When nothing is left, wait in the foreground inside the turn, no longer
     than the time remaining before the deadline, with no background command
     or `/loop`. Handle a reply as soon as it arrives, and check the board for
     an answer after each wait. When the person answers in another
     session, the butler writes the answer on the board at once.
  4. At the deadline, check the board and the agent's own conversation once
     more. If there is still no answer, do only the one thing the question
     named, not related switches or operations, and write on the board:
     「<HH:MM> PT 5 分钟未答，按推荐做了 <具体哪件>；原问题 <…>；撤回办法 <…>」.
     If the person later decides otherwise, change it back their way; for
     something already installed in the daily app, changing back means the
     next version.
  5. A hard gate never defaults; it waits for the person's explicit answer.
     Examples, not a complete list: pushing, uploading, publishing, or messages
     to other people; spending money; connecting to the real DeepSeek service;
     deleting data or anything else irreversible; switches only the person may
     use (the automatic-messages switch, automatic migration, authorizations,
     designating the secretary, integrator or butler); loosening permissions
     or confirmation gates; ending sessions or backends, exposing this machine,
     or quitting or restarting the daily NAW other than for an installation;
     the person's own financial or career decisions, including proposals made
     for them; a conflict with the vision or a requirement (see Vision first).
     Write a hard-gate question as 「需要你决定：…（硬门，不按默认）」; the
     butler collects it into the person's list. First do any part of the
     current item that does not depend on it. Then a queue member ends its turn
     with a final message whose first line is that question (NAW marks the
     item 等你决定 and sends the member its next item). An agent outside a
     queue (the integrator, the secretary, an agent on the private task
     board), Claude or Codex, keeps working within
     existing authorization or leaves one background command that waits for
     this answer, and does not end the turn idle.
  6. When the person is asked to look at the wording of interface text, items
     2–4 apply; at the deadline the wording first passes one independent
     review and merges only after it passes. Installing it into the daily app
     then follows the person's standing install permission (2026-11-12, for
     the agent that installs daily builds), provided every pre-install check
     passes. Reversible local choices about how the interface looks (lines,
     color blocks, spacing, layout) within existing authorization also follow
     items 2–4 (the person, 2026-11-16). Send the pictures, state the
     recommendation and how to undo it, and retain the required independent
     review and pre-install checks.
  7. A question without a recommendation cannot default. First decide a
     recommendation with a reason, then ask; if you cannot, treat it as a hard
     gate.
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
  practice: use the shared risk-based review gates once per delivery checkpoint,
  quoting the person's words and checking side effects on other views when a
  review is required; integration review covers only the batch interactions and
  edits made while integrating, reusing unchanged approved patches. The daily
  update operator is compared by program with the last
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
- The review record is one file per day: append a new record at the end of
  `docs/review/YYYY-MM-DD.md` for the day you write it (`date +%F` on this
  machine), creating the file if needed. `docs/review.md` holds the records
  written before it was frozen on 2026-11-13 (that day continues in
  `docs/review/2026-11-13.md`): the push guard refuses any file over 2 MiB, and
  every edit put another whole copy of it into history. Do not add to it or
  edit it; a correction or status change to an entry there is a new record in
  today's file, naming the entry. When merging, keep every record both sides
  add to a day file. When a branch changed `docs/review.md`, restore main's
  frozen copy and put each added record, and each change restated as a record
  naming its entry, at the end of the day file of the day you move it.
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

- Push only `main`, and only when the person explicitly says to push.
- Never push `backup/*` or `lane/*`.
- Never use `--no-verify` or bypass hooks or publication checks.
- Before pushing, run `python3 scripts/privacy_guard.py history` (see
  `docs/publication.md`). Its privacy/PII checks and gitleaks must cover the
  complete unpushed range: every patch, content added then removed, commit
  messages, author/committer identities and outgoing refs. Show the full
  scan output to the person, inspect findings and resolve every block first.
