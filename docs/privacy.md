# Privacy requirements and release conditions

As of 2026-10-17. This document is a design and release constraint, not a claim
that an implemented app has passed a privacy audit or complies with every law.
The repository currently contains planning material and local developer checks.
There is no product account system, telemetry backend, or shipping agent integration.
GitHub independently processes repository visitors and contributions under its terms.

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

These conditions are not all completed: no application runtime exists to validate
yet, and operator/market-specific legal analysis has not been performed. Local-first
design and Apache-2.0 do not replace privacy obligations or provider terms.

## Primary references

- [GDPR official text](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng): scope in Articles 2–3; data principles in Article 5; design/default protection in Article 25; security in Article 32. Applicability depends on actual processing and territorial scope.
- [California Attorney General's CCPA explanation](https://oag.ca.gov/privacy/ccpa): covered businesses, personal/sensitive information, notices and consumer rights. Public source code alone does not determine whether a business is covered.
- [Claude Code legal and authentication terms](https://code.claude.com/docs/en/legal-and-compliance): conditions for running the unmodified CLI in a product, native authentication, direct user billing, and restrictions on intermediating subscription credentials. Recheck before integration/distribution.
- [Project licensing boundaries](licensing.md): code, brands, model services, and third-party payloads have separate terms.

These sources inform the engineering requirements; they are not a worldwide legal
clearance. Recheck changing terms and the actual business model before distribution.
