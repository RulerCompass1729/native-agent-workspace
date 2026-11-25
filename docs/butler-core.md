# Record-only butler core

The app now records passive local queue facts, including before a butler is
designated. Native/model activation and the working-day recording trial remain
off. No provider, automatic judgment, queue write or lifecycle operation is
started by this intake. The complete B4 feature and installed acceptance remain
open.

The core separates the butler's designation from the queue secretary. A trusted
host supplies an unforgeable person context, the actual caller record and the
current runner binding; model-authored identity fields are not authority.

The designated execution identity is a DSH butler instance. Its actual record must
match the selected session/native IDs, runner/backend binding and selection
revision; changing a provider label or constructing a lookalike caller grants
nothing. `actorRecord.provider === 'dsh'` identifies the execution harness, while
`runner.provider` names the configured model vendor. These are different fields.
The identity correction changes neither the five proposal kinds nor their
`effect:none`, record-only mode, default-off state or person-only controls.

`ButlerBackend` requires explicit non-secret host metadata:
`configuration: { profile, provider, model }`. Here `profile` is an opaque named
configuration, not proof of a native Codex profile. There is no model/vendor
fallback in the shared backend. Missing configuration refuses preparation/start
before checking presence or qualification. A different configuration/runtime
cannot reuse or rewrite an existing reservation. All four qualification defaults
remain false. The old dormant native factory supplies its former values only at
that legacy boundary; the DSH factory is a separate integration by its owner.
The legacy runner rejects any different configuration triple before its spawn
work. Backend `read()` and `snapshot()` throw `binding-mismatch` for a persisted
runtime mismatch, even without host configuration. With configuration supplied,
a different configuration also throws. A future host/UI caller
must catch that refusal and show a blocked state; upgrading never silently
rewrites or reuses the old binding.

- `butler-ingress.cjs` captures only structured queue decisions/failures and
  vacancy transitions. RoomState stores a compact source in the same commit as
  the outcome; startup recovery is independent of OS notification delivery and
  queue-row trimming. B1 retains its direct notification and the intake never
  asks it again. Vacancy episodes and their events share one journal append, so
  unchanged observations and restarts create no new event. The existing
  dispatcher supplies readiness/quiet/busy-filtered business fields without a
  new timer, connection or native-history scan.
- `butler-queue.cjs` is an unconnected transaction contract. The default host
  grant is false and its record-only result invokes no adapter. Synthetic-only
  granted tests require real caller/current role/canonical completed action and
  space checks again immediately before an atomic adapter commit. The adapter
  must retain the operation receipt independently of trimmed queue rows. There
  is no production adapter, S2 caller-proof route or creator-schema expansion.
- `butler-role.cjs` persists the person's selection and revision. It follows the
  existing complete `successor` rules for written done/kept rotation edges, then
  rechecks the resolved native identity and dedicated non-member runner.
- `butler-backend.cjs` reserves a separate private store, purpose, profile and
  runner identity. It neither changes the ordinary active backend nor pauses it.
  Its driver is a future trusted local adapter, not a native implementation.
  Default credential presence and tools/context/provider/S2 qualification are
  false. Unknown liveness or mismatched recovery never starts a replacement.
- `butler-ledger.cjs` appends durable events, batches, proposals, pending
  questions, delivery reservations, receipts and usage. Every business proposal
  has `effect:none`; there is no queue or lifecycle execution dependency. Host-issued canonical question sources and decision types prevent a rephrased
  open question, including one using another event reference, from becoming
  another notification. A new fact must be a matching host event after the answer. Reserved deliveries recover as unknown without resend; completed but unreserved
  questions and reports resume without waiting for another model batch. READY
  reports include every READY source even if the model omits its report.
- `butler-business.cjs` provides a designated, read-only capability for bounded
  queue and structured-delivery queries. Its sole tool dispatcher rejects all
  conversation/history/general-control methods, even with ordinary approval.
  Production DSH wiring remains unqualified; see [the business boundary](butler-business.md).
- `butler-policy.cjs` builds only an active-space business index and validates a small
  proposal vocabulary. A queue proposal has no executor. Ambiguous spaces become
  a pending decision only when the source has the host's canonical question key
  and decision type; otherwise that candidate is suspended for review.
  Native histories, environment objects, arbitrary commands,
  claimed execution effects and model-authored usage are rejected.
- `butler-controller.cjs` consumes events without an interval or heartbeat. The
  first READY starts one non-extending batching deadline, including after restart.
  Construction marks an unconfirmed running batch failed even if the host skips
  `resume`; only an explicit recovery event can retry it. New events arriving
  during a turn are batched afterward without concurrent turns. B1 outcomes are
  recorded without spending a model turn to repeat them. Budget and unknown-cost
  checks precede native work; every attempt gets a durable unknown-cost marker
  before submission. Failed and late attempts retain their own usage; unknown
  costs block automatic work even across a UTC day boundary. Actual usage
  belongs to the trusted adapter, not model JSON.

