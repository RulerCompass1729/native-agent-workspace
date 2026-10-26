# Local alpha privacy and release conditions

As of 2026-10-22. The macOS alpha runs locally. There is no product account
system, cloud sync, analytics service, remote crash upload or shell model call.
The renderer permits network requests only to its local DSH host. The UI host
mounts an explicit UI composition; model/tool/account/telemetry plugins are not
mounted. These implemented boundaries are not a complete network or legal audit.
GitHub independently processes repository visitors and contributions.

## What is stored and how to remove it

The default location is the current account's Application Support directory under
Native Agent Workspace. Development/test profiles may override it. The in-app
**隐私与用量 → 查看本机数据** opens the actual location.

- workspace.json contains displayed conversation copies, selected working paths,
  native IDs, process identity for safe recovery, team-event metadata, explicit
  shared messages, drafts and bounded structured native tool records already displayed
  to the user. It does not contain raw terminal scrollback,
  provider credential files, full environment dumps or raw protocol traces.
- legacy-shared.json stores only native display blocks authorized by an explicit
  room send on inspected retained Claude connections. It is owner-only and atomic;
  already-displayed structured tool inputs/results are saved within the existing
  200-record/1 MiB bounded trajectory, including an explicit overflow marker. Clearing shared history removes
  these replies too. Reopening preserves displayed history, never a live sharing
  grant or pending task. Permissions, private input, departure, control change,
  gaps and context changes freeze the grant. A shared reply may refer to earlier
  native context; sharing grants do not erase or isolate the model memory.
- views.json stores window/layout selection, terminal display preferences,
  a per-window shared-task draft and a local private-session draft recovery copy.
  An unreadable or malformed view record blocks startup and writes to that file;
  the application retains the original rather than replacing it with empty data.
  The startup screen offers the same local-data location and an explicit retry
  after permission repair or restoration from a known-good backup. This does not
  repair a damaged file or provide an independent historical backup service.
  A later write failure keeps the normal window/quit action from closing the
  unsaved view. The existing warning offers an explicit local-save retry, even
  if the native service has disconnected. A message already accepted by a native
  agent stays accepted; retrying storage never resends it. Forced process
  termination, device failure and unsaved memory are not covered by this guard.
  Electron/DSH keep local UI preferences/cache and a local UI access token.
  The independent service keeps its private connection/token files and a
  versioned runtime copy. Tokens are not displayed in startup failures.
- runtime-locations.json stores explicitly chosen executable paths only, in an
  owner-only file. Discovery does not execute a program or inspect credentials;
  choosing a program does not prove sign-in or version compatibility.
- session-labels.json holds display names keyed by stable application session ID.
  Names use an owner-only file and are not automatically sent to a model.
  Explicitly shared background can include visible room/session names; its text
  can be reviewed and edited before sending. An explicitly authorized bounded
  reply exchange also shares its previewed source names, provider and short
  application session IDs with selected participants. Native titles, history and stored
  original author labels are not renamed; the UI can display current aliases.
- legacy-links.json holds explicit same-process connection references, not
  credentials. Retained Claude uses a local project plugin; retained Codex uses
  its existing private native socket. legacy-dispatches.json keeps submission
  metadata for private input. **Explicitly shared** submissions additionally
  store their text and recipient name locally, with acceptance status. Replies
  are not inferred or automatically copied from retained sessions. Clearing
  shared records strips the selected rows' text/name/sharing flag while retaining
  dispatch accounting. A later submission is not part of that earlier clear.
  Provider history and material already delivered to another agent remain separate.
- legacy-reader-*.json stores explicitly connected retained Claude and Codex
  private local projections: native/process identity, accepted inputs, displayed
  response text, bounded structured native tool inputs/results and turn/gap metadata.
  It is atomically saved with owner-only permissions. Raw terminal observations
  remain excluded. Reopening marks unfinished tool state unconfirmed, not running. Invalid or missing projection
  data after attachment cannot silently fall back to the old raw-response cache.
  Observed Codex partial replies and interrupted turn boundaries survive GUI exit
  even when native history omits them. Reopening never renews a sharing grant,
  resumes a task or sends a model request. The cache is limited to 64 MiB per
  native session; write failures remain visible, with the previous file intact.
  This is a local display copy, not an edit to provider history or a crash-proof
  backup. Removing an ended application record removes its projection and connection
  metadata; native-provider history and separately shared room records remain.
