# Local alpha privacy and release conditions

As of 2026-10-17. The macOS alpha runs locally. There is no product account
system, cloud sync, analytics service, remote crash upload or shell model call.
The renderer permits network requests only to its local DSH host. The UI host
mounts an explicit UI composition; model/tool/account/telemetry plugins are not
mounted. These implemented boundaries are not a complete network or legal audit.
GitHub independently processes repository visitors and contributions.

## What is stored and how to remove it

The default location is the current account's Application Support directory under
Native Agent Workspace. Development/test profiles may override it. The in-app
**隐私与数据 → 打开本机数据目录** opens the actual location.

- workspace.json contains displayed conversation copies, selected working paths,
  native IDs, process identity for safe recovery, team-event metadata, explicit
  shared messages and drafts. It does not contain raw terminal scrollback,
  provider credential files, full environment dumps or raw protocol traces.
- views.json stores window/layout selection and a local draft recovery copy.
  Electron/DSH keep local UI preferences/cache and a local UI access token.
  The independent service keeps its private connection/token files and a
  versioned runtime copy. Tokens are not displayed in startup failures.
- Records stay until removed. After a session ends, use **会话与原生团队 →
  移除本应用记录**. This also removes matching saved window drafts. Shared-room
  records are separate: pause handoffs, then use **隐私与数据 → 清除共同工作记录**.
  Clearing shared records does not cancel a native task already in progress.
- For complete local removal, first end/disconnect native sessions and confirm
  their state, open the data directory, then choose **隐私与数据 → 所有会话结束后完全退出**.
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