Events share the policy validation before being journaled. Context capacity is
checked before creating an active batch. Invalid candidates are retained as
suspended records with no effect, while independent valid proposals and the
trusted READY report complete. A suspension records judgment of the source; it
does not claim execution or an answered question. Invalid JSON replies retain a
failed batch for explicit retry. Host context failures preserve pending business
events without creating or quarantining a batch. Publication recovery failures
record a blocked notice and retry only on the next real event or explicit resume;
rule-only B1 events are still consumed. There is no periodic recovery loop.
An unavailable global publication context or ledger also holds new batches. If
startup recovery is blocked, a pending READY has no timer until a real event or
explicit resume restores processing. Individual stored-question errors identify
that question and leave independent questions, reports and new batches usable.
Stored delivery identity is checked before any source admission: a later decision
on the same source cannot invalidate a previously accepted question or resend it.

Private records use restrictive ownership/mode checks. Corruption or uncertain
writes preserve the source record and stop processing. These same-user file
checks are not protection against a compromised host account. The ledger is
single-writer and rejects a changed file rather than silently merging writers.
Clean history deletion/rollback, concurrent process writers and automatic stale
lock repair are not qualified here; native activation must keep those recovery
limitations visible. The reported cursor is a conservative contiguous confirmed
prefix; per-report receipts determine whether an individual report was sent.
The low-level quarantine operation has no recovery interface here and is not
used by the controller for ordinary candidate or host-context errors.

## Remaining connection gates

S2 is present in the source base. The target execution layer is NAW's own DSH
agent loop with DeepSeek, above the independent native session service. The old
Codex composition remains dormant and is not the target of further qualification.
The source now accepts the designated DSH instance through the existing identity
checks. This does not qualify live tools/context, provider privacy, credentials,
usage accounting, installed operation or a working-day trial. Those gates remain
closed until the DSH host and its business-only tool boundary are integrated and
verified. No other model adapter is added here.

The business-only input/tool capability is implemented in source, but is not
proof that a live runtime exposes only that dispatcher.

The desktop pairs the dedicated NativeHost/service driver and name-only profile
checks with the existing backend, without preparing or starting it. Native provider compatibility remains
unverified. The next source stage needs direct person-request ingress and controller binding, the
person-only designation menu/dialog, a production queue transaction adapter
and the non-member rotation/create-plan hooks. The core's pure
rotation candidate filter and role successor are not a claim that those hooks
are already connected. Missing or unverified provider usage/cost and reminder
settings also keep automatic work off.

Native integration must also provide a reviewed reconciliation path for unknown
costs and a decision on unsent questions from a revoked designation revision.
Neither a new UTC day nor a new designation silently replays those uncertain
operations. Blocked notices without a batch currently dedupe for their recorded
scope; the host must surface rejected input, and future journal validation
changes must preserve the recorded schema's replay rules.
The durable audit projection includes suspended candidates and their sources.
Its person-only review API and record-table renderer are connected below;
installed suspension notification remains separate work.
Host mapping must give different decisions of the same type distinct source
references. Canonical question keys still dedupe a single decision across those
references. Raw B1 observation errors must be surfaced by the host caller.

After those gates and integration, a real working day in record-only mode needs
the person's review: at least nine tenths agreement and zero repeat questions,
with the actual sample count. Synthetic tests cannot pass that acceptance or
enable queue-only/lifecycle execution.
The rate counts distinct admitted suggestions once, even when they appear
repeatedly. Suspended candidates are listed separately and excluded from its
denominator. Complete occurrences and sources remain available for audit;
unreviewed suggestions are never assumed to agree. Fewer than ten distinct
suggestions means insufficient samples, with no agreement conclusion. The
canonical projection and durable audit confirmation are connected below; their
audit-only provenance cannot certify the working-day trial.

Both host code and the record-table renderer must use the same arithmetic from
`butler-review-policy.js`, rather than copy a sample threshold:

```js
const { MIN_REVIEW_SUGGESTIONS, agreementSummary } = require('./butler-review-policy.js');
const quality = agreementSummary({ distinctSuggestions, agreedSuggestions, confirmed });
```

The browser export is `NativeButlerReviewPolicy`. `MIN_REVIEW_SUGGESTIONS` is 10.
`quality.status` is `insufficient-samples` below that value, `unreviewed` before
explicit confirmation, and `reviewed` otherwise. The first two return null for
both `agreementRate` and `agreementMeetsThreshold`; the reviewed case calculates
the rate and compares the nine-tenths threshold exactly. Callers provide the
deduplicated admitted-suggestion counts, excluding suspensions. This arithmetic
does not establish actual question delivery, a full working day, overall
acceptance or authority to activate the butler. Logical delivery reservations
and blocked candidates cannot certify zero repeat questions. The delivery
measurement below is required before the working-day trial; its unknown result
cannot satisfy that trial.

## Durable person-only audit review API

This source checkpoint serves the vision's attention goal: the person can resume
one exact set of proposed work and its sources without reconstructing previous
judgments. It records an audit review; it neither activates the butler nor opens
the working-day recording period. The review-table renderer is a separate
consumer of the following frozen interface.

`window.workspace.butlerReview(action, ...args)` is a dedicated preload method.
Main uses the existing Ingress ledger writer and its measurement epoch. Every
operation requires the same live, non-background window context currently held
by Main, including reads and availability. A claimed `kind:person` is not
identity. The command is removed from the generic agent catalog/invoke map,
and a trusted background renderer's direct IPC is still refused. Review records
are not added to initial state, ordinary display state or view state.

