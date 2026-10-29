# Bounded testing

Historical validation records. For the current delivery scope, see [readiness](readiness.md).

## Exact code copying and long commands - 2026-10-27

`node scripts/test-markdown-copy.cjs` uses the existing synthetic transport and actual Electron/DSH reader. Signed114 e69cc05 passes four complete-task groups: pending acknowledgement and deduplication, truthful failure/retry, exact Unicode/tab/newline payload, narrow-window horizontal scrolling, private/shared records and reload preserving drafts/identity. Zero models/providers/native dispatch; the owned main-process writer is intercepted so all system clipboard formats remain intact. Existing native copy backend proof is reused.57 runtime files and strict post-test signature match; owned processes/profile are removed and temporary inventories stay unchanged. Ordinary visible daily114 preserves9 original sessions and12 flushed view drafts. Physical clipboard/device/screen-reader proof is not claimed.

## Creating another session with retained work - 2026-10-26

`NAW_TEST_SESSION_CREATION=1 node scripts/test-six-session-workflow.cjs`
uses the existing synthetic native-progress transport through real Electron.
Six independent records stay alive when one is archived. Creating a seventh
Codex session then reopening and restoring the archived entry preserves the
original identities, states and unsent draft, with zero model calls, sends or
terminal input. Source and signed106 `bda7ee0` paths pass; the installed launcher
records its executable and app paths. This is not seven real provider processes.

Three related regressions fail before removing the fixed cap and pass after:
backend creation, cross-service concurrent creation, and a history read that
finishes after six other records exist. Additional client history-routing
coverage keeps one import on the active service. All1123 checks pass. The first
GUI baseline opened the archive list before new-session creation and failed on
that modal; it is retained as a harness error. After moving that archive-list
step to restoration, the original cap leaves the seventh create dialog open;
the fixed runtime passes the complete task. Archive still retains native work.

The five limit checks are removed without changing the creation/history queues,
identity/storage checks or native permission defaults. Candidate106 gives the
new runtime a version boundary because service selection first reuses a matching
version; it does not hot-patch an older running service. The person's daily104
app is unchanged. Historical six-session measurements remain scoped evidence,
not an overall resource-capacity claim.

## Ordinary Claude tool approval - 2026-10-26

The existing permission case in `test-native-blocks.cjs` passes on signed105
`c7b4ada` with actual Claude2.1.310, manual permission mode and two fixed loopback
responses (zero paid inference). GUI preserves the Bash name and input JSON;
there is no separate NAW approval decision. Before the original TUI decision,
the marker file is absent and the second request has not run. After selecting
native Yes, the command runs, the turn completes with the same native ID/PID and
the GUI request clears. GUI/TUI raw text and a real recording remain private.

The owned launcher records the running executable and app paths, both inside
the signed candidate. All57 payload files match; strict signature passes after
native use; the owned profile is removed, temporary sets stay571+1056 and only
the daily app appears in application search. No runtime change, package rebuild
or daily-app action. Existing source evidence for311 is reused without claiming
a new installed311 or denial test. This does not prove real-author recovery or
a full workday.

## Ended conversation and compact reading — 2026-10-26

Signed candidate105 from clean committed `c7b4ada` passes the existing compact
reading runner through the installed Electron binary and bundled runtime, using
synthetic local transport and zero model calls. An ended conversation keeps its
received terminal frame, saved history and draft; after window reload, an ended
conversation without a held frame explicitly says no screen was retained instead
of promising that a first message will show it. Recovery copies and input remain
reachable. Source checks pass 1121 tests without skips.

The same run retains the measured compact-layout limitation: a long confirmation
at 850×600 leaves zero conversation height, while its decision stays reachable and
the input visible; at 1000×600 it leaves at least four lines. This is a tested
wider-window workaround, not a four-line pass at minimum size. No layout changed.
All 57 runtime payload files match, strict signature passes after the installed
UI test, application search contains one daily app, and the temporary-directory
sets are unchanged (571 OS-temp and 1056 /tmp directories). The owned profile is
removed. Native-only lane audit evidence stays source-only; this UI fixture does
not prove provider commands, physical input, a real workday or author recovery.
The person's daily104 installation remains unchanged.

## Single-agent native goal preflight — 2026-10-25

`NAW_NATIVE_GOAL_TRIAL=1 NAW_CODEX_VERSION=0.164.0` with native-first startup
extends the existing context runner. Actual native create_goal and native automatic
continuation complete while Electron is closed; thread/goal/get confirms active
then complete. Reopening retains the same native ID/PID, unsent draft and final GUI
reply with one human dispatch. Four fixed loopback responses plus one title, zero
paid inference. Native code-mode calls use functions.exec rather than assuming
flat tool declarations. The first failed harness assumption remains in the private
evidence; the final witness restores exact temporary sets. Fable review14 passes
this bounded scope and the private shared migration plan. No product runtime,
scheduler or framework is added. This is not real productive use, a full workday,
an in-flight application update or native-process-death recovery.

The tested alpha.98 Claude integration candidate passes 999 units without skips
and real310 direct resume/background, one fixed local reply each, but fails the
resume-background combination. The original native display reports backgrounded
while the GUI says ended. Independent review14 requires a lane fix, so that runtime
candidate is held outside main and the accepted installed alpha.97 is restored.
Its complete source diff, archive, passing/failed evidence and regression delta
are retained privately. The Codex goal preflight is an independent test-only
change; its Codex runtime path is unchanged by that rejected Claude candidate.

## Rejection, explicit continuation and thread closure — alpha.97

`NAW_NATIVE_FAILURE_TRIAL=1` on `test-native-codex-context.cjs`, with Codex164
and native-first startup, tests an actual nonretryable HTTP400 from a loopback
provider. GUI error text/failed boundary remain intact, no assistant reply is
invented and no automatic resubmission occurs. One explicit next GUI task completes
in the same native thread. Two task attempts plus one native title, zero paid
inference. The native TUI hard-wraps the error; only its display comparison ignores
whitespace, while the GUI text is checked verbatim.

`NAW_NATIVE_CLOSED_TRIAL=1` on `test-native-confirmation.cjs` separately sends a
controlled `thread/closed` notification through the real adapter/workspace and
installed GUI. Injection enters the session runtime directly, bypassing host
per-thread routing; it does not certify that routing. It displays ended, retains
native identity and the unsent draft,
and makes no task dispatch or provider call. This bounded mode does not execute
or certify the older approval-history scenario. Two attempts to extend that full
scenario encountered obsolete heading/removed-progress-panel selectors before
the closure assertion; those are retained as failed harness trials, not passes.
Actual display-only exit/continuation reuses the unchanged native identity task.
Both final witnesses exit successfully and restore identical complete temporary
sets; all 56 runtime payloads, strict signature after native use and single-launcher
check still pass. Fable review13 passes these bounded scopes. These test-only additions do not
rebuild or bump the application.

## Owned temporary resources — alpha.95

All 57 standalone temporary-profile scripts allocate through the explicit
`fixtures/test-scratch.cjs` owner and wrap their original teardown. Spawned
processes, Electron applications and positively identified profile daemons are
tracked; teardown waits for exit before removing that owner's directories.
Normal completion, rejection/throw, explicit failure and SIGINT/SIGTERM are
covered. Unconfirmed ownership, a replaced directory or a surviving process
fails cleanup rather than deleting or killing an unrelated resource. Each daemon
also removes its own socket directory at ordinary exit/startup failure. Tests
that intentionally hard-kill a daemon register that directory before the crash.

Default runs delete disposable profiles. `NAW_EVIDENCE_DIR` explicitly exports
selected raw diagnostics outside the repository before removal; failure snapshots
are retained there too; capture errors and timeouts are reported. Native-context producer fixtures use a separately owned
persistent provider home/workspace, with an ownership marker, so the import test
can reuse original native history after the producer's Chromium profile is gone.
The history consumer still requires stopped original writers and a loopback-only
model endpoint. The native runtime may append settings events and update its SQLite/WAL files
when importing; this is a reusable evolving fixture, not an immutable archive.
The consumer verifies that every existing rollout byte remains an unchanged
prefix and records before/after hashes.

Sixteen targeted no-model unit checks and all 981 units pass with no skips.
After independent review, counterexamples also reject an exited/reused parent
PID and a live child whose birth identity cannot be read. A failed process census
still runs teardown while retaining uncertain scratch. Source and installed crash
recovery and installed native import were rerun with the updated helper; each
restores both complete sets. The final 981-unit run is measured separately with
identical sets and no skips. Installed import checks all three original rollout
prefixes byte-for-byte; one gains a native settings event, none lose old bytes.

Source real UI state/crash/large-history tests, Codex 164 local-response native
fixture export and fresh UI import restore identical canonical `naw-*` directory
sets in both temporary roots. The final full-unit/package batch also restores
identical sets. Installed state, crash recovery, large history and native import
are measured separately; each restores both complete sets, not merely a count.
Explicit success and failure diagnostics survive outside those temporary roots.
Installed import makes no inference request; the source fixture producer uses
three fixed local task responses and one title response, zero paid inference.
The original installed profile reopens hidden with the same three native IDs,
PIDs, existing records and drafts/views, and zero new portal dispatches. The
55-file runtime, strict signature after native testing and one launcher match.

This does not certify that every one of the 57 scenarios was rerun. All callers
are wired and syntax/census checked; representative lifecycles above exercise
the shared owner. Runner SIGKILL/power loss, concurrent independent `naw-*`
writers and non-`naw-*` Chromium/Playwright temporary resources are outside this
bounded cleanup claim. Existing unrelated temporary directories and the intentionally reused
`test:desktop` dogfood profile are not swept.
Independent headless Claude final source/evidence review passes; full U17 is not closed by this task.

