# Phone workspace, first delivery

This delivery serves the product's single-entry vision: use the same NAW sessions,
spaces, queues and record reminders from a phone. It adds no provider runtime,
model, background polling, telemetry destination or dependency.

## Candidate: QR-authorized enrollment and atomic phone replacement

The normal Connect phone path now prepares an in-memory candidate. Its QR is a
one-use enrollment password, not immediate workspace authority. The private
carrier and originating human window are checked before code generation, before
exchange and before activation. The link can be exchanged within two minutes;
exchange grants a separate two-minute enrollment window. Expiring QR pixels
does not cut short that redeemed window. Closing or changing setup cancels the
matching candidate; a stale cancellation cannot revoke its successor.

The phone explicitly invokes the existing WebAuthn creation and key-possession
verification. The QR intent authorizes only this candidate's first key, bound to
the exact origin, RP, generation and device. Its verified completion can enable
per-card approval without a Mac fingerprint ceremony. An ordinary paired cookie
cannot use this enrollment path or replace a key. Every supported sensitive card
still requires a fresh UP+UV assertion for its exact identity, presentation,
decision and deadline. The original manual selected-pairing path remains manual.

If system enrollment is unavailable or cancelled, the person may explicitly
choose basic access. It never enables sensitive approval implicitly. A candidate
can otherwise access only its setup status and fixed enrollment/completion
routes; sessions, workspace, execution and push remain denied until activation.

Preparing, exchanging, cancelling or expiring a replacement leaves the active
phone's authority unchanged. Completion refreshes current targets and checks
the carrier, human context and original generation again. In-flight or uncertain
old receipts block the swap instead of being discarded. A single authority-file
rename switches generations; old tickets then fail and the old key, contexts,
queued push and owned client are cleared before successful completion returns.
A known pre-rename storage refusal preserves old access. An unconfirmable disk
state or post-commit cleanup failure closes access rather than restoring an old
grant or claiming success. Already committed native work is not undone or resent.

