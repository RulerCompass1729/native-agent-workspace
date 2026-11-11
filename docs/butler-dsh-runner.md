# Dedicated DSH butler runner

The desktop factory constructs a dormant `ButlerDshDriver`. It does not prepare
a store, inspect credentials, select a butler or start a process. The four
tools/context/provider/S2 qualification defaults, activation and recording trial
remain off. Ordinary Claude/Codex services are unchanged. The legacy dedicated
Codex service modules remain for existing records; the desktop factory no longer
chooses them, and DSH refuses to adopt their stores. Desktop read/snapshot
converts incompatible/unsafe saved-state errors into a blocked status with no
binding. Core read/prepare/ensure refusal stays strict; no automatic migration,
launch or saved-record change occurs on an app-version mismatch.

The DSH host is a separate process. A trusted host supplies a dedicated binding
and a scoped `native_workspace` stdio MCP configuration. An absent MCP binding
is an error, never a fallback to ordinary agent tools. The production factory
does not yet supply that configuration or a controller activation path. A future
qualified composition must obtain it from B4's business-only control boundary.

The exact `0.2.1-rc.2` composition mounts system-prompt, llm, tools (native mode),
session, agent, session-projection, agent-loop, llm-deepseek-api-key and mcp-client.
It mounts no built-in execution tools, telemetry, account, analytics, subagent
or compaction plugin. Agent-scoped tool restrictions retain only the trusted
MCP allowlist; only `mcp__native_workspace__*` names are accepted. This does not
replace S2 authorization for any individual NAW command.

## Anonymous headers

The pinned provider has no opt-out. Its optional Files API `fetch` hook does not
cover the model transport, which directly calls global `fetch`. The registration
function also unconditionally installs the anonymous-ID resolver. Therefore this
uses the third allowed option: an auditable, host-local pinned-source patch.

`butler-dsh-privacy.cjs` checks both version and the complete upstream source
SHA-256, then removes exactly the two header expressions. Removing the user-ID
expression also removes the only call to its resolver. A Node module load hook
applies this source only in the dedicated host before any DSH import. It changes
neither `node_modules` on disk nor the desktop UI's module instance. Unexpected
version, bytes, unsupported Node hook API, or an import that did not pass through the pinned hook refuse startup. There is no proxy,
alternative model transport or silent compatibility fallback.

The loopback witness requires both headers absent on every request. A clean
DSH home must not create `.anonymous-user-id`. A second launch puts a FIFO at
that exact filename: any read would block, while normal model/tool completion
must still occur. The dependency still exists on disk as an upstream utility;
the proof is about execution and wire behaviour, not removing its package name.

## Credentials, lifecycle and accounting

Presence checks return a Boolean only. A missing credential reports
`DEEPSEEK_API_KEY is missing from the butler launch environment.` The launcher
inherits only the API-key entry without copying its value into JS
arguments/configuration/logs. Python runs in isolated mode (`-I`); the launcher
drops other entries by name, including inherited base URL/proxy configuration,
and sets a dedicated home. Production pins `https://api.deepseek.com/anthropic`. The
non-exported desktop composition has no endpoint option; a driver test dependency
accepts only an explicit IPv4 loopback URL. The DSH provider resolves the credential by its variable
name; credential supply from Dock, launchd or a secret manager is not implemented.
Provider diagnostics are discarded, and protocol errors use fixed codes.

`start(binding)` and `recover(binding)` retain the backend contract. Ownership
records identify the actual host process and its start time; unknown/live
foreign owners are preserved, never killed or replaced. Recovery does not attach
to a foreign process. The owner closes through its private pipe, then terminates
only its owned process group if graceful shutdown exceeds three seconds. EOF
also closes the DSH context and its MCP client. If disposal hangs, an unreferenced
two-second host deadline kills its own detached process group, including MCP
children. The isolated launcher checks the actual process-group ID before exec;
a host without that proof refuses startup. This deadline still applies after the
desktop dies. Desktop quit waits for this dedicated driver to stop; it preserves
ordinary native sessions. Closing also cancels a start waiting on recovery, so a
late startup cannot escape shutdown. Once desktop quit passes view-save validation,
the driver synchronously refuses all subsequent starts, even after a close receipt.
The desktop waits at most five seconds for this dedicated close. A missing or
negative receipt shows an unconfirmed-shutdown notice and continues quit; it never
claims cleanup succeeded or removes an unconfirmed owner record. Late receipts do
not schedule another quit. Notices use the existing in-window toast and OS
notification channels in the selected language. With no running/pending butler,
quit adds no asynchronous wait or notice. `close()` is idempotent and
returns a receipt. If a later view/outbox check cancels quit, the start seal
remains until relaunch. Before activation the user-facing cancellation path must
explain that restarting the App is required to start the butler again. The
English entry and quit notices both use 'butler'. Unknown/changed ownership is preserved and reported as
`cleanupConfirmed: false`. A crash before a trustworthy owner identity was saved
requires manual identity reconciliation; elapsed time never authorizes takeover.

