# Bounded testing

## Retained Claude main reader — alpha.64

`scripts/test-native-retained-claude.cjs` uses this repository's actual alpha.2
backend, an explicitly supplied Claude Code 2.1.302 binary and the actual Electron
application. The provider endpoint is local and serves three bounded canned
responses; this is native client/protocol evidence, not hosted reasoning quality.
No provider executable or private transcript is included in the repository.

Four source and installed groups pass: original native history and identity
survive same-process
compatibility-plugin upgrade; accepted GUI input, intermediate display batches and
tool output appear in the main reader once; GUI close/reopen during a held final
preserves the original PID, native ID and unsent draft; a second actual window
receives later output, and native `/exit` plus cold reopening preserves projected
history with a null PID. The raw evidence includes requests, complete native
terminal text, streaming/completed/ended snapshots, native debug log and screenshot.
The installed run also records a successful video; all 46 runtime payload files
match source and the strict application signature remains valid after native
testing. Normal hidden reopening preserves three original native IDs/processes,
selected view and drafts with zero additional dispatch.

The local suite passes 633 checks, no skips. Independent counterexamples cover
missing/corrupt/private-cache restoration, raw old-final suppression, stop/PID-null,
reopening ended records without a transport, second-window event continuity,
explicit record cleanup and child/stale observation rejection.

Failed intermediate trials are retained privately and are not counted as passes:
missing native ownership before key confirmation; incorrectly formed fixture SSE;
an incomplete line withheld by the native display event; duplicate plugin loading
in the runner. The last was diagnosed from the native debug log and fixed by using
ordinary project discovery without a duplicate `--plugin-dir`. Both final trials
assert there are no plugin-loading errors. An intermediate installed trial
incorrectly required a pending-upgrade hint after the native file watcher had
already reloaded successfully. The corrected test accepts only a pending
explanation or a confirmed reader, and keeps input editable. That failed trial
is retained separately.

The reader preserves downstream display content, not raw pre-transform text. It
cannot reconstruct transient content before attachment or while disconnected.
Tool bodies remain volatile under the existing observation privacy boundary;
reopening does not guarantee their restoration. Physical IME, native menus and
all transient-state parity are not established. U17 remains open.

## Concurrent native recipients — alpha.63

`node scripts/test-native-concurrent.cjs` starts real Claude Code 2.1.308 and
Codex 0.163.0 through normal Electron/service bootstrap. Both use private native
configuration and a loopback provider, bounded to two responses each, zero paid
inference. Actual GUI input and mouse drag cover simultaneous attributed streams,
a waiting Claude instruction while Codex receives same-turn steering, discussion
filtering and reload, departure/rejoin without publishing private tails, and
GUI/TUI continuity. Native Claude PID and Codex server identity are retained;
Codex may create a separate terminal display process. Exact downstream requests
exclude the other recipient's instructions.

The old installed composer fails the second-recipient enabled check as expected.
Two runner errors (wrong thread-back selector and conflating Codex display/backend
PIDs) remain failed evidence. Final source five groups pass; 622 local tests and
nine existing room UI groups pass without model calls. Independent review also
verified both acknowledgement orders preserve a newer shared draft. The installed
five groups pass, followed by exact 45-file payload/strict signature checks and
hidden reopening that retains the original three native identities/processes,
selection/draft and eight Codex messages with zero new dispatch. Final independent
review passes. This does not prove physical IME input, real model reasoning,
or complete native state parity. Raw native records and recordings stay private.

## Explicit discussion threads — alpha.57

Source checks pass independent review: 520 local tests with no skips. The actual
Electron `test-progress-reading.cjs` runner passes eleven groups, with five
controlled-provider sends and zero model calls. It covers opening a reply,
streamed content under its original parent, member filtering, searching another
discussion and returning, reopening with its scoped draft intact, and a finite
two-agent exchange whose task, replies and system events stay in the same thread.
Thread association itself adds no history. A directed send delivers the new
body only; the existing explicitly authorized finite exchange still forwards its
task and the confirmed preceding reply, as shown in its delivery receipt. Search and the nine-group room-send regressions pass.

Counterexamples cover missing parents, malformed references, cycles, retired
records, unsupported retained backends, and old RPC arity. Three intermediate
GUI runs found incorrect test selectors/scope/expected IDs; those failed runs
remain private, and only the final eleven-group run counts as a pass. Successful
application recording and screenshots remain private. The installed alpha.57 also
passes all eleven groups. This scope does not close working-turn input or all of U17.

The normal profile then exposed a separate blank-page failure: accumulated DSH
per-port authentication cookies exceeded the HTTP header limit. A real Electron
regression seeds 80 synthetic cookies, reproduces HTTP 431, and verifies startup
cleanup, unrelated-cookie retention, reload and a second window. Source and
installed runs pass with no native sessions or model calls. Only this app's exact
loopback DSH cookies are retired before the fresh launch URL authenticates the UI;
provider credentials, history, drafts and preferences are not cleared.

After the fix, the installed normal profile reopens hidden with its original
three native IDs and processes, eight retained Codex messages, current model,
saved selection/mode/draft, and no added Portal dispatch. Earlier blank runs remain
failed evidence. The strict installed signature passes. No new physical IME or
hosted-provider inference test is claimed.

## Shared streams and retained readers — alpha.56

As of 2026-10-21. Source checks pass independent review. The installed app passes
the retained-reader (three groups) and shared-reader (seven groups) runners below. `npm test` passes 515 checks with no skips.

- `test-progress-reading.cjs`: seven actual Electron groups, including two
  interleaved agent replies, exact mention targeting, draft/focus retention,
  member filtering, stable final blocks and departure during streaming.
- `test-retained-reader.cjs`: three actual Electron groups using an old-service
  transport fixture. Original history/current model, GUI input, live text/tool
  content exactly once, unchanged identity and reopen/draft/no-replay pass.
- `test-room-send.cjs`: nine existing room submission/receipt groups pass.
- `test-native-blocks.cjs`: actual Claude 2.1.308 and Electron with three local
  canned inference responses. Native intermediate/tool content appears in the
  shared reader before final completion, with unchanged process and exact final
  attribution, alongside interrupt/context-clear. The full runner makes two
  Portal submissions (one shared, one solo interruption task), three local
  inference responses and zero paid inference calls. The successful recording
  remains private.

A separate read of a retained native Codex process recovered eight original
messages from its same loaded identity while the old portal stored zero. Current
model identity was reconciled; no new turn or process was created. This supports
the native read contract, not a hosted-provider inference test.

Review counterexamples cover approval while streaming, revoked-grant eviction,
nonempty old partial caches, history/live races, failed reconnect preservation
and native error with unfinished text/tools. Failed earlier GUI runs remain in
private evidence and are not counted as passes. Controlled providers are labeled
fixtures; tool records remain bounded and volatile, not a durable full trace.

The normal installed profile was reopened through `--background`, retaining all
three native session IDs/processes, selected view and saved draft. Its previously
empty Codex main reader displayed eight native messages and the current model;
portal dispatch count did not increase. A private screenshot confirms the reader
contains the original conversation and no terminal-camera panel. A separate
actual-app runner confirms first and repeated background launch keep windows
hidden. A read-only macOS observer recorded no foreground-application or Space
change during the actual reopen. This is one controlled desktop observation,
not a guarantee for every macOS configuration. Normal user activation restores
ordinary Dock/window behavior; background startup temporarily uses accessory
activation policy. No test-profile guard was relaxed.

At this alpha.56 checkpoint: reply threads, working-turn GUI input, complete terminal-state
mapping and older Claude display compatibility. These results do not close U17.

## Native block foundation — earlier source validation

As of 2026-10-21. This source-only increment replaces the rejected camera/replay
panels with native content in the solo main reader. The installed alpha.55 is
unchanged. Earlier panel-specific results below describe those historical
versions; they are not evidence for the replacement reader.

`node scripts/test-native-blocks.cjs` launches actual Electron through normal
service bootstrap and the installed real Claude CLI in an isolated test profile.
Only its inference endpoint is replaced with a loopback SSE fixture. Native hooks,
tool execution, submission, terminal and interruption are real. Three canned
responses verify intermediate text and a Bash result before the final response,
stable block identity/order, an authorized display-confirmed shared final reply,
native interruption and `/clear` without replacing the process or losing local
history. No paid model request is made. A successful application recording and
screenshot remain private. This is not hosted-provider, physical IME or full
terminal-state fidelity evidence.

Both 2.1.307 and 2.1.308 pass this trial. An intervening recorded trial failed
because automatic CLI updating crossed the explicit compatibility gate; that
failure is retained and not counted as pass. The generated type declarations
were compared before extending the gate, then the actual 2.1.308 trial passed.
The runner checks the version before sending so a future update fails early.

The local suite includes mixed native ID namespaces, duplicate/empty/final
display batches, delayed old-root observations, tool results crossing turns,
background tools after interruption, lost snapshot/live races, bounded volatile
caches and final-proof invalidation. Redaction tests assert raw hidden text cannot
reach the room, its persisted data or the next automatic handoff. A native turn
ending does not claim all tools or child agents stopped.

All 499 local tests pass with no skips. Actual source Electron regression
evidence includes nine room-send groups, eleven reading/selection/focus checks,
and four inline native/retained-backend groups, including disconnect → late event
→ reconnect. Capability-only loss on the oldest bridge has a separate source
counterexample; it is not described as an actual old-runtime GUI trial.
The legacy test entry `test-native-progress.cjs` now invokes the inline-reader
runner rather than asserting the retired replay UI. Controlled progress fixtures
do not establish native-provider compatibility. Separate unit/native results
and independent review are required before closing a scoped issue.

At that checkpoint, shared intermediate streaming and installed delivery were
open; see the subsequent alpha.56 evidence above. Threads, working-turn input,
complete native input/menu/permission mapping and wider old-runtime compatibility
remain open. No complete
U17, universal 1:1, zero-latency or zero-error claim follows from these checks.

## Integrated core acceptance — alpha.55

On 2026-10-21, six runners operate the actual installed Electron/DeepSeek Harness
application, sequentially with isolated profiles. Provider events and replies are
controlled transport fixtures; these are not new native reasoning trials. The
main scenarios use a three-person travel budget (75 total, 25 each) and a weekly
study plan (35 minutes each day, 175 over five days).

| Runner | User path and checked boundary |
| --- | --- |
| `test-desktop-workflow.cjs` | Preview material → explicit ordered three-session task → exact result copy → detach → private draft → archive/restore → app reopen. Both provider arrangements, duplicate labels, an excluded member, save failure and delayed picker/ownership loss pass. File-picker selections and the result file are controlled fixtures. |
| `test-collaboration.cjs` | Actual pointer drag-in/out, cancelled/invalid/duplicate drops, keyboard `@`, exact recipient, notes, rename, archive/restore and late private results. Shared-history removal preserves native records; no hidden dispatch. |
| `test-six-session-workflow.cjs` | Six independent sessions, ordered reply cap, departure during work, reopening, an unrelated permission request and a pending private acknowledgement. No wrong recipient, private-context spill or automatic replay. |
| `test-bounded-away.cjs` | Close UI during an authorized exchange → completion at its reply cap → reopen. Error and explicit pause keep later results private; pause does not pretend to stop accepted native work. |
| `test-graphical-followthrough.cjs` | Native confirmation/intervention → find private result → edit/select share → local note/search → explicit graphical approval → private result → cancel/reopen sharing → one newly authorized delivery → archive/restore/reopen. The old finite run remains paused and the unsent draft survives. |
| `test-progress-reading.cjs` | Read/scroll a private result → switch sessions, GUI/TUI and room membership → retain expansion and reading position. A newer gesture defeats delayed restoration; a retired connection/item loses stale state. The held outer-container gesture uses a synthetic DOM event; other navigation uses Electron mouse/keyboard actions. |

All six complete without renderer errors. Together they make 32 explicitly
controlled synthetic submissions and no provider model call. The added
follow-through branch makes five submissions in that runner: cancelling its
preview sends nothing, confirming sends the exact selected text once, and the
new reply never revives the paused automatic exchange. This extends the earlier
four-submission M3 evidence without rewriting that historical result.

