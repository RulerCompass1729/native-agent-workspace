# Core product acceptance

Active scope authorized 2026-10-18 after alpha.22 solo acceptance. This supersedes
the earlier pause on collaboration expansion; the acceptance below defines its local-trial completion boundary.

问题：把原生保留、普通人体验、可控协作、隐私保护和无隐性开销做成可日用的产品。
现有机制：DSH UI、persistent native service、`workspace.cjs`、`adapters.cjs`、
`room-state.cjs`、`workspace-client.cjs`、renderer 和已有 DMG/guest 验收。
最小增量：完成安装、独立工作、共同核查、脱出继续与恢复的一条完整流程。
不做会坏什么：协作仍像未完成的表单，原生状态未知导致交接停止，新用户卡在设置。

Decision: readiness for a small macOS trial. Scope: Claude Code, Codex and one
human; preserve DSH, native identity, permissions and fleets. Main agent implements
and tests, with one reused independent reviewer. Initial native test allowance:
eight top-level submissions and two necessary fleet trials, cheapest suitable
models, no automatic retries. Report child usage separately; this is not a dollar
hard cap. Prefer local tests and reuse unaffected native evidence.

## One accepted product increment

| Area | Required evidence before closing | Starting state |
| --- | --- | --- |
| Solo GUI/TUI | Input/read/progress/interrupt/permissions, same identity, drafts and recovery | Alpha.22 controlled local acceptance; rerun affected paths only |
| Shared work | One recipient control with `@`, reply timeline/search, join/detach/rename/archive/resume | Mechanical checks; coherent flow pending |
| Shared context | Private history separate from shared record and actual deliveries; explicit transfer, durable notes; leaving stops routes without claiming forgetting | Manual notes exist; delivery awareness pending |
| Bounded collaboration | Native readiness, finite authorization, human override, unknown/permission/repetition/limit stops; one real task | Native adapters currently always report unknown fields |
| Installation/setup | Free DMG, clean install, prerequisites, discovery/custom location, first use, update/recovery | Local DMG exists; clean setup journey pending |
| Trust | Inspectable storage/sharing/usage/unknowns, affected privacy/network/license checks and independent review | Existing controls; affected-path review pending |

## Final acceptance journey

Install → set up one native agent → solo work → invite the second agent → share
and check a small task → human takeover → detach and continue the same native
session → archive/resume → quit/reopen/update with records and drafts intact.
Also complete one explicit bounded autonomous task. No relevant high-severity
issue may remain open. Disabled controls, mocks and documents do not substitute
for native acceptance.

Free distribution remains unnotarized. Do not claim Gatekeeper approval, full
fleet termination, identical total cost or zero latency. Additional platforms,
providers, cloud sync and terminal embedding wait for this flow. Paid enrollment
and broad consumer release are outside this increment. Keep raw evidence private
and findings in the existing `review.md`.

## Acceptance result — alpha.23

The scoped local core workflow passed implementation, native task, installed
artifact and visible guest checks on 2026-10-18. Final independent delivery review
is recorded in `review.md`; this file is not a security certification.

- Solo: alpha.22 OS input evidence retained; final solo/room regressions pass.
- Shared work: actual three-parent-reply Claude/Codex task, same-session private
  continuation, membership, notes, archive and reopen; visible guest interaction
  separately uses synthetic transport without model spend.
- Setup: downloaded/quarantined DMG, app-specific approval, Python installation,
  native discovery/custom path and both providers' login screens. Authenticated
  replies were checked on the host, not with a fresh account in the guest.
- Control: explicit root-reply authorization, finite limits, human/native-activity
  interruption and no automatic replay. Unknown descendants remain unknown.
- Trust: disclosures and publication guard retained; no added dependency/model
  router/automatic summary. No claim of independent security certification or
  identical total task cost.

This closes a core **local technical trial**, not the entire product vision.
Trigger the next increment with trial feedback: account onboarding on another
Mac, full native-fleet lifecycle and external-session attachment, then broader
consumer distribution. Arbitrary overnight goal completion is still unverified;
this version authorizes a bounded exchange, not an unlimited agent conversation.


## Native visibility follow-up — alpha.24

The local core workflow now includes bounded readonly native TUI output and tool
progress in solo/room views. A real two-provider CSV check complements the earlier
recorded study-planning workflow; unchanged lifecycle scenarios reuse their prior
OS evidence. Current raw-output, queue/gap, focus/draft and reconnect checks plus
same-history cold recovery are recorded in `live-progress.md` and `testing.md`.
The new-backend observation subcase passed. Subsequent retained-session screenshots
reopen U17: terminal output is present but conversation mode lacks it and cannot
send. The practical seamless-use milestone is therefore not closed for that path.
U05, full fleet recovery and official Desktop state integration remain open.

Alpha.25 repairs the inspected retained alpha.2 Claude path without replacing its
native process: explicit native input plugin reload, readonly complete-screen
snapshots, draft/owner protection and UI reconnect. See `live-progress.md` for the
real task and limitations. U17/U05 remain open for other old connections, including
Codex and legacy shared/automatic dispatch; this narrower repair does not close
all seamless-use acceptance.


Alpha.26 extends the retained-session repair to Codex and explicit human-directed
sharing on both providers. Two real cheap parent tasks and repeated source/installed
lifecycle checks retain native identity/history and drafts. The final installed
renderer and runtime files match the tested source. This closes the inspected
input/raw-preview/manual-sharing subcases after independent delivery review;
full U17/U05 remain open for other compatibility and active-fleet cases. Old
Claude automatic reply routing still needs a reliable submit-to-turn contract.
