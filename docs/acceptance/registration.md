# Small native collaboration task: weekend registration

This is a synthetic acceptance scenario. Scoped results are recorded below;
they do not certify every collaboration or fleet lifecycle.
Run against the installed app in a separate private test profile. Keep raw native
history, recordings and logs outside Git. The native runtimes and ordinary
permission prompts remain in use; a synthetic model transport is a different test.

## Input

Create `registrations.csv` in an empty test work directory:

```csv
id,time,people,status
A,09:00,2,confirmed
B,09:05,1,confirmed
A,09:10,2,confirmed
C,09:15,3,cancelled
D,09:20,4,confirmed
E,09:25,2,confirmed
F,09:30,1,confirmed
```

Create `rules.md`: capacity is eight people; exclude cancelled rows; keep only
the earliest row for each ID; process remaining groups by time. Admit a whole
group if it fits, otherwise waitlist that group and continue to later groups.
Do not split groups. No external information is needed.

Create `draft.md`, deliberately wrong: “Admit A, B, D, E, nine people. Waitlist F.
The second A row is a separate registration.”

## Actual user journey

1. In a solo Claude conversation, ask it to inspect these three files. Use one
   native in-process teammate, on the same cheap model, for the duplicate and
   cancellation rules. Require an actual shared task, teammate assignment,
   completion and a teammate-to-lead message. Keep the team idle for a later
   shutdown request. The lead gives a short preliminary result.
2. Drag Claude and Codex into the room, rename it, save a short shared note and
   use `@` to ask Codex for an independent check of the input and preliminary
   result. Do not send the entire private conversation. Inspect each provider's
   native progress from the same interface.
3. Preview and send Codex's finding to Claude. Ask for `final.md`, then request
   the existing teammate's native shutdown. Verify actual native acknowledgement;
   do not infer shutdown from the lead's reply or a tool accepting the request.
4. Detach Claude and ask for a short announcement from the retained result.
   Confirm that this private continuation is not appended to the room. Archive
   and restore the room/session; close and reopen the UI with an unsent Chinese
   draft. Preserve native identity, existing processes, shared notes and records,
   with no prompt replay.

While the teammate exists, switch GUI/TUI, join/leave the room and reopen the UI.
This is live-process continuity, not reconstruction after killing the native
process. Do not count in-process team cold resume as passing.

## Independent result oracle

The accepted IDs, in order, are **A, B, D, F**: `2 + 1 + 4 + 1 = 8` people.
**E** is waitlisted. The later A row is a duplicate; C is cancelled. E must not
block the later one-person F group. Check the actual file and answers against
these facts, independently of what either model claims.

## Budget and completion

- Four human top-level submissions: Claude setup, Codex review, Claude final,
  detached Claude continuation. One Claude teammate; no Codex child is needed.
- Verify selected cheap models before submission. No automatic retry or costly
  fallback. Internal native tool/message turns are additional usage and must be
  reported separately; four submissions is not four model calls or a cost cap.
- End a stuck trial, preserve evidence and fix the demonstrated problem. Do not
  rerun paid work merely to increase the test count. Reuse unaffected evidence.
- Record result correctness, task/message/team lifecycle, native identities,
  GUI/TUI input and progress, membership, sharing boundaries, recovery and errors
  separately. A correct final list does not imply a passing product journey.
- Independent review reads the actual evidence. List unverified surfaces such
  as physical OS input, machine crash and broad version compatibility explicitly.

## Observed run — 2026-10-20

The installed alpha.42 app ran this task using actual Claude Code 2.1.305
(Haiku 5.5 for both lead and teammate) and Codex 0.163.0 (Luna), with normal
native permission handling. The final file independently matches the oracle.
The named child is recorded natively as an `in_process_teammate`, with a shared
task, ownership/status changes, messages and an approved shutdown request.
This is native Agent Teams evidence, not an ordinary subagent mock.

| Surface | Observed result | Scope |
| --- | --- | --- |
| Native task/list/assignment/message | Actual tool results and teammate metadata confirm the workflow | One teammate; no claim about all Teams configurations |
| Independent check and final artifact | Codex and the written final file match A/B/D/F, eight people | Synthetic local registration task |
| Drag, naming, notes and explicit sharing | Actual pointer/UI actions preserve native identity and show the chosen recipient/preview | Shared notes are local until explicitly sent |
| UI reopen with a team | Lead identity/process, idle teammate, messages and Chinese draft retained; teammate later receives shutdown | Teammate was already idle at reopen; no active-inference or cold-team reconstruction claim |
| Native file permission | Actual native prompt, one-time approval, correct file written | No permission bypass or blanket approval |
| Reply after native permission intervention | Conservatively retained as private; marked `reply-private` | Automatic return to room did **not** pass this path; person must explicitly share the result |
| Detach and continue privately | Same Claude identity retains context and drafts a short announcement | Private continuation does not enter room records |
| Archive/restore/reopen | Room messages, notes, names, drafts and native IDs retained | No additional task submission |
| Codex display retry | A dead cached terminal was reproduced; alpha.43 repair is documented in testing.md | Zero-model regression and actual installed native retry passed; same thread/server, no replay |

The budget was exactly **four human submissions and one teammate**. Native
transcripts contain 12 unique lead assistant responses and eight teammate
responses, including tool/message cycles; Codex completed one user turn with
tool activity. Four submissions must not be reported as four model calls or an
exact bill. No additional model task is authorized by the regression checks.

The initial test wrapper incorrectly applied server permission flags to the
remote TUI. Correcting that fixture exposed the product's cached-dead-display
bug; the initial failed launches are not passes. A separate initial test-profile
permission failure was corrected before any model submission.

Local evidence includes complete task transcripts, app state snapshots, actual
file contents, screenshots, observed native protocol and timestamped app frames.
The recording covers the first part of the task, not the entire four-submission
journey. Raw evidence stays private. Physical keyboard/IME, a machine crash,
full fleet termination/reconstruction and cross-version coverage are unverified
by this task. The existing core baseline remains separately scoped.