`driver.nativeId` names the actual DSH session. `run(input, expectedSelection)`
validates it and returns the existing controller envelope with batch/attempt,
selection, model reply and separately measured provider usage. Each session
currently accepts one batch. `rotate()` disposes it and returns a fresh nativeId;
the caller must persist the corresponding role/record succession before another
batch. A closed/restarted host also needs a new trusted identity. The policy and
ledger supply business continuity, not DSH history or compaction.

The trusted host preserves settled assistant-message usage even if a later
request or boundary fails. Cache counts remain included. Model JSON cannot
choose identity or usage. The trusted result envelope carries a fixed
`failureCode` independently from `reply` and `usage`; the controller first records
its matching attempt usage, then fails the batch. A failure never calls the
pricing function. Missing provider rows or fields leave confirmed counts as lower bounds
(`tokensComplete: false`), while a refusal before an additional transmission can
retain complete token counts for all requests actually sent. A generic failed stream always marks counts incomplete even if it left a usage
row. Cost remains unknown
for the failed attempt, so automatic work remains blocked. This does not recover
usage the SDK never exposes, nor survive a host crash before its result receipt.
Pinned rc.2 emits its usage chunk only at message_stop: a stream aborted after
message_start therefore remains unknown even if that wire event held input counts.
The abort fixture checks that this is not presented as an exact zero.

The ledger persists the completeness flag. Partial bounds can only increase;
marking them complete requires all four counts, after which known counts cannot
change. Existing records without the flag keep their previous per-field semantics.
The usage projection displays incomplete counts as known lower bounds with an
unknown-run marker. Missing pricing on otherwise successful work still retains
measured tokens and unknown cost. Fixture prices are zero only because responses
are synthetic. Output remains bounded to 4096 tokens/request and eight streams
and actual transport attempts/batch; no provider retry is configured.

## Input limits

Before a batch begins, policy caps its **twice-JSON-escaped input at 128 KiB**,
including space metadata and open questions, reserving the largest valid batch
ID and attempt number. The controller takes the largest whole-event prefix that
fits, leaving all other events pending. It never truncates event text or changes
a saved failed batch's membership. All fields of one maximally sized valid event fit with an empty catalog,
including worst-case surrogate escaping. Fixed context that cannot fit with even one
event is blocked before an attempt record or model call; repeating it incurs no
new model attempt. Such fixed context must be reduced by the producer (or a later
qualified pagination design); old saved batches above the new bound stay intact
and blocked. Later events remain pending and the existing notice is deduplicated
per selection revision. This is a documented size limit, not automatic recovery. Both driver and host enforce the same limit. Startup also
refuses a tool schema set over 32 KiB, before a batch can be attempted.