| Action | Arguments | Result |
| --- | --- | --- |
| `availability` | None | `{available, hasData, activation:'off', recordPeriod:'off'}` only; no ledger snapshot |
| `latest` | None | Latest stored review or `null`, without creating a new review |
| `read` | `reviewId` | That stored review |
| `freeze` | None | Reuse the saved latest review when only audit records changed; otherwise freeze a new head. Main fixes `afterSequence:0` and audit-only provenance |
| `reads` | `{afterSequence?, limit?}` | Person-only paginated read-audit metadata; independent of the suggestion ledger |
| `confirm` | One request object below | Current durable review with the saved confirmation |

The existing butler panel is the sole record-table entry. Its host-provided
`entry.reviewAvailable` must come from the same ledger writer's
`hasReviewData(context)` result; `available` alone reports storage health. This
person-only data bit
reads the existing action/suspension/current-failure indexes and one replayed
flag for a nonempty saved review, without cloning or scanning the journal.
Pending facts and an empty frozen review do not create an entry; a failure-only
review does. Storage failures offer no review action. The existing entry
projection offers review only in ready, held or recording states, when that
data flag is true; this integration preserves those approved state rules.
Main currently supplies no butler entry view, so the production entry remains
hidden; this UI adds no fallback entry or second business-state projection. No
review body enters an ordinary state update.

The renderer opens the saved latest review and restores its marks, all-read
confirmation and revision. The person's first opening, or opening a previously
empty saved review, can freeze the current head. Otherwise only an explicit new-audit
action freezes it; that action is disabled while the person has an unsaved draft. Failed saves
retain that draft. The adapter checks the identity, digest, expected revision
and both mark sets before reporting success. The shared structured display-error
path carries conflict/capacity reasons through sandboxed preload. The panel
closes before its `openReview` callback opens the record dialog. That explicit
click rechecks person-only availability and requires both `available` and
`hasData`; concurrent clicks coalesce. Closing returns focus to the sole butler
row if it is still visible, and hiding the host entry closes the record dialog.
There is no availability timer, poll, or automatic freeze. Both recording and activation
remain off. Audit records show zero working-day samples, distinct from synthetic
examples and qualified real samples.

The exact confirmation request is:

```js
{
  reviewId, contentDigest, expectedRevision,
  disagreedSuggestionIds: [], disagreedCandidateIds: [], allRead: true
}
```

No renderer-supplied scope, rows, counts, provenance, identity or activation
settings are accepted. IDs must belong to the frozen review. Personal
confirmation is independent of `answerQuestion`; it cannot answer or withdraw
an outstanding business decision. A new confirmation appends a revision, a stale
competing revision fails, and repeating a previously accepted request returns
the current stored review without rolling back a newer revision.

Every returned review contains `reviewId`, `contentDigest`, `projectionVersion`,
`window:{afterSequence,throughSequence}`, `provenance`, `frozen`,
`questionMetrics`, `createdAt`, `physicalSeq`, `revision`, `confirmation`,
`confirmations` and `summary`. `provenance` is exactly
`{kind:'audit',recordPeriod:'off',activation:'off'}`. Before confirmation,
`revision` is zero and `confirmation` is null. Each saved confirmation retains
its digest, expected and accepted revision, disagreement IDs, all-read
attestation, physical sequence and confirmation time; `confirmations` preserves
that history across restart.

`frozen` has `projectionVersion:1`, `sequence`, `afterSequence`,
`throughSequence`, `rows` and `failed`. Rows retain each occurrence with `id`,
`batchId`, business fields, complete `sources` and `batchSources`, missing
source IDs, selection and question evidence/status when applicable. Admitted
rows have a canonical `suggestionId`; suspended rows have a `candidateId` and
remain outside the suggestion denominator. A missing or ambiguous source stays
visible and unassessable. All occurrences remain visible even when several
share one suggestion ID. For questions, identity follows the canonical question;
other suggestions use the trusted source business key, target space and full
business text, without trimming or inferred natural-language equivalence. If
any occurrence of a suggestion is unassessable, that whole suggestion cannot
count as agreed. Later source events, question changes and caller mutations do
not rewrite the frozen evidence.

`summary` contains distinct, agreed, disagreed, unable and pending suggestion
counts, marked suggestions, suspended/disagreed candidate counts, plus the
shared policy's `status`, `agreementRate` and `agreementMeetsThreshold`. Both
host and renderer must import `butler-review-policy.js`; do not copy its minimum
sample value. Suspended candidate disagreements are saved separately. Unknown
sources remain in the admitted denominator but cannot contribute agreement.

`questionMetrics` is the actual-send counter frozen at the same journal prefix.
An owned healthy epoch's prefix certificate and the freeze share one atomic
append. A later display cannot alter those metrics; absent or incomplete
coverage leaves `repeatedQuestions:null`. Neither an audit confirmation nor a
new epoch converts uncertainty into a verified zero. The existing 2 MiB record
and 32 MiB journal limits apply: capacity failures preserve the earlier journal
and fail explicitly, without truncating sources or claiming a saved review.
Projection budgets each row before cloning it.