- Session names: a Claude session created without a name is launched without
  `--name`, so Claude makes its own small title request, as it does in a
  terminal. NAW reads only the newest `ai-title` row from the last 256 KiB of
  that session's own transcript (on session start, prompt submit and stop) and
  keeps the title as the row name; nothing else in the transcript is read or
  stored. Codex rows use their first request, then a native thread name if one
  is set, including the title the Codex TUI generates for an unnamed thread.
  An automatic name comes from a private first request or summary and, like any
  row name, becomes the participant label in shared records and handoff
  previews. A desktop rename stays in session-labels.json and always wins.
- room-state.json contains the room name, human-written shared notes and their
  saved versions, confirmed membership events, archive indexes and the original
  member IDs for explicit restoration. Its file is owner-only. These are local
  records; note/background text reaches a provider only when explicitly sent.
  Clearing a current note does not delete its older timeline versions.
- services.json records relative backend directories. After an update, retained
  backends keep their own workspace/connection files under this same private
  application data directory. The UI combines their records in memory; it does
  not copy private histories to a new native session. Complete local removal must
  include these directories after every service has safely exited.
- Records stay until removed. After a session ends, use **会话与原生团队 →
  移除本应用记录**. This also removes matching saved window drafts. Shared-room
  records are separate: pause handoffs, then use **隐私与用量 → 清理与完全退出 → 清除共同工作记录**.
  Clearing shared records does not cancel a native task already in progress.
  It also clears the local membership timeline and all saved note versions;
  a concurrent newer edit is preserved and reported instead of silently erased.
  Room names and archive indexes remain. Archiving only hides retained records
  and pauses future collaboration; it is not deletion, redaction or native-task
  termination. The archive list shows reported native state and supports restore.
- For complete local removal, first end/disconnect native sessions and confirm
  their state, open the data directory, then choose **隐私与用量 → 清理与完全退出 → 所有会话结束后完全退出**.
  This refuses while any session remains active or uncertain. After the service
  has exited, remove this application data directory.
  Never remove a live service's directory to try to stop its processes. Native
  Claude/Codex history, authentication, provider retention and OS backups remain
  separate; use their own supported controls for those copies.

Top-level data directories and service connection directories are restricted to
the current OS account; state/connection files use owner-only modes. Conversation
copies have **no application-layer encryption**. Another process with access to
this account can read them, even on an unlocked encrypted disk. Sensitive or
regulated information is not an appropriate first alpha test fixture.

## Inspecting privacy and usage

Agent-selected handoffs use a native tool registered with new supported sessions.
Its tool description consumes native context even outside a collaboration round.
An authorized round also adds participant IDs/names and remaining reply limits to
each delivered task; the existing message delivery details expose the exact
wrapped text. These tokens and each native tool continuation are billed or counted
by the provider. There is no separate routing model, but this is not a claim of
identical token usage to a plain native session without the messaging tool.
Only a valid bounded room grant permits delivery. Claude's session-local MCP
helper uses stdio and cannot dispatch messages itself; its native permission and
hook result must return to the authenticated root before staging. No global
provider settings or credentials are changed.

The **隐私与用量** panel shows current application/backend versions, the number
of managed sessions not confirmed ended, application dispatches since backend
startup, and native token reports where available. Refresh is a local state read;
it sends no model prompt. Opening the local data directory or public source is an
explicit action. Clipboard text is read only for a user-initiated paste, never
polled or saved as clipboard history.

The dispatch count includes application sends and collaboration handoffs. It does
not include direct native TUI input, every underlying model request, tools or
teammates. Native-service counters reset on backend restart; the retained-session
compatibility ledger persists its dispatch count across UI restarts. A failed/unconfirmed dispatch
can still be counted. Native tokens can be missing, stale or incomplete for a
fleet. Unknown values say **未报告**, not zero. The app does not calculate a dollar
charge or claim equal cost to direct native use; verify charges in the provider's
own account. A limit on handoffs is not a hard provider-spend limit.

