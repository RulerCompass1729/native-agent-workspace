# Bringing an outside session into the workspace

Contract and implementation record as of 2026-10-20. Alpha.49 implements the
selected stopped Codex history path below; source and installed acceptance pass.
This is not general compatibility certification. Locally inspected versions: Claude Code 2.1.306 and Codex 0.163.0.
The assessment and protocol probe do not touch the person's outside sessions.
The probe uses a new synthetic record in two owned native servers; installed
acceptance explicitly resumes one previously completed, owned native test task.

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

## Alpha.49: stopped Codex history

The existing new-session dialog offers **继续已有 Codex 会话…**. Metadata
browsing happens only on request; an unnamed entry uses a bounded native preview,
without a title-generation call. Recovery uses only the explicitly selected
native ID. Check existing and archived records across every connected backend
before creating a local reference. Preserve the native configuration; do not
replace it with the new-session defaults. An active-writer rejection leaves its
source untouched, removes the unacquired local placeholder and retains the
selection and explanation in the picker. Once resume has succeeded,
history-loading or local-save failure must not trigger another resume, fork or
replayed task.

Source and installed interface checks cover selection/cancellation, writer conflict,
same-identity history, drafts, archive/reopen and recovery. Normal installed
bootstrap also restores exact real historical messages and the original model
without sending a new task; see [testing evidence](testing.md). The protocol probe's
single injected synthetic record is not complete-history acceptance. Its native
notifications included goal clearing, so preserving arbitrary goals or active
fleets is not claimed. The actual running server must report exactly 0.163.0 in its initialization
handshake before this path is enabled. A same-path CLI replacement cannot lend
its version to an older server. Unknown versions remain unavailable for outside
history; existing workspace sessions retain their existing behavior.

## Alpha.52: native clear within an existing Claude session

This is continuity of an app-managed terminal, not outside-history import.
Claude Code 2.1.306 keeps its process through `/clear` but changes the root UUID.
Its mod `session.start` does not repeat. The original mod observes
`session.end(reason=clear)` and verifies the new `classic.SessionStart` against
`$.session.id()`. A private root binding, rotated at each confirmed transition,
keeps child or retired identities from rebinding the parent. See the [official
hook lifecycle](https://code.claude.com/docs/en/hooks) and [native commands](https://code.claude.com/docs/en/interactive-mode).

The portal saves the old root reference and a history boundary before enabling
submission on the new root. It preserves the same row, terminal, local history
and drafts; prior messages are never replayed. Pending authorizations are revoked
and observed late private replies stay before their original boundary. Sequential
metadata processing covers rapid clears and lost acknowledgements. This exact
native contract is enabled only for 2.1.306; unverified transitions remain visible
in the native terminal with graphical submission closed. Native `/resume` still
requires separate identity and history synchronization proof.

## Later: connection to a running outside session

A further owned-history probe on 2.1.306 restored a previously completed Claude
test conversation with `/resume` in its original working directory. The native
root changed to that history's exact ID; `$.session.messages()` returned the
prior user text and assistant answer unchanged. The same command from a different
test directory reported no conversations. This proves one native recovery/read
path, not a general cross-directory picker or Portal import. That message API
returns at most the newest 4096 entries, without all temporary progress rows;
it cannot replace the live terminal or certify complete historical trajectories.
The portal keeps graphical submission guarded after this unimplemented native
transition. Writer exclusion, duplicate local references, full history hydration
and a usable entry flow must be resolved before enabling Claude outside history.

Live attachment needs separate proof that an observer can leave without stopping
its source, and that input ownership, unsent drafts, approvals and live events
remain coherent between native and graphical views. Historical resume, live
connection and a read-only reference must be named separately. Missing proof
does not permit silently forking or copying context. Existing app-managed
sessions retain their current join, detach and recovery paths.

The history browser uses the native state index with bounded pagination. It does
not crawl history files or repair a missing native index. Native archived history
is not included yet; locally archived workspace records are deduplicated and
remain available through the existing archive view. One local reference is saved
before resume; this follows the existing local-save behavior, not a guarantee
against power loss. Uncertain native acknowledgement or incomplete pagination
keeps that reference without automatic retry, fork or task replay.
