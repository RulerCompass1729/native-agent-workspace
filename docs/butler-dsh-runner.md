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
returns a receipt; unknown/changed ownership is preserved and reported as
`cleanupConfirmed: false`. A crash before a trustworthy owner identity was saved
requires manual identity reconciliation; elapsed time never authorizes takeover.

`driver.nativeId` names the actual DSH session. `run(input, expectedSelection)`
validates it and returns the existing controller envelope with batch/attempt,
selection, model reply and separately measured provider usage. Each session
currently accepts one batch. `rotate()` disposes it and returns a fresh nativeId;
the caller must persist the corresponding role/record succession before another
batch. A closed/restarted host also needs a new trusted identity. The policy and
ledger supply business continuity, not DSH history or compaction.

The trusted host sums settled assistant-message usage once per request, including
separate cache counts. Model JSON cannot choose identity or usage. A failed/aborted turn, missing usage or fewer settled usage rows than actual
requests makes the whole attempt unknown; partial counts never price the whole
attempt. A missing/invalid price calculation retains known token counts and
unknown cost; production has no injected pricing function here. Existing core
unknown-cost rules then stop another automatic batch. Fixture pricing is zero
only because all responses are synthetic and local. Output is bounded to 4096
tokens/request and eight model requests/batch; no provider retry is configured.

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
expression. The product User-Agent remains. The network sandbox proves no
successful off-fixture connection during acceptance; it does not by itself prove
that no denied connection was attempted.


The existing role resolver can follow trusted `done` handoff edges without
changing the person's designation revision. A supplementary packaged test proves
that reading path across two real DSH replacements; production handoff-record
creation remains part of the dormant host/activation integration. App upgrades
refuse old runtime bindings. An authorized re-preparation flow and localized
blocked-state UI are required before activation; this checkpoint supplies neither
a silent migration nor a new activation path.