For a reproducible check with synthetic content:

1. Record the installed app/backend versions and the provider version in its
   native terminal. The public source is inspectable, but a version label alone
   does not verify the binary's signature or provenance.
2. Inspect the data directory before/after a private message, an explicitly shared
   message, and removal. Check the separate native history as well. Do not upload
   these files as a diagnostic bundle.
3. Check that app opening, view switching and room membership changes do not send
   prompts. Use native history/usage alongside the narrowly scoped app counter;
   the counter alone cannot prove the absence of all model activity.
4. Inspect process/network behavior independently if needed. The panel does not
   currently measure CPU/RSS or complete subprocess network egress. An idle network
   trace cannot establish what every future native tool will do.

The checked source disables automatic shell title/summary/model-routing features.
This is an implementation property, not an independent privacy certification.
Full egress auditing, equal-task token/cost comparisons and independent security
review remain open. Do not turn missing measurements into a green “all safe” badge.

## Data boundaries

| Surface | Required behavior before it ships |
| --- | --- |
| Provider credentials | Use native authentication. Do not extract subscription tokens, build a replacement login, duplicate secrets in room state, or log process environments. Pass only necessary credentials/environment to the intended runtime. |
| Native sessions | Keep sessions private by default. The provider may send prompts, selected files, tool results, and metadata to its own services; a local desktop shell does not make a cloud model offline. Disclose the actual provider/destination. |
| Collaboration | Authorize recipient and material scope. Joining is not consent to copy private histories or all project files. Treat agent output and documents as data, not authority to broaden sharing. |
| Local state | Store only necessary state, with restricted local access and a defined retention/deletion path. Do not duplicate raw transcripts for convenience. Decide encryption and backup handling against the actual threat model before persisting sensitive content. |
| Logs and diagnostics | Default to operational events without prompts, file contents, credentials, financial records, personal paths, or full environment dumps. Optional exports need local preview, minimization, and explicit destination selection. |
| Telemetry and crash reporting | No shell telemetry, remote crash uploads, or session replay by default. Review each dependency's initialization and outbound requests; a disabled UI switch is not evidence that a library stopped sending. |
| Tools, plugins, and fleet | Preserve native permission enforcement. Room membership is not an OS sandbox. Unattended work does not authorize new recipients, new data categories, or uploading secrets. Verify descendant processes and tool destinations. |
| Exports, clipboard, notifications | Export only selected material. Avoid sensitive previews and silent clipboard capture. Show what leaves the application and where it goes. |

Detaching a session stops future room routing; it does not retract prior messages,
erase another agent's context, or delete provider-side records. Local deletion and
provider retention are separate and must not be presented as one operation.

Use invented data in public examples and tests. Personal identity, finances,
employment, health, legal matters, account access, and customer information require
the same care as obvious API keys. Redacting one name from a real conversation does
not necessarily make it anonymous.

## Conditions before a public application build

The maintainer must review the actual build, rather than approve this list once:

1. Inventory data categories, storage locations, retention, recipients, network
   destinations, and subprocess permissions, including transitive dependencies.
   Verify idle startup and representative tasks for unexpected outbound requests.
2. Verify authentication, session separation, selected sharing, export previews,
   local deletion, and logs with synthetic sensitive fixtures. Document provider
   retention and capabilities the shell cannot enforce.
3. Identify the operator, intended markets and users, and actual data-processing
   roles. Assess applicable privacy laws and provider/platform terms for that
   deployment; publish accurate notices and a working privacy contact before
   collecting data. Review collection purposes, lawful basis where applicable,
   user rights, service contracts, international transfers, and incident handling.
4. Review the exact dependency versions and distributed binaries, code licenses,
   notices, provider authentication terms, telemetry defaults, and update mechanism.
   Adding analytics, accounts, cloud sync, hosted execution, children as a target
   audience, or regulated uses triggers a new assessment before release.

These conditions are not all completed: runtime state and local deletion checks
exist, but comprehensive subprocess/network coverage, independent privacy review,
and operator/market-specific legal analysis have not been performed. Local-first
design and Apache-2.0 do not replace privacy obligations or provider terms.

