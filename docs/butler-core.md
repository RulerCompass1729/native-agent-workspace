# Record-only butler core

The app now records passive local queue facts, including before a butler is
designated. Native/model activation and the working-day recording trial remain
off. No provider, automatic judgment, queue write or lifecycle operation is
started by this intake. The complete B4 feature and installed acceptance remain
open.

The core separates the butler's designation from the queue secretary. A trusted
host supplies an unforgeable person context, the actual caller record and the
current runner binding; model-authored identity fields are not authority.

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
- `butler-policy.cjs` builds only approved business context and validates a small
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

S2 must reach main before its trusted caller/control hook is connected. The
normal Codex app-server interface has no verified full-tool ceiling in this
checkpoint. Turning off shell alone does not disable independently registered
patch tools; project document limits do not turn off global instructions.
Tool/context qualification therefore remains false. This source adds no invented
Codex flag and does not infer provider compatibility from a saved profile name.

The dedicated NativeHost/service driver and name-only profile checks are now
available as a separate dependency. Native provider compatibility remains
unverified. The next source stage needs restricted automatic context and tool execution,
the remaining typed user-request/READY ingress and controller binding, the
person-only menu/dialog and review table, a production queue transaction adapter
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
The eventual working-day review table must include suspended candidates and their
sources; this core has no user-facing review table or suspension notification.
Host mapping must give different decisions of the same type distinct source
references. Canonical question keys still dedupe a single decision across those
references. Raw B1 observation errors must be surfaced by the host caller.

After those gates and integration, a real working day in record-only mode needs
the person's review: at least nine tenths agreement and zero repeat questions,
with the actual sample count. Synthetic tests cannot pass that acceptance or
enable queue-only/lifecycle execution.

## Source checks

The new core and its direct secretary/membership dependencies have deterministic
Node tests in `app/tests/butler-*.test.cjs`. They use synthetic records and fake
local drivers, not a provider, model endpoint, user session or installed app.
B1 notification text and native dispatch actions retain their existing behavior.
Passive intake adds local source records and a small off/blocked status in window
state. It does not enable an execution path. The future controller must reuse
the intake ledger owner; this checkpoint does not qualify concurrent writers.

## Passive intake boundaries

An ordinary completed queue item is not a READY handoff. No task-board, private
conversation or terminal text is scanned to infer one. Typed READY and direct
person-request ingress remain a later checkpoint; existing synthetic controller
READY batching is not a claim that a production READY producer is connected.
When a trusted intake has already committed an event, its future controller
binding must call `notifyPersisted(eventId)`, which reads that exact pending
event from the ledger. Calling `receive` with the event again retains its
existing duplicate semantics and does not start a READY window. Notifications
reuse the original event time and one non-extending timer; they cannot admit new
text, repeat a consumed event, or authorize a failed batch retry. This is a
dormant source interface, not an activation switch or a connected producer.
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
