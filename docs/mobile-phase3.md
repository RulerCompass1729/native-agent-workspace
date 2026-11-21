# Phone push: a count and four fixed alerts

This phase serves the single-entry vision by waking the person with a reminder
count, then opening the existing private phone entry for the records themselves.
Since 2026-11-20 the same push also carries four fixed alert codes, so that the
person learns at once when NAW itself needs them (see "Alerts" below).
Sensitive approvals remain disabled. This is an isolated implementation candidate;
phone pictures, independent Codex review and real-device activation are separate gates.

## One count and no private payload

Main's `appRecordsStatus()` supplies the desktop `records` status command and the
phone workspace's `records.status()` adapter. Push reads **that adapter's count**.
It neither counts cards nor interprets reminder rows. When the bell's upstream
status includes confirmations or cleanup reminders, push follows the same field.

The shared status already includes a shown temporary-file reminder. Desktop
passes the result of its person-only inspection; read-only callers use that
manager's cached public summary or the existing checked summary file. The public
summary contains no cleanup ticket, paths or candidate receipts. An unreadable
summary remains visibly unavailable. The desktop alone receives its window-bound
ticket, and does not add another temporary-reminder count after the shared status.

The confirmation-inbox candidate uses the same `appRecordsStatus(snapshot,
suppliedTemp)` entry and `tempSummary` whitelist. Its future confirmation count
extends this entry's final total. Phone and push keep reading `.count`; neither
adds cards or temporary reminders itself. This repair does not import that
candidate's UI or depend on its visual approval.

Without an alert the encrypted application payload has exactly one property:
`{ "count": N }`. With alerts it is `{ "count": N, "alerts": [code, …] }`; the
count is left out when it may not or cannot be read (see "Alerts").
The service worker creates “NAW 有 N 条提醒” / “NAW has N reminders” locally. It
never receives names, conversation text, local paths, screenshots, private-origin
URLs, or approval tokens. Clicking always opens `/mobile/` on its own origin;
it does not approve an operation or use a URL from a notification.

Standard Web Push metadata remains visible to the push service: its opaque
subscription endpoint, timing, VAPID public key/JWT, TTL, topic and ciphertext
length. VAPID's subject is the fixed public project URL, never the private
Tailscale name or a personal contact. The topic is always `naw-count`. A
count-only payload has TTL 60 seconds and normal urgency; a payload with an
alert has TTL 3600 seconds and high urgency, so the push service can tell that
an alert is being sent, though not which one. Identical states are coalesced;
changed counts, including zero, replace the notification. Accepted means
accepted by the service, not delivered to the phone. JWTs are reused for one
hour per push-service origin.

Only exact HTTPS hosts `web.push.apple.com`, `fcm.googleapis.com` and
`updates.push.services.mozilla.com` are supported. Ports, credentials, queries,
fragments, IP literals and suffix lookalikes are refused. DNS must return public
addresses, TLS uses the normal certificate check, proxies are unused, redirects
are not followed, and requests/responses have finite time and size bounds.
Other legitimate provider hosts currently fail closed; this is not a claim of
support for every browser endpoint.

## Alerts

The codes, most urgent first, are `service-disconnected`,
`steward-wake-stalled`, `token-anomaly` and `decision-waiting`. The Mac sends
only codes from this list; the service worker holds the wording (“本机服务断开”,
“大管家该叫醒没叫醒”, “token 异常”, “有事等你决定” and their English forms) and shows
nothing for any other value. No name, text, reason, duration or number other
than the reminder count is sent. An alert notification uses the tag `naw-alert`;
its title is the most urgent alert, its body the remaining ones and a count
above zero. When the last alert ends, one payload with an empty list lets the
phone show “告警已解除”; after that the count-only payload returns.

An alert payload outlasts a phone that is briefly unreachable; the shared
topic lets a later state replace one the push service has not delivered. Alerts
are reported by the same check as the count, about a minute after they begin: a
60-second timer and then the send. Whether a locked Mac slows that timer is
unverified. A lost service is the exception: it is said at once (see below).

