# Background application control

`native_workspace.workspace_control` operates the running NAW application through
the same command handlers as its desktop interface. It does not move the desktop
pointer, activate a window, or require NAW to be the foreground application.
The existing foreground interface is retained.

Each original native agent has its own hidden view, selection, recoverable drafts
and clipboard. Shared changes, including messages and names, remain visible in
the normal interface. The agent's history records who requested each operation,
its exact arguments, result and any confirmed native receipt. Message rows retain
agent provenance in both the recipient conversation and shared space.

Call `{"action":"catalog"}` for command names and ordered parameters, then
`{"action":"snapshot"}` for current session, native and turn identities.
To execute a command, supply `action: "invoke"`, `method`, an `arguments` array,
and a unique `operation_id`. For example, `forward` takes the recipient's local
session ID, the exact message, and its current native ID. `spaceAction` addresses
a particular collaboration space. `queueShared` and `steerShared` use the
recipient's existing busy-input path; they do not pretend the session is idle.

Keep the same operation ID when inspecting an uncertain result. Use
`{"action":"receipt","operation_id":"the-original-id"}`. Repeating an
invocation with that same ID returns its saved result without executing again;
changing its arguments is rejected. Do not generate another ID to retry an
uncertain send. `awaiting-native` is not a native delivery receipt. Only a real
receipt from the bound recipient makes the operation `received`; this does not
claim that the recipient has started or completed its task.

Every operation record is kept (the person, 2026-11-11: keep everything, split
into small blocks, for example by day). `background-operations.json` holds what
is still current: operations that ended within the last day or are still
pending, views, refusal summaries. Once an operation has ended more than a day
ago with nothing pending (no unread copy), it moves to the day's block under
`history/operations/` (the shared layout in `app/record-history.cjs`), which is
only added to; a later change, such as a send confirmed on a later receipt, adds
the record again and the later line holds (a receipt that changes nothing adds
nothing). The state file records how far the blocks go; a history folder moved
away or shortened stops background control instead of reading as empty. All records stay loaded, so receipts,
a repeated operation ID and the conversation rows behave as before. A block that
cannot be read stops background control rather than risk running an operation ID
again. The state file is version 2. An older version refuses it, and its
background control is then unavailable while the app runs, instead of starting
empty. An older version's file is kept as `legacy-NNNN.json` beside the blocks
when it is taken in; an operation ID it shares with the blocks keeps the record
written first. Memory and start time grow with the whole record; the person is
reminded at 0.5 GiB.

File commands accept explicit absolute `paths` on the invocation instead of
opening a desktop picker. File and web links return validated material or a URL
without opening another application. `newWindow` returns an independent hidden
`view_id`. View layout changes affect that view. `interfaceSettings` discovers
and updates the existing Host's language and appearance settings, with its
current revision; those explicit application preference changes are shared.

Original native permission checks remain on the tool path. Existing destructive
confirmations appear as inline pending operations in the initiating conversation,
without a desktop modal. An agent cannot press its own confirmation. The human
decision rechecks the original agent and target identities before executing.
This interface grants no additional task authorization, changes no model or
budget, and never approves a native tool on the person's behalf.

The existing automatic-agent-message switches also apply to background input.
If the global switch or any addressed recipient is disabled, send, forward,
queue, steer, relay and terminal input are refused and recorded. This includes
commands inside a named space. Reading and independent drafts remain available;
human input retains its existing behavior. Native submission guards recheck the
switch before accepting input. Already accepted native work is retained.

The frontend and originating/target backends must carry `backgroundControlV1`.
An older running backend is refused for operations that require provenance or
draft isolation. Updating frontend files alone does not adopt this capability
into a retained native runtime or refresh its native MCP catalog. That adoption
belongs to the existing integration and native compatibility procedure; no CLI
or native task is silently restarted.

Startup-error recovery and human confirmation IPC are not agent commands.
External applications remain outside this interface. The source acceptance uses
the real hidden Electron application, daemon, stdio MCP and original-runtime
proof path with explicitly synthetic native events and no model calls. It does
not qualify an installed original Claude/Codex producer or prove that every
catalog command has been exercised against that producer.