The approved trust root is possession of the short-lived QR plus the existing
carrier/account gates. The retained `none` attestation does not certify a real
iPhone, particular biometric, or trusted hardware. A same-account person or
software client who obtains the QR first can enroll its own key. The desktop
warns about this accepted boundary; there is no claim that per-card verification
repairs a stolen first enrollment. See [WebAuthn's none attestation format](https://www.w3.org/TR/webauthn-3/#sctn-none-attestation).

All current/future target, ended-target and shared-host exception boundaries
below remain. No native terminal, arbitrary command, session/space
creation, membership, model/settings, interruption/takeover or file API is added.
The session/space creation `+` controls remain hidden; queue task addition remains
the separately authorized existing action. No real pairing, phone, notification
service or daily app was used for this implementation's isolated tests.

## Shared scope and transport behavior

The desktop's **Connect phone** action verifies an existing private Tailscale
Serve mapping and the native login before opening its loopback listener. It uses
an existing CLI entry, never the GUI bundle executable, and runs only `status`
and `serve status`. It never edits Serve, Funnel, DNS or ACLs. Ambiguous mappings,
unavailable identity and unknown shared-host trust fail closed. A shared-host
exception still needs an explicit choice in Advanced settings; cookies are not
isolated by port.

The check includes foreground Web mappings and same-host TLS TCP forwarding,
not just the root Web table. Unprovable additional topology needs that same
one-call exception; ambiguous ownership and Funnel cannot use it. Changes to
scope or carrier trust invalidate pending setup results before clearing pixels,
so an earlier all-scope response cannot reappear under a narrower form.

Core Image generates the one-use QR locally through an OS helper. Its payload is
piped to the helper, not put in process arguments, logs, files or a remote QR
service. The normal response contains image pixels and expiry, not a plaintext
link. QR pixels are cleared on expiry, closure, revocation or a changed setup.

The default **intent for a new pairing** covers current and future sessions
(read/send/answer), spaces, queue actions and record reminders. Opening Settings
does not grant access or broaden an existing pairing. The all policy lives only
in Main's current pairing lifetime. Observed concrete native tuples are mirrored
into the strict v1 authority for already-running backends; no backend receives a
wildcard ticket. A v2 empty bootstrap handles a pairing before the first native
session exists. Native identity, action, owner, generation, expiry, prepared-input
and human-input checks still apply. New trusted backend membership invalidates
old read contexts before rebinding. Scope storage remains bounded; no silent
truncation is permitted.

Only current native targets belong to an all pairing. Ended, archived, unbound
or confirmed-exited targets are removed from its list, grants and workspace
projection using the same target predicate. When no targets remain, the exact
scope set is cleared to the strict empty v2 bootstrap, which authorizes no
target; both current and published v1 readers reject the previous ticket. A
later current target can be mirrored without widening an old selected pairing.
Individual-selection mode retains its existing historical read semantics.

All-scope conversation previews share a four-MiB encoded-body budget rather than
each reserving the old per-thread maximum. Session/space metadata is retained;
recent text is shortened only at UTF-8 boundaries and uses the existing omission
flags. This prevents long histories across many sessions from making the entire
eight-MiB response unavailable. The original native records, confirmation content
and selected-mode limits are unchanged. Metadata itself still has the existing
hard response bound.

Since 2026-11-20 an all-scope pairing may use push like any pairing with records
access, at the person's request (it was refused on the server before); what a
push may carry is in `docs/mobile-phase3.md`. Enrollment and candidate activation follow the separate
QR authorization above. This checkpoint is not a daily installation.
Session/space `+` controls that only explained a Mac-only
action are now hidden; no creation API is added.

## Delivered boundary

The six Chinese/English views use Main's `displayState` projection. Native reads,
plain-text sends and ordinary native-question answers keep the existing mobile
prepared-submission protocol. The queue uses `RoomState` and the desktop assignee
gate; record acknowledgements use the desktop bell's source. Phone sends preserve
the desktop draft and enter the existing human quiet interval.

In the retained individual-selection mode, the desktop person explicitly selects each native session, its send/answer
permissions, shared spaces and record reminders. A room grant includes shared
messages, member metadata and queue management, not members' private conversations.
The new workspace grant and its idempotent request receipts live only in Main's
memory, bound to the current pairing generation. A restart requires pairing again.
Existing native request persistence remains unchanged.

Unpaired requests receive no private state. Pairing/revocation are excluded from
agent application commands and require the current desktop window context.
The listener binds only `127.0.0.1`; transport still requires the configured HTTPS
Host, Tailscale identity header, bearer cookie, same Origin for writes, and
session-bound CSRF. These are carrier/delegation checks, not a protected proof of
the physical person's identity against arbitrary same-account local code.

The retained individual-selection path starts with sensitive approval disabled;
the QR path enables it only after authorized system enrollment. Cards show the
original operation and deadline; native input is two minutes,
other operations ten minutes, matching the stale-card lane. That lane owns the
desktop execution-time expiry gate. Merge its gate without replacing it with this
delivery's presentation-only deadline field. Native terminal, interruption,
takeover, session/space creation, shared-space broadcast and record export explain
that they currently require the Mac.

Workspace actions persist an original request ID in the phone before posting.
An uncertain result can only query its original receipt; reload never resends.
Workspace receipts disappear on revocation/restart, so a missing receipt means
unknown, never permission to retry. Logout invalidates server authorization and
its cookie, retaining phone drafts and unresolved IDs for checking on the Mac.
Do not clear browser storage until unknown
outcomes have been checked on the Mac. Read views are bounded and label omitted
history/attachments. Data updates on navigation, actions and explicit refresh.

## Verification without a real tailnet

```sh
npm run build:ui
node scripts/test.cjs app/tests/mobile*.test.cjs
NAW_EVIDENCE_DIR=/absolute/private/output node scripts/test-phone-workspace.cjs
```

The browser script owns temporary daemon profiles, launches a hidden headless
browser at 390px, uses synthetic native transports and carrier forwarding, and
operates real Main mobile handlers, the loopback server and Unix service. Its
owned TLS proxy uses a disposable self-signed certificate, never a public CA or
the machine's trust store. Real browser network responses also verify logout
retains uncertain request IDs/drafts; intercepted response fulfillment would
miss browser storage deletion. It
checks both languages, all six views, ordinary send/question, queue add/cancel,
record acknowledgement, sensitive-operation refusal and revoked credentials.
It produces screenshots and prototype comparisons under `NAW_PICTURES_DIR`
(default `~/Pictures/naw-dogfood`). Pairing secrets are redacted from failures.
It never initializes a real model, desktop user profile, public certificate, tailnet or
Web Push subscription. A physical phone, actual Serve identity forwarding and
public-CA certificate issuance remain acceptance steps for the activation owner.

## Activation checklist for the designated operator

These commands are a handoff, not an automatically executed setup. Read-only
inspection first, privately; status can contain device names and user identities:

```sh
tailscale version
tailscale status --json
tailscale serve status --json
tailscale funnel status --json
tailscale serve --help
```

Stop if this installation differs from the referenced CLI, port 443 already hosts
something, or Funnel is enabled for the proposed endpoint. Preserve other services;
do not reset the global Serve configuration. Identify the Mac's exact HTTPS DNS
name and the phone's Tailscale IP from private status, without copying them into
Git or public evidence.

Before enabling HTTPS/issuing any certificate, show the person the exact machine
and tailnet DNS name. Obtain explicit approval to publish that name in the public,
append-only Certificate Transparency ledger. A private Serve endpoint does not
make its certificate hostname private. Enable MagicDNS/HTTPS only after this check.
See [Tailscale's HTTPS privacy description](https://tailscale.com/docs/how-to/set-up-https-certificates).

Review the entire existing access policy with the operator: allow only the chosen
phone device to reach this Mac's TCP 443. Device IP selectors can scope a grant.
Grants/ACL permissions are additive, so adding a narrow grant does not cancel an
existing broad allow. Add positive and negative policy tests before applying any
policy change; never overwrite an existing policy from a template. See
[grants and overlapping permissions](https://tailscale.com/docs/features/access-control/grants/grants-explained).

Choose a free local port, for example 48765. Configure the private carrier first;
the authorized operator runs the following only after the hostname/privacy and
access-policy checks above:

```sh
# Example port: replace it with the exact port selected in the desktop dialog.
tailscale serve --bg --https=443 http://127.0.0.1:48765
tailscale serve status --json
tailscale funnel status --json
lsof -nP -iTCP:48765 -sTCP:LISTEN
```

Confirm Serve says the endpoint is within the tailnet and Funnel remains off.
Then enter that port, the exact HTTPS origin and the person's Tailscale login in
the desktop phone setup, select intended sessions/spaces/reminders and confirm
the configured private carrier. Do not grant butler or unrelated conversations for
this acceptance trial. Prepare the link and rerun `lsof` above: NAW must listen
only on `127.0.0.1`. Serve provisions TLS automatically; do not run
a separate certificate export or put keys in NAW. This uses private **Serve**,
never Funnel. The syntax and port-specific shutdown follow the
[official Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve).

On the selected phone, open the desktop's short-lived pairing link, then exercise
read, plain-text send, queue add and reminder acknowledgement with a synthetic
session. Verify unpaired access, a different device and access outside the tailnet
are denied. Revoke on the Mac; old credentials must fail. Check unknown receipts
on the Mac before re-pairing. To close only this endpoint, retaining other services:

```sh
tailscale serve --bg --https=443 off
tailscale serve status --json
```

Also revoke in NAW so the listener and device delegation close. `tailscale cert`
and Web Push subscription are not part of this delivery. The later push phase
will send counts only from the same record-reminder source, after a separate
permission and real-device acceptance; no subscription UI claims it works now.
