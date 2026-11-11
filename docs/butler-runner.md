# Dormant legacy butler service dependency

The current execution target is a designated DSH butler instance. This document
records the earlier dormant native service dependency, not the production target.
Its existing factory explicitly supplies the former profile/provider/model names;
the shared backend no longer defaults to them. A new DSH factory must pass its
actual `configuration: { profile, provider, model }`, keep its own exact persistent
instance proof and reject foreign/unknown stores. Do not relabel a Codex process
as DSH or reuse its liveness claim. Role and rotation authorization now require the
actual designated DSH record, with the same IDs, binding and revision checks.
The core `run(input, expected)` return envelope is unchanged.

This checkpoint provides the dedicated service driver for the dormant
[butler core](butler-core.md). It does not activate the butler or qualify native
DeepSeek inference, tool restrictions, automatic context or S2. Ordinary
services and the daily application keep their existing backend selection.

`new ButlerServiceDriver(directory, { executablePath })` implements the core's
`recover(binding)` and `start(binding)` contract. Pass the same directory used
by `ButlerBackend`; the driver owns only its reserved `store` child. The
`credentialPresent` export is a name-only precheck suitable for the core's
Boolean callback. All four qualification flags still default to false.
Only a trusted host may supply qualification evidence; a successful precheck or
initialize response is not such evidence.

The desktop now constructs that pairing through `createDedicatedBackend` in the
desktop-only `butler-backend-host.cjs`, using its private `butler-native` child directory and
current application version/executable. Construction makes no provider call,
configuration/presence check, store preparation or native launch. Event intake
retains its existing single ledger owner; no controller is constructed. Even an
explicit later `ensure()` remains blocked by the four false qualification
defaults; the factory does not accept qualification flags from its options.
This is dormant host composition, not a running thread or an enabled trial.

The service manifest retains the exact core binding, including purpose,
profile, provider, model, runtime version, backend/runner references and start
nonce. The ordinary layout never registers this store. Both ordinary connection
and bootstrap reject a dedicated service before pausing, upgrading or reusing
it, even at the same version. Dedicated bootstrap checks the binding against the current
application version rather than relabeling the spawned code, and never upgrades
an existing daemon. Unknown daemon/native liveness, changed identities and occupied
unreserved stores stop recovery instead of allocating another runner.

The existing service bootstrap copies the private runtime and starts a daemon.
That daemon passes its binding into NativeHost. Its only accepted RPCs in this
checkpoint are initial state, guarded runner initialization and shutdown; normal
session creation and message/execution RPCs are disabled. The runner initialization
starts no thread and sends no model turn. It registers none of NAW's ordinary
workspace/computer/outbox MCP tools. Native/global tools and context are **not**
qualified or claimed disabled; that is a remaining activation gate.

Before native launch and on recovery, a narrow helper checks these non-secret
configuration names: profile `deepseek-pro`, model `deepseek-v4-pro`, provider
`deepseek`, and provider credential environment name `DEEPSEEK_API_KEY`.
`spawnRunner` also requires its supplied binding to match that exact three-name
configuration before its own Python discovery, environment or child spawn. Other names
fail rather than being recorded for a process that still uses fixed arguments.
This guard belongs to the legacy runner; a DSH driver must check its own actual
configuration instead of inheriting these legacy model pins.
The profile must explicitly declare model and provider; its provider environment
name may inherit from the base configuration. Missing, mismatched, duplicate or
unsupported metadata blocks launch. The checker supports canonical simple TOML
name declarations and ignores unrelated tables; multiline string layouts and
quoted provider table names, dotted provider declarations and provider inline
tables remain unsupported and fail closed. It never
rewrites the person's configuration.

A second check runs in the child immediately before exec, retaining that
process's environment and PID. Its private pipe returns only presence and fixed
status fields. No credential value is printed, logged, hashed, measured or
placed in command arguments. Codex receives the named profile and explicit
model/provider/environment-name overrides, so a later configuration-layer
default cannot select another model. Native/provider compatibility still needs
separate evidence.

A launch marker is persisted before spawning. After initialization it records
the native process birth identity. If the daemon disappears between spawn and
confirmation, recovery remains unknown; this checkpoint has no automatic repair
for that ambiguous marker. A failed preflight starts no native child. A failure
after the launch marker, or a stale connection record without confirmed
liveness, may require an explicit recovery procedure in a later checkpoint.
Do not clear these records merely to retry.

Source verification uses real isolated daemon/NativeHost connections with a
synthetic local Codex executable. It covers cold boot, same-runner recovery,
ordinary same-version isolation, missing credentials/profile, provider/model
mismatch, changed binding, unknown prior launches and live orphan protection.
The fixture makes no provider request and cannot certify Responses streaming,
authentication, tool calls, usage accounting or installed daily operation.
