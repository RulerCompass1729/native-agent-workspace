# Phone confirmation boundary

This serves the product's single entry on the phone: the person can answer an
original desktop confirmation without treating a paired browser as the person.
The desktop and phone still use the same BackgroundControl operation and gates.

## Authority and registration

Sensitive phone decisions are off by default. From the desktop setup panel, the
person starts a two-minute registration and enters its six-digit code on the
paired phone. Registration accepts only ES256 / P-256 and `fmt=none`. A separate
UP+UV signed assertion proves possession before the Mac can confirm the public
key. The person compares the complete SHA-256 public-key fingerprint on both
screens, confirms that exact registration on the Mac, then separately enables
phone decisions there. Changing keys or revoking approval authority is desktop
only; those methods are absent from the background command catalog and HTTP.

The registry, challenges and consumed outcomes live in the app process, scoped to
the current paired device, generation and configured HTTPS origin. Restarting,
re-pairing or losing that connection invalidates them. There is no persisted
`verified=true` authority and no automatic recovery or re-enablement. A passkey
left in the phone's credential manager is insufficient after its registration
has gone. No passkey is registered on a real device by the automated tests.

## One decision, one proof

The server fixes the RP to the hostname of the HTTPS origin configured on the Mac.
IP literals are unsupported RP IDs; isolated tests use `localhost`. The browser
requests only the registered credential, with user verification required. The
server verifies the credential ID, raw ID, ceremony, exact challenge and Origin,
RP hash, UP, UV, backup flags and ES256 signature with Node crypto. Cross-origin
ceremonies, extensions, other algorithms and attestation formats are refused.
The bounded CBOR reader accepts only the definite maps/integers/bytes/text needed
for this format, rejecting duplicate keys, excess nesting and trailing data.
There is no password, cookie-only or preferred-UV fallback and no new dependency.
The protocol requirements follow [WebAuthn registration and assertion
verification](https://www.w3.org/TR/webauthn-3/#sctn-verifying-assertion).

A random challenge binds device authority, session/native identity, immutable
card/operation digest, decision and deadline. Its server record is consumed once,
before entering the original operation; the signature counter is not the replay
guard. Validity is checked again after awaits and before the original handler.
Revocation, disable, re-pairing, changed targets/cards and expiry invalidate old
proofs. Once the original handler has committed work, revocation does not undo
that work. Original target, permission, actor, native-input and audit checks remain.
Input cards keep the original two-minute deadline; other cards keep ten minutes.
A challenge expires at the earlier of the card deadline or two minutes.

Only cards originating in explicitly paired readable sessions are projected.
After desktop enablement, a native-only pairing can also read these cards;
this adds no space or reminder grant. Revoking approvals retains the read-only
card/receipt projection until the pairing ends.
This implementation supports message cards with Cancel=0 and Approve=1; other
button schemes stay on the Mac. If title/detail exceeds the phone projection's
limits or does not match the authoritative card, both presentation and the
server refuse phone decisions. The full operation/guard digest remains bound.

The browser saves only a receipt identity before posting the decision. A lost
response, reload or error never resends the assertion/decision. The person can
query the original receipt or check the Mac. Assertions, CSRF and biometric data
are not saved in browser receipt storage. Uncertain results cannot be dismissed
to silently unlock another send.

## Explicit limit and deployment gates

This is the same local trust boundary as the desktop, as chosen for this stage.
It does not protect either approval path against an agent with arbitrary
same-account code/file writes, an administrator, an OS compromise, a malicious
browser extension, or a person approving the wrong operation. UV may use a PIN;
passkeys may synchronize and do not prove one unique physical phone or that the
person read the card. A separate protected local approval boundary is deferred
until the person requests it or an actual local bypass is observed.

Tests use synthetic sessions, a loopback carrier, ephemeral untrusted test TLS
and Chromium's virtual authenticator. They do not prove physical-device behavior,
OS authentication UI policy or production Tailscale configuration. Real-device
registration, enabling approvals in the daily profile, Serve/ACL/certificate
changes, system services, distribution and spending remain separate human gates.
No test changes them, and no install or publication is implied by a local commit.

Run `npm run build:ui`, then set private `NAW_EVIDENCE_DIR` and run
`node scripts/test-phone-consent.cjs`. Screenshots use `NAW_PICTURES_DIR` or
`~/Pictures/naw-dogfood`; the script exits only after owned resources are cleaned.