Main's `appHealth(status)` is the one source:
`{ available, alerts: [{ code, at? }], unknown: [code] }`. `unknown` lists the
codes whose source could not be read, and `available` is false when there is
one: unknown is never "no problems". The push keeps a code it has already said
for as long as that code is unknown, and keeps all of them when the answer
itself cannot be read, so an unreadable source is never shown as “告警已解除”.
It does not raise an alert it has not said. A reminder count that cannot be
read holds back only itself: alerts still leave without it, and it alone sends
nothing.

The optional `at` is when the newest case of that alert began; it stays on the
Mac, and an unchanged alert is sent again only when it grows, so a second
question is announced while the first is still open.

`appHealth` reports a waiting decision: a queue item that waits for the person
(the rule of the desktop decision notification), or a confirmation card the
person can act on, judged from the shared reminder status the caller passes in;
without that status the cards were not judged and the code is unknown. It
reports a stalled butler wake-up when the wake record's view has a `blocked`
field. Nothing on this change sets that field, and token anomalies have no
producer either: until their producers are merged, neither alert is ever sent.
The phone banner is meant to read the same function.

The broker adds `service-disconnected` itself when its connection to the local
service is lost. On this change that loss ends the phone's session, as it did
before, and nothing connects again by itself. The push therefore says the loss
once, trying again each minute until the push service accepts it, and then ends
with the session; it sends no "cleared" afterwards. To receive anything further
the phone is paired again and reminders are enabled again. A Mac revoke or a
new pairing stops an unfinished last send. When the phone page's reconnection
(a separate change) is merged, the subscription is meant to stay through a
reconnect instead.

## Device lifetime and offline behavior

Subscription, VAPID keys and pending work are memory-only, tied to the current
issuer/generation/device. Subscribing needs the explicit records permission,
which pairing "all" includes. The broker closes them on logout, Mac revoke and
re-pair. On a service disconnect it keeps the subscription only for the one
last message that reports the disconnect: the count is no longer read or sent,
the phone's private entry refuses every request, and a Mac revoke, a new
pairing or the device's expiry ends that last send too. Each refresh rechecks
the device, expiration and the disabled marker. A request rechecks after TLS and
before writing HTTP headers/body; close also aborts its outstanding request.
This extends the existing phone delegation, not a new proof of physical identity
against arbitrary same-account local code.

Only an explicit phone button requests permission and subscribes. When enabled,
one timer reads the shared count at most once a minute; records changes can also
refresh it. Failure stays “submission unconfirmed / may be delayed.” A 404/410
ends the subscription. No response body or endpoint is copied into a UI error.
Mac sleep/exit, no network, phone settings and the push service can delay or lose
notifications. A count is a snapshot when created. Open the private entry to read
current records and last sync; an unavailable entry is not presented as current.
Already submitted or displayed notifications cannot be recalled by Mac revoke.
No private offline cache is added.

## Dependency and packaging