Previously reviewed real native task/identity evidence is retained under
[M1](acceptance/desktop-workflow.md#observed-outcome--alpha44),
[native progress](#native-claude-intermediate-observation--alpha54) and
[session continuity](acceptance/session-continuity.md). Runtime code is unchanged
in this checkpoint. The previously observed natural ten-minute deadline is
reused; the new installed away runner does not fast-forward or repeat it.

Final artifact checks match all 41 shipped source files, verify the installed
bundle's strict signature, retain hashes of four protected normal-profile files
and find one ordinary application entry. No owned test runner remains. A short
one-frame-per-second recording and screenshots of the installed task are retained
privately; they are application frames, not physical macOS/IME evidence.

This closes only the supported local-core path after independent review. Outside
live-session attachment, Claude outside history/native `/resume` synchronization,
full active-fleet cold restoration and official provider Desktop synchronization
remain open. Multi-level rooms are parked design research, and public installer
distribution remains deferred. No universal compatibility, full cost parity or
security certification is inferred from this acceptance.

## Running-result reading — alpha.55

An actual Electron reproduction on alpha.54 lost result expansion and its inner
scroll position after switching sessions. Alpha.55 retains bounded per-session,
per-native-connection reading state, including a solo-panel anchor. The room grid
keeps one scrollbar, so member panels do not compete to restore it.

`npm run test:progress-reading` rebuilds the actual DSH client before the source
trial. `scripts/test-progress-reading.cjs` also accepts the installed executable
and app-root overrides without rebuilding the signed installation. Five groups
pass in source and installed Electron:

- Pointer-read output and an unsent draft survive switching; identical item IDs
  in another session remain independent.
- GUI/TUI changes and intentionally collapsed containers/results retain intent.
- Joining, room view, returning and detaching retain the result's exact inner
  scroll offset and visible body, with no shared text added.
- A held snapshot cannot restore an old anchor after newer pointer intent on the
  outer container. This particular boundary check dispatches a synthetic DOM
  event; it is not physical macOS scrollbar or input-method proof.
- New native connection revisions and retention eviction retire obsolete state.

The actual pointer scenarios and screenshots use the running Electron product
with controlled transport fixtures. No real provider inference is started.
Dispatches, sends and inputs stay at zero; the intentional TUI switch opens one
fixture display and generates ordinary size updates. The eight-group raw-progress
regression also passes in source and installed code. The 479 local tests pass
with no skips. Private raw logs and screenshots remain outside Git.

Reading state is in memory and bounded by retained items and the existing session
cache; it does not persist temporary native output across a cold restart. Existing
native provider evidence is reused because no provider/transport code changed.

## PTY startup input — alpha.53

A real Python PTY child reproduced a lost first input when its configuration and
input command arrived in one pipe write: the old buffered configuration reader
read ahead, and subsequent unbuffered reads could not recover those bytes.
One byte-stream parser now retains and drains complete commands before waiting
for another input event. No prompt rewriting or added per-key delay is involved.

Five real-process checks cover coalesced startup/input, UTF-8 splits in both
configuration and commands, startup resize ordering, later input, stop/EOF and
incomplete configuration. The full local suite passes 465 checks without skips.
`node scripts/test-pty-input.cjs` drives actual hidden Electron and a real Python
echo PTY through ASCII/Unicode input, graphical/native switching, join/detach
and app reopening. It verifies rendered text, the same PID/native reference,
an unsent graphical draft and no duplicate echoes. The first UI runner missed
an already restored terminal because its constructor observer was installed too
late; the corrected runner reads visible rendered rows. Source and installed
acceptance pass. The installed 41-file application payload matches source and
retains its strict signature after testing. Four protected normal-profile files
remain byte-identical, and application search returns one ordinary installed app.
These PTY checks use no model; they do not certify a native completion menu or
physical input method. Existing live backends retain their original runtime copy.
Independent review of source, raw logs, rendered evidence and installed payload
closes the startup-input defect within this scope.

Separate Claude resume contract work had an unintended native `/claude-api`
submission when fast automated typing was followed immediately by Enter. The
owned trial was stopped. Native records show two model responses, a completed
shell tool result and a subsequent question; Portal dispatches remained zero.
Later tracing observed all 44 intended characters and the correct native edit
line, but cannot retrospectively establish the original failure's cause. This
is not evidence that the PTY startup defect caused that command. Native command
tests now inspect the settled edit line/menu before Enter. A subsequent selected
history recovery added no new question. Neither the failed probe nor counters
alone may be reported as proof of zero native model use.

## Native Claude context continuity — alpha.52

The installed alpha.51 application reproduced an actual Claude Code 2.1.306
`/clear` changing its root ID while the portal retained its old identity and
stopping state. Settings lifecycle events and a private native mod probe agree:
`session.start` does not repeat; `session.end(reason=clear)` precedes the new
`classic.SessionStart(source=clear)` and `$.session.id()` identifies that root.
The implementation gates this contract to the verified version. It keeps the
same PTY/row and records old context references with a local history boundary.

Local counterexamples cover saved identity and drafts, rejected child/retired
root events, writes failing before acknowledgement, repeated/rapid clears,
metadata ACK loss, and a new transition during the final asynchronous identity
read. Unverified root observations are bounded and replayed only after that ID
is proven. Overflow leaves graphical submission closed. Real `Claude.send` and
`SubmissionChannel` tests retain cached old replies before the old boundary,
even when accepted input has no correlated prompt ID; they never authorize
sharing. Frozen context checks span the GUI, awaited client operations and the
final daemon dispatch. Old transports keep their existing argument format.
Exact released compatibility-plugin bytes upgrade; edited copies are preserved.

`node scripts/test-native-context.cjs` drives the actual hidden Electron UI.
Five controlled-transport groups cover history/draft retention, accepted/rejected
late private ACKs, clearing while the first shared ACK is pending, and reopen.
Three synthetic submissions make no model calls. The added shared case exposed
a six-argument request being rejected by the old five-argument transport limit;
the scoped protocol fix passes the same UI path. Initial failed logs are retained.

Actual source UI/TUI verification runs two `/clear` commands with Haiku selected,
without sending an inference task. Both new IDs match native lifecycle evidence;
the process, row, Chinese draft and collaboration membership remain intact and
submission reconnects. The final installed bridge repeats both native clears successfully; its runtime
copy matches the installed source. All five installed GUI groups and the seven
existing source collaboration-waiting groups pass. The complete local suite
passes 460 checks without skips. Independent source/artifact review passes;
41 installed payload files match source, strict signature verification succeeds
after native cleanup, four normal-profile files are unchanged and application
search has one daily entry. This does not claim physical IME coverage, active-fleet restoration,
external Claude import or `/resume` history synchronization.

## Visible waiting and cancellation — alpha.51

The actual installed alpha.50 interface reproduced a pending first collaboration
with no visible status or cancel action. The existing status bar now names the
wait, and its existing pause action can cancel a waiting authorization. Directed
shared sends show their recipient and acknowledgement wait without offering a
false task-cancellation promise. No new provider calls or polling are introduced.

Cancellation intent immediately protects task materials and focus. Only a
confirmed pause produces the success notice. Old submission completion cannot
release a newer submission or a cancellation that is still pending. Both native
success-before-pause and pause-failure-before-native-success initially reproduced
material loss and now pass. A failed pause remains visible and permits another
explicit operation; it does not claim the native task stopped.

`node scripts/test-room-waiting.cjs` runs seven actual hidden-Electron groups,
with twelve synthetic submissions and zero model calls. It verifies first wait,
cancel and immediate typing, late failure/private draft restoration, fresh consent,
late success during another authorization, both cancellation/ACK orders, pause
failure, and a directed send retaining a newer draft. The unchanged shared-client
human-operation guard passes 28 local checks. The existing actual collaboration
runner passes drag/drop, exact mentions, shared notes/search, archive/reopen and
history-deletion regressions. Final installed runs repeat all seven waiting groups
and six collaboration groups successfully. Independent source/artifact review
passed; 41 payload files match source, strict signature validation passes, four
normal-profile files remain unchanged and one daily application entry remains.
Raw failed and passing logs and screenshots stay private.

These are actual interface/IPC checks with controlled provider transport, not
new model or physical OS/IME acceptance. Existing native task and physical input
evidence is reused within its original scope. Cancelling subsequent sharing
never implies cancellation of native tools, teams, accepted work or billing.

## Six-session independence — alpha.50

The actual alpha.49 installed interface reproduced an unrelated native permission
request pausing a selected pair. The fix restricts automatic native approval,
failure and exit events to selected participants; explicit human intervention and
membership changes retain their existing conservative behavior. Delayed send
failures can pause only their original run. Private draft restoration and pending
cleanup remain intact. Current-participant failures still stop sharing.

Nineteen local counterexamples include seven paired selected/outside events,
private acknowledgement failure after another run starts, and old/current-run
initial and handoff rejections. Three asynchronous cases failed before the final
fix and pass afterward. The complete local suite passes 438 checks, with no skips.

`node scripts/test-six-session-workflow.cjs` drives actual Electron controls at
850 × 600 with three Claude and three Codex same-name sessions, controlled provider
transport, thirteen synthetic submissions and zero provider/model tasks. Five
source and installed groups cover ordered six-reply completion, removing a later participant,
late-private results, draft/archive/reopen identity retention, an independent
permission request during a selected pair, and private send failure followed by
explicit reauthorization. The real Codex adapter handles synthetic native events;
Claude transport is a fixture. Screenshots and raw logs remain private. Final source/artifact evidence passed
independent review. All 41 installed payload files match source, the strict
signature remains valid, four protected normal-profile hashes are unchanged,
and application search resolves one daily installed entry. Existing native
services were not stopped or migrated.

An initial GUI experiment expected a new run to start before a pending private
ACK. It failed because the client intentionally waits for outstanding human
operations. That guard was retained. The corrected GUI test verifies no dispatch
while waiting, rejection without replay, restored draft and explicit new consent.
The daemon-level late-rejection cases are separate from this GUI ordering proof.

Optional `--idle-sample` takes five minutes of owned-process measurements. The
baseline had 21 samples and a constant six-process app/service tree. Median
interval CPU was approximately 0.13% of one core, peak approximately 0.93%; summed
RSS went from approximately 742 to 706 MiB. RSS can double-count shared pages.
This sample has no real provider processes and establishes neither real-agent
resource bounds nor general absence of leaks. All windows remained hidden and
non-focusable; physical OS input and new native reasoning are not exercised.

## Outside Codex history — alpha.49

`node scripts/test-native-history.cjs` drives the actual hidden Electron app.
Six controlled-transport scenarios cover explicit browse/cancel/search/pages,
exact history and native identity, view switching and join/detach with a draft,
repeat and archived selection, active-writer refusal without a local copy,
partial recovery and reopen. They make three synthetic resume requests and no
inference/start/fork calls. Runtime tests additionally hold metadata reading while
requesting daemon shutdown, and interrupt version verification with stop, removal,
close or a second recovery. Accepted native recovery followed by failed saving or
pagination retains one reference and never retries automatically.

A separate normal-bootstrap test reuses the completed native budget task, sending
no new question. The initial source run displayed the exact historical user and
assistant text and retained its model, but failed at its private protocol-log
collection because the injected recorder was not loaded. That run is not recorded
as fully passing. The final installed run uses normal service bootstrap and passes:
the exact previous user/assistant messages, native ID and model remain; joining
and detaching retain an unsent draft. The native terminal also shows the exact
historical assistant answer; returning to conversation retains the draft.
It sends no new question and records zero
application dispatches. Protocol request-count assertions belong to the controlled
transport and native writer probe, not to the unavailable recorder.

Final source and installed six-group interface checks pass; the complete local
suite passes 419 tests with zero skips. The 41 installed payload files match
source, strict bundle verification passes after the native run, the four normal
profile records retain their original hashes, and application search finds only
the one daily installed application. Screenshots, full logs and exact native IDs
remain private. This does not verify physical OS input, live outside attachment,
full fleet restoration or other native versions.

## Readable result actions — alpha.48

The graphical follow-through runner now checks actual composited text contrast
for directed and permission-pause result navigation in light and dark themes.
It waits for rendered theme updates and confirms distinct backgrounds, avoiding
a stale-color pass. The old light-theme action fails at 2.28; source and installed
fixed values are 18.90/17.45 for directed results and 5.80/12.11 for system pauses.
Tab reaches the pause action with a visible focus indicator and Enter opens the
original session. The six existing task scenarios still pass without model calls.
This is a scoped check, not full accessibility certification.

## Bounded unattended lifecycle — alpha.47

`node scripts/test-bounded-away.cjs` drives the actual app through window closure,
reply-cap completion, native error and human pause. Add `--real-deadline` to wait
the full ten minutes, without changing time. Source timed acceptance and installed
ordinary lifecycle checks pass, as does installed graphical follow-through.
The deadline unit counterexamples and actual Claude completion method raise the
local suite to 400 passes, zero skips. All new provider responses are controlled;
zero new model calls. See [M4 scope and boundaries](acceptance/bounded-away.md).

## Graphical follow-through — alpha.46

`node scripts/test-graphical-followthrough.cjs` drives the real application using
controlled provider events. Its six scenario groups cover directed/private
results, explicit selection sharing, local decisions/search, finite-exchange
permissions, read-only archive and reopen. Four authorized synthetic submissions,
zero model calls. The result must enter the actual conversation viewport after
local search; DOM presence alone is insufficient. Source and installed runs pass.

The complete unit suite passes 394 checks with zero skips; the existing seven
sharing-preview and six search groups also pass. The installed 40 application
payload files and generated UI match source, archive hash and strict signature
pass, normal profile files remain unchanged, and application search has one
daily entry. Actual alpha.44 native non-coding task evidence is reused because
the provider adapters/protocols are unchanged. See [M3 boundaries](acceptance/everyday-workflow.md).

The maintainer explicitly requires restrained use of Claude/Codex tests. The goal
is confidence in important behavior, not maximum live-test volume.

## Order of evidence

1. Inspect the changed implementation and reuse relevant passing evidence.
2. Check state transitions, routing and failure handling with local synthetic tests.
3. Exercise Electron renderer/IPC behavior in a hidden app, without sending prompts.
   Visible desktop acceptance requires an explicitly wanted separate check.
4. Use a real native model turn only when the unresolved question requires it.

Every live trial needs a concrete question, a small synthetic task, a finite
root-turn/teammate allowance, and a stop condition. Stop when the evidence arrives.
No status prompts, automatic resubmission, repeat acknowledgements or multi-agent
debates just to make a test feel thorough. Native subagent/tool work must be counted
as usage too; root-turn limits are not provider token/cost limits.

Use the cheapest suitable model currently available for both Claude and Codex
in isolated tests. Verify availability, current pricing and the actual selected
model before sending a task; a fixed alias is not a permanent cheapest-model
claim. If that model is unavailable, stop rather than silently falling back to
a more expensive default. Apply model/effort overrides only to test sessions,
never to the person's normal configuration.

For changes to the Claude bridge, run `claude plugin test app/claude-bridge`
and `claude plugin validate app/claude-bridge` as well. The native test kit executes
the real mod dispatcher with mocked external boundaries, without login, network
or a model turn. Node mocks alone missed a native dispatch difference during
alpha.5 development. Neither kind of local check replaces a visible native test.

Automated Electron launchers use a validated test parent and private profile and
remain hidden by default, including startup, restored views and duplicates. The
checks below can establish DOM interaction and real IPC/storage behavior; they do
not establish visible desktop or physical OS input acceptance. Historical visible
results keep their original dates and scope. Do not activate a test window or
reopen the normal user UI as a cleanup step.

## Reuse and retest

An unchanged provider does not need another marker response for a CSS, window,
draft, or packaging change. Retest a native path when its adapter/protocol changes,
the provider version changes materially, or a real failure invalidates the result.
Name untested capabilities instead of expanding live tests merely for completeness.

Use `npm test` for local logic and `npm run test:desktop` for lifecycle behavior.
The desktop runner has one stable private profile and an exclusive runner lock;
parallel launches are refused. Only intentional multi-view checks may create an
extra window, and they close it afterward. Cleanup owns specific child handles,
never broad process-name kills.

## Graphical independent-session workflow — alpha.44

Run `node scripts/test-desktop-workflow.cjs` after the normal client build. Set
`NAW_APP_EXECUTABLE` and `NAW_TEST_APP_ROOT` to verify an installed build; optional
`NAW_EVIDENCE_DIR` stores private app screenshots and a recording (requires local
ffmpeg). One hidden Electron window uses actual UI, IPC, storage and the daemon;
provider replies and native file-picker results are controlled fixtures.

The source and installed checks cover local material preview/insertion, exact
result copies, both three-session provider arrangements, duplicate labels,
selected subsets/order, unchanged private history and six synthetic dispatches.
They also cover the 6,000-character collaboration preflight, failed draft-save
retry, delayed picker navigation, ownership changes and detach/archive/reopen.
The final length regression was added after the source run and passed in the
installed run. Existing room-send and pointer collaboration regressions passed.
No provider model is called by these runners.

One separate installed native task used three root submissions with Haiku/Luna/
Haiku and produced the correct Markdown result. Native permission intervention
paused automatic sharing; GUI preview/copy and retained-session continuity passed.
The full source suite passed 388 checks before the final length correction; 112
affected checks passed afterward. Exact installed payload comparison covered 39
source files. See [the acceptance record](acceptance/desktop-workflow.md) for the
observed usage and boundaries. This does not add physical macOS picker/IME,
full native-fleet restoration or unattended-completion proof.

Real native tests must use normal service bootstrap, which copies mutable
provider-plugin files into the private runtime. A private direct-daemon runner
bypassed this and invalidated the installed bundle signature through generated
Claude type files (A44-4). The original reviewed archive was restored; a zero-task
normal GUI/native startup then passed, with generated files outside the bundle
and strict signature verification before and after. Always verify the signature
after native testing. Synthetic provider fixtures do not exercise this behavior.

## Single-conversation interaction check

`npm run test:solo` uses one hidden Electron renderer at a time against a private synthetic
transport. It covers late view acknowledgements, queued takeover conflicts,
read-only view navigation, unavailable send routes, menu/dialog focus, composition,
explicit send/interrupt, and draft persistence in the DOM, main process, disk and
service after reopening and 12-second idle windows. It waits for actual restored
UI state; the runner never signals application readiness on the renderer's behalf.

For an installed build, set both `NAW_APP_EXECUTABLE` and `NAW_TEST_APP_ROOT` (the
bundle's `Contents/Resources/app`) and run `node scripts/test-solo-use.cjs`. The
fixture then exercises the installed daemon and workspace as well as the UI.
This is Electron UI/IPC/persistence evidence with synthetic native transport,
not visible desktop, physical macOS IME or provider-model evidence. Its window
stays hidden and non-focusable while CDP delivers test input. It makes two synthetic sends
and starts no native providers or model tasks. `test:focus`, `test:terminal` and
`test:drafts` retain the relevant timing and draft regressions.

## Visible macOS input acceptance

Alpha.22 additionally used one visible installed app in an isolated macOS guest.
No host home, credentials, clipboard or user configuration were shared. The VM
window stayed off the host desktop; an OS-event driver operated its real GUI and
input methods. Host test windows retain their default hidden/non-focusable policy.

Reproduce this acceptance in an isolated desktop with the exact candidate app:

1. Verify guest app version and runtime/generated-UI hashes against the installed
   candidate. Use a private profile and synthetic provider transport; keep the
   real Electron renderer, IPC, service, storage and OS input methods.
2. Select System Pinyin, then WeChat Input. Observe candidates; confirm/cancel,
   switch sessions mid-composition, and check exact origin/text/Enter bytes. In
   the GUI, distinguish IME confirmation from task submission. Click Send/Stop
   and immediately type, without refocusing the input as a test workaround.
3. Use OS mouse selection/scrolling, Command-C/Command-V and actual guest
   clipboard. Check multiline paste both without and with bracketed-paste mode.
   Scroll a long terminal history, copy an older line and switch views/sessions.
   Return from another guest app and check the first input's destination.
4. Save different drafts, quit normally and reopen the same profile. Compare
   native IDs, service PID, history, selected view and drafts, including the DOM
   and persisted state after an idle window. Assert no task replay.

The final alpha.22 cases passed with four synthetic GUI submissions and zero
real provider/model calls. Initial test-driver failures (key naming, helpers and
assuming DOM scrollTop for virtual terminal rows) are retained separately from
product failures. The Stop-focus defect was reproduced before the fix. OS event
traces include compositionend isTrusted=false; exact delivery and candidate-window
observations, not that flag, establish the bounded input result. These are real
OS IME paths driven by CGEvents, not physical-person or universal IME certification.
Read the remaining limits in [alpha.22](alpha.md#alpha22-single-conversation-os-acceptance).
Raw guest screens, event traces and user-state comparisons remain private.

## Continuous reading and resource samples

`npm run test:reading` uses a hidden real Electron/DSH application and production
IPC/service with 240 synthetic completed history messages and subsequent output.
Pointer selection, historical action focus, latest Copy payload, bottom-follow,
reading older content, GUI/TUI and conversation switching, reopening, and late
layout isolation are checked. A held main-process disk timer verifies that normal
quit flushes already-received reading metadata. Invalid geometry is rejected
without changing the saved view. Only session/message IDs and bounded geometry
are saved; selected text is never part of reading metadata.

Copy payloads are intercepted inside the test main process: the person's system
clipboard is untouched, and this does not certify OS clipboard shortcuts. The
runner samples Electron working-set memory and cumulative CPU plus synthetic
service RSS/CPU; samples after UI reopen belong to new processes and must not be
used as a leak or steady-state comparison. The full-snapshot service is unchanged.
For installed verification use `NAW_APP_EXECUTABLE` and `NAW_TEST_APP_ROOT` as above.
This test starts zero native providers, makes zero model requests, and does not
certify physical input methods, foreground focus or visible desktop interaction.

## Immediate input and composition

`npm run test:input` clicks a session/view and types immediately, without waiting
for a terminal-focus assertion after the click. First attachments still have an
explicit loading gate. The hidden Chromium renderer check uses actual composition events,
checks exact bytes and origin IDs, and covers Enter confirmation, cancellation,
blur/refocus, GUI drafts, slow input/control acknowledgements, cancelled queues,
newer owners, error-copy paste isolation and opt-in macOS app activation. It permits
confirmed text only after an observed compositionend and rejects confirmation CR;
a separate later Enter must pass exactly once. Synthetic transport starts no
provider processes or model tasks. This is not physical System Pinyin/WeChat IME
certification or visible desktop acceptance. Deterministic CDP checks use a hidden,
non-focusable Electron window from its first construction. The existing test-parent
lease and canonical, privately owned profile select test-only accessory activation
policy before app readiness; invalid test flags fail before locking or windows. Normal
user launches retain their usual window behavior. macOS foreground-return is
skipped by default, not counted as passing. Set `NAW_TEST_FOREGROUND_RETURN=1`
only for an explicitly wanted short activation check; it checks exact input,
hides the test window immediately and suppresses raw foreground diagnostics on
failure. This isolation does not prove physical OS input or prevent every
possible desktop interaction. Both installed-build variables above are supported.

Pending control input is bounded to 65,536 UTF-16 code units and only exists for
an already-ready terminal owned by this view. New terminals and another owner's
session remain gated until authorized. Rejected/cancelled input is never retried;
the copyable error notice is temporary, and explicitly instructs the person to
copy it before closing the app. It is not a persistent native terminal draft.

## Initial demo evidence

The first desktop check used seven completed top-level native requests for
Claude/Codex terminal/conversation replies and a three-reply bounded handoff,
followed by one Claude native team task with one teammate. The team generated its
own native work and mailbox turns; eight top-level requests are not eight total
model calls and are not a token/cost total. An earlier separate Codex continuity
probe also used one native request. Subsequent stop checks opened one empty
Claude session and one empty Codex metadata thread, without sending prompts;
the alpha packaging/recovery checks likewise sent no model tasks. A later,
explicitly requested fresh-install walkthrough used one bounded Claude request
to verify the first reply after installation, then stopped model testing. It
observed no tool or teammate activity; see [the walkthrough](alpha.md#fresh-install-walkthrough).

Twenty-four local state/lifetime/submission checks and the visible lifecycle regression
passed. They consume no model tokens. The native fleet coverage remains limited
as described in [demo](../demo.md); a synthetic test is never labelled native proof.

The stop checks distinguish a closed PTY stream from a reaped process, an
unsubscribe acknowledgement from a closed native thread, and a failed stop from
a successful one. The visible Claude check verified stopping → ended and actual
process exit; the native OS confirmation dialog was automated, not manually
mouse-tested. The Codex metadata check observed the thread still loaded after
unsubscribe. Both checks cleaned up only their own processes; the original two
sessions kept their native IDs/PIDs, with zero new dispatches on UI restoration.

The protocol distinction follows the official
[Codex app-server unsubscribe contract](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread).
It does not establish fleet termination or an exact billing total.


The alpha build can be exercised by the same visible lifecycle runner:
set `NAW_APP_EXECUTABLE` to the built app's executable and run
`node scripts/test-desktop.cjs`. It uses its own stable test profile and launches
no model tasks. A fresh profile has no native sessions; identity/draft assertions
on that empty profile do not replace the separate live-session evidence in alpha.md.

The runner now checks rendered foreground/background contrast in both light and
dark themes. Playwright's default light appearance previously hid a real system
dark-mode failure; the check explicitly switches themes and then restores the
system preference. It sends no native inputs or model prompts.

The runner also checks the privacy/usage panel, unknown-usage wording, shared-task
drafts and preference validation. With an existing idle terminal owned by the
test view, it verifies font/palette persistence and focus on returning to that
session; an empty profile does not prove those native-terminal checks. Test-only
shared drafts and display settings are restored on cleanup. Native clipboard
typing/selection is a separate bounded check on an inspected empty prompt, using
synthetic unsubmitted text and restoring the original clipboard.

The room check runs only with exactly two controlled, empty idle terminals and an
unused room. Otherwise it reports SKIP, never native coverage. It joins through
the UI, switches both member terminals, checks that viewing does not change
collaboration/control revisions, opens one intentional read-only second view,
exercises explicit takeover and detaches/rejoins the same session. Native identity,
history and dispatch counts must remain unchanged. Room/member selection survives
reopening; cleanup restores original membership and view settings. A small-window
check also verifies that sidebar and pause controls remain usable. Screenshots
are optional via `NAW_EVIDENCE_DIR` and must stay outside the public repository.

`npm run build:ui && node scripts/test-session-menu.cjs` checks the session menu
in a visible Electron window with a new private fixture of two ended records.
It creates no native session and sends no provider task. The check covers an
unselected target with duplicate names, click/right-click/keyboard, focus across
a real service state update, cancellation, rename validation, another window,
room names, light/dark contrast, small-window positioning and reopen persistence.
`NAW_APP_EXECUTABLE` also selects an installed build; `NAW_EVIDENCE_DIR` captures
screenshots outside Git. Ended synthetic records prove UI behavior, not live
native input, fleet lifecycle, physical IME or VoiceOver behavior.

## Late send acceptance and GUI drafts

Run `npm run test:drafts` for a headed desktop regression. It uses one isolated
profile and a delayed synthetic provider transport; the DSH UI, Electron IPC,
service and draft persistence are production code. No provider process or model
request is started. Both provider labels cover retyping identical text, whitespace
edits, failed acceptance, unchanged-draft clearing, switching sessions and UI
reopen. The runner stops only its own fixture service. `NAW_APP_EXECUTABLE` can
select an installed matching app, and `NAW_EVIDENCE_DIR` stores private screenshots.
This verifies the desktop draft boundary, not native TUI draft or turn ordering.

## Terminal connection readiness

`npm run test:terminal` opens a real desktop window with synthetic terminals whose
initial snapshots are held by the runner. It verifies that loading never exposes
an editable terminal or enables paste, including during service state updates.
After readiness, the first input reaches the intended session exactly once. A
late snapshot from another member or an older connection cannot steal focus or
activate stale input. Failure stays noninteractive; explicitly selecting the view
retries. Room and solo views use the same terminal. No native provider process or
model request is started. The installed-build and private-screenshot options match
the draft runner above. Native draft continuity remains separately documented.

## Room composer regression

`npm run test:room` opens one hidden Electron/DSH window with an isolated profile,
real IPC and workspace state, and a delayed synthetic provider transport. It
starts no native provider processes and makes no model requests. The check
verifies default form submission, pointer/keyboard activation, explicit automatic
runs, unknown-fleet pauses, pending/blank/ended-recipient guards, late failure and
reopening without replay, saved/legacy/invalid recipients on restart, and
recipient departure in both sharing selectors.
The composer sends with Enter and inserts a newline with Shift+Enter. While the
mention picker is open, Enter selects its highlighted recipient instead.
Set `NAW_APP_EXECUTABLE` to verify a packaged app; do not run desktop runners in
parallel. Synthetic provider labels do not constitute native model/fleet proof.

`npm run test:focus` controls terminal snapshot and view-control timing with the
existing synthetic terminal fixture. It verifies the real desktop focus/input
path when a room snapshot is ready before its control acknowledgement, including
late responses after selecting another member, menus/dialogs, shared drafts,
failure/retry and a simulated competing owner. It opens one window and makes no
native provider or model requests; the owner scenario is not a native two-window
concurrency or permission test. The existing `test:terminal` readiness cases
remain separate coverage for delayed/stale/failed snapshots.

## Draft ownership and recovery

`npm run test:draft-ownership` deliberately opens two hidden windows, using real
Electron/IPC/workspace persistence and synthetic transport. It checks explicit
takeover, current draft visibility, reload without stale writes, rejection of a
former owner's save, copyable recovery, and legacy window records after a full UI
restart. Unresolved copies must survive ordinary editing; explicit deletion must
survive another window's state broadcast while a successful save acknowledgement
is still held. No provider or model task is created; dispatches must remain zero.
Set `NAW_APP_EXECUTABLE` and `NAW_TEST_APP_ROOT` together for packaged validation.
Screenshots remain private via `NAW_EVIDENCE_DIR`. This is not physical IME proof.

## Complete daily-use regression

`npm run test:daily` uses one hidden desktop window and an isolated profile.
It exercises setup appearance, both themes, Codex first-attachment history across
pages, solo conversation/terminal switching, exact input and GUI drafts, rename,
directed two-agent sharing, detach/continue, repeated launch and reopen, privacy
and usage disclosure, and a compact window. Assertions cover actual rendered
replies as well as recipients, message identity, dispatch counts and persistence.
The Codex adapter/Workspace/IPC are real; provider startup, terminal transport and
Claude replies are synthetic. It creates no native provider or model task.

For an installed build, set both `NAW_APP_EXECUTABLE` to the app executable and
`NAW_TEST_APP_ROOT` to its `Contents/Resources/app` directory: the fixture then
loads the packaged daemon and adapters too. Optional `NAW_EVIDENCE_DIR` stores
private screenshots. Run desktop scripts sequentially and preserve the person's
normal UI/session state. This runner reports a single owned-process RSS/CPU sample
and launch timings, not a steady-state or native-agent performance guarantee.
Observed renderer requests are not a complete egress/privacy audit.

## Collaboration, context and archive regression

`npm run test:collaboration` runs a hidden Electron/DSH window with the production
workspace, IPC and Codex history adapter, using synthetic provider transport.
It exercises real pointer drag into/out of the room, invalid/cancelled/repeated
drops, duplicate-name mention selection by stable ID, exact outgoing text,
timeline search/filter and context visibility after long Markdown mounts, explicit shared background, local notes and conflicts,
late replies after departure, rename persistence and archive/restore after reopen.
Two windows are intentional only for the concurrent edit/ownership cases, and
the observer is closed afterward. It makes no native provider or model request.

Archive checks include an active native-status fixture, blocked new input,
unchanged IDs/drafts/history, room roster restoration excluding separately
archived members, and no replay. Unit checks additionally simulate partial
archive/restore failure and cold retry, failed disk writes, stale clear requests,
and pending input invalidated while awaiting authorization. These are not proof
of native process recovery after reboot or active fleet lifecycle.

Use both `NAW_APP_EXECUTABLE` and `NAW_TEST_APP_ROOT` as above to test the installed
artifact, not a packaged UI against source-only service code. Evidence stays
outside Git. Run sequentially; this is application pointer-input verification,
not physical trackpad, IME, VoiceOver or external-application drag certification.

`codex-history.test.cjs` separately covers paging, live/history arrival in both
orders, same text with distinct identity, own GUI echoes, overlapping deltas,
working/approval races, closed/stopped reads, malformed data and failed/cyclic
pagination. History imports neither dispatch work nor impersonate human input;
a real human notification must still take precedence even if already displayed.

## Alpha.23 core acceptance

Use `test:room`, `test:collaboration` and `test:solo` with the installed executable
and `NAW_TEST_APP_ROOT` to test the actual bundle's UI and service. Parent/child
model trials are separate and capped; alpha.23 used five parent submissions plus
one observed Codex child. Replaying native event shapes tests protocol mapping
without rerunning a paid fleet.

The visible guest core journey used actual OS pointer/keyboard events with
synthetic provider replies: drag in/out, typed `@`, one send, explicit three-reply
authorization, notes, rename, archive/restore and normal reopen. Four synthetic
submissions were checked against recipient/payload counts. Initial driver-only
errors (input-source identifier, ambiguous menu selector, wrong assertion field)
are retained in private logs and do not count as product passes or retries of
paid tasks. Final state assertions and visible screenshots establish the result.

Installer checks use a fresh app profile and a guest without the host's auth.
Keep downloaded quarantine attributes, compare SHA-256, use only app-specific
Gatekeeper approval, and verify prerequisites after installation with Recheck.
Do not use curl-only copying as browser-quarantine proof. The guest test found
the system Python shim masking a later real installation; the selection-stage
regression and final guest native startup cover that fix. Native login screens
are not evidence of completing a new account's authorization.

## Recorded native collaboration trial (2026-10-19)

The installed alpha.23 interface was exercised with OS mouse/keyboard events in
an isolated macOS guest. A test-only SSH socket bridge connected that interface
to the production daemon and real native agents in a separate host test profile.
Provider credentials stayed in their native host stores. This bridge is test
infrastructure, not a supported remote-session feature or clean-account setup.

One synthetic study-planning task covered both a 90-minute plan and a human
change to 75 minutes. Claude proposed the first plan; Codex checked it through
an explicitly authorized two-reply exchange. Claude was dragged out for the
private revision, then the person explicitly shared the revised constraints and
answer for Codex to check. An independent local validator checked durations,
order, uniqueness, internal rests, continuity and the maximum work interval.
Both plans passed; six malformed counterexamples were rejected.

Exactly four parent submissions were observed: two on Claude Haiku 5.5 and two
on GPT-6-Luna, both with low effort. Native events/transcripts showed no tool or
child-agent calls for this task. Native hooks and MCP startup did occur; a parent
submission count is not a complete cost, network-activity or side-effect audit.

The visible trial also checked:

- Typed `@`, room/session naming, explicit shared context and retained notes.
- Unchanged Codex and room histories during the private revision, until sharing.
- GUI/TUI switching, unsent native inputs and separate solo/shared GUI drafts.
- Two normal UI quits/reopens, including reopening archived records.
- Room/session archive and restoration, repeated real pointer drag in/out,
  timeline search/copy and unchanged native identities, histories and dispatches.
- Removing the selected recipient clears the target and disables sending;
  the draft is retained without silently choosing another agent.

Fifty-seven targeted local regressions also passed for takeover, permissions,
late replies and recovery. Those checks are not additional visible native trials.
Driver synchronization errors around native select-menu closing were retained
as failed attempts; they did not cause duplicate model submissions. Independent
review found no blocking product defect in this task. Raw recordings and an
original-speed excerpt remain private; native status bars contain personal paths
and quota information. This result does not establish full fleet recovery,
arbitrary unattended completion, physical-device parity or equal-task cost.


## Native observation and cold recovery — alpha.24, 2026-10-19

Run `npm test`, `node scripts/test-native-progress.cjs`, `npm run test:solo`,
`npm run test:reading`, and `npm run test:draft-ownership` for the affected local
regressions. No native model is called by these runners. The full unit run passed
203 tests; the later missing-model assertion also passed the observation group.
The observation runner uses real Electron/daemon/xterm and a synthetic provider,
including actual screen equality, bounds, lost-sequence resync, paused replay,
GUI-first no-TUI tool progress, composition DOM/focus retention on reconnection,
manual scroll and no readonly input/open/resize. It also checks that queued or
peer structured progress stops when the UI reports disconnected.

Maintenance counterexamples cover two ended stores plus a working peer, late
initial acknowledgements and queued operations. Targeted replacement leaves the
other real service PID/socket intact. These checks are not a physical IME upgrade
trial. Physical System Pinyin/WeChat input evidence is reused from unchanged
alpha.22 input paths; no new claim for every input method/device.

The visible macOS guest trial used OS mouse/keyboard, current product UI and real
host native runtimes through the same isolated test bridge described above. The
CSV task involved one Codex submission and one explicit @Claude submission, each
on a verified inexpensive model. Both found 3 rows and total 23. Raw terminal,
structured tool, permission wait and completion were inspected. Human approval
in the original terminal invalidates automatic room sharing by design, preserving
the result privately. Two total parent submissions, no new child activity observed.
No extra marker turn or repeated paid run was used for UI changes.

After native work was idle, an owned test-backend shutdown simulated a fault.
Explicit UI history recovery retained both native IDs, prior messages and room
membership; dispatch count since restart stayed zero. This is **fault/cold recovery**,
not an ordinary successful Codex termination: native unsubscribe returned
unsubscribed/notSubscribed and correctly stayed disconnected. It is also not a
hot alpha.2 migration or reconstruction of native teams. No real user backend was
stopped. The guest was briefly stopped by the disk guard; that interruption was
not reported as product failure or as a continuous installation journey.

Guest product source was checked against a 65-file manifest. Subsequent local
maintenance fixes were separately tested on the updated source and packaged
artifact; do not attribute unexecuted code to the earlier guest recording.
The final installed alpha.24 artifact passed ZIP CRC, code-signature verification
and exact source comparison for all 32 packaged app files. Four sampled user-state
files retained their hashes across replacement. The observation runner was then
run against the installed executable and installed daemon/modules: 202 latency
samples, P95 19 ms, no page errors and zero native input/open/resize/send actions.
This last runner is a hidden synthetic regression, not another visible native task.
Application search and LaunchServices both resolve one normal installed app;
the owned VM, test bridge and isolated test backend were stopped after testing.
The private video is a roughly 149-second edited excerpt of the real task and
recovery, with idle development intervals omitted. Full timestamped screen frames
and native event logs remain local; none are embedded in the public repository.
Source/protocol evidence, visible GUI evidence and installed artifact evidence
remain distinct. See `live-progress.md` for retention/performance boundaries.


## Retained-session continuity — alpha.26

As of 2026-10-19. A real isolated alpha.2 service retained both native sessions
while the new Electron UI connected through the compatibility path. Codex Luna
(low) created a one-line arithmetic file; UI automation selected its result in the
actual GUI share dialog and sent one check to Claude Haiku 5.5 (low), CLI 2.1.304.
Claude read the file and confirmed the arithmetic. The recording includes the
explicit preview/send, running native screen and result. Two parent submissions;
no observed child activity, not a complete fleet/token billing audit. Raw video,
native screen dumps, operation logs and screenshots remain private. The Electron
test window stayed hidden to avoid switching the user's macOS Space; its real
renderer was operated and recorded. This is not physical keyboard/IME evidence.

Two subsequent zero-model UI cycles used pointer drag to detach/rejoin, archived
and restored a session, archived the room, quit/reopened the UI, and restored the
room. Exact native IDs, PIDs, two messages per native conversation, private draft
and explicit shared message were retained with no replay. Tests also exercised
switching a retained Codex terminal's composition to GUI, without losing the
original xterm or submitting the unfinished native prompt. CDP composition does
not prove physical System Pinyin/WeChat behavior; earlier OS evidence is separate.

The full local suite passes 237 checks, including owner changes, stale initial
responses, pending interrupts, exact turn matching, connection shutdown, ACK
storage failure and shared-history clearing during pending/new sends. A separate
receive-order regression checks both initial/event orders in one actual IPC parser
chunk. The UI restore check waits for the dialog to close and archive state to clear
before inspecting the roster; clicking a button alone does not await its handler. Real UI
IME and native-progress fixtures pass with synthetic providers and no model call.
These fixtures supplement, rather than replace, the two real native tasks.

Retained automatic reply routing remains disabled: old Claude submission ACKs
lack a resulting turn ID, so temporal/text matching could expose an unrelated
private reply. The direct shared send is locally persisted and explicitly labeled; viewing
the recipient and selecting its reply is the supported continuation. Native
Codex attachment checks that the original thread is loaded before subscribing,
but the provider does not offer an atomic loaded-only resume contract. Neither
this test nor a readonly pane proves full active-fleet migration or recovery of
already overwritten terminal frames.


## Same-session recovery and reply identity — alpha.27

As of 2026-10-19. The current Claude adapter now requires the native prompt ID
observed through the public plugin API, a single matching main-thread prompt
append with the engine-pinned plugin origin, and the matching Stop ID before
sharing a reply. Native acceptance without provable attribution remains accepted;
the reply stays private and subsequent handoffs pause. Authorization-before-input,
identical human text, stale Stop events, conflicting native appends, hook exception
and timeout fallback, and previous-service capabilities have explicit regressions.
Old running services without this capability cannot inherit the new UI's permission
to forward replies. Their native processes and solo input remain available.

A real Electron/DSH trial resumed the two existing native sessions, then used
Claude Haiku 5.5 low and Codex Luna low for one arithmetic check and its review.
Exactly two new parent submissions were observed; the second input contained the
first agent's new response. The reply cap stopped further routing. Native journal
IDs, the two results, the shared timeline and both live terminal panes agree.
The short successful recording and complete local evidence remain private.
No tool or child call was observed in these two new turns; this is not a provider
billing audit. A separate native plugin-engine probe established prompt/append/ACK
ordering without invoking a model. No paid retries were made.

Cold recovery exposed an old cache defect: early Codex services assigned random
local IDs to native user rows, so native history added a second displayed copy.
Full successful history import now reconciles unmatched pure-text legacy rows
one-for-one, only from the recovery-start snapshot. Native ID/clientId matches,
repeated text counts, mixed-content inputs, GUI submissions and new live input
are protected. Unmatched cache remains. Text matching here changes the local
presentation only; it never authorizes routing, emits input or changes native
history. The synthetic old cache was reset to its original failing baseline for
reproduction, while the real native journals and completed shared run remained
untouched. The fixed recovery shows four messages per original session with no
new model submission. The implementation builds lookup queues once instead of
scanning the complete cache for every historical item.

The full local suite passed 265 checks with no skips. The later equivalent
linear-time cache implementation passed its 44 affected history/recovery checks.
Claude's native plugin validation and both plugin-engine tests passed. The exact
known previous compatibility plugin upgrades successfully; user-edited plugin
files remain untouched. Final installed alpha.27 passes exact source/archive/signature checks, same-ID
native recovery and two pointer-driven lifecycle cycles (drag, detach, session
and room archive/restore, UI reopen, private drafts and shared records). The five
installed progress groups pass with 204 synthetic paint samples and P95 20 ms;
all observed input/open/resize/send side effects are zero. Eight deterministic
input groups pass; physical foreground return is skipped to preserve the user’s
Space. User-session PID, identity, history/draft and stored-view hashes remain
unchanged. Independent review read these outputs and compared the installed code.

The task recording uses the real application renderer and native providers with
a hidden test window, avoiding foreground/Space disruption. The exact resume
confirmation is answered by the test harness; this is not a physical OS click.
A repeated guest IME experiment did not complete: its assumptions about initial
view and the IME's inserted space were incorrect, and the disk-reserve guard later
stopped the guest. It is not a pass. The unchanged renderer/input path retains the
earlier alpha.22 visible System Pinyin/WeChat evidence and later regression checks;
this release adds no new universal IME/device claim.


## Local find and disconnected-session continuity — alpha.28

Source tests cover literal local search, current/all/shared scope, pagination,
archive inclusion and exclusion of private drafts. The actual hidden Electron/DSH
search runner uses 160 synthetic records, a match deep inside a long Markdown
message, streaming while reading, the original reading position and shared filters,
archived-session reading, archived-room preview/copy and close/reopen. Search
queries are not persisted. Markdown syntax that has no visible equivalent may
locate the message rather than an exact text range.

The native reconnect runner uses a previously completed isolated Codex history:
continue, disconnect, continue the same thread, check exact history and Chinese
draft, then open its native TUI. No new task is submitted. A separate real empty
thread probe confirms reconnect without manufacturing a model turn. The transport
fixture verifies cancel, failure and retry through the actual dialog/action path.
Native dialogs in these hidden tests are answered by the test harness, not OS input.

Regression cases include old reconnect success/failure/history arriving after a
new connection, old send failure after a new pending task, early approvals,
empty-thread status races, history-read failure, concurrent stop and closed legacy
observers. A first accepted user input stays accepted when subsequent observation
fails; it is never automatically resent. Reconnection uses only thread identity
and the native exclude-turns option, without model or permission overrides.

Native progress labels a disconnected session as a frozen observation, refreshes
on reconnection, and rejects snapshots from an older connection generation. Its
actual UI test covers an old held snapshot arriving after the next connection.
Search/progress/connection tests do not create a model turn or edit native settings.
The final artifact matches all 35 packaged application source files and passes
signature verification. Installed reconnect and ten two-window draft-ownership
checks pass; unchanged bundled search/progress files retain their installed
six-group checks. The complete local suite passes 296 tests with no skips.
The original three user sessions, histories, drafts, view files and process
identities remain unchanged; application search has one existing installed entry.
Temporary app bundles were removed, retaining the previous rollback archive.
Independent source and final installed-artifact review passed within this scope.

Reviewer counterexamples also cover rejected old-owner input after takeover and
an empty retained thread completing before its ACK. Clearing the old pending slot
cannot modify the new owner's draft/work. The accepted native turn ID survives
completion and observation does not emit a second reply or resend an input.

## Owned native backend failure — alpha.29

A synthetic local server first reproduced an exited child with a permanently
cached closed RPC. The repair releases only a confirmed dead owned lease, rejects
an endpoint that still answers, and fences old runtime events, queued creation
and late startup results. A remote display-client exit must be confirmed before
continuation is offered. Its pending-exit period is read-only, including the
actual IPC input path; the last observation remains available.

The real native UI trial reuses previously completed isolated Codex history. It
opens the native terminal, retains a Chinese graphical draft and room membership,
terminates only the test-owned server, waits for recoverable state, and explicitly
continues the same native ID with a replacement server. History, draft and room
membership match; GUI/TUI switching works and dispatch count remains zero. It
submits no new model task. Hidden windows are non-focusable; native dialogs are
answered by the test harness, not physical OS input.

Synthetic regressions cover input before an acknowledgement, unchanged versus
newer drafts, dead transport with a living process, a still-listening endpoint,
unconfirmed display exit, old completion/events and creation slots. Actual
Electron tests additionally verify the read-only pending-exit state and restore
path. Final installed checks cover four connection groups, six observation groups
and the real native no-task recovery. All 35 packaged application files match
source and signature verification passes. The complete suite passes 307 tests
with zero skips; the final endpoint/startup cleanup additionally passes ten
focused regressions. Original user sessions, histories, drafts and view files are
unchanged, with one existing installed application entry. Independent source and
final installed-artifact review passed for this bounded repair.

## Continuous-output checkpoints — alpha.30

The old trailing-only save timer was reproduced with uninterrupted output: the
conversation changed in memory while the disk retained no part of that reply.
Short bursts still coalesce for 150 ms, with a separate one-second scheduling
target for an uninterrupted stream. Direct persistence and normal close cancel
both timers. This is not a real-time or power-loss durability guarantee; changes
not yet checkpointed can still be lost in a crash.

The actual Electron/service test creates 400 synthetic historical records, enters
a Chinese draft, joins the shared room and receives continuous output. It kills
only its own test daemon with SIGKILL, then clicks reconnect. Checkpointed text,
message IDs/order, native identity, draft and room membership survive; no provider
process or model task is created. The related direct regression confirms a native
closed event followed by a late rejection of that same resume cannot change the
confirmed ended status. The same UI test obstructs its own checkpoint temporary
path, verifies a failed retry leaves the old checkpoint intact, removes the
obstruction and clicks retry again. Current history, draft and membership are
saved with no native action. Separate regressions preserve unread/corrupt originals
and reject retries queued across a backend replacement. Final installed acceptance
passed independent review.

The recovered partial-reply label was checked against the previous built UI,
where it incorrectly claimed to be replying, and the corrected build. Session
and progress state remain the source of current activity.

A 45-minute real Electron reading run used 1,000 synthetic historical records,
90 selection/stream/conversation-switch cycles and a retained Chinese draft.
All eleven reading checks passed, including stable selection/scroll/focus,
late-output isolation and reopen/quit restoration. Initial history rendering took
930 ms on the test host. Sampled application working-set totals ranged with
garbage collection, peaking at 1,011 MiB during the timed loop and ending at
750 MiB; the later reopen sample was higher. These are observations, not a
cross-machine performance or leak-free guarantee. No model or provider process
was used by this run.

The actual renderer privacy trial uses synthetic content and a separate loopback
receiver. Script-bearing HTML remains inert; Markdown cannot read a private
test file, and image/fetch/WebSocket/beacon probes do not reach the receiver.
Copy and external-link actions are intercepted to verify their explicit payloads
without changing the system clipboard or opening a browser. Privacy-panel refresh
retains zero dispatch and correctly distinguishes missing usage from zero usage.
This covers the application renderer, not native provider/tool network traffic or
a security certification.

Real empty-daemon boundary tests reject non-object, malformed, unauthenticated
and oversized frames while a valid observer remains responsive. The draft and
privacy UI runners reconnect to their final backend layout for cleanup and verify
owned services exit. Unknown and user-owned native processes are preserved.

The complete suite passes 317 checks with zero skips. Final installed storage,
privacy and draft flows pass; the installed empty-daemon/client/RPC boundary
checks also pass. All 35 application files match source and signing verification
passes. Original three sessions and their history/draft/view records remain
unchanged; system application search lists one installed launch entry.

## Graphical transport recovery — alpha.31

The native backend and its remote terminal may remain alive after the GUI RPC
socket closes. Continuation now explicitly reconnects that owned backend and the
selected native thread. It validates both the published endpoint and the resolved
socket when Codex uses a symlink. Reconnection does not start another backend or
terminal, change native settings, replay a task, subscribe unselected peers or
restore an earlier reply-sharing authorization.

Negative regressions reproduce a first-turn observer crossing into a replacement
connection, a stale permission decision matching a reused native request number,
a replaced target behind an unchanged symlink, and replacement of a retained
terminal's recorded process identity. Lifecycle/RPC/process guards, request-scoped
decision tokens and separate endpoint/process identities repair those cases.
The complete suite passes 331 checks with zero skips.

The real installed Electron/native trial resumes a previously completed isolated
Codex test history, opens its actual TUI and enters an unsent Chinese GUI draft.
Private instrumentation closes only the graphical WebSocket. The original TUI
still accepts and clears unsent text. Clicking continuation restores GUI access;
native thread ID, backend PID, terminal PID, both recorded process identities,
model, complete messages, room membership and draft remain unchanged. UI close
and reopen preserve the same native processes. During acceptance, the application
RPC trace contains only initialization, history reads and two resumes: the initial cold resume retains its
saved working directory; the subsequent transport reconnect passes only thread
identity and history-exclusion flags. There is no new thread, turn or steering
request, and the dispatch count remains zero. Cleanup then unsubscribes the
test-owned thread. This trace instruments the application's RPC calls, not every
request issued internally by the separate native TUI.

Source and installed renderer tests cover cancel, failed retry, successful retry,
switching to the retained TUI, a queued click on an obsolete permission button,
current refusal and the existing confirmed-backend-exit gate. These permission
events use synthetic native transport; they are not new proof of a native tool
permission round-trip. Test confirmation dialogs are answered by the harness.
All test windows remain hidden and non-focusable, so this run does not revalidate
physical OS IME or foreground switching.

The installed artifact has 35 application files matching final source and passes
signature validation. Existing three user sessions and their history/draft/view
files are unchanged; protected native processes stay alive and system application
search finds one installed app. Final independent source and installed-artifact
review passed for this bounded recovery repair.

## Native confirmation synchronization — alpha.32

Native `serverRequest/resolved` updates the original progress record and removes
only the corresponding action. It means answered or cleared, not successful tool
execution; the native thread status remains authoritative. Sending a decision
disables repeat submission while awaiting the native event. A disconnected
observer marks unresolved progress unknown. The compatibility adapter explicitly
overrides an old daemon's cached approval even when the current value is null;
obsolete numeric IDs cannot fall back to the older transport.

Negative checks reproduce stale buttons, false local working state, compatibility
fallback, duplicate-request resubmission and conflicting contents under one
unresolved native ID. Fixes preserve the original request/connection, distinguish
numeric and string IDs, retain pending decisions on duplicate delivery, and direct
ambiguous requests to the native terminal. These are synthetic protocol
counterexamples, not claims of provider defects. The complete source suite passes
349 checks with zero skips.

The shared display/backend policy presents the complete command, directory and
reason. Network/additional-permission scopes, file changes, terminal input and
unsupported native decision lists cannot be accepted as ordinary commands.
Where the native method permits refusal, it remains available without granting
the hidden scope. Direct IPC and compatibility calls enforce the same policy.
An actual previous alpha.31 daemon is retained while the new GUI opens a new
active backend: the older session retains its native ID and terminal but offers
no GUI decisions, and direct accept/decline calls are blocked. This demonstrates
per-session capability isolation rather than assuming the active backend's
capabilities apply to all sessions.

The first full suite after policy extraction exposed a missing module in the
independent runtime copy. The runtime manifest now includes it; that negative
result is retained alongside the passing repeat.

The real Electron runner clicks current and obsolete actions, switches GUI/TUI,
retains an unsent draft, receives native-resolution/status events, and loses the
connection. It checks the original progress rows and exact outbound decisions,
with no native provider or model tasks. An actual screenshot exposed low warning
text contrast; rendered light/dark checks now cover this confirmation area.
Two initial UI attempts with an added recording configuration timed out before
the product entry appeared; those failures are retained and are not passing
evidence. The existing hidden non-focusable launch path works without that
recording option. This round produces screenshots, not a new successful video.
Physical IME, foreground switching and live native tool permissions are not
retested by this runner. Final installed verification and independent review pass.
The final installation matches all 36 shipped source modules; the installed UI
repeats four confirmation groups, light/dark readability and the corrected pending/
resolved composer hints. The actual prior-backend isolation check, empty-profile
cold boot and six reconnection groups also pass. Test windows remain hidden and
non-focusable, owned test daemons exit, and original user records/processes remain
unchanged. There is one discoverable installed app. This closes only A32-1–7, not
the remaining full-product and arbitrary-old-backend acceptance.

## Long-session navigation — alpha.33

A real hidden Electron probe with sixty retained histories reproduced two issues:
the shared workspace was below the viewport, and opening the last session from
search left its selected sidebar row offscreen. Session history now scrolls in
its own section; shared-space and utility actions remain reachable. Explicit
selection reveals the complete row, including its menu in the compact rail.
Native state updates do not reset a person's manual sidebar scroll.

The navigation runner uses ninety synthetic saved histories (thirty initially
archived), plus one live synthetic transport. It exercises search, a long rename,
archive and last-entry restore, actual pointer drag to/from collaboration, repeated
native status updates, the minimum-size window, keyboard menu dismissal and UI
reopen. Identity, history, names, archive state and an unsent draft remain intact;
there are no model submissions or native provider processes. This is navigation
acceptance, not physical OS-input or full compact conversation-layout acceptance.
Six source and installed navigation groups, six source search groups and five
installed daily-use groups pass; independent final artifact review passes. All
36 shipped application files match source. Original user records and protected
processes are unchanged, with one discoverable installed app. The 349-check
alpha.32 backend result is reused for this UI-only change, not claimed as a new
full-suite execution.


## Compact reading and native-panel empty states — alpha.34

A real hidden Electron window at 850×600 reproduced zero readable text height in
both solo and shared views. The existing raw panels now shrink/scroll while the
conversation retains at least four text lines in the tested geometry. No output
is filtered or removed to make space. Initial native panels show no frame controls
until a frame exists; a disconnected panel with received output keeps that last
frame, while an ended session without cached output says so.

An independent reviewer identified a further counterexample: manually resizing
the shared draft to 200px pushed Send below the viewport. The actual pointer-drag
reproduction failed before the responsive height limit. An initial composer-scroll
fix also failed the ordinary-input check and was revised: the editor retains its
normal height, with a bounded scroll area for expanded recovery copies.

The compact runner verifies the solo/shared timeline, pointer/keyboard folding,
canonical terminal buffers, distinct unsent drafts, explicit member-terminal
switching, long permission scope and reachable decision actions, retained versus
absent last frames, and three persisted recovery copies after reload. It uses
synthetic provider events and actual Electron controls; no model task or native
provider process runs. Five source and installed groups pass. Six raw-progress regression groups
and eleven reading/selection/reopen checks pass in the final installed app.
Independent final review passes; all 36 shipped app files match source. Original
user records and five protected processes are unchanged, with one discoverable app. Four unchanged UI-lifetime checks pass without skips. This is not a new
physical input-method, screen-reader or complete accessibility certification.

## Unreadable window-record protection — alpha.35

An actual isolated Electron probe reproduced a destructive recovery path:
truncated views.json was treated as an empty array and overwritten during startup
and quit, removing a synthetic saved draft recovery copy. The separate ViewStore
now accepts only a successfully read compatible record (or a genuinely absent
file) before allowing writes. Malformed content, read denial, a file disappearing
after stat, unsafe file type/ownership/mode and invalid draft shapes fail closed.
Unique owner-only temporary files avoid following a predictable temporary-file
symlink; rename failure preserves the prior file and removes only the owned temp.

All 355 unit checks pass without skips. The real Electron runner checks damaged
startup, repeated failed retry, quit, an actual chmod-induced read denial, and
explicit retry after restoring a known-good synthetic backup. Both original
windows, selected identities, legacy/private/shared drafts and recovery copies
return. Further editing and another reopen retain them. No new DSH host starts
while the record is unreadable; the existing service connection stays unchanged.
The data-folder button is clicked through its actual guarded IPC, with only
shell.openPath intercepted so Finder does not change the person's desktop.

All provider opens, input writes, resizes and sends remain zero in this runner.
Its two windows are intentional, hidden and non-focusable. This is local recovery
evidence, not physical IME, provider-history restoration or power-loss durability.
The original user's view-record shape was checked read-only for compatibility.
The same three installed recovery groups, nine source normal-draft checks and
eleven installed reading checks pass final independent review. All 37 application
files match the tested source, with a verified ad-hoc signature. Original user
records and five protected processes are unchanged; one app is discoverable.

## Window save failure and safe close — alpha.36

An actual Electron write-fault probe showed that closing a window after a failed
view save still closed it and produced two uncaught main-process error dialogs.
Only the older draft was on disk. Normal close and quit now cancel if saving the
view record fails; the existing UI host and editable drafts remain. An intentional
window destruction cannot be cancelled, but its failed save is handled without
throwing another main-process error.

Independent review identified two further counterexamples, both reproduced:
a post-native-acceptance save error caused the graphical send to appear failed;
a storage event before a peer's initial snapshot caused an undefined-state error.
The accepted result now stays accepted with a separate storage warning. The latest
storage event survives initialization and an older initial snapshot.

The real source runner checks held initial delivery, two-window close/quit
cancellation, failed and successful retry, original host retention, reopen with
independent shared/private recovery copies, and local retry after backend exit.
Private text not acknowledged by the service stays a recovery copy rather than
silently replacing the service draft. A delayed synthetic-acceptance check verifies
one submission and no replay through the later save failure. Ten source draft
checks and all 355 unit checks pass without skips. Native provider/model tasks
remain zero. Six installed write/lifecycle groups, including normal single-window
close after recovery, ten installed draft checks and three installed read-failure
groups pass final independent artifact review. All 37 app files match source and
the ad-hoc signature verifies. Original user records and protected processes are
unchanged, with one discoverable app. Force termination, crash and power loss
are outside the cancellable close/quit protection.

## Saved window placement — alpha.37

An actual Electron startup restored synthetic saved coordinates outside every
current display. The window ran but had no visible overlap. The new placement
helper restores only unreachable title bars and unusably small dimensions;
reachable positions, including intentional partial placements, remain.
Six focused geometry checks include negative-coordinate displays, a small work
area, hidden title bars, invalid native-coordinate input and the independent
reviewer's accessible 100×100 counterexample. All 361 unit checks pass without skips.

The actual source Electron runner checks offscreen recovery, persisted corrected
bounds, two independent windows/drafts, repeated normal reopen, unchanged native
identity/service and a real undersized-record recovery to the native minimum.
All provider opens, inputs, resizes and sends remain zero. Windows are intentionally
hidden and non-focusable; this does not certify OS Space assignment or live monitor
hot-plug handling. Small/negative display configurations are geometry fixtures;
the actual restart runner uses the host's current display configuration.
The same four installed restart groups and six installed save-failure lifecycle
regressions pass final independent review. All 38 shipped app files match source;
the ad-hoc signature verifies. Original user records and five protected processes
remain unchanged, with one discoverable app.

## Sharing preview continuity — alpha.38

An actual sharing-dialog reproduction confirmed that an old send acceptance
closed a newly opened preview. Preview revisions now bind completion to the
original unedited content and recipient. Blank text and additional clicks while
acceptance is pending do not submit. People can still edit or close the preview;
doing so does not retract an already accepted native task.

Real Electron controls with delayed synthetic transports cover same-text edits,
cancel/reopen before success or failure, retained edits after rejection, explicit
keyboard retry, Escape without reopening, and recipient departure/rejoin before
native acceptance without automatic selection or replay. Departure does not
cancel work already accepted by a native agent. The first runner's final count assertion used
the solo-message role instead of the shared-message role; correcting it changed
only the test, not the stored records. Earlier failure evidence remains private.
Seven source groups and seven existing room-send groups pass source review.
The same seven installed preview groups and five installed daily-use groups pass
final independent review. All 38 app files match source and the ad-hoc signature
verifies; original user records and five protected processes remain unchanged,
with one discoverable app. No new native model task was run.

## Keyboard controls during native updates — alpha.39

Actual Electron reproduction showed that unrelated native history updates removed
the focused header, member and permission buttons. These controls now retain their
DOM nodes while the represented action remains valid. A changed permission request
or owner still rebuilds or disables decisions; removal of a focused member moves
focus to dialog completion instead of another member action. Advanced local
notes/context controls use the same stable-node approach.

Seven source keyboard groups cover history/name updates, exact member navigation,
member departure, changed permission/ownership and repeated selection/membership
changes. Independent review supplied a second real counterexample: a peer changed
a focused join button into leave, so Enter performed the opposite operation.
Membership controls now withdraw old focus only when their session or action
changes; both directions pass the regression. The first runner incorrectly expected a raw numeric permission ID; the
actual service uses an opaque request identity. Its corrected assertion compares
the two real identities and checks rejection of the old one. Production behavior
was unchanged by that test correction. The separate native-confirmation runner
checks actual IPC decisions, duplicate delivery, pending/resolved states and
special permission scopes with synthetic protocol events. The installed app passes
the same seven keyboard groups, four permission groups and six collaboration
groups (including drag, context, archive and reopen). All 38 app files match
source and the ad-hoc signature verifies. Original user records and five protected
processes remain unchanged, with one discoverable app. Independent final artifact
review passes. No new native model task was run.

## Local idle resource sample — alpha.38

A five-minute installed-app check sampled six owned processes in each sample
at 15-second intervals, with two idle synthetic native-progress panes. Interval CPU time
was a median 0.1% and maximum 0.8% of one core. Summed resident memory was 748 MiB
at the first sample, then 718 MiB for the remaining samples; the six-process count
stayed constant. Provider opens, inputs, resizes and sends were all zero.

This was a hidden, non-focusable Electron window with background throttling
disabled for testing. Summed RSS can count shared pages more than once. These
numbers do not include real native agents, certify visible-window energy use,
or establish long-term leak freedom. The original user's processes were excluded
from measurement and retained.

## Selection-to-sharing continuity — alpha.40

With a real room recipient available, the installed alpha.39 pointer probe selected
text in the readonly native pane but the header asked the person to select text.
The same mouse action in the repaired source opens an exact-text sharing preview.
The initial probe without a room recipient was insufficient on its own: the
repaired path correctly asked for a recipient. Both results remain in private
evidence, and the corrected comparison uses identical recipient prerequisites.

The existing header action now reads only the current visible native pane or
conversation/trace/permission text. A new document selection replaces an older
terminal selection and vice versa. Empty, hidden and other-pane selections are
not shareable. No selection text is cached across sessions. The preview and its
explicit recipient/confirmation remain unchanged. No clipboard read or model call
is added by selection, viewing, opening or cancelling a preview.

Actual pointer/keyboard source checks include exact readonly and native-terminal
selections, competing document/native selections, session and view switching,
keyboard collapse of native pane/trace/record and room-to-member navigation.
Early runner failures were corrected to await the selection event and identify
the selected terminal by session ID, rather than matching multiple retained DOM
screens. Five source and installed selection groups pass, as do six installed
native-progress and seven installed sharing-preview regression groups. All 38
app files match source and the ad-hoc signature verifies. Original user records
and five protected processes remain unchanged, with one discoverable app.
Independent final artifact review passes. No native model task was run.

## Full local regression and first-turn native permissions — alpha.41

On 2026-10-20, all 23 existing installed-app scenario runners passed: solo/daily
use, collaboration and room sending, drafts and ownership, composition and view
switching, privacy boundaries, search/reading, progress/permissions, reconnect,
view/storage recovery, window placement, controls, sharing, navigation and menus.
Two stale test assumptions were corrected: a GUI-only thread has no retained TUI
frame on disconnect, and an ended unowned fixture cannot write a native draft.
The checks retain history/draft and focus assertions; neither change relaxes the
production boundary. Physical foreground/IME return was intentionally skipped to
avoid taking over the person's macOS Space. Prior guest OS evidence is unchanged.

A subsequent real Codex 0.163.0 runtime check found a first-turn approval dead end:
`environmentId: local` plus literal accept/cancel choices were not represented,
and opening the same native terminal demanded a completed turn. Alpha.41 accepts
only the native one-time local decision, sends native `cancel` as turn cancellation,
and advertises this support separately from older approval synchronization.
Old backends retain their supported decisions without receiving unsupported ones.
The first terminal attachment reads the owned native rollout and checks identity,
transport and lifecycle before attaching; it never creates an artificial turn.

Source and installed UI checks used the actual native binary and its permission
protocol against a loopback synthetic Responses server. They verify GUI accept
→ exact native RPC reply → resolution → fixed command output/exit 0 → completion;
first-turn same-thread native terminal attachment; native TUI cancellation of a
file-change request with no file written; and GUI cancel → native interrupted turn.
Each run submitted three user turns. Two native ephemeral title threads were also
observed per run; there were five source and six installed loopback HTTP requests.
There were zero external paid model requests. This is native protocol/runtime
proof with synthetic inference, not a provider inference or billing benchmark.
A test-wrapper permission override initially blocked remote TUI attachment; the
wrapper was corrected to configure only its own server, with native resume left
unmodified. The failed attempt and successful native screens are retained privately.

Independent screenshot review also found a stale terminal-exit activity after
reopening. The final build clears only that specific notice on a new display's
start; other activities remain intact. Actual local PTY process exit/restart checks
pass against both source and the final installed adapter. All 372 unit checks pass.
Seven final affected installed runners pass: native confirmation, control focus,
reconnect, solo use, room sending, input/composition and draft ownership. Final
independent delivery review is recorded in review.md. Original user sessions and stored profile hashes remain unchanged.


## Observed native child continuity — alpha.42

The next native-fleet gate began with actual Codex 0.163.0 using a local synthetic
Responses endpoint. It reproduced a misleading display: the root had replied,
its child was still running, but the UI said ready and the spawn activity's
completed envelope appeared as finished work. Alpha.42 labels that envelope as
an observed start, shows the last known child state in existing solo/room progress,
and distinguishes root readiness from child activity. It does not add model calls,
team controls, polling queries, shared child messages or fleet completion inference.

The final installed run submitted one root task and created one actual native
child, making exactly three loopback Responses requests. The fixed child response
was held while the UI joined a room, left it, saved a Chinese draft, closed and
reopened. Native root/child IDs, child activity and the unsent draft survived;
reopening made no new provider request or task dispatch. Releasing the response
produced the native child completion event and the UI changed to “本轮已结束”.
No private child event became a shared message. Screenshots, full native events
and an approximately nine-second app-frame recording stay private. This verifies
the native runtime/protocol with synthetic inference, not model quality/billing.
Early probes used unsupported function-call namespace shapes; a later fixture
misclassified child input and replied too early. Those attempts are not passes.
All inference in these probes used the explicit loopback provider, not paid APIs.
Playwright's optional video launch twice failed to expose the app DOM; normal
hidden launch and timestamped app screenshots were used for the final recording.
No macOS Space was brought to the foreground for this test.

All 379 unit checks pass, including same-name child identity, unrelated task
completion, contact-versus-start, stale legacy/transport/cold state, latest-eight
ordering and the actual native start/completed envelope shape. Seven source
progress groups pass. Final installed progress, control-focus, reconnect and
collaboration checks cover the affected surfaces; complete logs remain private.
Claude lifecycle interpretation has hook fixtures here, not a new live Teams run.
An observed completion describes that child's turn, not success, process exit or
full fleet termination. The 80-event window and latest-eight view are incomplete;
old retained services without freshness metadata remain explicitly unknown.


## Native registration task and display retry — alpha.43

The [registration acceptance scenario](acceptance/registration.md) was run through
actual installed alpha.42 Electron UI with one native Claude in-process teammate
and an independent Codex review. Native task ownership/status, messages and a
matching shutdown approval are in the private transcripts. The written final
file matches the independent oracle. Four human submissions include 12 lead and
eight teammate assistant responses plus Codex tool activity; this is not a
four-model-call or exact-billing assertion. Actual pointer drag, shared preview,
room naming/notes, private continuation, archive/restore and saved Chinese drafts
were exercised. Reopen occurred while the teammate was idle, not mid-inference.
After native file approval the final reply was deliberately private; automatic
return to the room is not a pass. This boundary is A43-3 in review.md.

A faulty test wrapper initially applied server-only permission flags to a remote
Codex TUI. Once corrected, the product still reused the dead cached display.
Alpha.43 uses explicit display lifetime/epoch: repaint cannot recreate a dead
view, uncertain exits remain blocked, and an explicit view action can replace a
confirmed-ended display without replacing its native server or conversation.
Old-epoch output cannot corrupt the new screen. Independent review also found
that a new snapshot can precede the batched state notification; a local state
confirmation now precedes input readiness/focus. A delayed reopened snapshot is
rejected if ownership changes before completion.

All **381 unit checks** pass with no skips. Source and installed reconnect,
control-focus and deterministic terminal-input runners pass. The reconnect fixture
withholds the new display's started/state notification, removes the cached DOM,
checks that repaint opens nothing, then checks explicit retry, automatic keyboard
focus and the first typed character. Separate counterexamples cover unknown exit,
concurrent attachment, delayed ownership changes and stale output epochs.

The final installed alpha.43 also resumed the task's actual Codex history without
submitting a prompt, opened its native terminal, typed an unsent marker, exited
the display through native Ctrl-C, and reopened through the same terminal tab.
The new screen accepted keyboard input immediately. Native thread and server
identity stayed unchanged; only display PID and epoch changed. Observed native
`turn/started` and new app dispatch counts were both zero. Existing history and
room records remained available. Raw native events, before/after state and actual
app screenshots support this check; it is not a synthetic transport result.

Independent final review checked the actual source, installed payload and raw
native evidence and closed A43-1/A43-2. The installed source payload, archive
digest and local ad-hoc signature match the tested build. Original user session PIDs, IDs, message/draft hashes and saved
views/labels were unchanged. Tests used one hidden, non-focusable app at a time.
Private timestamped recordings cover the first portion of the task and the full
later display-retry verification; they are not an uninterrupted full-task movie.
Physical OS input, full team cold recovery, external-provider billing and broad
native-version compatibility remain outside this acceptance.


## Long-history transport and reopen continuity — alpha.45

The previous app disconnected with 80 synthetic records totaling 19,457,001
bytes. A separate 1,200-short-record probe passed its eleven reading checks;
message count alone had missed the byte-size failure. The new bounded transport
passes an actual slow-socket test with a response above the old 16 MiB receive
cap and a backlog above the old 8 MiB send gate. Exact terminal bytes and RPC
responses stay ordered, and only queued complete state snapshots coalesce.

All 393 local checks pass with no skips. Source focus regression passes seven
groups, and deterministic input/composition regression passes with no model
calls. Foreground return is explicitly skipped to avoid taking the person's
Space; physical IME is not newly certified by these checks.

The final installed application passes all seven checks in
`node scripts/test-long-continuity.cjs`: 80 long records, 19,450,131 bytes, full
history hash, retained Chinese draft/membership/native ID, selection and reading
while output arrives, conversation and GUI/TUI roundtrips, quit during a held
native-control acknowledgement, normal reopen and forced local-service loss
followed by the actual reconnect button. The installed history mount took
4,763 ms in this sample; this is neither an end-to-end provider latency promise
nor a scale benchmark. Recovered native records are `recoverable`; no native
resume or model task is triggered. Cold reconnection exercises normal bootstrap
and its privately copied new transport module.

An additional actual alpha.44 daemon with 100 short synthetic records is retained
by the installed alpha.45 frontend while its current backend starts separately.
Normal reopen preserves the old daemon PID, native ID, exact history, draft and
reading position, with no migration/replay. The first probe assumed a newly
opened observer would default to chat; it actually used the saved/default
terminal preference. The corrected probe explicitly selects chat, then verifies
that choice on reopen. This does not assert that a retained old daemon gains the
new large-backlog behavior.

Final source/installed evidence is independently reviewed. All 40 shipped
application files match source; strict signature verification passes after the
installed tests. Five protected normal-profile data files remain byte-identical;
application search finds one normal installed entry. Test windows stay hidden
and non-focusable. No native provider process/model task is started by this
increment's scenarios. Raw profiles, logs and screenshots stay private.

See [M2 acceptance](acceptance/session-continuity.md) for finite frame/queue
limits, old-service capability boundaries and the history-paging trigger.


## Native Claude intermediate observation — alpha.54

Actual source and installed Electron checks cover the existing solo and room
progress panels, exact text, literal rendering, gap/truncation/media notices,
privacy and lifecycle. Both eight-group controlled UI runs pass; the final
479 local tests pass with zero skips. The declared dual-session synthetic paint
check records a 19 ms P95 in both source and installed runs (204 samples each);
that number is not native append-to-screen latency or an end-to-end guarantee.

A real installed Claude Code 2.1.306 process receives one explicit graphical task
from two canned loopback responses. The real tool executes harmless local printf.
While the second response is held, the actual UI already shows the intermediate
assistant text and the completed tool output, with the session still working.
After release, three native saved-message observations have exact content and
stable IDs. Join/detach keeps them out of the shared timeline and preserves the
unsent graphical draft. Normal application close/reopen preserves the same native
PID, root ID, all four progress rows and the draft, without another submission.
There are one Portal dispatch and two local protocol responses, no external model
inference. The unchanged native `/reload-plugins` command also retains identity
and input capability; it does not demonstrate replacement of an unchanged mod.

Separate zero-model counterexamples hold HTTP requests across timeout, native
root clear and real mod-registration reload. They verify tail-gap disclosure,
the two-request cap, monotonic order, retired observer rejection and unchanged
control lease. Neither those controlled timings nor Chromium input constitutes
physical keyboard/IME evidence. An earlier CDP Browser.close experiment hung
and was aborted; it is not counted as a reopen pass. The final reopen uses the
normal Electron application lifecycle.

The installed 41 source payload files match, strict signature verifies after
native testing, the four protected normal profile files remain unchanged, and
application search finds one ordinary installed bundle. Owned trial processes
are closed. No private screenshots, native history, tokens or full event payloads
are published. Existing retained services keep their old observation capability.
# Message delivery details — development, 2026-10-21

The real Electron application and IPC/native-session service were exercised with
controlled provider transport. Nine UI groups cover visible human submission before
ACK, exact payload and target, pending/accepted/uncertain status, mouse and keyboard
expansion, retained expansion across ACK, finite three-reply handoff payloads,
recipient filtering, failure, reopen, changed draft and recipient departure.
There were nine synthetic dispatches, one test window and zero native provider
processes/model calls. This is UI/transport verification, not a new native API or
physical IME test. The current installed build is not certified by this source run.

Workspace and retained-input checks pass 104 cases, including pending receipts
after cold recovery, no replay, accepted receipt surviving sharing revocation,
exact automatic wrapper, private-history exclusion and shared-history clearing.
The existing native input route is unchanged. These checks do not close U17's
complete real-time mapping, working-turn input or full multi-agent message stream.
Final full suite passes 482 checks without skips. Eleven existing actual Electron
reading checks also pass. A real mouse selection inside the expanded payload
survives its native ACK; the receipt updates without replacing that text node.
Independent review inspected source, callers, complete outputs and owned-window
evidence. Installation acceptance remains pending for this development increment.

## Working Codex input — alpha.58

`node scripts/test-native-steer.cjs` launches real Codex 0.163.0 and Electron
through normal service bootstrap, using an isolated native home and two canned
loopback Responses streams. The running turn receives GUI Enter input through
`turn/steer`; the second actual provider request contains that exact input.
The original partial response stays visible, ACK does not end the turn, the
final native boundary appears once, and the native TUI contains both inputs and
the result in the same thread. No paid model calls. Owned services terminate.
Native working input is gated to the inspected version and an observed turn ID.

534 local checks pass with no skips. Accepted and unconfirmed private steering
freeze an existing room stream before subsequent native output, retaining the
private continuation and adding no automatic handoff. The retained-reader
Electron regression exercises the original backend bridge, drafts and reopening.
Earlier full runs exposed stale IPC mocks after the UI-cookie fix; those mocks
now include the real bootstrap dependency. An initial native runner cleanup
incorrectly equated unsubscribe with termination; the fixture now terminates only
its exclusively owned isolated daemon and verifies its exit. Failures remain in
private evidence. Physical IME and Claude queue/force-send are not covered here.


## Waiting Claude input — alpha.59

`npm run test:native-queue` rebuilds the DSH client before launching real Electron
and Claude Code 2.1.308 with an isolated profile and two loopback Anthropic
responses. The actual native submit queue waits for 42 seconds, crossing the old
15-second submission and 40-second RPC deadlines. Original task/ID/PID remain;
the next provider request contains the queued text once. GUI/TUI changes and
renderer reload preserve the pending message and newer unsent draft. The native
terminal contains both inputs and results. Four groups pass with no page errors
and zero paid model calls. Raw requests, snapshots, terminal output and recording
stay private. This does not prove physical IME, force-send or other versions.

Independent review found and corrected lost-result waits, reload retirement,
late previous-prompt completion and cross-context raw attribution. Counterexamples
also cover newer approvals, uncertain receipts, duplicate clicks, draft revisions,
owner/context changes across awaited pauses and revocation of old room sharing.
The waiting command is not retried. It cannot mark native work cancelled or
complete merely because the UI closed or a receipt became uncertain.

The installed alpha.59 repeats the four groups using its normal service bootstrap,
with two local responses and no paid inference. Strict installed signature remains
valid afterward. Normal-profile background reopening retains three original native
IDs/processes, selection, draft and eight Codex messages with zero new dispatch.
Application source matches the installed payload.

Build note: public-registry retrieval of browser notices timed out. The build
reuses the full notices from the previously reviewed alpha.58 archive only after
verifying its SHA-256 and matching all 153 locked names, versions and integrities.
All 155 notice/index files are retained; no license is omitted. This is evidence
for this local artifact, not a new network fallback in the product or repository.


## Shared waiting Claude input — alpha.60

`NAW_QUEUE_SHARED=1 node scripts/test-native-queue.cjs` uses the actual Electron
application and Claude Code 2.1.308 with two canned loopback responses, zero paid
inference. It drives the actual composer, joins the room, selects the member with
@, queues a new instruction while the original task runs, waits 42 seconds, changes
GUI/TUI views, reloads the renderer and reads the complete native request and room
records. Five groups pass in source and installed application:

- A pending human message and receipt survive both former timeouts, without retry.
- Navigation/reload keep the original task, native identity and newer room draft.
- The next native provider request contains the queued text exactly once.
- Only that prompt's attributed reply enters the shared reader; original private
  output and the solo draft stay private. Source message shows exact delivery.
- The same native terminal contains the original and queued inputs and responses.

Local counterexamples cover departure, takeover, clear, context/approval changes,
unattributed receipt and deleted discussion parents before/during an awaited
pause. The parent guard defect was independently reproduced and rechecked after
repair. Full local suite: 573 passed, zero failed/skipped. The private installed
run also records a success video. These checks verify native mechanics, not
paid-model behavior, physical input methods, Claude force-send, Codex shared
steering or complete retained 2.1.302 display compatibility.

## Shared working Codex input — alpha.61

`NAW_STEER_SHARED=1 node scripts/test-native-steer.cjs` opens real Electron and
Codex 0.163.0 through normal bootstrap, with private config and exactly two
loopback Responses streams. It creates a private task, keeps that response open,
joins the room, selects @ and sends through the existing composer. The actual
second native request contains the new instruction once in the same turn.
The old private item and unsent solo draft do not enter the room. The new shared
item streams with its native ID; renderer reload retains its identity and a newer
room draft without dispatch. Native final completion and the same terminal's
input/output are checked. Source six groups pass; screenshots and a successful
recording remain private. Canned local responses prove native mechanics, not
model quality, production routing or total task cost parity.

606 local checks pass with no skips. Independent review reproduced two failures:
late start after an unknown first delta could promote a private prefix, and an
unscoped native error could leave the new shared grant open while the old input
tag was still pending. Unknown first observations now stay unknown; native errors
close the affected session/runtime grants before later output. Tests cover both
ACK orders, completed-before-ACK, missing/wrong/history-only echo, turn mismatch,
permission/departure/rejoin/control/context/disconnect and late private items.
Router capability tests clone their fixture capability arrays, preventing one
test from accidentally enabling the next retained service. Installed alpha.61 passes
the same six native groups. Exact affected payload and strict signature pass;
normal hidden reopening retains three original native IDs/processes, selected view,
draft and eight original Codex messages, with zero new dispatch. Independent source
and installed review passed. This does not close overall U17 or add Claude force-send.

## Native tool text and history — alpha.62

`node scripts/test-native-tools.cjs` launches the actual Electron application and
Codex 0.163.0 through normal service bootstrap. Two canned loopback Responses
streams issue one native `functions.exec` call: apply a one-file patch, then read
that file through native command execution. It checks the actual Unicode file,
full tool text in the solo reader, the next native provider request, GUI/TUI
identity and renderer reload. The native one-time file permission is checked
against the exact fixture diff and selected TUI choice before Enter. The shared
reader contains only the file diff observed while authorized; its sharing-stop
marker remains, and command output/final response after permission stay private.

A separate service-protocol stop/resume step uses the real native thread history:
tool rows rehydrate with the same native thread/backend and no new room record,
dispatch or provider request. This step is not a physical test of the OS recovery
confirmation dialog. The display process may be replaced when reconnecting;
that is distinct from the preserved native thread and backend.

Source five groups pass. 612 local checks pass with zero skips. Independent
review reproduced normal-bootstrap failure when the new module was absent from
the private-runtime allowlist, and stale cached tool text winning after reconnect.
Both are fixed and rechecked. New tests cover public text/structured output,
explicit unsupported-media placeholders, discarded private metadata/reasoning,
patch updates, native failure/refusal, pagination, current-connection live data,
snapshot/delta overlap and the existing bounded volatile cache. Installed five
groups, strict signature, all 45 allowlisted source files and original three-session
hidden reopening pass independent review. A successful installed recording remains
private. No paid model inference or normal-provider settings are changed.

These checks are bounded native mechanics evidence. They do not establish actual
MCP-server behavior, binary/media rendering, hidden reasoning visibility, arbitrary
provider version compatibility, physical IME behavior or complete U17 acceptance.


## Retained Claude waiting input — alpha.65

`NAW_RETAINED_QUEUE=1 NAW_CLAUDE_302=/path/to/claude-2.1.302 node scripts/test-native-retained-claude.cjs`
extends the existing actual old-backend/native/Electron scenario with a bounded
four-response loopback task. Source passes six groups: original history and PID,
streaming display/tool text, waiting beyond 42 seconds without extra requests,
exact native request payload once, newer draft and two-window continuity, and
ended-history reopening. Private full native requests, state and video are kept
outside Git. This is actual UI/CLI mechanics with canned provider output, not
hosted-model reasoning, physical IME or all native-state parity.

Local counterexamples check queue identity rather than matching text, unknown
acceptance after closing, no replay on reopen, and changed owner, member, root,
permission or human control before authorization. After native authorization,
leaving or closing does not claim to retract input already queued in the CLI.
Final installed six groups pass with the same four-response budget. The 46-file
application payload matches source; strict signature remains valid after native
testing. Hidden reopening preserves the three original native IDs/processes,
selection/draft and existing Codex messages without another dispatch. Full-app
closure while a native queued input is pending is not a native acceptance claim;
the authorized-close/no-retry branch is covered by the local channel check.


## Retained Claude shared main reader — alpha.66

`NAW_RETAINED_SHARED=1 NAW_CLAUDE_302=/path/to/claude-2.1.302 node scripts/test-native-retained-claude.cjs`
uses the existing real old-backend/Claude/Electron fixture with at most five
loopback responses and no paid inference. Source launch now rebuilds its UI to
avoid testing stale generated client code. Seven source groups pass:

- Retained native identity/process/history survive connecting the current reader.
- An explicit room task streams only its attributed native text, tools and turn.
- GUI/TUI switching, renderer reload and a second window retain input and output.
- The final updates its original block without duplicated raw Stop content.
- Completed shared history survives full GUI reopening with unchanged dispatches.
- A real native permission hook precedes tool results and later private replies;
  those remain private, including after GUI departure/rejoin.
- Native exit and cold history reopening do not create a process or model turn.

The ordered permission trace is captured from the real adapter without changing
its behavior; the native prompt is answered through the actual terminal UI.
Source evidence independently confirms the trace, full native requests, shared
and private snapshots, stable identity, two explicit portal dispatches and five
local responses. All 658 local checks pass, with zero skips. Independent review
found obsolete manual-share labels; persisted delivery metadata and composer
help now reflect this supported connection. The final source rerun verifies them.
Installed seven groups pass independently, with five local responses and zero
paid inference. All 47 application files match source; strict signature passes
after native testing. Hidden reopening preserves the original three native IDs
and processes, selection/draft and eight Codex messages, with zero new dispatch.

Private screenshots, successful video, native output and request records remain
outside Git. These are native/UI mechanics checks with fixed responses, not
hosted reasoning quality, physical IME, universal provider compatibility, retained
shared waiting, forced input or automatic cross-service collaboration. No private
model context is erased or isolated by selective output sharing. Closing the
observer freezes unfinished shared streams; reopening does not renew a grant.


## Retained Codex shared main reader — alpha.67

`node scripts/test-native-retained-codex.cjs` boots the real alpha.2 host, native
Codex 0.163.0 and current Electron with an isolated configuration. It operates the
native folder-trust gate, types an original private task in the terminal, connects
the graphical reader, addresses a shared task with **@**, reloads while streaming,
reopens the application and requests a native command permission for one isolated
file read. The test retains full native requests, UI snapshots and successful video
outside the public repository. Source and installed versions pass four groups:

- Original private history attaches to the same native identity/process without
  starting another model request.
- The addressed room reply streams into one attributed block, remains stable
  across renderer reload, and excludes private history and unsent drafts.
- Closing/reopening the application restores room history and both drafts without
  replacing the native process or replaying the task.
- A real native command permission stops sharing, including a visible explanation
  when the preceding tool already completed. Approval executes the selected file
  read; its output and final reply remain private, including after departure/rejoin.

All 668 local checks pass without skips. Exact installed payload (47 files) and
strict post-native signature checks pass. Normal-profile hidden reopening retains
the original three native identities/processes, selected view, draft and eight
Codex messages without another dispatch. Native evidence is independently reviewed.

Budget: four fixed task responses and at most one fixed native title response,
all loopback with zero paid inference. The native TUI's automatic title request is
counted separately rather than hidden in portal dispatch totals; the test returns
its requested structured format. This does not establish production inference
cost or disable the user's native title behavior. Completed shared text is local
history; tool text remains volatile. Full native display parity, retained shared
steering and automatic cross-service handoff are not acceptance claims here.
