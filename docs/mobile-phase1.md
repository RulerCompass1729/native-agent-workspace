# Phone workspace, first delivery

This delivery serves the product's single-entry vision: use the same NAW sessions,
spaces, queues and record reminders from a phone. It adds no provider runtime,
model, background polling, telemetry destination or dependency.

## Delivered boundary

The six Chinese/English views use Main's `displayState` projection. Native reads,
plain-text sends and ordinary native-question answers keep the existing mobile
prepared-submission protocol. The queue uses `RoomState` and the desktop assignee
gate; record acknowledgements use the desktop bell's source. Phone sends preserve
the desktop draft and enter the existing human quiet interval.

The desktop person must explicitly select each native session, its send/answer
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

Sensitive approvals are deliberately disabled, as the person approved for this
batch. Cards show the original operation and deadline; native input is two minutes,
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