## Existing history, cold recovery and first new reply — alpha.93

The complete task starts with actual stopped Codex 164 native history, not an
injected chat row. `test-native-history-existing.cjs` opens the installed app with
a fresh owned profile and selects the exact native ID from its history picker.
It checks received text/model, original native completion times and durations,
the actual native folder-trust menu, private join/detach, no duplicate reference,
whole-app reopening and refusal of a second live writer. The rejected profile's
cleanup must leave the first backend alive and its persisted session list empty.

With explicit cold-recovery flags, the runner confirms backend exit, reopens a
recoverable record and exercises the normal recovery handler with the exact
fixture consent. The old ID/model/draft/history remain while backend identity
changes. This tests the handler and explicit choice; it does not certify OS dialog
appearance or a physical click. No model request occurs during import/recovery.
Only a subsequent explicit Send permits one fixed local response and at most
one native title. The installed accepted trial received one of each, one portal
dispatch, zero paid inference, no page errors. Every pre-send record is matched
exactly once by ID and compared for role, text, native ID, kind, native turn ID,
start/completion timestamps and duration. Both reader and the same TUI display
the new reply; the room receives none of the private history or continuation.

The installed old renderer reproduces the new readiness regression. Recovery
previously attempted its snapshot before the runtime existed and cached that
failure despite restored history. Alpha.93 waits for runtime availability and
rejects stale display generations without blocking an already-live recovering
terminal. Seven source and installed readiness groups pass; 951 unit checks pass
without skips. Source focus checks pass; Chromium IME events are tested, while
OS foreground-return and physical system/WeChat IME are not claimed. Unaffected
alpha.91 eight-response addressed-cooperation evidence is reused.

Two test-evidence errors were retained as failures and corrected before acceptance:
response/item IDs must be unique across trials, and all old records must be the
baseline rather than only the earliest two messages. A fresh native display can
briefly show shortcuts before its directory-trust menu; the owned fresh-folder
trial explicitly waits for that menu before pressing Enter. Earlier shortcut-only
returns generated no key or input IPC and were not native refusals or passes.

The runner requires `NAW_NATIVE_HISTORY_EVIDENCE` to name an owned context-runner
fixture with stopped original writers and an exact loopback-only model endpoint.
`NAW_NATIVE_EXPECT_IMPORT_TRUST=1` selects its known first-directory trust case.
`NAW_NATIVE_COLD_RECOVERY=1` enables explicit recovery;
`NAW_NATIVE_COLD_CONTINUE=1` additionally permits the one fixed continuation.
Never point it at a normal native profile. No provider credentials, configuration
migration, arbitrary external live attachment or new model recap is introduced.
Independent final installed-artifact and original-profile continuity review pass. Full U17 remains open.

## Running-version visibility — alpha.92

`test-native-version.cjs` uses actual Electron and synthetic native handshakes:
known 163/164 remain quiet, a future version names its unverified enhancements,
permission state stays visible, disconnect marks the version last-known, and
prerelease/invalid text never certifies a release. Display B, address A and an
unsent shared draft persist with zero dispatch. Current and retained call-site
counterexamples prohibit borrowing a newer backend's handshake.

`test-native-codex-context.cjs` with `NAW_NATIVE_METADATA_ONLY=1` stops after the
real native handshake reaches the graphical session: zero task/title responses.
Installed current 164 and actual original-profile retained 163 readings both
pass; replacing the binary does not replace the running server's version.
951 checks pass without skips, 55 runtime hashes match, strict signing and one
launcher pass. Original three-session reopening keeps IDs/PIDs, readers/inputs,
24 Codex items, drafts/views and zero dispatch. Independent final scoped artifact
review passes. Reuse alpha.91 full native addressed/permission tasks; no input gate
or native transport changed here. This is a compatibility explanation, not new
certification of every feature or a version manager.

## Pending actions, current native compatibility and scoped usage — alpha.91

The delivery unit is a complete existing workflow: view A and address C while B
has two requests, resolve B’s later question first, handle its older confirmation,
reload and retain draft/recipient; then use actual current native sessions for a
bounded budget check, interruption of the next handoff, private continuation and
whole-app reopening. Each step preserves actual recipient and native identity.

- `test-pending-actions.cjs`: actual Electron and workspace, synthetic native
  request transport, no providers or inference. Source and installed runs retain
  older pending requests, distinguish typed IDs, route two exact decisions and
  keep private request details out of the shared record.
- `test-collaboration.cjs`: existing complete drag/drop, inline mentions, notes,
  sharing, filtering, private drafts, archive/restore/reopen and deletion flow.
  It now also checks scoped usage, unknown-vs-counted switching, refresh and
  original privacy controls. Four synthetic dispatches, zero inference.
- Original locally generated Codex 163/164 protocols establish unchanged core
  request/event shapes and optional added fields. `NAW_CODEX_VERSION=0.164.0`
  explicitly selects only that verified version in native tools/context,
  concurrent and addressed runners. Unknown/future versions remain countercases.
- Installed current-native context includes native `/new`, `/resume`, `/fork`,
  menu cancellation, display exit, same-thread GUI continuation and read-only
  native catalog: three fixed task responses plus one native title.
- Installed `test-native-addressed.cjs` with `NAW_TEST_USAGE=1`: real Claude
  310/Codex 164 structured tools, three exact handoffs, scope-correct native usage,
  human pause before the next peer input, detached private work and full app
  reopening. Four fixed responses per provider, zero paid inference and no
  token-count request. Initial native process identities must be present/alive.
  Codex’s first TUI attachment creates its display client; original server identity
  is checked separately. All identities are compared across whole-app reopening.
- Installed retained alpha.2/Codex 163 with `NAW_RETAINED_GUI_APPROVAL=1`: four
  fixed task responses plus one native title. The current GUI answers the actual
  original native command request; sharing stays frozen and later private output
  does not republish after leave/rejoin.

948 local checks pass without skips. Source/installed complete task checks,
55-file payload hashes, strict signing after native use, a single launcher and
original three-session reopening pass. Failed trials remain local and do not
count as passing: version drift caught before inference; premature DOM sampling;
a hidden-on-hover action; async archive-restore sampling; an ambiguous cached
terminal selector; and conflating the first display-client PID with the unchanged
native server. Each relevant runner now waits for the actual visible result or
compares the correct exact identity; no production behavior was relaxed to pass.
Final independent artifact review passes for this increment. Source native permission/steer and
privacy witnesses retain their separate scopes. Complete U17, physical system
input methods, Recap/Next semantic reading and user visual acceptance remain open.

## Native Claude GUI interruption and continuation — alpha.90

- `test-native-abort.cjs`: default is a separate SDK probe and explicitly does
  not certify the GUI button. `NAW_ABORT_PRODUCT=1` uses only the actual product
  plugin and GUI controls: stream, type next draft, click Interrupt, immediately
  press Enter while confirmation is pending, preserve the editable draft, wait for
  native completion, send that draft from GUI and receive the next reply on the
  original process/session. Two fixed local responses, zero paid inference.
- `test-native-concurrent.cjs` with `NAW_CONCURRENT_INTERRUPT=1` and
  `NAW_CONCURRENT_CLAUDE_API=1`: actual Claude/Codex streams, GUI interruption,
  preserved private cut/exact stopped shared prefix, peer continuation, reload
  and new shared tasks in the same sessions. Four fixed responses plus at most
  one native title. Existing native-Escape mode continues to test its distinct
  human Stop/recovery semantics.
- Explicit negative cases require all three native proofs and the settled local
  submission channel; cover both ACK/boundary orders, changed turn/control/epoch,
  gap, duplicate clicks and a late old timer. A held abort API cannot hold the
  observation queue. Native control is never retried or replaced with a keypress.
- Native 302's real compatibility boot/reader/tool/reopen journey passes with
  three responses. The exact released alpha.89 hook can upgrade while edited
  copies remain protected. Node syntax checks alone missed the native module
  compiler's ban on reading an API noun as a value; the real zero-inference boot
  caught it before any model response, and the code now calls literal native APIs.

939 local checks pass without skips. Installed solo and mixed versions of the
above journeys pass, with two and four fixed task responses respectively, plus
one native title in the mixed trial. Video records the installed solo journey.
Independent final artifact review, 55 matching runtime files, post-native strict
signing and original three-session full app reopening pass. The API mixed trial
uses renderer reload; the old raw-log full-app-reopening label is not accepted as
proof and is corrected in the runner. Original-profile whole-app continuity has
its own actual launch evidence. Complete U17 and physical IME remain open; this
increment does not widen native fleet completion.

## Native state, controls and context continuity — alpha.89

Use the actual hidden Electron application, actual Codex 0.163.0 and Claude
302/310 processes, and fixed loopback inference. These prove transport/control
mechanics, not model judgment. No paid inference is part of these trials.

- `test-native-codex-context.cjs`: native `/new`, GUI input, `/resume`, `/fork`,
  real model/permission menus, display exit and same-thread GUI continuation;
  three task responses plus one native title. A separate native-first case uses
  one task plus one title and real isolated-folder trust, without a seed task.
- Its question mode uses three fixed responses plus one native title: native
  Plan settings, a GUI-origin question, exact native options, immediate Enter
  through the native handling action, completion and retained submission history.
  Resolution never changes a submitted answer into an accepted-model claim.
  Native items history was independently probed; it omits that answer output.
- Its retry mode uses two fixed responses: actual stream disconnection, literal
  native retry notice, working state and eventual same-thread completion.
- Retained Claude 302 uses five responses for shared progress, real permission,
  native choice, privacy after leaving/rejoining and continued original process.
  Current 310 uses three for before-text phase, native blocks and interruption.
