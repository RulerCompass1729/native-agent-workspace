# Project manager replaces the queue secretary in CLAUDE.md (2026-11-25)

Branch `lane/claude-pm-rules-306-20261125`, base `b6a4fe81` (alpha.305 locked
head). Documentation only: `CLAUDE.md`.

- `0a7510d7` ports the earlier rule patch onto the CLAUDE.md that `4185a3cc`
  split. Words are those of the earlier patch except line wraps, "a task board"
  (the wording of the new base) and two sentences whose text now lives in the
  maintainer overlay.
- `b3cb34e2` is a stricter wording on top. It restores three limits the earlier
  patch had dropped from the secretary's paragraph (the product V12 cost and
  consent conditions, asking before adding, not routing another agent's new
  work), bounds "steps" to what finishes work the person gave the space, and
  limits the manager arranged by default to spaces the person creates.

The person's recorded answer: changing the rule is fine; the secretary becomes
the project manager of a space, and a manager adds to its own space's queue
only the work the person gave it and its steps. A choice between the two
wordings is left to the designated butler or the person.

## Independent review

A separate headless read-only Claude session (Read, Grep, Glob; no MCP), told to
check whether anything is looser than the recorded answer.

- `0a7510d7`: CHANGES REQUIRED. The port is faithful, but the earlier patch
  itself dropped the V12 conditions and "Do not route new work from another
  agent" (both blocking), left "steps" unbounded, and said "a new space" where
  only spaces the person creates get a manager.
- `b3cb34e2`: PASS. All four closed; every change restores or narrows.

Conditions and open points from the review:

- Merge with the project manager code or after it, never before.
- `docs/product.md` V12 and the manager arranged by default are not reconciled;
  left to the feature's own lane and the person.
- The rule does not list the transitional exceptions (a session still on an
  older backend, messages queued before the role was set). They add no
  authority to any agent.

## Checks

`queue-monitor-events` and `docs-size` tests: 23/23 on both commits. The overlay
change is prepared as a diff outside the repository and is not applied.
