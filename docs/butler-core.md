# Record-only butler core

This is a dormant source checkpoint, not an enabled assistant. No existing app,
service, native adapter, menu, task queue or rotation dispatcher imports these
modules. The complete B4 feature and its installed working-day acceptance remain
open. No provider is started by importing or constructing this core.

The core separates the butler's designation from the queue secretary. A trusted
host supplies an unforgeable person context, the actual caller record and the
current runner binding; model-authored identity fields are not authority.

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

The next source stage needs a real dedicated NativeHost/service driver, runtime
profile/provider validation, restricted automatic context and tool execution,
actual global event/B1 ingress, the person-only menu/dialog, queue transaction
idempotency and the non-member rotation/create-plan hooks. The core's pure
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
The original full-app behavior is untouched in this checkpoint.