- `test-native-state.cjs` runs the real UI with synthetic observations, zero
  providers: freshness, precise private permission body, stable heartbeat DOM,
  focus/draft and revoked room sharing. It is not native permission evidence.
- Delayed metadata/storage/source-close counterexamples cover context identity,
  fork ID reuse and interrupted partial text; a held history cannot turn
  FIRST + an unknown TAIL into a purported exact native cut.

The native feature inventory and unmapped surfaces are in [interaction](interaction.md).
Installed checks and final independent acceptance are recorded separately;
source passing alone does not certify an installed payload or full U17.

Installed artifact: 55 runtime-file hashes match; post-native strict signing
passes. Actual question/Plan/fast-input (three task responses plus one title),
mixed interruption/recovery (Claude three, Codex two, one title), and isolated
file permission/history (two responses) pass with zero paid inference. The mixed
runner retains the full private cut and asserts the exact first shared-stop text
never expands after private flush. Older failed fixtures remain local: premature
DOM reads, post-Escape private text incorrectly required in revoked shared output,
an automatically allowed file tool mistaken for a permission trial, and reading
collapsed tool text without opening its disclosure. None count as passing runs.
Final installed native-context progression (three task responses plus one title),
original three-session hidden reopening with zero dispatch, unique launcher and
independent final artifact review pass. The final question trial checks literal
answer text without internal JSON and retains its submitted status.

## Compact processes and simultaneous TUI — alpha.88

One existing-session shared task and a private control/recovery scenario remain
the delivery unit. No new editor, framework, terminal-byte parser or summary model.

- Actual Electron: two agents check a document with the shared reader and a native
  xterm surface together. Displaying A while addressing B sends only to B. Native
  typing, GUI drafts, selection sharing, hide/maximize, streaming disclosures, full
  original Copy, keyboard expansion, filtering, off-page failures, acknowledged
  error collapse and immediate full reopen are checked.
- File preview and finite collaboration authorization work with another member's
  terminal displayed. Delayed selection and ownership changes cannot insert into
  the wrong draft. Reading, shared-send, archive/membership, focus, draft ownership,
  input-event and terminal-generation regressions pass.
- Real Codex 0.163: two fixed local response tasks plus one title verify passive
  first-turn attachment, streaming, completion metadata, Escape and reopening. A
  retained alpha.2 service completes four tasks plus one title, including native
  permission, private continuation and original identity. No paid inference;
  fixed responses do not certify model judgment.
- Reviewer counterexamples reproduced and repaired: hover actions blocked a
  disclosure pointer target; old input mode ignored reader selection; an older
  collapsed choice hid a new off-page error. Ordinary failed/dead displays still
  require explicit recovery. Only the known never-started first-message case
  retries on new native turn/output proof, without a seed or agent replacement.
- Test adaptations preserve intent: terminal visibility no longer proves input
  ownership; nested delivery disclosures and two takeover controls need uniquely
  scoped targets. Physical system IME and foreground Space switching remain
  unverified in hidden tests and are not counted as passed.

The final installed candidate repeats the integrated task at 850×850 and
850×600, including shared Send visibility. The native control case clicks the
actual TUI in the shared workspace before Escape; its saved snapshot confirms
`selected=room`, a selected member, native input mode and the retained unsent
shared draft. All 54 runtime files match; strict signing after native tests and
original three-session ID/PID/draft/view continuity pass with zero dispatch.
The unchanged retained permission path reuses its complete source evidence; the
installed retained history/timing/reopen path also passes. 913 checks pass without
skips. Independent final artifact review passes for this scoped trial.
Recap/Next, complete TUI parity and user aesthetic acceptance remain open.

## Lightweight reader — alpha.87

The candidate reuses the existing reader, textarea and native connections.
Content-width human messages and quieter hover/focus actions are a lightweight
visual proposal; user acceptance and complete TUI display parity remain open.

- **User task, actual Electron:** two attributed participants check a three-number
  document, including a long tool record and interleaved streaming replies. Exact
  recipient choice, member filtering, private departure, original identity/draft
  retention and whole-app reopening pass. A separate same-turn private-input case
  removes the room phase while native work continues and freezes public content.
  Providers are synthetic here, with three explicit fixture submissions.
- **Actual Codex 0.163.0:** a completed turn retains exact native time/duration in
  solo and authorized shared records; duration matches the native TUI. Native
  Escape freezes the observed process text in both readers. Its interruption
  timing stays in the private reader; a revoked grant does not copy that later
  boundary into the room. A retained alpha.2 service restores its original private
  boundary **before** the first shared send; the new shared turn has a different
  ID, keeps its own clock, and reopens without process replacement or draft loss.
  Installed trials use normal bootstrap and record video. Inference uses fixed
  loopback streams, not paid models: source and installed each have two current
  task responses, two retained task responses and two native title responses.
- **Regression:** 911 checks pass, zero skips. Reading has 13 application checks;
  collaboration has six groups; room sending has ten groups. Installed usability,
  current/retained native and collaboration journeys pass. Unchanged provider
  reasoning/handoff evidence is reused rather than rerun.
- **Artifact:** all 54 installed runtime files match source; strict signing passes
  after native execution. Original three-session hidden reopening keeps native
  IDs/PIDs, selected view, private/shared drafts and readers, with zero new portal
  dispatch. Application search exposes one daily app.

Independent review reproduced and repaired optional metadata holding up history
and input, a retained test accepting the new boundary instead of the old one,
and historical room rows leaking same-turn private activity. Held-request,
lifecycle, exact old/new identity, private steer, pause and permission cases now
have targeted checks. No current sharing grant is restored from saved metadata.
Unchanged live-region text is left alone during streaming.

Recap/Next existing-result access, simultaneous TUI/conversation layout, physical
system/WeChat IME, Claude phase parity and full U17 remain unverified. A shared
steer's generic whole-turn phase stays private until input-scoped activity can be
proved. These limits are not passed tests or grounds for whole-product completion.
Raw logs, native transcripts, synthetic screenshots and recordings remain private.

## Native-selected cross-service handoffs — alpha.85

V2 peers reuse the existing authenticated native tools, source-side completion
proof, revocable socket grants and shared reader. All selected services and
their runtimes must support directed messaging. V1 peers remain fixed-order;
there is no silent mode fallback, text-mention parser, routing model or new UI.
An addressed message has its own exact body and receipt, even if the human final
answer differs, is empty, or exceeds the fixed-order reply limit. Only the intent
body is transferred; its 6000-character bound remains enforced. Directed proof
does not copy the human final answer between services.

Source native testing covers two same-name Claude sessions and Codex across two
services. Four root tasks follow A → third member → Codex → A rather than roster
order; work continues with the interface closed. Reopening, member filtering,
departure, archive/rename and removing ended references retain native identities,
drafts and historical authors/recipients. Seven fixed loopback responses, zero
paid inference. A separate native policy-denial journey refuses the tool through
Claude PreToolUse: two fixed responses and no Codex dispatch.

Installed native two-agent testing completes a budget task, pauses another after
native intent staging, detaches Claude for private TUI continuation, and reopens
the application with stable IDs/PIDs, history and draft. A human-only final answer
longer than 10000 characters stays visible but never enters the Codex request.
Four Claude/four Codex fixed responses, zero paid inference. The real application
recording is retained locally. No new response is requested for recording.

The compatibility journey uses the exact released alpha.84 commit, not a version
string substituted into current code. Its live native Claude is preserved by
normal installed alpha.85 bootstrap; a new Codex then completes A → B → A with
it. V1's directed option stays disabled. First Codex TUI entry, UI-closed work,
same native identities, private/shared drafts and three exact dispatches pass;
two Claude/one Codex fixed responses, no title response and zero paid inference.
The original failing control tests checked a null run before its initial state
arrived; waiting for the actual new run ID fixes the test, without a production
timing workaround or hiding those failures.

The source suite passes 895 checks without skips, including source identity,
tool failure, recipient removal, capability retirement, duplicate/expired calls,
long/empty/different final replies and V1 rejection. The installed 53-file payload
matches source and passes post-native strict signature. Original three-session hidden reopening preserves IDs/PIDs, drafts and selection
with zero new dispatch. Final independent installed-artifact review passes. This closes neither arbitrary old
backends, external live attachment, full solo fidelity nor unrestricted fleet
or unattended automation.

## Finite exchange across existing supported services — alpha.84

The existing shared reader can coordinate a finite fixed-order reply exchange
across independent local services that advertise `peerReplyHandoffsV1`. This is
an explicit 2–6-member, at-most-six-reply/ten-minute authorization. It creates no
new provider runtime or routing model and does not replace native sessions.
Existing services without that protocol, including alpha.2/83, remain manual;
this is not an external-live-session attachment implementation.

Source Electron/native testing uses actual Claude 2.1.309 and Codex 0.163.0 with
isolated private homes and fixed loopback responses: Claude drafts a 36+14 budget,
Codex checks it, and the original Claude concludes. The same Codex TUI opens
during its active turn without changing the native server. The GUI then closes;
both later steps finish without it, and reopening retains identities, private
and shared drafts, exactly one human source and three final replies/receipts.
Three root responses, no native title response and zero paid inference. The
first TUI attempt failed because the test emitted a delta before subscription;
it remains failed evidence. Waiting for the native task and Working prompt, as
in the existing first-terminal test, passes without a production workaround.

A separate actual Electron/two-daemon journey checks completion, UI-closed work,
held and lost pause acknowledgements, explicit read-only pause verification,
permission→idle in a single state batch, and departure. Seven synthetic sends,
no native process or model. Clearing history through the actual privacy menu
cannot erase pending/unconfirmed revocation or its verification action. New
runs cannot overwrite it, including through stale windows/backend requests.
The original same-service six-group collaboration regression also passes.