`web-push` is pinned to **3.6.7**, published 2024-01-16. As checked against the
[official registry](https://registry.npmjs.org/web-push) on 2026-11-15, latest
4.0.0 was published 2026-11-06 and had not aged two weeks. The direct package is
MPL-2.0; its complete 17-package runtime closure is locked. Source/import and
lifecycle inspection preceded local installation. The private phase3 status
holds the full version/license inventory and raw source-audit locations.
No package has an install lifecycle script. Import opens no network or writable
file; an isolated import probe checks this. `http_ece` has an opt-in key logger:
NAW refuses `ECE_KEYLOG=1` before loading/using encryption. It uses the library's
request generation, not its proxy/send/CLI paths. Third-party source and licenses
remain unmodified in the dependency payload.

`package-mac.cjs` copies the new app files and installs the production lock with
scripts/audit disabled. To inspect just this payload without packaging/signing:

```sh
node scripts/list-phone-push-payload.cjs /absolute/private/new-output.noindex
```

The script checks the package allowlist and exact production dependency closure,
stages actual files under `.app/Contents/Resources/app`, and prints every file.
It neither builds a launchable app nor signs, registers or installs one.

## Operator activation, after approval

These steps are for the designated operator. They were **not executed** in this
delivery; this run permits official npm downloads and loopback fakes only.

1. Obtain the person's approval of the new phone pictures, the independent
   Codex verdict and explicit permission for real subscription/push traffic.
   Integrate/package using the authorized operator's normal process. A source
   commit or picture approval alone is not real-service activation.
2. Follow `docs/mobile-phase1.md`'s carrier checklist. Inspect `tailscale version`,
   `tailscale status --json`, `tailscale serve status --json`,
   `tailscale funnel status --json` and `tailscale serve --help` privately.
   Show the exact DNS name and obtain its public-CT consent before certificates.
   Check additive ACLs for this phone and preserve other Serve services.
3. After those checks, choose the free port in Mac setup (example 48765) and run
   `tailscale serve --bg --https=443 http://127.0.0.1:48765`. Recheck Serve/Funnel
   status and `lsof -nP -iTCP:48765 -sTCP:LISTEN`. Funnel stays off and NAW must
   bind only 127.0.0.1. Substitute the selected port, not a guessed one.
4. Select only intended sessions/spaces and **record reminders** in Mac pairing.
   For acceptance use a synthetic profile/reminder, not butler or unrelated
   conversations. On iPhone open the private HTTPS page in Safari and choose
   Share → Add to Home Screen. Launch NAW from that icon. Verify pairing inside
   the Home Screen app; do not assume Safari tab cookies carry over. If needed,
   generate a fresh Mac pairing link and paste its short-lived `#pair=` value
   into the existing pairing-code input there, only on the person's own device.
5. Open Reminders → Enable reminders, then personally allow system notifications.
   This is the first real push-service subscription. If unavailable/denied, the
   page shows instructions; it does not subscribe automatically or enable a
   fallback service. Compare N to the Mac bell, verify only the count on the
   Lock Screen, then open the notification and verify private-entry authority.
6. Check offline/sleep: the UI must show uncertainty/last submission and last
   sync, never confirmed phone delivery. Resume and refresh the private entry
   for current records. No two-minute delivery promise is made.
7. Disable on the phone, then re-enable for the revoke check. Revoke on the Mac:
   old private credentials must fail and no later push may be sent. Old queued
   messages may survive until TTL or already be displayed. Turn off the Web
   App's notifications in iPhone settings if desired. To close only this Serve
   endpoint use `tailscale serve --bg --https=443 off`, preserving other services,
   and revoke in NAW as in phase 1.

iOS/iPadOS 16.4+ Web Push requires a **Home Screen web app** and a direct user
gesture for permission; an ordinary Safari tab is not treated as subscribed.
See [WebKit's Home Screen requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
and [Apple's Web Push server requirements](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers),
checked 2026-11-15. This implementation uses feature detection, a stable manifest
id/standalone display and the ordinary Share-menu installation path. It does not
require experimental install APIs or an Apple Developer Program subscription.

Not covered by this push: an app that has quit or cannot run its timers sends
nothing, the subscription does not survive an app restart, and it ends when the
paired device expires (twelve hours after pairing). None of these raises an
alert on the phone. After a lost service has been reported, the push is off
until the phone is paired and subscribed again.

## Verification boundary

Unit/integration checks decrypt the real encrypted request at an owned loopback
TLS receiver, test malformed endpoints, count equality, origin/CSRF/grant checks,
revocation/re-pair/disconnect, delayed responses, expired subscriptions, JWT reuse
and fixed notification clicks. They also check that only listed alert codes
leave, that a lost service is said once without a count and the push then ends,
that an alert is said once, again for a newer case and cleared once, that an
unreadable source keeps what was said and is never reported as cleared, that an
unreadable count holds back only itself, and the worker's fixed titles.
Browser checks use the actual HTTP handlers and
service worker, with the permission/subscription APIs replaced by synthetic
objects before interaction. They never contact a real push service. Neither an
actual iPhone/Safari notification, APNs/FCM/Firefox delivery, real Tailscale
forwarding nor physical-device revocation has been qualified here.
