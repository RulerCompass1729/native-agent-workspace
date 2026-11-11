# B4 finite native transport trial

The person approved one native turn, at most two inference requests and at most
USD 1 on 2026-11-10. The separate daily reminder choice is USD 2 per UTC day;
this script does not set that role configuration or activate B4.

## Why this trial has a local gate

The real Codex 0.167.1 binary did not serialize `max_output_tokens` when candidate
config/RPC overrides requested 1024. Its captured local request had no output
limit. A prompt asking for a short answer cannot supply that missing limit.

`scripts/test-butler-native-trial.cjs` therefore runs the native app-server
against a one-purpose local gateway. This is a guarded protocol experiment,
not evidence that the production driver already has these boundaries. Default
execution uses fixed local responses and incurs no inference charge:

```sh
node --test app/tests/butler-trial-gateway.test.cjs
node scripts/test-butler-native-trial.cjs
```

The dated live flag must not be run until independent review covers this exact
version, and the person separately approves the credential relay described below.
The extra `--allow-native-auth-relay` flag records that approval; it must not be
added by the author without that answer. It has a durable exclusive claim under
the lane's private evidence, anchored to the script rather than the caller's cwd;
an existing claim forbids another invocation. There is no automatic paid retry.
Recheck rates before allowing execution on a different UTC day.

## Enforced and measured boundaries

- One controlled native home, retained synthetic thread and turn. The existing
  name-only profile preflight checks the selected Pro profile/provider/env name.
  Only a Boolean environment credential-presence observation is made by the
  harness. Codex inherits its environment key and constructs an Authorization
  header. It sends that header over loopback HTTP to our gateway, which then
  sends the opaque header bytes to DeepSeek over verified TLS. This is an
  additional credential relay, not native-only authentication; permission for
  the finite model run alone does not authorize that change.
- The native process can reach only the randomly selected local gateway port;
  the existing OS policy and per-run probes deny other IP destinations, local
  proxies, resolver and keychain. The gateway has one literal, certificate-
  verified TLS destination: `api.deepseek.com:443`, `/responses`. No redirects,
  environment proxy, alternate provider or retry is implemented. Live execution
  refuses an inherited `NODE_EXTRA_CA_CERTS` variable.
- The gateway does not inspect the native Authorization value. It copies the
  existing header line as opaque bytes to that destination. It never reads a
  key from configuration/environment, decodes the value, formats it into a
  string, stores it in receipts or prints it. Upstream/header/error bodies and
  native stderr are not dumped. The test covers this path with synthetic auth
  through a real local TLS server, never a real credential. The native fixture
  also supplies a known synthetic env key and verifies the actual header path.
- The native registry must advertise exactly the fixed fixture function.
  Its one callback returns a constant string and has no execution/file/network
  effect. A different tool, thread, call ID, arguments or repeated callback is
  rejected. The live provider's first call must match that same function.
- No native input, instructions, history, filenames or client metadata are
  forwarded. The gateway constructs two fixed synthetic request bodies. Only
  the validated bounded call ID from the first response enters the second.
  The first request forces the fixture function; the second disables tools.
- Every outgoing request has service-side `max_output_tokens=1024`, including
  reasoning; reasoning is disabled for this smallest compatibility check.
  There are at most two reserved upstream attempts and no overlapping attempt.
  The total transmitted synthetic JSON is capped at 1600 ASCII bytes. The
  actual fixed bodies with a maximum-length call ID total 1178 bytes; the
  official offline V4 tokenizer counts 297 tokens for their complete serialized
  JSON. That is a local sizing check, not the provider's internal chat framing.
- A 2000-total-input-token reserve and two 1024-token outputs would give a
  peak-rate token estimate of USD 0.01075008 using the dated official tariff.
  That reserve is not a pre-spend limit: provider-side framing is unknown.
  Documented output limits and bounded synthetic input support the USD 1 trial
  allowance; USD 0.01075008 is not a cap or guaranteed bill. The provider's actual
  usage must still be checked; an unexpected amount,
  cache count, output/input overrun or server tool stops the trial. The gateway
  cannot set a separate account-level billing cap or certify a provider invoice.
  Do not represent the local tokenizer count as exact billed input.
- The trial stops at 120 seconds; an upstream attempt also has a 45-second idle
  timeout. Owned listeners and native children close after success or failure.
  It never stops the person's existing native process or daily application.

## Evidence and limits

Receipts record reserved attempts before opening the inference socket, completed
TLS request writes separately, the exact fixture callback, provider usage and
terminal outcome. A single completed, incomplete or failed final event first
saves reported integer usage fields (unknown fields stay null), before model,
usage-limit and completion checks. Thus truncated or over-limit responses retain
known usage even when the trial stops. Costs computed from the peak tariff are labelled estimates;
no native monetary amount or account bill is invented. A failure without usage
remains unknown. A sent request is not automatically a completed response.

The retained native thread and receipts live only in the lane's private evidence.
They contain synthetic business content; no real task or daily workspace is
attached. This is not an installed-GUI acceptance, a native TUI human-input
test, production B4 activation or a working-day recording trial. The core's
tool/context/provider/S2 qualification flags are unchanged.

The B4 owner still needs production context/tool/outbound controls and reliable
native accounting before activation. The approved USD 2/UTC reminder belongs
in that owner’s person-authorized configuration; recording the decision on a
board does not prove the runtime has adopted it.
