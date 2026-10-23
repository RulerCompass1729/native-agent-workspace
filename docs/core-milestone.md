# Core product acceptance

## Current priority — 2026-10-22

The user clarified that the embedded native TUI is an acceptable single-agent
surface for this milestone. Recreating every TUI detail in a separate solo chat
is deferred. The current delivery decision is whether the **shared workspace**
is usable: one attributed reading stream, human `@` selection, bounded explicit
agent-to-agent messages, human intervention, detach/continue, and persisted
records/drafts through archive and reopening. Preserve the existing solo reader;
do not build additional viewers or terminal-camera panels.

Use one small end-to-end task and one control/recovery scenario, real application
interaction and affected native paths, then independent review. Reuse unaffected
evidence. Fix blocking failures before repeating the affected case; avoid separate
releases for individual cosmetic or peripheral improvements. Existing native
protocols and reusable implementations take priority over new infrastructure.
Installation, broader provider support, and complete solo GUI/TUI parity are
follow-up work. The historical checkpoints below retain their original scope;
they do not constitute acceptance of this current shared-workspace milestone.

Current cross-service increment: **alpha.84, 2026-10-23**. Explicit V1 peer
services can run a finite fixed-order exchange without replacing native sessions.
Source and installed native/UI journeys pass three steps, first Codex TUI entry,
UI-closed continuation, identity/draft retention, pause verification, permission
changes and departure. The 888-check source suite, 53-file payload/signature and
original-three-session hidden reopen pass. Final independent artifact review passes.
Existing alpha.2/83 services remain manual because they lack this protocol; this
increment does not complete external live attachment or U17.

Previous shared-workspace checkpoint: **alpha.83, 2026-10-22**, accepted for the
supported new-session local trial after independent review. One real Haiku/Luna
budget task performs two native tool-selected handoffs and concludes in three
root submissions; installed native pause/private-continuation/reopen and six
shared UI groups pass. Subsequent actual-native tests cover three same-name
participants, continued authorized work with the UI closed, stable identities and
drafts on reopen, and concurrent working-turn input with private departure.
Native usage reads add no inference/count-token request. Source suite: 865 passed,
zero skips; final metadata guards pass 77 targeted checks. Original sessions
survive the update. Final independent alpha.83 artifact review passes; see readiness.md. See [exact evidence](testing.md#agent-selected-addressed-cooperation--alpha81).
Old connections without the tool remain manual/fixed-order; full solo 1:1,
mid-turn agent handoffs, arbitrary unattended goals and external live attachment
are not closed by this checkpoint. Tool metadata/continuations have native cost.

Historical integrated checkpoint: **alpha.55, 2026-10-21**. The currently supported
local single/shared-session workflow passes six installed-application journeys,
including private-result follow-through after a permission pause. Independent
final source/artifact review passes; [evidence and exact limits](testing.md#integrated-core-acceptance--alpha55)
distinguish real application interaction, controlled provider transport and
reused native task evidence. This checkpoint introduces no runtime change or
additional product feature. M5 live entry and the wider product vision are not
declared complete by this local-core acceptance.

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


## Alpha.27 local-trial checkpoint

The supported local GUI/TUI and bounded-collaboration path passes final independent
review. Real retained Claude/Codex work, explicit sharing, same-ID cold recovery,
new prompt-correlated reply transfer, two installed lifecycle cycles, and native
live-pane/input regressions cover the reported day-to-day path. The successful
recording is local; only synthetic reproductions and redacted conclusions enter Git.
This delivery fixes the reproduced stale-reply attribution and recovery-display
bugs without additional background model calls or replacing the user's sessions.

Keep U05 open for arbitrary live old-backend feature upgrades. An existing native
process can continue with its supported capabilities; current automatic handoff
requires the verified identity contract. Full fleet restoration, arbitrary
unattended goals, external-session live attachment, official Desktop UI state
synchronization and broad consumer onboarding remain separate unfinished work.
No new claim of physical IME completeness, zero latency or identical total cost
is made by this checkpoint. See the alpha.27 evidence in testing.md and review.md.

## Local reliability follow-up — alpha.29–40

As of 2026-10-20, the supported local-trial workflow has additional failure and
interaction coverage. This preserves the earlier native task evidence and its
limits; it does not declare the entire product vision complete.

- Recovery and saving: confirmed backend exit, explicit same-owned-Codex
  reconnect, continuous-output checkpoints, unreadable-record preservation,
  failed-save close/quit cancellation and accepted-send/storage separation.
- Daily interaction: long-list navigation, minimum-window conversation space,
  unreachable saved-window recovery, stable keyboard controls and exact visible
  native-selection sharing through the existing preview.
- Control: native permission pending/resolution and scope guards, obsolete
  request/owner rejection, invalidated membership actions and protection of
  newer preview edits from older send completion.

Each increment has actual failure/counterexample evidence, affected source and
installed-app checks, and independent final review in testing.md/review.md.
The final local app is alpha.40; only one ordinary application entry remains.
Original native sessions and saved user records were preserved. No new native
model task was run during this hardening window; local synthetic transports test
the changed interface/control paths, not provider inference quality. Earlier
automated guest OS-event and native-task evidence retains its original scope and date.

The next larger gate remains complete native-fleet lifecycle and cross-version
compatibility, followed by broader account onboarding and distribution. External
live-session attachment, official Desktop-state synchronization and arbitrary
unattended goal completion are still unfinished; they are not implicit claims
of this local-trial acceptance.

## Existing-core regression — alpha.41

A full 23-scenario installed regression passed, then actual native permission
checks exposed a first-turn dead end that synthetic UI coverage had missed.
Alpha.41 repairs local one-time approval/cancellation and same-thread terminal
attachment before that first turn completes, with separate retained-backend
capability checks. It also clears an obsolete terminal-exit notice on display
restart. The native runtime evidence uses local synthetic inference with no
external paid model request; native internal title work is counted separately.
See testing.md and A41-1/A41-2 in review.md. This does not broaden the earlier
physical IME, onboarding, fleet or external Desktop integration claims.


## Native-fleet follow-up — alpha.42

The first follow-up slice now exposes observed child lifecycle without confusing
root reply/tool completion with child completion. Actual native window continuity
and room join/leave retain the same root/child identities and unsent draft. This
is a verified visibility increment, not closure of the larger fleet gate: complete
inventory, active-backend migration, full termination and live Claude Teams
continuity remain separately unverified. Source/installed evidence: testing.md.