The renderer should call `latest` when opening, restore its confirmation and
revision when present, and explicitly `freeze` only when a new audit is wanted.
A freeze may reuse the same review ID, nonzero revision, saved confirmation and
older window if its suffix consists entirely of review freeze/confirmation
records. Reuse writes nothing. A business or metric record, or another requested
window, requires a fresh freeze. Real Main startup opens a new metric epoch, so
reopening the application can require a new freeze; simply reopening a ledger
without such an epoch is different.

These are bounded audit records, not an unbounded retention scheme. A projection
above 2 MiB is explicitly refused; repeated source changes can still fill the
shared 32 MiB journal. Establish the recording period's bounded window before a
working-day trial. A future change to projection or metric semantics must preserve
v1 replay or introduce a versioned reader, with a pinned historical-journal check;
it must not silently reinterpret saved reviews.
Its request token must bind review ID, content digest and revision. When mapping
UI marks, remove only the outer `suggestion:` or `candidate:` prefix; a canonical
ID can itself start with that prefix. Keep the draft on errors, and verify the
returned revision/confirmation against the request and current generation before
showing it saved. A non-null confirmation alone does not prove a new draft was
saved. This contract permits the C2 renderer to connect without reproducing
Ledger policy or using business-question answers as review persistence.

## Source checks

The new core and its direct secretary/membership dependencies have deterministic
Node tests in `app/tests/butler-*.test.cjs`. They use synthetic records and fake
local drivers, not a provider, model endpoint, user session or installed app.
B1 notification text and native dispatch actions retain their existing behavior.
Passive intake adds local source records and a small off/blocked status in window
state. It does not enable an execution path. The future controller must reuse
the intake ledger owner; this checkpoint does not qualify concurrent writers.

## Passive intake boundaries

An ordinary completed queue item is not a READY handoff. B6's typed completion
fact now retains a compact source with the complete original queue task, branch
and commit in the same durable write. Only after that write does its intake
callback admit the source to the existing ledger. Recovery uses the retained
source even after its queue item is trimmed; no task-board, private conversation
or additional terminal parser is used. Earlier B6 monitor rows without that
auxiliary source remain in space history and are not backfilled from short text.
Direct person-request ingress and a live controller binding remain later work.
When a trusted intake has already committed an event, its future controller
binding must call `notifyPersisted(eventId)`, which reads that exact pending
event from the ledger. Calling `receive` with the event again retains its
existing duplicate semantics and does not start a READY window. Notifications
reuse the original event time and one non-extending timer; they cannot admit new
text, repeat a consumed event, or authorize a failed batch retry. This is a
dormant scheduling interface, not an activation switch or a live controller binding.
A persisted recovery event also grants no retry authority; sending that same ID
through `receive` remains a duplicate. A future host must use a separate,
explicitly authorized retry path rather than replaying a notification.
Source intake failures keep the durable room event, and expose a fixed blocked
status. They do not prevent B1's independent notification or claim the input was
consumed. The initial vacancy projection uses the dispatcher's observed snapshot;
a separate passive readiness clock survives skipped maintenance ticks while the
native dispatch clock keeps its original freshness rules. A newly reopened
window waits for readiness evidence without declaring that a previously active
vacancy ended. The same unknown-settling rule applies between observations; a
brief busy spell between minute-apart passes can remain in the same episode.
This is passive sampling, not a continuous idle trace. No model is called to retry a source or observe an unchanged
empty queue. An extra eligible member within an already active room is included
in capacity metadata; the persisted episode is per room.

Bad auxiliary sources remain on disk and become separate blocked B4 records;
they cannot make a space unreadable or prevent its queue writes. Intake errors
are tracked by source, so unrelated success does not erase a pending error. A
rejected display name is omitted without preventing later rooms from being
observed. Internal butlerSource fields are excluded from ordinary exported room
events; the source intake reads the private metadata directly.

While activation is off, vacancy facts can accumulate toward the ledger's finite
capacity; there is no automatic history deletion or paid drain. An explicit clear
of space history can remove sources not yet copied to the ledger. The ledger is
a separate audit record, and this checkpoint does not change history-deletion
semantics or qualify a data-erasure workflow.

## Actual question delivery measurement

`ButlerLedger.questionSendMetrics(window)` counts managed, formal outward asks,
not candidate text, a logical reservation, a transport's `sent`, or opening an
already displayed question. The B1 OS notifier is connected; dormant controller
asks use the same ledger. Activation and the working-day record period stay off.
Raw native candidate audit remains separate and is not silently reclassified as
a question sent to the person.

Every outward operation first journals a host-generated unique `attemptId` with
canonical `questionId`, `deliveryId`, `sourceEventId`, and channel `notification`
or `butler-ask`. For B1, `sourceEventId` is the ledger source (`butler-source:…`),
not the original space event UUID. `ButlerIngress.record` returns those IDs for
decisions; `bindQueueOutcomes` supplies that receipt as the notifier's second
argument even when intake fails (then undefined). B1 still displays on intake or
measurement failure, with incomplete attribution or coverage.

