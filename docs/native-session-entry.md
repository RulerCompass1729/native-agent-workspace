# Bringing an outside session into the workspace

Contract assessment as of 2026-10-20, not an implemented feature or compatibility
certification. Locally inspected versions: Claude Code 2.1.306 and Codex 0.163.0.
No outside user session was resumed or attached during this assessment. A later
protocol probe used one newly created synthetic record in two owned native servers.

## Available native entry points

Codex exposes metadata/history reading separately from resume. Its generated
`ThreadResumeParams` schema says an already-running thread ID rejoins that thread
in the connected app-server. `thread/loaded/list` describes that server's loaded
threads; it is not evidence of global exclusion across other servers. Creating a
fork changes identity. See the [official protocol](https://learn.chatgpt.com/docs/app-server).

Claude now provides `agents --json` for interactive/background session status and
`attach` for background sessions. Detaching a display does not stop that session.
An attachment may restore a stopped background process, so it cannot always
promise the same PID. The short background ID and full conversation UUID are
different identifiers. See [agent view](https://code.claude.com/docs/en/agent-view)
and the [CLI reference](https://code.claude.com/docs/en/cli-reference).

## Native writer exclusion observed

A zero-inference Codex 0.163.0 probe created one synthetic record, without a
`turn/start`. A second independent server reported that record as `notLoaded`
but rejected `thread/resume` because it already had an active writer. After the
first server's confirmed exit, the second resumed the same ID. This supports a
stopped-history entry path for the tested version; it does not prove live TUI
attachment, GUI approval routing or all versions' behavior.

The initial probe wrongly required zero HTTP requests. It failed because native
model-catalog refreshes reached the probe's loopback endpoint, with no inference.
The corrected endpoint serves an empty catalog; the final probe passes with no
turn start or inference request. The raw record, scripts and logs stay private.

## Why these commands alone do not finish M5

Current `app/adapters.cjs` owns its Codex server and closes that child on shutdown.
Its Claude constructor installs hooks and a submission bridge when starting the
process. Reusing those lifecycle assumptions for an outside endpoint could stop
someone else's work; attaching a terminal does not establish that an already
running Claude process has this bridge.

The observed native writer exclusion does not establish Portal's exclusive live input control,
visibility of another terminal's unsent draft, approval ownership or complete
live event coverage. This is an integration proof still missing, not a claim
that the providers cannot support it. Versioned upstream Codex implementation
source could not be retrieved, so the exclusion result is scoped runtime evidence, not a source-level guarantee.

## Next acceptance task: stopped Codex history

Offer metadata browsing only on request, and resume only the explicitly selected
native ID. Check existing and archived records across every connected backend
before creating a local reference. Preserve the native configuration; do not
replace it with the new-session defaults. An active-writer rejection leaves its
source untouched and creates no writable copy. Once resume has succeeded,
history-loading or local-save failure must not trigger another resume, fork or
replayed task.

Verify selection/cancellation, writer conflict, same-identity history, drafts,
archive/reopen and recovery through the actual interface. The protocol probe's
single injected synthetic record is not complete-history acceptance. Its native
notifications included goal clearing, so preserving arbitrary goals or active
fleets is not claimed. Version compatibility must be checked before enabling
this path.

## Later: connection to a running outside session

Live attachment needs separate proof that an observer can leave without stopping
its source, and that input ownership, unsent drafts, approvals and live events
remain coherent between native and graphical views. Historical resume, live
connection and a read-only reference must be named separately. Missing proof
does not permit silently forking or copying context. Existing app-managed
sessions retain their current join, detach and recovery paths.