The final transport guard appends one host-owned user text block **after all
history** in each request, with its exact remaining UTF-8 JSON space. It appends
to the final user message (after any tool results), or adds a final user message.
The system value and all preceding conversation blocks stay unchanged. Previously
the changing counter was an extra system block before the history, invalidating
that prefix for reuse. The text is now an advisory at user-message priority; it
grants no permission and does not replace any host enforcement. The same advice
and counter reach the model, after the business content instead of before it.
It computes the number after serializing
all input, system text, tool definitions, history and this budget block itself;
no credential/header is inspected. The extra text still adds input tokens; actual
provider cache hits and prices are unmeasured. This preserves a stable semantic
prefix rather than claiming a measured cost saving. The budget is regenerated rather than stored
in DSH history. It tells the model to read fewer records, leave space for its own
reply/envelopes, and finish with an unread cursor if the next page cannot fit.
The host also enforces admission before a tool result enters conversation history.
It retains the adapter's actual previous JSON body, projects the current text-only
assistant/tool step with the pinned adapter's serialization rules, and measures
the next complete wire body with the same capacity-note serializer. All pending
calls reserve a short refusal result. A whole result is admitted only with 64 KiB
left for reply/envelopes; a page that does not fit is withheld in full and replaced
by explicit feedback. No records are truncated and no cursor is invented. After
exhaustion, further reads in that batch are denied before MCP execution. The
model is told to retain its original query/cursor for a later batch and not mark
an unreceived page processed. No automatic retry is added.

Business data may itself contain a forged `NAW_CAPACITY remaining_bytes=...`
string. The model can mistake that text, or the host's user-role advisory, for a
user instruction; semantic resistance to this has not been qualified. Neither
budget guard parses such strings as limits or authority: it measures serialized
bytes and uses host constants. A forged number therefore cannot enlarge page
admission or the final request limit, even if it persuades the model to ask for
more reads. It may still affect the model's choices or make it finish early;
host enforcement does not prove task correctness or general prompt-injection
resistance. Actual cache hits and savings require the separately authorized real
pricing qualification; no such call is part of this proof.

This uses DSH's existing pre/post-execution policy hooks, not a change to Business
permissions, schema or pagination. A Business-approved page is already counted
and logged, even when the host withholds it; there is no quota refund or audit
deletion. Rotation clears only the host's per-batch admission state. The actual
shared audit uses the trusted host data directory across sessions.

The live loopback fixture runs actual Business -> MCP -> DSH with roughly 60 KiB
pages: obedient sequential reads, repeated reads ignoring the note, six calls in
one assistant step and a heavily escaped batch. It checks whole-page equality,
no MCP calls after exhaustion, confirmed usage, a completed core ledger batch
without unknown-cost notifications, and rotation without resetting daily quota.
No live model is used or assumed to follow the advisory.

Every complete body is still limited to 256 KiB. Nothing is transmitted on
refusal, and the eight-transport-attempt limit still counts internal resends.
Every final tool projection has its own 128 KiB ceiling and 512 KiB per batch;
the whole-body check also covers fields DSH adds outside that projection. The
core's durable 64-page UTC-day budget is separate; session rotation cannot reset
it. Real page sizes and escaping matter, so there is no fixed pages-per-batch
promise. Admitted pages cannot consume the reserved headroom. This is not a
promise that arbitrary model output or unlimited repeated refusals can complete:
the eight-request limit, malformed/non-text content and oversized single tool
results still fail closed, with measured usage retained and no automatic retry.
Byte limits are not exact token or spending limits.

Only text is supported. Unexpected endpoints, Files requests, body types and
non-text tool results fail closed. An oversized result may remain in the isolated
DSH record but cannot trigger another model/tool call from that failed batch.
Image preparation and unreceived usage still need their own qualification; no
activation, credential supply or production pricing is added here.

## Reproducible checks

Install dependencies with `npm ci --ignore-scripts --no-audit --no-fund`, build
the ignored UI client with `npm run build:ui`, then run the Node unit suite.
The runtime test removes inherited provider variables before substituting its
own fixed fake credential:

```sh
env -u DEEPSEEK_API_KEY -u DEEPSEEK_BASE_URL node scripts/test-butler-dsh-runner.cjs
```

`--app-root=<unpacked-package-root> --executable=<unpacked-app-executable>`
loads the packaged host, driver and core under the packaged Electron runtime. A
test-owned sandbox wrapper admits only the loopback fixture port. The fixture
checks actual MCP discovery/call, wire headers, output cap, fresh context,
rotation/restart continuity, per-attempt usage and shutdown. Real factory
qualification remains false; the controller acceptance uses an explicitly
synthetic readiness dependency and person context. This neither qualifies B4
nor demonstrates a production UI activation flow. `--driver-only` is an interim
check while the core DSH identity change is unavailable and cannot count as the
complete controller acceptance.