The OS adapter counts Electron's actual `show` event. Electron documents this as
emitted when the notification is shown; `show()` returns void, and does not prove
display or reading ([Notification API](https://www.electronjs.org/docs/latest/api/notification#event-show)).
`failed` is known not displayed; no event or an uncertain exception stays unknown.
A second unexpected display event creates a coverage gap. A future trusted ask
adapter receives `ask(question, observe)` and calls `observe('shown')` only from
its actual user-visible display receipt, or `failed`/`unknown` as appropriate.
The callback is never model-authored. A generic return value cannot certify
actual delivery. Without a durable intent the controller does not ask. Duplicate
ACKs of one attempt are idempotent; a second shown attempt for the same canonical
question, including across channels or restarts, counts as a repeated ask. New
host-validated facts after an answer can establish a new question version.

| Field | Meaning in the selected journal window |
| --- | --- |
| `shownAttempts` | Actual display receipts, including unattributed displays |
| `knownRepeatedSends` | Confirmed repeated displays of a canonical question; a lower bound when coverage is incomplete |
| `repeatedQuestions` | The actual repeated-ask count only with complete coverage; otherwise `null` (unverified) |
| `unknownAttempts`, `unattributedAttempts` | Unresolved physical sends and sends without a validated canonical question/source |
| `duplicateQuestionCandidatesBlocked` | Model question candidates blocked by the pending-question rules; not outward asks |
| `suspendedQuestionCandidates` | Suspended question candidates, separately audited |
| `coverage` | `complete`, `incomplete`, or `unavailable`; never infer zero from the latter two |
| `unobservedDecisionSources`, `unobservedLogicalDeliveries`, `uncertainBaselineQuestions` | Missing instrumentation or uncertain earlier delivery of a question actually shown in this window |

Windows use physical journal positions `(afterSequence, throughSequence]`, not
business event `sequence`, timestamps or batch counts. Projections expose
`physicalSeq` (and `completedPhysicalSeq` on completed batches); event `sequence`
keeps its original business-event meaning. Use the **existing ingress writer**
for an active measurement; opening a second ledger does not inherit its authority:

```js
const ledger = butlerIngress.ledger;
const throughSequence = ledger.snapshot().sequence;
ledger.checkpointQuestionMetrics(throughSequence);
const metrics = ledger.questionSendMetrics({ afterSequence, throughSequence });
// Record-table repeat row: metrics.repeatedQuestions === null -> unverified.
// Candidate-block row: metrics.duplicateQuestionCandidatesBlocked.
```

The host opens one durable measurement epoch at startup, closes it on normal quit,
and reuses its writer across startup retries. The review-period owner must persist
`afterSequence` when that period starts and freeze `throughSequence` alongside the
review snapshot. An explicit checkpoint certifies only the observed prefix for a
later read; it does not fix unknown sends or authorize the trial. No heartbeat is
used. A fresh reader or restarted writer cannot adopt a previous open epoch or
ACK its sends. Unclean suffixes, failed writes and unconfirmed physical intents
stay unknown after restart. Known historical prefixes remain available. Unrelated
legacy logical receipts do not poison a new window, but an uncertain earlier
showing of the same question does. Old unresolved physical intents remain unknown
because they may display late. `snapshot()` contains only replayable data arrays
(`questionSends`, `questionMetricEpochs`, `questionMetricGaps`); it does not contain
a dynamic metric that a fresh reader could misrepresent as complete.

The working-day record table must preserve `null` as unverified; actual repeat 0
is one separate gate alongside a full day, at least ten distinct admitted
suggestions and the person's confirmed agreement. No installed OS notification,
real working day or enabled production ask adapter is qualified by synthetic
EventEmitter/unit checks. All future formal outward ask channels must use this
measurement before they can participate in acceptance.


## Shared UTC-day usage reading (source, dormant)

`require('./butler-usage.cjs').summarizeUsage(ledger.snapshot(), { now })` is the
shared read-only calculation for the person's entry and `Controller.budgetReady`.
Use the existing healthy writer, not a second ledger. It returns `{utcDay, asOf,
today, guard}`. It does not authorize a call, qualify a runtime or start a period.

`today.recordedRunCount`, `attemptCount` and `legacyBatchCount` count ledger runs,
not HTTP requests. One DSH run may make multiple requests, and an uncertain attempt
may not have reached a provider. `providerRequestCount` remains null until trusted
provider-request measurement is persisted. An empty-day zero describes the ledger,
not a verified provider bill or proof that no requests occurred.

`today.costMicros` and each `today.tokens` field (`inputTokens`,
`cachedInputTokens`, `outputTokens`, `totalTokens`) return `{value,
knownLowerBound, unknownRuns, overflow}`. Any missing reading makes its complete
value null. The subtotal adds only supplied values; overflow makes both totals
null. There is no price conversion, inferred token total or missing-cache zero.
`knownLowerBound` is a subtotal of recorded values, including any marked estimates;
it is not a verified lower bound on the actual bill. Keep source and estimate
uncertainty visible: `sources:{values,unknownRuns}` and
`estimated:{yes,no,unknown}` preserve absent or mixed metadata.

Attempts belong to their start UTC day, including retries, stale and quarantined
attempts. Any attempt coverage suppresses the completed-batch fallback. Legacy
completed batches without attempts belong to their completion UTC day. The guard
retains the existing first-failure order: any historical unknown attempt cost
blocks; an old legacy unknown cost does not newly block. Cost overflow is invalid;
token overflow alone does not change the monetary guard. The person's budget,
estimate gate and reminder path retain their existing semantics. A two-dollar
reminder is not introduced here as a new cap. `guard.reason:null` grants nothing.


## Business read audit (source, activation closed)

`ButlerBusiness` records an allowed page's metadata before release, then rechecks
the bound instance. Its separate private audit store atomically enforces 64 pages
per UTC day across role changes and restarts. It never stores business bodies or
raw cursors. A quota or audit failure returns no page. The review IPC's new
`reads` operation exposes only this metadata to the current person window, using
the same opaque window verifier; it has no agent catalog entry. See
[the exact audit and quota contract](butler-business.md#read-audit-and-page-allowance).
The host must explicitly pass its shared `ButlerReadAudit` instance; there is no
implicit audit directory based on the role record's path. Reconstructed business
capabilities and the human reader use that shared store.
Business records through the fixed base entry and private audit implementation,
so an instance or subclass public-method override cannot supply its receipt or
skip the allowance. The base static check and record entry cannot be replaced.
This protects host API composition, not arbitrary same-process code execution.
Runtime acceptance still requires the actual Main factory to inject its real
`dataDir` and the single `butlerReadAudit` also used by the person's reader.
Two matching but incorrect directory arguments do not establish correctness;
that production factory injection remains unverified in this checkpoint.
Human reads also return the log's size against the person's 0.5 GiB reminder line
(2026-11-11). The log is kept whole in blocks of at most 32 MiB with no cap on the
whole; the UTC allowance and retained records stay unchanged.
An optional trusted-host callback emits only capacity metadata after a successful
operation and lock cleanup; it adds no timer or UI delivery claim.
This neither changes the USD reminder/budget policy nor approves activation,
legacy automatic context or a real provider trial.


## Person controls (source, activation closed)

The dedicated IPC is closed in normal runs. Only the existing verified isolated
test profile together with `NAW_TEST_BUTLER_ENTRY=1` enables its source-phase
handler, after the real person-window check. The flag does not enable a model,
recording period or designation offer. With it, a person window is answered
with the entry it draws (below); without it every call is refused and the
window shows nothing about a butler.

The dedicated `workspace.butler(action, ...args)` IPC accepts only the current
live person window. It is removed from the agent catalog and generic invoke
map. Construction reuses the existing ingress ledger and never prepares a
backend, checks credentials or starts a runner. Status is not added to ordinary
window state: a person window asks for it once as it starts, when it comes back
to the front, when the entry opens and after each action. A refusal that means
the entry is closed ends the asking for that window.

| Action | Arguments | Source-phase result |
| --- | --- | --- |
| `status` | None | The entry a person window draws: designation configuration, reminder line, host answer, bounded usage, fixed closed phase |
| `recheck` | Expected role revision | One presence-only probe after revision validation, then the same entry |
| `designate` | Expected role revision | Blocked until a trusted actual DSH candidate exists; no inferred identity or budget |
| `revoke` | Expected role revision | Persist revocation, preserve the ledger, then report cleanup separately |
| `setActive` | Boolean, expected role revision | `true` refused; `false` requests only the selected target's cleanup |

What leaves the main process is built by `app/butler-entry-host.cjs` from the
core's person view, copying named fields only. The session identity, runner and
backend references, batch ids and stop targets stay in the main process; the
result of `designate`, `revoke` or `setActive` keeps its plain facts (status,
reason, revision, stopped or not known) without the target it acted on. The
core's `open` and `close` capabilities are not action names of this call and
are not passed on. Whether this version can start a butler is a constant of the
build (it cannot), never read from a host that reports ready. The window sends
an action and the revision it was drawn for, and nothing else: a third argument
is refused. When designation becomes possible, the main process must compare
what the confirmation page stated with what it would really select, and both
sides change together.

Status uses only this object's explicit display-probe result. Legacy backend
negative presence and its `credential-missing` reason cannot prove absence:
the old startup probe also returns false on failure. The display-only probe
returns a boolean only for a successful bounded Boolean-only receipt; spawn,
timeout, protocol and exit failures remain unknown. A confirmed missing reason
is shown only after this object's successful negative probe. The startup gate
is unchanged. The display probe is synchronous and bounded to three seconds;
only an explicit recheck calls it. Status does not probe the environment. Unknown readings remain
unknown, and no recorded runs do not certify zero provider spending. The shared
UTC usage arithmetic is retained; arbitrary source labels are reduced to counts.
The reminder amount is separate from a selected budget; this checkpoint changes
no monetary guard.

A pause is based only on a persisted failed active batch matching the current
selection revision, both identity IDs and runner reference. Its batch creation
position, ledger head and failure time remain distinct facts. A computed usage
guard, an in-flight batch or a notification alone is not a recorded pause.

Main does not yet supply an owned-stop adapter. Physical `stopped` and
`cleanupConfirmed` therefore remain `null`; source activation `off` and a saved
revocation prove no physical exit. A future adapter must resolve the exact
captured target and prove both stop and cleanup, including after restart. A
fresh driver with no local child is not that proof.

This IPC view is not the renderer's versioned `butler.entry` view. No offer or
confirmation is synthesized, and an extra designation-confirmation object is
refused in this phase. The renderer remains closed; its future host adapter must
preserve unknown status, compare the displayed selection against the actual
trusted candidate and respect the still-pending activation decisions.

The persisted designation and its resolved current identity have separate
availability. `role.available` means the designation can be read and validated;
`role.currentAvailable` means the rotation view can also be resolved, or the
readable designation is empty. When a rotation log changes during a read, is
temporarily unreadable or has a malformed tail, status retains the saved
revision, configuration and budget, but returns `state:unknown`,
`selected.identity:null`, no pause and no close target. During a failed read it substitutes neither the original identity nor a
previously resolved successor. A later valid complete log read can restore the
current identity on the same Role instance. For file-backed reads in the same Role object, observed history now has a
seen-file flag, a nondecreasing safely observed byte count, and the length/hash
of the last fully parsed, accepted prefix. Missing history after a file was seen,
shrinking it, or replacing verified bytes refuses the read. A changed named path
is checked again after the descriptor read. No snapshot or cached identity is
returned as authority. A branch, cycle or kept edge appended after an observed
handoff cannot resolve back to an earlier identity: a fresh resolution from the
original must agree with one from the last observed identity for that selection.
That latter identity is only a comparison, never a fallback result. A branch,
cycle or kept disagreement can keep this Role and selection revision unavailable.
The verified part now survives restart in `butler-rotation-proof.json`.
This private bounded file contains only version, a hash of the canonical saved
selection, proof revision, verified raw-byte prefix length/SHA-256, and resolved
session/native ids. It contains no log lines, names, reasons, conversation text
or credentials. Production `current()` takes the same cooperative Role lock used
by human changes, reloads the latest selector and proof, then reads the actual
log and verifies its accepted prefix and resolution. Before returning an advanced
identity it atomically replaces and fsyncs the proof file and directory. A second
reader cannot replace a newer proof using an observation made before that lock.
A changed or shortened verified prefix, missing seen history, or an appended
branch/cycle/kept disagreement therefore refuses in a fresh Role or process too.
Within one object, proof revision rollback and changes at the same proof revision
also refuse. No proof or last identity is returned as cached authority.

A proof read confirms file and directory durability before accepting it. Only an
unchanged inode/version and identical raw-byte hash that this object already
successfully synced can omit that acknowledgement; fresh proof bytes and the
real log are still read and checked every time. Failed directory sync is never
remembered as an acknowledgement. This cache changes I/O cost, not authority.

New on-disk selectors use version 2; the public set/snapshot shape stays version
1. The previous strict reader refuses the new disk version instead of silently
bypassing its required proof. Legacy version-1 selections remain visible and
human-revocable in the new reader, but file-backed `current()` refuses them;
there is no automatic proof creation from an untrusted existing log. A human
set prepares the new proof durably before replacing the selector. Re-designation
carries the recognized stored proof's recorded byte prefix, including after cold
restart, revoke or an interrupted selector replacement. It does not inherit that
proof's old identity, runner or authority: the person selects those anew. When
both disk and memory have a prefix, equal-length conflicting hashes refuse;
for different lengths, the actual log must satisfy both before the longer
constraint is carried forward. A revoked/interrupted selection hash need not
match the new selection to retain that restriction. This carries the recorded byte restriction,
not all prior selection-specific semantic comparisons when the person selects a
new origin. Malformed/unsafe proof still blocks re-designation; a human recovery
route for it remains separate pre-activation work. A well-formed stored prefix
that no longer matches the log also requires such a recovery route; re-designation
must not erase it to make current() succeed.
An interrupted set can leave a mismatched proof and must refuse model authority. Missing,
malformed, unsafe or mismatched proof blocks current identity without poisoning
the readable saved selection or its revision-checked human revoke. Revoke neither
reads nor deletes the proof, log or ledger. Recovery or re-designation after
corrupt proof remains separate user-facing work.

Only successfully verified prefix/identity advances are durable. Safely seen but
unverified tail lengths remain process-local; restart cannot discard verified
bytes but can forget that unverified high-water observation. Changes never seen
or verified, and restoring an older valid proof together with compatible log
bytes (including jointly rolling back all trust sources), are outside this
protection. The proof file is not a tamper-proof external monotonic counter. A missing log never observed still resolves the saved identity
only with a valid required proof. This is a local continuity guard, not a trusted
DSH handoff producer or transport/physical-stop proof. Those activation gates,
packaged-runtime qualification and default-off controls remain unchanged.
Trusted explicit-entry fixtures retain their parser semantics, never write proof
and never affect real-log observations; production Controller, Business and
Queue authorizations all use the file-backed form and must keep doing so.
A full-source invariant pins every named direct authorize/current call in the
production Butler modules to three/zero arguments respectively. It does not
claim to detect indirect aliases or arbitrary runtime code changes.
The shared Main Role must be retained across bindings rather than reconstructed
for each model call. Model reads, bindings and queue commits still fail closed
on an unresolved rotation view.

A readable saved designation remains human-revocable without resolving that
view. Person verifies the expected saved revision, then the real Role writer
reloads and checks it again under its existing lock before persisting the clear.
Cleanup resolution is best effort and cannot prevent that clear: an unknown
target receives no stop call and returns unconfirmed cleanup with null physical
stop fields. The ledger is retained. Close and designate still require a resolved
current identity; this recovery grants neither operation a fallback identity.

A selection `readSync` EIO after the private file was safely opened refuses the
current call with `ERR_BUTLER_STATE`. Only that internally identified read fault
allows the same Role to try a future explicit call. It returns no old snapshot,
identity or empty designation. A later complete, stable read must still pass
all file, schema and saved revision/content checks. Safe opened-file existence
is remembered before its first byte, including a constructor read failure, so a
later missing file cannot become the never-designated initial state.

The locked writer can see this fault only while loading the selection before
creating a replacement. It writes no designation in that case and releases only
its own lock. Any uncertain fd close or owned-file cleanup remains sticky;
write/fsync/rename failures are never read retries. An I/O error in lstat, open,
fstat or final metadata checks is also not covered. Role itself schedules no
retry. The existing human status path may make another complete snapshot read
when resolving current identity fails; that can restore saved metadata and the
revoke action, but current identity stays unknown. If resolution fails during
revoke, the saved role can still be cleared while stop/cleanup remain unconfirmed
and no target is invented. None of these reads changes a permission, recovers a
legacy lock or proves physical shutdown.

Designation-file corruption, rollback, directory-integrity/permission faults and
uncertain writes retain the existing sticky guards. A rotation-log file with
unsafe owner/mode/link-count/size is refused on every affected read, but that
log-file error is no longer sticky; a later valid log may recover. On Darwin, new writers publish a fixed protocol marker from an already-written,
fsynced private stage through an atomic hard link. They hold a nonblocking
`O_EXLOCK` descriptor until their own published lock name is removed. This is a
cooperative file lock, not proof that a PID has died. A later writer can recover
only a safely read, recognized marker after obtaining its kernel lock and
rechecking the named path against that descriptor. A two-link crash window is
accepted only when both links are the canonical lock and the exact marker-named
stage inode; arbitrary extra links are refused. Selection files still require
one link. Recovery removes only those known protocol names, then competes for
the lock name atomically again. An old O_EXCL writer that wins that gap is kept.
Other platforms retain the previous no-recovery protocol.

Before publishing any Darwin marker, the holder opens its same private stage
again with `O_EXLOCK|O_NONBLOCK`. Only EAGAIN/EWOULDBLOCK is accepted as actual
contention. If the second descriptor succeeds, it is closed and that module's
process lifetime refuses all further acquisition/recovery as busy, even if a
later call restores the flags. No canonical lock is published or reclaimed.
Unexpected probe I/O also marks that module unavailable until restart; this
includes descriptor exhaustion and unexpected stage-open errors. This check guards against a runtime silently
ignoring the flag; it does not replace the still-required packaged-runtime test.


Empty, unknown, malformed, unsafe or still-held lock files remain busy; merely
being old or obtaining a new kernel lock on a legacy file never authorizes its
removal. An unpublished orphan stage is not searched for or swept. The protocol
assumes cooperating writers in the private directory and does not defend an
arbitrary same-user process rewriting paths or metadata. The exact host Node
Darwin protocol tests pass, but the owned embedded-runtime probe produced no
confirmation and exited SIGTRAP. Embedded Electron qualification remains open;
no activation or normal-App startup proof follows from the host tests.

A busy or legacy empty lock
is not recovered or stolen, and OS write failures or a stale expected revision
can still reject revocation. A failed directory fsync after rename is not called
durable success. Safe store recovery and reliable physical cleanup remain
pre-activation work; restart alone does not repair persistent malformed data.
No rollback, truncation or fresh Role instance hides uncertain storage.

In the same Role object, a complete recovery must retain the verified prefix
and cannot shrink any safely observed history, including an unverified tail.
Across restart the persisted verified prefix remains required; unverified tail
length observations alone are not persisted. A malformed suffix may be repaired
to complete valid data at least as long while preserving the verified bytes; a
valid shorter prefix is not an automatic recovery. User revoke still needs only
the readable designation and its locked revision check. Directory/designation
faults and unknown legacy locks remain unchanged; physical stopping is separate.

## Six parts of a dispatch

A dispatch from the butler to the project manager or a member (a queue item, a
NAW message, or a brief it points to) is read by a session that cannot see the
sender's reasoning. Weigh the six parts by the instruction's weight; not every
part needs filling, and a short instruction still states its cause and its end
signal.

1. 起因 (cause): the person's request and the problem it solves, with
   `file:line` when code is involved.
2. 现状 (current state): who is working on it, how far it has got, and where the
   evidence is.
3. 目标 (goal): what the work should achieve, why it is worth it and what it
   costs, so the receiver can judge how far an exception may bend it.
4. 边界 (boundaries): what must not be done, and what the receiver decides for
   itself.
5. 结束与失败 (end and failure): the signal that ends the work, which must reach
   and wake the receiver (a NAW message, queue item or event; a file alone does
   not), what to do on failure, and who checks when no signal arrives in time.
6. 未核实 (unverified): what the sender has not checked, so the receiver does not
   take a guess for a fact.
