# Demo readiness and milestones

As of 2026-10-17. Current phase: **local macOS source demo**, with DSH as the UI
foundation. The maintainer authorized implementation and real use, then explicitly
limited Claude/Codex tests to important unresolved native behavior.

| Milestone | Status and evidence |
| --- | --- |
| Product boundaries and public repository | Done: session/room/view distinction, Apache-2.0 original work, source register and publication guard |
| Single native session with GUI/TUI views | Local demo: both providers have real replies through both surfaces; native trust/login remains native |
| UI reopen without re-login/session replacement | Normal exit, crash recovery and loading-window exit checked with live native sessions; view/draft/identity retained while the service remains alive |
| Intentional multi-window, no accidental duplicate app | Same-profile lock, one DSH UI host, exclusive test launcher and owned-process cleanup checked |
| Two agents and human-directed collaboration | Join/leave and explicit sharing implemented; real three-reply check stopped at its limit; local control/race checks passed |
| Native fleets | Claude single teammate/shared task/messages observed; idle team retained across room changes/UI reopen without a new model prompt. Active Codex fleet and full failure/termination semantics remain unverified |
| Daily-use release | Not ready: installer/update/reboot recovery, complete input/accessibility, privacy/network and native compatibility coverage still required |

See [demo instructions and exact limits](../demo.md), [test policy](testing.md), and
the historical [first continuity result](native-continuity.md). Do not turn a
successful root reply into a claim that all descendants finished or stopped.

## What can be tried now

Run `npm ci` then `npm start`. Use one session, switch conversation/native terminal,
invite another session, explicitly share a task, and detach either session without
replacing it. Native providers must already be installed and authenticated through
their own mechanisms. No provider binaries are distributed by this repository.

The frontend reuses DSH's Web composition and UI components; the separate native
service deliberately outlives its windows. Updating frontend source does not
silently replace a live backend. Machine reboot and service loss are outside the
current continuity guarantee.

## Next milestone

Use this demo for normal single-session work and fix concrete feedback. Before
publishing an app download, close the actual distribution/license, privacy,
recovery and accessibility gaps. Retest native integrations only when a relevant
change or observed failure justifies the model usage. More providers and cloud
features wait until the two-provider experience is usable.

Every commit/push still requires proactive secret/PII scans and review, including
outgoing history, author identities and commit messages. Raw test evidence stays
local. The guard and written privacy requirements are not a global compliance
certification. See [publication](publication.md) and [privacy](privacy.md).