The separate `scripts/test-butler-dsh-failures.cjs` protocol test exercises a
successful tool request followed by HTTP failure, the eight-request bound,
SIGSTOP followed by forced process-group shutdown, missing MCP tools and unknown
pricing blocking the next automatic batch. It uses the same isolated local
fixture and never changes production qualification defaults.

## Dependency delta

Against the integration base lock, the addition is 17 package instances and
15,887,322 logical installed bytes (about 15.15 MiB), not the earlier proof's
16/10.8 MiB comparison against a different installed tree. The extra instance is
agent-loop's nested zod 4.4.3. All DSH roots are exact 0.2.1-rc.2. The newly
resolved non-DSH instances are MCP client/core 2.2.0, eventsource 3.0.7,
eventsource-parser 3.1.1, jose 6.2.17, pkce-challenge 5.0.1 and nested undici
8.11.2. The existing cross-spawn/which/isexe/path-key/shebang packages now also
serve production MCP subprocesses: these six promotions make the shipped
production delta 23 instances, 15,934,284 logical bytes (about 15.20 MiB). Integrity pins, per-package license files and
the generated package inventory cover the complete production closure.

Only the DeepSeek provider in the mounted plugin closure imports the anonymous-ID
utility. That utility reads synchronously inside `getOrCreateAnonymousUserId`,
which the provider's lazy resolver formerly called from the removed header
expression. The remaining `user-agent` is exactly
`deepseek-harness/0.2.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)`;
it contains no machine or session identifier. Upstream would send
`x-deepseek-harness-compact: 1` only for a compaction request. This composition
has no compaction plugin and never sends such a request. The network sandbox proves no
successful off-fixture connection during acceptance; it does not by itself prove
that no denied connection was attempted.


The existing role resolver can follow trusted `done` handoff edges without
changing the person's designation revision. A supplementary packaged test proves
that reading path across two real DSH replacements; production handoff-record
creation remains part of the dormant host/activation integration. App upgrades
refuse old runtime bindings. An authorized re-preparation flow and localized
blocked-state UI are required before activation; this checkpoint supplies neither
a silent migration nor a new activation path.

`env -u DEEPSEEK_API_KEY -u DEEPSEEK_BASE_URL node scripts/test-butler-dsh-input.cjs`
boots the real isolated DSH host and MCP server inside a loopback-only network
sandbox. It checks oversized success/error tool results, cumulative history,
JSON escaping, large tool schemas, failure/unknown-cost ledger records and normal
session rotation. No provider service is contacted.

Packaged runtime prerequisite **closed**: the isolated packaged Electron 44.9.0
(Node 24.22.0) exposes `module.registerHooks`; its rc.2 adapter SHA-256 equals
`eba35025ed1eedda89c51f2da46a3a968f7be1d59719f2ceeadfc4518dff37d6`.
This is the existing packaged DSH-runner witness, not a claim that later source
patches were installed or tested in the daily App.

The signed alpha.232 candidate was separately checked read-only with its own
executable in isolated Electron Node mode: Electron 44.9.0 / Node 24.22.0 exposed
`module.registerHooks`, the packaged adapter matched the DIGEST above, and the
packaged privacy loader's `assertApplied()` passed after importing that adapter.
The network sandbox denied all outbound connections; the fetch witness counted
zero calls. No provider variables were supplied and no window was created.
Strict signatures and all 12,236 regular-file contents were unchanged before and
after; the owned runtime exited and its canonical test slot was released. This
closes these two runtime prerequisites for that signed candidate only; it does
not qualify a real provider call or activate the steward.

Quit verification includes the actual before-quit handler paired with a real
ButlerDshDriver, DSH host and MCP child (owned process-group kill), plus a real
driver with its exit callback deliberately withheld (desktop deadline). The
separate hidden GUI check verifies notice rendering; this does not claim a full
GUI quit with an activated production butler.

`env -u DEEPSEEK_API_KEY -u DEEPSEEK_BASE_URL node scripts/test-butler-dsh-read-budget.cjs`
exercises live synthetic business pages, host admission and core ledger behavior
in an owned loopback-only sandbox; synthetic price zero is a fixture, not a
production pricing qualification. The dedicated host returns bounded read-budget
counts separately from model JSON for verification.
