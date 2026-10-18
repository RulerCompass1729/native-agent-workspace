# Native continuity experiment

As of 2026-10-17. This is a diagnostic, not a desktop app or a collaboration
implementation. The first [result](../../docs/native-continuity.md) covers an
idle Codex thread. Claude Teams, active Codex fleets, approvals, and room
membership have **not** passed this experiment.

## What the probe does

`probe_codex.py` connects two JSON-RPC clients to a user-selected local Codex
app-server. It checks that the selected thread is already loaded and idle,
subscribes the second client, disconnects that client, and checks identity and
loaded state again. It prints booleans and method counts, not transcripts,
account data, paths, native IDs, or raw upstream errors.

Its request allowlist excludes thread creation, model turns, tool execution,
approval responses, and server shutdown. It does not read native credentials.
It does not send telemetry or upload reports. The native server retains its own
configuration and network behavior; this diagnostic is not a network sandbox.

Keep the original native owner connected throughout the check. Loaded-state
checks and `thread/resume` are not atomic, so a concurrent unload can invalidate
the result. Only test a synthetic, idle session. Do not use this diagnostic to
move a real active task or to establish exclusive input ownership.

## Run

Requirements: macOS or Linux, Python 3.10+, a separately installed native Codex,
and `websockets==16.0`. The runtime check used Codex 0.163.0 on macOS. Other
versions and Linux are unverified; the native app-server interface is experimental.

Install the experiment dependency into a virtual environment of your choosing:

```sh
python -m pip install -r experiments/native-continuity/requirements.txt
```

If you do not already have a dedicated test server, create one in a private
socket directory. This uses native authentication and disables analytics for
this invocation; it does not edit global settings:

```sh
NATIVE_PROBE_SOCKET_DIR=$(mktemp -d /tmp/native-probe.XXXXXX)
chmod 700 "$NATIVE_PROBE_SOCKET_DIR"
codex -c analytics.enabled=false app-server --listen "unix://$NATIVE_PROBE_SOCKET_DIR/app.sock"
```

In a separate terminal, connect the native TUI using that socket's actual path:

```sh
codex --remote unix:///path/to/private-directory/app.sock
```

Use a synthetic workspace and complete one small native task before testing.
This task uses your native model quota. A freshly created empty thread failed
to resume in our tested version despite appearing in `thread/loaded/list`.
Use the native TUI's `/status` to obtain the selected thread's session ID and
keep that TUI open. Do not use a fork's session-tree root in place of its thread
ID. Then run:

```sh
python experiments/native-continuity/probe_codex.py \
  --socket /path/to/private-directory/app.sock \
  --thread THREAD_UUID
```

Exit 0 means **only the reported idle metadata checks passed**. Exit 1 means
not passed; it never silently falls back to a new or cold-resumed session.
The output is not evidence of live fleet preservation, zero total provider
billing, latency parity, or a functioning GUI. Inspect native terminals and
runtime evidence separately for those requirements.

The probe leaves the server and original session alone. When finished with a
dedicated test server, exit its native test TUIs and stop that specific server.
Do not stop a shared daemon that may host other work. Native test conversation
records remain under native retention controls.

## Dependency and publication boundaries

`websockets` 16.0 is experiment tooling under BSD-3-Clause, copyright Aymeric
Augustin and contributors. Its installed license was inspected; upstream
[license](https://github.com/python-websockets/websockets/blob/16.0/LICENSE) and
[client documentation](https://websockets.readthedocs.io/en/stable/reference/asyncio/client.html)
describe the package and Unix socket API. No package source or binary is
vendored here. Redistribution in a future app must retain its applicable
license notices. The probe itself is original project code under Apache-2.0.

Keep raw native responses, terminal captures, session IDs, account state,
private socket paths, and credentials outside Git. Only reviewed, sanitized
results belong in the public repository.