## Primary references

- [GDPR official text](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng): scope in Articles 2–3; data principles in Article 5; design/default protection in Article 25; security in Article 32. Applicability depends on actual processing and territorial scope.
- [California Attorney General's CCPA explanation](https://oag.ca.gov/privacy/ccpa): covered businesses, personal/sensitive information, notices and consumer rights. Public source code alone does not determine whether a business is covered.
- [Claude Code legal and authentication terms](https://code.claude.com/docs/en/legal-and-compliance): conditions for running the unmodified CLI in a product, native authentication, direct user billing, and restrictions on intermediating subscription credentials. Recheck before integration/distribution.
- [Project licensing boundaries](licensing.md): code, brands, model services, and third-party payloads have separate terms.

These sources inform the engineering requirements; they are not a worldwide legal
clearance. Recheck changing terms and the actual business model before distribution.


## Native observation

Alpha.77 persists already-displayed structured native tool inputs/results in the
existing private session and explicitly authorized shared histories. These can
contain sensitive data just like displayed conversation text; they are not
automatically redacted or encrypted. Existing record removal/shared-history clear
apply, separately from provider history. Persistence does not restore a live
sharing grant, add tool output to a model prompt, or send any task. Raw terminal
bytes and unstructured legacy observations remain memory-only.

The following describes the earlier alpha.24 observation layer:

The portal now holds bounded native terminal bytes and allowlisted structured tool
progress in local process memory. These may contain private paths, drafts, login
messages or secrets printed by the native program; they are **not** guaranteed to
be redacted. The same local human can inspect them in solo/room views. Observation
does not automatically write these records into workspace persistence, exports,
shared context, diagnostics or external uploads. Explicitly selecting/copying or
sharing content is a separate user action. Native providers may independently
retain their own histories according to their own settings and terms.

Limits and overflow/disconnection behavior are documented in `live-progress.md`.
No model is invoked to summarize or interpret a screen. Local rendering/memory
are real costs; short test measurements are not a zero-resource or bill-parity
claim. Raw test evidence remains private and is not included in source/packages.

## Explicit retained-session input connection in alpha.25

For the inspected alpha.2 Claude connection, clicking the connection action adds
our own plugin code to `.claude/skills/native-workspace-compat` in that session's
working directory. It does not install globally, copy provider credentials or
silently overwrite a different/edited plugin. The app validates directory
ownership and refuses symlink destinations. Native plugin reload stays explicit.

Per-session socket credentials are in the existing private local socket directory,
not the project/plugin or public repository. The UI's local metadata retains the
native identity/connection reference and dispatch attempt status; the compatibility
ledger does not duplicate prompt bodies. Existing workspace/native histories and
drafts continue under their prior retention rules. Closing the UI removes its
active descriptors; a later UI restores only explicitly prepared, still-identical
native processes. Neither setup, polling nor reconnect sends a model prompt.

Dispatch counters include rejected/unconfirmed attempts and are not paid-call
counts. Compatibility attempt counts persist locally; ordinary native backend
counters remain per process lifetime. No claim of complete billing measurement.

## Explicit local file preview — alpha.44

A system file choice reads one selected regular UTF-8 text file, up to 256 KB.
Symlinks, special files, unsupported formats and changing reads are rejected.
The preview holds a snapshot in the window's main-process context and releases
it when closed; it does not crawl a directory or watch files. “加入草稿” appends
the displayed filename and content to the existing draft, with the normal 16,000
character limit. Drafts are saved locally by the existing draft mechanism. Only
an explicit send shares the draft with the selected native agent; any native
provider/tool access still follows its own permissions. “另存副本” writes the
previewed bytes, refuses existing destinations, and does not reread a changed
source. Previewing or saving calls no model.


Retained Claude private reader caches also retain explicitly queued solo text
with its native acceptance status. The metadata-only dispatch ledger still does
not store private prompt text. Closing before receipt leaves an uncertain local
row, does not resend it, and does not claim that native accepted work was canceled.
These private caches remain local, follow the existing private reader removal,
and never become room-sharing authority.