The full source suite passes 888 checks without skips. Counterexamples include
native human/control/approval/observer gaps before and after preparation,
source-side single-use completion proof, native-context/backend changes,
late send acknowledgements, socket loss, expiry, repeated replies, background
work, lost revocation receipts and frozen preview identities. Opening a Codex
TUI changes its display PID without changing the backend identity. Native work
already received is not claimed cancelled by revoking future handoffs.

Independent source and raw-native/UI evidence review passes. Installed native
three-step cooperation and the four Electron control journeys also pass. All 53
runtime payload files match source, and the post-native strict signature passes.
Original three-session hidden reopening retains IDs/PIDs, drafts and selected
view with zero new dispatch. Final independent installed-artifact review passes. Ordinary input, records, delivery details and
permission handling continue through the existing paths. Full solo parity,
external live entry and arbitrary old-service automatic exchange remain open.

## Native usage visibility — alpha.83

The existing privacy/usage dialog and session details display native readings.
Claude 2.1.309 uses its no-argument `session.usage()` API: context, native /cost
ledger and last-reported quota windows when available. The exact generated native
types state this read is free; no breakdown, token-count request, status-line
replacement or model prompt is made. Codex retains native cumulative/last token
events and window size. Missing values stay unknown, cached input is a subset,
and neither a dispatch count nor a native USD ledger is called an actual bill.

Source three-native Electron journey passes with seven fixed local responses.
Startup and post-task metadata are visible; opening/refreshing the dialog adds
no model response and no token-count request. Root identity, bounded single-flight
reads, unknown versions, zero vs absent values and separate count semantics have
deterministic checks. The complete suite passes 865 checks with zero skips.

Actual boot exposed template substitution interpreting a literal dollar sequence;
callback replacements now preserve inserted content and build-time JavaScript
compilation checks the output. A second boot exposed a missing module in the
private-runtime and package manifests; both were fixed before the passing run.
Installed three-member usage and concurrent two-agent journeys also pass. The
latter adds four fixed local responses, no native title response and no paid
inference; a local success recording is retained. It verifies concurrent streams,
working-turn waiting/steering, threads/member filtering, departure/rejoin and
private-tail isolation. The 51 installed runtime files match source; strict
signature and original-three-session hidden reopening pass with zero new dispatch.
Independent final installed review passes.

Review found positive native amounts below four-decimal precision displaying as
zero. They now display `<$0.0001`; exact zero remains `$0.0000`. Targeted checks
cover both actual fixed-response readings and an even smaller positive amount.
Unavailable context metadata is discarded without creating an output gap.

