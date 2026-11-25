# An agent's own notification is not the person stepping in

A Claude session that starts an agent in its turn, and whose agent ends in the same turn, gets a `<task-notification>` in that turn, with the turn's prompt id and no `source`. NAW knew such IDs only from a turn-end report, or, since 2026-11-12, from a Bash or Monitor `PostToolUse`. An agent is in neither: so the notification counted as the person typing. The control revision went up, automatic messages were withdrawn, relays paused, and the queue item was settled "you stepped in" with its complete reply. The 2026-11-12 record left this open ("Agent-tool background tasks were not seen … and are not recognised").

- `adapters.cjs`: `SubagentStart` under the root session names the agent (the same ID again when `SendMessage` resumes it).
- `workspace.cjs`: agent IDs are kept apart from Bash and Monitor IDs, with their own limit of 200: an agent that sends no notification keeps its ID, and must not push out a task that still runs. A notification uses up its ID in both. Everything else of the rule is as it was: only notification blocks, every block known, a `user` or `sdk` source is never machine input.

`SubagentStop` is not used: it is seen for IDs that never started (1,043 stops to 70 starts in one installation's records, counts only).

## Where it was seen
Counts, times, roles and tag names only, read from one daily installation: 43 agent notifications, 6 recognised (a turn end had reported them first), 37 counted as the person. For each of the 37, NAW had a `SubagentStart` of the same ID before it. All 43 had the same nine tags, status completed, and nothing outside the block.

## Checks
- Real Claude 2.1.332 on a loopback API, throwaway home and configuration (0 paid), with the real forwarder `claude_hook.py`: an agent started, then resumed with `SendMessage`. Both times `SubagentStart` comes under the root session, then `SubagentStop`, then the notification in the same prompt with no source; the turn-end report lists neither. Replayed through the real adapter and workspace: before, control 1 → 3 and two "human" wakes; after, 1 → 1 and none.
- `app/tests/workspace.test.cjs`, three new tests, all red on the earlier code: start, end, resume, failed and killed statuses, two in one prompt; a repeat without a new start, an unknown ID, a mixed prompt, another native session, IDs of another shape and a person typing still count; 500 agents do not push out a Bash task; a queue item through `planDispatch` is done after an agent's notification and still waits after the person types.
- 17 changes to the new lines, each caught. Tests that read these events: 1,542 of 1,542.

## Not done
- No real NAW window was run: the probe is the real client and forwarder, not the application.
- A Claude session started before this is installed is recognised only after its backend takes the new code.
- A person typing exactly the notification of an agent that started here is read as machine input, as for a Bash task.
- An agent result that itself prints `</task-notification>` still counts as the person.
- Moves: an item left unsettled across a backend move still compares a number that the new process starts at 0. Of seven such items seen, three were held only by a quiet window (fixed separately); the other four were this bug.

Independent review: pending.