References: [Claude native API](https://code.claude.com/docs/en/plugins/mods/api),
[ccusage source-vs-estimated cost](https://github.com/ccusage/ccusage/blob/main/docs/guide/cost-modes.md).
No external implementation or pricing dependency was copied. These readings may
lag and do not establish complete descendant accounting, billing accuracy or
latency/token parity with an unextended agent. Older connections may not report
them; native sessions are never replaced merely to acquire usage.

## Three native participants and identity — alpha.82

Source and installed `NAW_TEST_THREE_MEMBERS=1` journeys use two Claude 2.1.309
sessions and one Codex 0.163.0, all with the same display name. Actual Electron
controls create, invite, address, filter, detach, archive/restore, rename and
remove ended references. Routes follow stable IDs rather than roster order.
Authorized handoffs continue while the interface is closed; reopening preserves
native IDs/PIDs, shared history and the unsent draft without replay. Four root
dispatches produce five Claude and two Codex fixed local responses, with zero
paid inference. This proves transport and lifecycle, not model judgement.

Existing labels now distinguish duplicates in the sidebar, menus, invitation and
member dialogs, native turn rows and copied history. Removed references retain
the original author/recipient IDs in shared history. A separate zero-native
Electron regression crosses a real state update while the invitation menu is
open, preventing refresh from erasing identity labels. Both copy checks wait for
the new clipboard event. Only the two test-owned stop/forget confirmation dialogs
are accepted by the test harness; native tool permission handling is unchanged.

The 861-check source suite passes without skips. Installed shared-workflow and
original-profile continuity acceptance are recorded in readiness.md. No new
routing behavior, model requests, external attachment or solo-parity claim.

## Agent-selected addressed cooperation — alpha.81

As of 2026-10-22. This increment prioritizes the shared workspace; embedded native
TUI is accepted for independent work and full solo chat parity is deferred.

- `app/tests/addressed-handoffs.test.cjs`: 13 deterministic checks, including
  exact stable ID with duplicate names, once-only handoff after authoritative
  completion, reciprocal limits, native refusal, pause/departure/control/connection
  invalidation, wrong roots/turns/prompts, and no routing from ordinary prose/code.
- Complete source suite: 861 passed, zero failures/skips. A held native tool-list
  read cannot block root binding or the existing input poll, and metadata requests
  stay single-flight. Final targeted handoff rerun passes after the tool-name hint.
- `scripts/test-native-addressed.cjs`: real Electron, Claude 2.1.309 and Codex
  0.163.0 through normal service bootstrap. Four source and installed journeys
  pass: Claude→Codex→Claude budget calculation; human pause after staging and
  before delivery; detach into the same private TUI; full GUI close/reopen with
  stable native IDs/PIDs, history and draft, without replay. Each run uses four
  Claude and four Codex fixed loopback responses, zero paid inference. Codex uses
  the actual advertised code-mode callable; requests assert native tool schemas.
- The same test with `NAW_TEST_NATIVE_DENY=1` verifies native PreToolUse denial
  overrides the named MCP allowance. Source and installed: two Claude local
  responses, no Codex response, one task dispatch, paused room, original denial
  preserved. No global native setting is changed.
- One real model task uses Haiku 5.5 low and Luna low, explicitly checked before
  sending. Two lunches at 18 each plus transport 14: Claude calculates, Codex
  independently confirms via a native tool-selected recipient, Claude concludes
  50. Exactly three root task submissions, two addressed messages, six underlying
  model responses (three per provider), and no observed subagent tool. Codex's
  native tool lookup accounts for one of its responses. Native config remains
  intact; this is not a token comparison with an unextended session. Full private
  native history, UI state, screenshot and successful video are retained locally.

The real task initially stopped at folder-trust setup before sending any model
request: a startup keystroke did not select the intended native choice. The test
now checks terminal input readiness/focus and the actual selected choice before
Enter. It never treats enqueue/keyboard delivery as proof of native selection.
Earlier failed protocol experiments are retained privately: reserved MCP server
name, premature capability discovery, and a wrong native-result field. The final
path uses the normal MCP permission chain and its actual flattened result text.

Installed shared UI regression also passes six groups: pointer drag/cancel,
duplicate-name @ selection, notes and exact explicit context, private departure,
room/session archive and restoration, and shared-history deletion. It uses the
real installed renderer/IPC with synthetic providers, not model inference.
The original three-session profile reopens hidden with unchanged native IDs/PIDs,
selection/draft and zero new task dispatch. Fifty installed runtime files match
source and the post-native strict signature passes.

The independent reviewer read source, complete native requests/results and the
real model task. Final independent installed-artifact and evidence review passes;
the reviewer separately checked all 50 files, strict signature and original-profile
continuity. U21 closes only for the supported new-session workflow. These checks do not prove physical IME behavior, complete
native fleet inventory, all provider versions, external live attachment or full
solo GUI/TUI parity. Old native processes are preserved without promising tool
injection; their supported manual/fixed-order path remains available.


## Native paragraph line breaks — alpha.78

The native terminal's final result contains two separate lines; the prior GUI
rendered them on the same line. A real Electron range-geometry assertion fails
before repair and passes afterward. Paragraph-only whitespace preserves original
line breaks without treating generated whitespace between Markdown elements as
blank lines. Source reading and room journeys pass 13 and 10 groups: streaming
line separation, completed shared text, Markdown/code formatting, exact Copy,
selection/focus, scroll anchoring, switching, reopening, deliveries and existing
bounded collaboration. Both use controlled transport, no native process or model.
Installed reading and room journeys also pass all 23 groups. Independent source
and artifact review, 48 matching runtime files, strict signature and the original
three-session hidden reopening pass with unchanged native IDs/processes, saved
view/drafts and no new task dispatch. This closes only the paragraph rendering fix.

Separate private capability probes run the actual Claude 2.1.309 client with
fixed loopback responses. Its pending final half-line is absent from both TUI and
GUI when native Escape cuts the turn; unshown `turn.answer` text is not inserted
into the reader. One successful response is used; an earlier probe incorrectly
expected that tail to be visible and is retained as a failed test expectation.
An explicit `turn.abort` probe permits the subsequent plugin submission, using
two fixed responses, but is not integrated into the product. Its native contract
omits the Escape interruption marker, so it is not proof of identical Stop or
force-send semantics. The product's post-Stop GUI limitation remains open.

## Native tool history — alpha.77

Set `NAW_RETAINED_TOOL_HISTORY=1` in the existing retained Claude test to run three
fixed loopback responses through actual Claude 2.1.302 and Electron. It checks
native-to-GUI attachment, explicit room sending, streamed progress/tool input and
output, full-app exit during the held final, restored private/shared tool records,
unchanged process/native identity and draft, and final continuation with no renewed
room grant. Native Ctrl+O expands the original terminal tool output for comparison.
The old implementation fails the private-history assertion after actual reopening.
Local regressions cover bounded persistence, raw legacy observation exclusion,
owner-only files, unfinished status, shared clearing and no restored grants.
Source and installed native checks pass, including the installed privacy disclosure.
The separate installed two-native journey verifies concurrent output, waiting and
steering, threads/member filtering, actual mouse departure/rejoin, native-terminal
comparison and unchanged drafts/identities with four fixed local responses.
A successful local recording is retained privately. All 808 checks pass, with no
skips; 48 runtime files match and the post-native strict signature passes.
Original three-session hidden reopening adds no dispatch. Final independent source and installed-artifact review passes for B35; U17 remains open.


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
At alpha.64, tool bodies were volatile and were not guaranteed to return after
reopening. Alpha.77 supersedes this with bounded structured-tool persistence. Physical IME, native menus and
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
fixtures; these earlier tool records were volatile. Alpha.77 now persists the
bounded structured records, still not a durable full trace.

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
history; tool text was volatile at this version (superseded by alpha.77). Full native display parity, retained shared
steering and automatic cross-service handoff are not acceptance claims here.


## Retained Codex working input — alpha.68

`NAW_STEER_RETAINED=1 node scripts/test-native-steer.cjs` uses an actual alpha.2
backend and native Codex 0.163.0. Add `NAW_STEER_SHARED=1` for the room path.
The runner uses the real Electron controls, native acceptance and downstream
provider requests, verifies the same native ID/process, and checks that terminal
and conversation contain the same instruction and final answer. Solo reload must
not restore an already submitted draft. Shared reload must retain a newer draft
and the same live message identity while excluding earlier private items.

Each run permits two loopback task responses and at most one separate native title
response, with zero paid inference. Fixed inference validates native transport/UI
mechanics, not hosted model reasoning or physical input-method behavior. A fresh
retained thread may initially report no model until native history exists; each
actual fixture request must use the isolated configured model.

Local full-router/WebSocket regressions cover the self-pending lock, both
ACK/user-item orders, completed-plus-idle before ACK, subsequent permission/private
input/history removal, stale owner/native ID/PID/turn/membership and manual intent.
Saved draft cleanup distinguishes a pre-send queued write from a newer same-text
edit. Final source and installed independent review pass: four solo and six shared
actual native/Electron groups, 685 local checks without skips. The installed app
matches all 47 payload files and passes strict signature verification after native
testing. Hidden reopening preserves the three original native IDs/processes,
eight Codex messages, current model, selection and drafts without dispatch. Native
late-ACK/idle permutations use the full-router/WebSocket counterexamples; the real
CLI trial does not claim to force those exact scheduler orders.


## Retained Claude shared waiting — alpha.69

`NAW_RETAINED_SHARED_QUEUE=1 NAW_CLAUDE_302=<native-executable> node scripts/test-native-retained-claude.cjs`
exercises the actual alpha.2 host, Claude 2.1.302 and Electron UI. The isolated
native configuration uses Haiku with four fixed loopback responses, zero paid
inference. It starts private work, holds the final stream, joins the room and
queues one instruction. Waiting persists beyond the old deadlines, through view
switches and renderer reload without interrupt/retry. Only the fourth native
request contains the queued instruction, exactly once. The corresponding native
reply appears once in the room; old private turns and drafts remain private.
A newer room draft and private draft survive, along with native identity/PID,
second-window observation, native exit and ended-history reopen. Seven source
and installed groups pass. Successful private video is kept
locally. The first runner had an ambiguous text locator matching the body and
collapsed delivery details; the corrected check locates only the message body.

Full router/retained adapter/submission checks cover both receipt/input orders,
waiting display, prior-private final completion, and permission, native identity,
member/control, manual intent, history clear and disconnect boundaries. These
checks do not establish forced-send semantics or hosted model reasoning.


The dual-native runner `scripts/test-native-concurrent.cjs` also accepts
`NAW_CONCURRENT_RETAINED=1 NAW_CLAUDE_302=<native-executable>` to use the actual
old host and both retained providers. It checks two simultaneous streams, Claude
waiting input, Codex same-turn steering, thread/member filtering, renderer reload,
mouse departure/rejoin and exact downstream payloads. The already-public Claude
reply must continue while its next input waits and finish at its native boundary;
a different member leaving must not stop it. Departure tails remain private.
Both retained and current source paths pass five groups, with two fixed task
responses per provider. Retained Codex additionally requests one native title;
all responses are local and paid inference is zero. No hosted reasoning, physical
IME or unrestricted agent-to-agent work is implied. Final installed dual-native verification also passes all five groups. The 47
runtime payload files match source; strict signature verification passes after
native tests. Hidden normal-profile reopening retains three native identities
and processes, eight Codex messages, selection and drafts with zero dispatch.

The first empty retained Codex task exposed `list_turns is not supported yet`
on native 0.163.0 resume. Compatibility is limited to that exact native error,
version, original connection and exact accepted input/turn identity; an ACK or
arbitrary output alone does not authorize display. Seven counterexamples cover
wrong input/turn, permissions, disconnect and unrelated errors. Five membership
regressions exercise RoomState through the actual retained router/native transport.
Three shared-queue regressions preserve previous public work without adopting
foreign private work and reject an older delayed send after a newer same-recipient
queue is accepted. Separate intent and display revisions prevent stale-input
replay while retaining the authorized live stream. The full suite passes 709
checks without skips.

Final independent review accepts this bounded alpha.69 increment. Whole-app exit
while queued was outside that verification; its subsequent failure and repair
are recorded below. Full U17 stays open.

## Retained Claude queued work across whole-app exit — alpha.70

Add `NAW_RETAINED_QUEUE_QUIT=1` to the retained shared-queue native runner above.
The actual Electron app queues one instruction, saves a newer draft and quits.
The original 302 process completes both its active task and queued instruction
before the GUI reopens. Source testing passes four groups with four fixed local
responses and no paid inference. Native identity/process stay unchanged, the
original final tail and queued response reappear, input is displayed exactly once
and the draft survives. The room initially keeps its uncertain receipt, then confirms native acceptance
only when a fresh recovered input exactly matches its tag, stored message UUID,
session, native identity and text. This does not revive sharing; recovered output
remains private. This test does
not replace the previously verified 42-second live-queue wait.

The initial installed alpha.69 reproduction showed old observer credentials
receiving 403 until `prompt.submit` returned, after the native task had finished.
Observation recovery now runs independently using the existing bounded queue and
one retry timer. Commands and old receipts keep their original credentials. Local
counterexamples exercise held submission, offline ordered batches, unchanged
credential refusal, invalid-row gaps, root retirement and delayed metadata.
Metadata waits time out without issuing another bind for the same credential;
outstanding HTTP operations remain bounded. Installed verification also passes
all four groups, with the original terminal's completed text captured after it
connects. A follow-up installed run starts from the alpha.69 hook and checks its
exact upgrade before exercising the same flow; user-edited hooks remain untouched
in local counterexamples. All 727 local checks pass without skips. Final installed
payload comparison covers 47 runtime files and post-native strict signature
verification passes. Private screenshots and successful videos stay local.

Original-profile verification initially failed its stronger input/reader check:
both existing Claude processes had never activated the compatibility connection.
The earlier identity-only reopen result did not establish GUI input readiness.
Through the installed UI, each existing session was connected and its exact native
`/reload-plugins` command inspected before Enter. Both readers and editable
composers became available without restarting the original processes, changing
models, sending a task or losing saved drafts. This is first-time activation,
not automatic installation into an unrelated running session.

Receipt recovery also exposed a real integration mistake: native append storage
UUIDs differ from classic prompt IDs, and input blocks do not carry the latter.
The final regression imports the actual hook and passes its event through the
retained reader and saved receipt, without inventing a prompt-ID field. Incorrect
identities, changed text, incomplete input, cleared shared text and retired
readers cannot confirm delivery. Saving failure preserves uncertainty, displays
the storage warning and rejects another dispatch.

After first activation, the stronger normal-profile whole-app reopening check
also passes: both original Claude readers/input reconnect, all three native
identities/processes and saved drafts/selection remain unchanged, and zero new
portal tasks are dispatched. Receipt recovery reuses the existing private-reply
hint and session link; it does not leave a confirmed message with an unexplained
missing shared answer.

Final installed regression also repeats the five-group dual-native room journey:
two independently streaming agents, original-turn Codex steering while Claude
queues, reply threads/member filtering, real mouse departure/rejoin, native
identity and private draft preservation. Two Claude task responses, two Codex task
responses and one native title response are fixed on loopback; paid inference is
zero. The successful raw app recording and a slower playback copy remain local.
This verifies native client/UI mechanics, not hosted-model reasoning quality.


## Native interruption and recovery — alpha.71

`scripts/test-native-concurrent.cjs` with `NAW_CONCURRENT_INTERRUPT=1` exercises
two real native providers in the actual Electron UI, using only fixed loopback
SSE responses. Current Claude 2.1.308 uses keyboard Escape; current Codex 0.163.0
uses the existing graphical interrupt. With `NAW_CONCURRENT_RETAINED=1` and the
inspected Claude 2.1.302 binary, both interruptions use the actual native terminal
keyboard. They are distinct acceptance cases; a GUI-created empty Codex thread
has no rollout to resume before its first input, so the test never creates a
hidden seed task merely to attach a terminal.

Five source groups pass for both connections: concurrent attributed streaming,
Claude interruption while Codex continues, Codex interruption, explicit Claude
native recovery with draft/private-output preservation, then graphical sending
to the original two sessions. Native partial text/status, identity, drafts,
acceptance receipts and four Portal dispatches are checked. Five native task
responses plus at most one native title response are local fixed data, zero paid
inference; this is not hosted model reasoning or a physical keyboard test.

Claude's native log explicitly refuses plugin submit after Stop until human
native input. The composer explains this limitation and preserves drafts; it
does not synthesize input or resend. `NAW_CONCURRENT_REOPEN=1` additionally checks
that the pause survives whole-application exit rather than only renderer reload.
Independent review of the first installed run exposed B28: the private Codex
partial reply and interrupted boundary vanished after full GUI exit, even though
the room retained them. The old room-only assertion did not establish private
history preservation. The test now checks exact private row IDs, text and status,
opens the actual solo reader after full reopening, and checks again after another
GUI task. Source and installed six-group runs pass after the cache repair; native
history reconciliation keeps the interrupted reply before later turns. All 751
local checks pass without skips, including unreadable/unsafe caches, write failure,
ended-record removal, native history ordering and no routing from imported rows.
A second independent counterexample caught a pending connection recreating a
forgotten cache. Delayed loaded/history responses with and without an old cache
now reject without republishing cache/index/reader/target; queued restoration
also respects removal. The independent four-case counterexample passes.
All 48 installed runtime files match and post-native strict signature passes.
Normal hidden reopening also retains the original three native processes, current
model, drafts, input connections and selection with zero dispatch. Successful
private recordings include the complete pre-exit and post-reopen UI journeys.
Final independent source and installed-artifact review passes for this scope. Full U17 remains open.


## First Codex task and terminal attachment — alpha.72

The actual empty-session GUI path reproduced an ineffective terminal retry.
Native 0.163.0 rejects `thread/read` with `includeTurns: true`; its verified path
uses metadata plus `thread/turns/list`. An exact same-thread unmaterialized
rejection becomes the existing first-message instruction. Metadata alone, wrong
IDs, malformed turn entries, unrelated errors and changed connections cannot
prove that a terminal can attach. Independent review supplied three malformed
turn counterexamples; those now fail before any terminal starts.

`NAW_CONCURRENT_EMPTY_TERMINAL=1 node scripts/test-native-concurrent.cjs` exercises
the actual Electron UI, native Codex and isolated loopback response transport.
It creates through the dialog, selects terminal before any task, verifies a
persistent actionable instruction and zero dispatch, returns to chat and sends
one requested task, then opens the same terminal while the task is still working.
New response text arrives in that terminal; after completion the main reader
retains both pre-attachment and later text. Thread/server identity and one dispatch
are checked. The source journey passes three groups with one local task response,
no native title response and zero paid inference; a success video stays local.

An earlier active-turn check failed because native TUI attachment did not replay
a partial delta sent before attachment. The terminal had successfully attached,
showed the original input and Working, while the private reader retained that
delta. This remains a native display limitation, not a claim of complete transient
parity. The later test verifies newly arriving text and final full content. A
separate runner selector typo was corrected without changing product behavior.
All failure evidence remains private. The installed three-group journey also
passes, with one fixed local response and no paid inference. All 48 runtime files
match source, post-native strict signing verification passes, and hidden reopening
preserves all three original sessions, drafts, selected view and current model,
with zero new task dispatch. B29 passes final independent source/artifact review.

## Claude native compatibility — alpha.72

During the first-use work the local Claude binary updated to 2.1.309. An isolated
zero-task boot showed the native queue gate disabled. The full generated plugin
types were compared with 2.1.308: changes add an optional prompt-fill cursor and
clarify existing model naming, without changing the submission/display/turn
interfaces used by the application. The [official Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)
identifies installed-version generated types as the relevant contract. Those
provider-generated files remain outside the repository.

The gate now includes exactly 2.1.309; a regression keeps an unverified future
version disabled. The immediately previous app-owned hook has an exact-hash
upgrade fixture; customized copies still reject replacement. Native test shims
resolve the selected binary once and disable their own auto-updater, without
changing the user's agent settings.

`NAW_QUEUE_SHARED=1 node scripts/test-native-queue.cjs` runs the actual Electron
app and native 2.1.309 with two fixed loopback responses, zero paid inference. It
sends a private task, holds it for 42 seconds, joins the room and queues an
explicitly addressed next task. Switching GUI/TUI views and reloading preserves
the waiting receipt and newer draft. The next prompt appears in the actual native
request exactly once; only its attributed reply appears in the shared reader.
The earlier private output and solo draft remain private. Full native terminal
output, request bodies, state snapshots, screenshot and success recording stay
local. An interrupted installed attempt is retained as a failed test: a concurrent
normal-profile quit/reopen check closed the test window through the shared bundle
identifier. Lifecycle checks are now serialized; that attempt is not a pass.
All five source and installed groups and 772 local tests pass with no skips.
All 48 installed runtime files match source; strict signature passes after native
testing. The subsequent normal-profile check preserves three original native
identities/processes, readers, drafts and selected view while staying hidden,
with no new task dispatch. Final independent source/artifact review passes for
B30. These are transport
and interface checks, not tests of hosted model reasoning or complete U17 parity.


## Native model selection without inference

Use `NAW_MODEL_ONLY=1 node scripts/test-native-queue.cjs` after building the UI,
or the same flag with `scripts/test-native-retained-claude.cjs` and its pinned
302 executable. These actual Electron/native journeys reject every inference
request. Native `/model` selection must update the existing title, preserve the
same native identity/process and unsent draft, and survive GUI/whole-app reopen.
Retained reopen ends on a model different from the original startup selection.
Neither the user profile nor its native model configuration is changed.


Final alpha.73 source and installed native 309/302 journeys pass three consecutive
Sonnet/Haiku/Sonnet selections, with the native edit line inspected before each
Enter. The native terminal confirmation, existing GUI title and session metadata
agree; reload or whole-app reopening retains the final selection, identity and
draft. No inference request is accepted. An earlier actual installed 302 run
failed because querying inside PostModelSwitch could still read the previous
selection. The fix uses the event's resolved value and rejects stale concurrent
reads. That failed evidence is retained separately, along with the reviewer's
held-query counterexample that initially blocked observer setup.

All 781 local checks pass without skips. Independent source and final installed
review passes; 48 runtime files match, strict signature remains valid after native
testing, and hidden reopening preserves three original sessions and drafts with
zero new dispatch. This closes B31 only; full display/input parity remains open.


## Codex public process summaries

The [native app-server protocol](https://learn.chatgpt.com/docs/app-server) separates
readable `reasoning.summary` / `summaryTextDelta` from raw `content` / `textDelta`.
The locally generated 0.163.0 types were checked. This increment maps only the
public summaries into the existing main reader; it adds no model request, terminal
parser, polling loop or separate display surface. The previously inspected Orca
transcript decoder also handles summaries separately; no third-party code is copied.

`scripts/test-native-summaries.cjs` uses the actual Codex and Electron application,
a private native configuration and two bounded task responses plus at most one
separately counted native title response, all loopback. It checks
streaming public summary sections, native/GUI comparison, shared attribution,
reload with an unsent draft, authoritative completion and native Escape.
`NAW_EXPECT_MISSING_SUMMARY=1` against the previous installed build reproduces
the missing reader row while the native terminal displays the summary. The first
runner attempt incorrectly waited for a heading that the TUI does not render in
its working status; its failure is retained, not counted as a product pass.

Source native tests pass normal completion, actual Escape and whole-app reopening
with the same native identity/process, records and unsent draft. Two independent
counterexamples exposed late frames changing an interrupted summary, and an old
resume acknowledgement overriding newly observed progress. Both now pass regression
checks and source review; 787 local tests pass without skips. An intermediate
runner also incorrectly counted a native title request as the second task; fixed
accounting separates it and bounds each request kind. Failed trials remain local.

The actual screenshot exposed excess paragraph spacing. The DSH Markdown component
did not forward the assumed class name, so the previous whitespace selector never
matched. The existing assistant message container now owns the rule; actual UI
reading checks preserve selection, scrolling and code whitespace. Final installed
native/reading verification and independent source/artifact review pass. All 48
runtime files match source, strict signature passes after native testing, and the
original three sessions reopen hidden with IDs/processes, drafts and selected view
unchanged and no task dispatch. Native cold-service hydration is covered by local
protocol tests only; whole-app reopen retains the running native service. Raw reasoning, hosted inference quality and complete
native transient/menu parity are not claimed.


## Codex proposed plan display

The official [app-server protocol](https://learn.chatgpt.com/docs/app-server)
provides `plan` items and `item/plan/delta`; the final completed item is authoritative.
Locally generated native 0.163.0 types confirm that contract. This uses the same
public native text lifecycle as readable summaries, not terminal parsing or a new
plan widget. Native `turn/plan/updated` checklists are a separate capability.

The actual pre-fix Electron/native trial entered `/plan`, submitted a small task,
and observed plan text in the native terminal while the reader had an empty tool
row. Two local fixed task responses and one native title response were used, with
zero paid inference. Initial test-helper variable errors and trailing-newline
expectation failures are preserved separately, not counted as product passes.
A later runner initially selected the wrong room sender role; another attempted
Escape before the current task was fully redrawn. The final runner uses the exact
shared source ID and waits for current native task text and input focus.
The expanded trial then exposed an undismissed native implementation menu: the
first Escape correctly closed that menu rather than interrupting the newer turn.
The final journey explicitly waits for and dismisses each native implementation
menu before starting another task, preserving native key semantics.
The native plan keeps its trailing newline in this tested version; production
does not trim it. A protocol regression separately checks different completed text.

`scripts/test-native-plans.cjs` boots actual Codex and Electron with a private
configuration and at most four fixed loopback task responses plus one separately
counted native title response. It covers native Plan command/task entry, live
solo text, reload/draft, completion, explicit shared plan and its receipt, private
plan isolation, actual native Escape and whole-app reopen. It does not accept
native implementation suggestions. Completion cannot authorize an automatic
handoff. The observed native command line/menu must settle before Enter.

Independent source review reproduced cached plan IDs missing the resume/reconnect
watermark and a completed shared plan incorrectly setting the human record to
`reply-private`. Common ID extraction and an exact valid-grant completed-plan
proof address these; revoked, private and incomplete plans retain existing guards.
Source and installed native four-task journeys pass, including completed shared
plan receipts, exact native interruption and retained-service reopening. Each
uses four fixed loopback task responses and one native title response, zero paid
inference. Independent source/artifact review passes; 796 local checks have no
skips, all 48 runtime files match source, strict post-native signature passes,
and the original three sessions reopen hidden without new dispatch. Cold native service restoration
is covered by protocol tests only, not the retained-service GUI reopening trial.


## Interrupted ordinary Codex replies

A controlled production-reducer reproduction shows three failures after an
observed native interrupted boundary: a late delta appends text, a completed item
replaces it and restores complete status, and cold history replaces the cut.
The common current/retained reducer now preserves that observed cut, without
freezing other turns, already completed messages or background tool results.
Independent source checks cover those boundaries.

`scripts/test-native-cut.cjs` uses actual Electron and native Codex with two fixed
loopback task responses and at most one native title response. It checks shared
streaming, real terminal Escape, a subsequent private task, exact private/shared
rows and drafts after whole-app reopening. Late portal event ordering is covered
by controlled protocol tests, not claimed as a behavior induced in the native CLI.
The first runner attached after a partial delta, which native attachment does not
replay, and its failure cleanup referenced a removed helper. The owned service
was stopped; the corrected runner attaches before releasing the stream and uses
its own cleanup. That failed run remains a failure, not a native pass.
A second runner waited for an Escape hint that native final-answer streaming
does not keep on screen. Its actual terminal contained the partial response; the
runner now checks that content and the working state before pressing Escape.
Current and retained source journeys pass: each has two task responses and one
separately counted native title response, all loopback, zero paid inference.
The retained journey reproduced a real next-send failure: its reader showed idle
while routing still used old-host working state. The common state accessor now
uses the authenticated retained native state and rejects closed transports.
Working/approval/closed counterexamples pass; owner, PID, identity and pending
guards remain. A separate failed comparison mistakenly distinguished undefined
fields from their JSON-persisted absence; the runner now compares serialized
records without altering product data. All 806 local checks pass without skips;
independent source and raw source-native evidence review passes. Both installed
current/retained journeys pass the same three groups, each with two fixed task
responses and one native title response, zero paid inference. Exact 48-file
payload, strict signature after native testing, and original three-session hidden
reopening with unchanged IDs/PIDs/selection/drafts and no new dispatch pass.
Independent final artifact review passes. Successful installed video is kept
privately and has been visually inspected; U17 remains open.


## Native API error continuity — alpha.79 (2026-10-22)

A real Claude 2.1.309/Electron reproduction showed an API error in the terminal
while the unified reader contained only a generic failed-turn record. The native
stand-in arrives through `session.append`, not ordinary `MessageDisplay`.
The repair retains only downstream processed text after an inspected synthetic
API-error shape, exact prompt `StopFailure`, and same-turn error completion agree.
Uncertain/ordinary/child/old-prompt/reinitialized/removed content stays excluded.
The existing system turn row updates; an error cannot be a final assistant reply.
Existing explicit sharing grants apply and are never reopened for late details.

Source current and retained 302 native checks pass one GUI task each, preserving
the original native ID/PID. Native 309 made six local error requests and 302 made
two; these were native behavior, not portal retries, and all were fixed loopback
responses with zero paid inference. The final source suite passed 826 checks, zero skips. Installed current and
retained error journeys pass, with identical native IDs/PIDs and corrected hints. Actual image review
also exposed misleading `/reload-plugins` guidance after an API failure; existing
error guidance now takes precedence, with real Electron coverage.

Reproduction commands use private scratch profiles and the actual CLI:

```sh
node scripts/test-native-error.cjs
NAW_CLAUDE_302=/path/to/retained/claude NAW_RETAINED_ERROR=1 node scripts/test-native-retained-claude.cjs
```

`NAW_APP_EXECUTABLE` selects the installed executable. For retained installed
coverage, `NAW_TEST_APP_ROOT` selects that artifact's application resources.
No provider methods are replaced in these error journeys. Only the local model
endpoint returns fixed responses. UI tests operate hidden real Electron windows;
these are not physical system-input-method or hosted-model reasoning tests.
Neither this fix nor those tests closes U17 or Claude's post-Stop plugin-input gap.


The normal-profile reopen initially failed: the exact alpha.78 compatibility hook
was absent from the upgrade allowlist, leaving its input/readers disconnected.
The fix accepts only that published hash and retains refusal of edited files.
A permanent released fixture plus a last-committed-hook upgrade regression covers
this path; a retained native trial boots that alpha.78 hook and upgrades it in the
same process. Final installed native checks pass. The final 48-file runtime
matches source, strict signing verification passes after native use, and all three
original sessions reconnect with their IDs/PIDs, drafts and selection retained.
Normal reopening dispatches no task and stays hidden. Independent final source and artifact review passes for B37; U17 and post-Stop
input remain open. A proposed synthetic legacy UI
fixture was rejected because production recomputed its flags; its failed run is
not counted as proof. The retained native path and an explicit pure decision
regression cover the corrected guidance instead.


## Explicit new input after native failure — alpha.80 (2026-10-22)

This repairs a confirmed request failure, not a human Stop or an uncertain
connection. Fresh native root/prompt/turn evidence permits one explicit new
human send. Replayed or persisted error rows cannot authorize it. The error
record remains visible; automatic runs and queued handoffs remain blocked.

Independent counterexamples exposed two event-order bugs: late A failure could
clear B before its settings hook arrived; the new B shared grant could close
while the original host still reported A's error. Regressions cover current and
retained paths through native authorization, ordered start, receipt and state
refresh, while permission, gap and departure keep revoking shared visibility.
Old grants never reopen.

Source real Electron/current Claude 309 solo recovery passes with two GUI sends,
six fixed local error responses and one fixed success. Retained Claude 302
upgrades the exact alpha.79 hook and recovers through an explicit shared send:
two fixed errors, one fixed success, same native ID/PID, preserved private error,
shared new reply and the original terminal result. Both use zero paid inference.
Failed intermediate shared trials are retained privately, not counted as passes.

```sh
npm run build:ui
NAW_ERROR_RECOVERY=1 node scripts/test-native-error.cjs
NAW_CLAUDE_302=/path/to/retained/claude NAW_RETAINED_ERROR=1 NAW_ERROR_RECOVERY=1 node scripts/test-native-retained-claude.cjs
```

Installed current/retained journeys pass with seven and three fixed local
responses respectively, zero paid inference, unchanged native identities and
one new explicit task after each original failure. Shared recovery preserves
its submitted receipt and one final reply without exposing the private error.
All 847 checks pass without skips. The new ordinary-send regression initially
inherited a 15 ms queue-timeout probe; under concurrent load it timed out before
ACK inspection. It now uses a bounded 5-second fixture window; production
timeouts are unchanged. Independent review's complete-before-ACK counterexample
is retained as a four-case real adapter/channel regression.

The final 48-file source/installed payload matches and strict signature checking
passes after native testing. All three original sessions reopen hidden with the
same IDs/PIDs, input/readers, selected view and drafts, with zero new dispatch.
Independent final source/artifact review passes for this bounded B38 repair.
Actual hidden Electron mouse/keyboard actions exercise native CLIs and production
adapters; loopback responses replace model inference only. This is not physical
IME coverage, hosted reasoning, arbitrary provider-version compatibility, or
closure of U17 and the post-Stop GUI restriction.

## Codex readability and inline mentions — alpha.86

Scope: compact human/agent reading, inline exact-recipient room input, and native
Codex activity in the existing conversation surface. No new inference/routing
model, provider SDK replacement or Claude native phase work.

- `test-codex-usability.cjs`: actual hidden Electron/DSH, bounded synthetic history;
  light/dark body contrast, role distinction, compact geometry, Markdown/code
  Copy, inline keyboard choice, real textarea undo/redo, body editing, reopened
  bindings, same-name IDs, obsolete names and departure. Application composition
  events test Enter guarding; this is not physical system/WeChat IME acceptance.
- `test-reading.cjs`: 13 reading/selection/focus/scroll/reopen checks pass; native
  single newlines and code formatting remain readable and Copy stays exact.
- `test-collaboration.cjs` and `test-room-send.cjs`: existing shared workflows
  use the inline input, including late receipt failure, exact payloads, threads,
  archive/restore, six-thousand-character body previews and recipient changes.
- `test-native-concurrent.cjs`, `NAW_CONCURRENT_EMPTY_TERMINAL=1`: actual Codex
  0.163.0, one fixed loopback response, no title response or paid inference.
  An inline-addressed room task reaches the same native session. Native item
  phase and native startedAt/turn identity appear in its conversation reader;
  first TUI attachment keeps the same task and the shared reader retains the
  complete reply. Completion clears live activity. The actual request contains
  the task and excludes both the private draft and the addressing token.
- Unit coverage includes concurrent native items, old-turn events, absent time,
  waiting flags, native usage identity, stale resume ACK, exact mention edits
  and private view persistence. Other native provider scenarios are not repeated
  merely for layout. Existing scenario helpers are migrated to inline addressing.

902 checks pass with no skips. The installed usability journey, ten sending
groups and six collaboration groups pass; the latter two use synthetic native
transports without provider inference. All 54 runtime payload files match source,
strict signature verification passes after native use and normal-profile reopen,
and application search has one installed entry. The original three sessions keep
native IDs/PIDs, selection and drafts through hidden reopening with no new
dispatch. Final independent source/artifact review passes for U26; U17, physical
system/WeChat IME acceptance and Claude native phase parity remain open.


### Single-session unattended recovery qualification

The explicit **continue native session** action now has one consent step: the action
itself. It preserves the existing backend capability, ownership, process-liveness and
exact-native-ID checks. It does not replay a task, reauthorize room cooperation, revive
an intentionally ended conversation automatically, or bypass native questions.
Deleting a local record still requires its separate cancellable confirmation.

Extend the bounded installed Codex164 goal fixture with `NAW_NATIVE_RECOVERY_TRIAL=1`
(and `NAW_NATIVE_GOAL_TRIAL=1`, `NAW_NATIVE_INITIAL_TERMINAL=1`,
`NAW_CODEX_VERSION=0.164.0`). It closes/reopens the actual installed GUI, terminates only
its isolated native server, clicks the unique recovery action inside the composer,
and verifies the same saved thread/model/history/goal/draft on a different server PID.
The runner fails rather than silently waiting if recovery calls the old confirmation
modal. Four fixed task responses and at most one optional native title; zero paid inference.
Window continuity compares the native server identity and checks that the original
reported process is still alive: the displayed PID can switch from server to the
already-running terminal without a process restart. The saved goal
is already complete at the process-loss checkpoint: this proves persisted goal state,
not automatic recovery of an in-flight tool or fleet. Window-closed automatic goal
continuation is verified separately earlier in the same task.

The installer qualification also uses the real Claude310 CLI with two fixed local
responses: window close/reopen, owned native-process loss, then cold registration via
the existing workspace serializer and native `--resume` of that original ID into an
assigned checkout. Its second native request must retain the first native response;
a copied GUI transcript cannot satisfy that assertion. This is a private one-time
operator qualification, not a public arbitrary/live Claude attachment feature. The GUI
reader explicitly marks pre-import history as unavailable there; original history stays
readable in the same-screen TUI and remains in the model context.
These are controlled trials, not a full development workday. Actual developer handoff
and prolonged use remain a separate acceptance record.


### Signed native terminal read/select/copy acceptance

Source4dfbbc9 ships as daily116. All24 geometry cases, the restored-frame/wide-cell regressions, six affected wheel groups and synthetic selection/copy/failure/retry flows pass against the signed bundle. The bounded actual-native supplement passes six geometry changes and original-line Option-drag plus the existing toolbar Copy for both Codex0.164 and Claude2.1.312, preserving native ID, live PID, owner and draft. Two fixed local task replies and one native Codex title, zero paid inference. The Electron copy writer is intercepted, leaving all OS clipboard formats untouched; physical pointer/trackpad, native-menu Cmd+C, iTerm parity and oversized read-only bottom-row reach are not certified. Existing copy-backend evidence is reused.

The initial actual115 Codex restored-grid failure remains recorded and115 was not deployed. A116 test-launch hook initially raced the client bootstrap and failed before any native/model start; its owned GUI was cleaned up and the hook corrected before the successful bounded trials. A short successful owned Codex UI video is retained privately and fully decodes; it captures neither the daily desktop nor audio.

The first authorized daily update guard stopped before replacing114 because it incorrectly treated pre-reboot historical PID metadata as live. It visibly reopened114. The corrected private operator snapshots and protects only identities actually alive at the checkpoint, while retaining every saved record. The subsequent ordinary visible114-to-116 update preserves9 records, all verified live native process/start identities and owners,9 saved drafts and12 flushed view drafts.57 packaged runtime files and post-native/post-install strict signature match the committed source. All six final trial profiles and captured GUI processes were gone at the23:16 GUI-slot release. A failed-startup GUI had outlived the original runner cleanup and recreated548bytes of Chromium profile files; those files were attributed, preserved and removed at23:18, after slot release. The corrected private launch hook closes the owned app before propagating setup failure. A separate profile created at23:17 belongs to the concurrently authorized Codex3 collaboration-overview trial; its claimed lane source creates that prefix and the canonical GUI lock identifies that owner. It is not this trial's leak and is not deleted by main. The global temporary state is not claimed unchanged. No daily debug port/background launch, provider/backend migration or goal change. Source-build guards are intentionally tied to pinned xterm6.0.0; an upstream change fails closed rather than silently applying the patch.

Independent main actual-source/signed-native/deployment checkpoint and documentation delta PASS. HEAD/index/status/diff and all reviewed file hashes remain unchanged through both reviews. The original failures and corrected cleanup chronology remain recorded. The full-day dogfood goal, physical inputs and unrelated tasks remain open.


### Existing-member reading and common content menus — signed117

A person reads three existing agents without changing input ownership, follows original process/results independently, opens a literal source excerpt, focuses and returns, searches the exact source, deliberately takes control or opens the same TUI, and detaches/rejoins without losing draft/recipient/native identity. All11 installed fixture groups pass. User actions such as takeover, approval and one directed send are intentional; zero passive deltas are not zero cumulative calls. Source review's broken explicit native-recovery route was reproduced and repaired using its existing operation callback.

Common menus copy exact private/shared text and links, edit existing text fields with native Undo, retain text on failure/oversize/stale clipboard completion, and remain inside modal dialogs under mouse/keyboard use. Six installed groups pass. Native mouse-mode ordinary right-click remains with the native program; Option-right-click and ContextMenu/ShiftF10 select the app menu. The related two-provider selection/toolbar regression and2480-message reader with15 continuity observations also pass. Zero product models/real providers; clipboard readers/writer and external navigation are intercepted in the owned application, leaving all OS clipboard formats/content untouched. Numeric spin-field and native OSC8 link menus, physical input, OS clipboard readback, busy-native equivalence and10/100-member qualification remain outside this acceptance.

One initial menu test failed on the old default room tab. Its shared message was retained but hidden by the approved default overview. The driver now explicitly opens the existing shared-record tab before the unchanged copy assertions. This single test-only commit follows the clean2de09db build and does not change any packaged runtime file. The actual signed117 launch/payload/signature proof is separate from hardcoded source-only scope labels in reused drivers. The successful owned menu video is retained privately and fully decodes. The ordinary visible116-to-117 update preserves9 session records/all verified live native process starts/owners and12 flushed view drafts, retains the sole searchable app, and leaves original native backends running. Both temporary-root counts remain unchanged across the measured window, with only GUI-service scratch replaced by reopening; owned test profiles and GUI processes are removed and the atomic slot released.

An owned signed116 supplement exercises actual Codex0.164 shell execution after GUI closure, then native goal completion and identity/draft retention on reopen. Four fixed local replies plus one title,0paid inference; its owned native PIDs/profile are removed and all57 files/strict signature pass. This is an execution-capability witness, not a full developer workday or a diagnosis of the previous long execution delay. The actual developer goal retains its original ID/objective/creation time and blocked status across the117 update; it is not claimed active or complete. Independent main integration/installed/deployment headless Fable review PASS with no required findings; HEAD/index/status/diff and all23 frozen file hashes remain unchanged.


### Compact session and original failed-tool reading — signed118

Eight header flows retain the actual input/terminal nodes, native identity/draft, full model/effort/status, critical permission/question/ownership/disconnection facts, existing menu actions, keyboard focus, archived display and focused room-member controls. At1440px outer width the ordinary reader starts56.398px higher; narrow850×600 retains original values and controls, while focused full values or critical states may grow. This is not a claim that every state fits one row.

Seven failed-tool flows verify default collapsed failures, exact original reason/input/output/copy, manual pointer/keyboard choices through status changes, another member streaming and reload, legacy choices and shared query. Failed Codex command and Claude Bash preserve their command once plus the existing bounded output preview. The integration driver enters the existing Join action through More after header compaction; assertions stay unchanged. Six current-menu regression groups and38 affected unit checks pass. All installed launches prove signed118/clean26cf8e5,57 identical runtime files and strict signature;0product models/real providers/native task inputs, with clipboard methods intercepted. Native mouse-mode menu regression deliberately passes2right-clicks and1guarded bracketed paste, not zero native bytes. Reused source-only labels are retained and installed provenance is recorded separately.

A successful owned5.04-second video fully decodes. Ordinary visible117→118 retains9 records/all current live native identities/owners/drafts and12 flushed view drafts; one indexed app, no debug/background launch, temporary counts6→6/0→0 and all owned test-profile/process cleanup pass. Native backends remain running; full backend refresh is a separate checkpoint. Main headless Fable installed/integration/deployment review PASS with no required findings; exact source and evidence freeze unchanged. Physical input, screen reader, OS clipboard readback and real transport/disk failure are not certified; full dogfood goal and T59 stay open.

## Native mid-tool input and attached list reading - 2026-10-29

The real Claude312 signed125 integration test reproduced a missing input: terminal and the next local request contained it, GUI did not. The corrected14af236 candidate preserves the exact accepted native rendering and UUID, labels engine framing as native-session content, and keeps the same nativeID/PID through completion. The final two-response local witness passes with one-time approval of a bounded owned Bash command; total11 fixed local responses across retained failures/corrections,0paid inference. A too-early durable-transcript assertion is retained and repaired with a bounded wait, without product changes. SDK13 and related139/full1283 Node checks pass; final corrected installed list/input5flows pass. Earlier signed list5flows and source clipboard/window receipts are reused for unchanged paths. Native bridge,308–311 shared startup, real-provider shared mid-tool, physical input and OS clipboard remain unverified. Daily installation is pending; these are scoped facts, not complete T88 or dogfood-goal acceptance.
