# Publishing without private data

As of 2026-10-17. These controls protect this repository's publication workflow;
they do not establish the future application's runtime privacy or legal compliance.

## Setup once per clone

Install Python 3 and gitleaks (verified with gitleaks 8.30.1). Create a UTF-8 file
outside the repository containing your private matching rules, one Python regular
expression per line. Blank lines and lines beginning with `#` are ignored. Include
identifiers that a generic scanner cannot infer: your private account identifiers,
personal addresses, financial context, internal projects, and customer identifiers.
Do not put the actual examples, rule values, or local path in a public issue.

```sh
python3 scripts/privacy_guard.py install /path/outside-repo/private-patterns.txt
```

The installer sets this clone's `core.hooksPath` and `privacyGuard.privatePatternsFile`
in local Git configuration. It does not modify global Git or agent settings and
refuses to overwrite an existing, different hook setup. The private rules must be
nonempty, valid, and outside the repository. They are not copied into Git.

Configure your public Git author identity, preferably a GitHub noreply address.
Personal email addresses are blocked; public contact exceptions need a specific
review before any rule change. Contributors retain their names/copyright choices.

## Before each publication

Review the diff and staged filenames first. Then run:

```sh
python3 scripts/privacy_guard.py staged
python3 scripts/privacy_guard.py message /path/outside-repo/proposed-message.txt
```

Read the result before committing. `pre-commit` rescans the actual index, including
partially staged files. `commit-msg` checks the actual message and author/committer
identity. A commit scan is not sufficient evidence for a later push.

Before pushing, run and review:

```sh
python3 scripts/privacy_guard.py history
```

`pre-push` then uses the actual ref updates supplied by Git. For each non-deletion
update it checks its complete reachable history, including every commit's tree,
patch, separate message and identity, annotated-tag text and tagger, and ref names.
This deliberately covers more than the final diff: added-then-deleted material and
merge resolutions must not disappear from the check. No cached remote tracking
ref or last-N-commits shortcut decides what is safe. Incomplete shallow history
is blocked. Git replacement objects do not hide the original history from scans.

The checks combine private rules, generic identity/financial patterns, and
gitleaks' standard rules. Missing tools, invalid rules, command failures, timeouts,
and unreadable content block the operation. Matched values are not echoed.
Repository gitleaks ignore files, configuration, and inline allow comments cannot
silently turn off this guard's secret scan.

At this preparation stage, database/export/log files, credentials, screenshots,
archives, external symlinks, submodules, and non-UTF-8/binary content are blocked.
The current finite limits are 2 MiB per scanned item and 128 MiB per scan;
exceeding either blocks rather than skips. On 2026-10-24, complete history reached
67,690,301 bytes across 110 commits and 1,860 unique blobs, exceeding the old
64 MiB total. The reviewed increase changes only that aggregate bound; every
ref, tree, historical patch, message, identity and secret check remains required.
Tests beyond the old bound cover clean input and late private/secret matches;
the new total bound, per-item bound and tool error/timeout remain fail-closed.
A future asset or larger repository requires another reviewed handling decision,
not an unbounded scan, skipped history or publication bypass.

## What these checks cannot establish

Patterns cannot recognize every private sentence, novel secret, encoded financial
record, or context-specific identity. Manual review and using synthetic data are
still required. Never print a real secret while diagnosing a match. Correct the
content or unpublished history and rescan; do not disable the guard to publish it.

Local Git hooks are user-controlled and can be disabled; they are not a security
boundary against a malicious local process. A fresh clone needs setup. GitHub's
web UI, APIs, issues, PR text, releases, attachments, and external services do not
pass through these hooks. Review and scan the exact content before those uploads
too. A CI check runs after upload and cannot undo a privacy leak.

GitHub secret scanning and push protection are enabled for this repository as of
the date above. They detect supported secret patterns, not arbitrary personal or
financial information. See [GitHub's push-protection documentation](https://docs.github.com/en/code-security/concepts/secret-security/push-protection).

If data already escaped: stop publication, revoke exposed credentials, limit access
where possible, and follow [security reporting](../SECURITY.md). Deleting a file or
rewriting Git history does not guarantee removal from clones, caches, or forks.

## Verify the mechanism

```sh
python3 -m unittest discover -s tests -v
```

These tests run real Git commands against disposable local repositories and bare
remotes. They generate only synthetic data, make no network pushes, and exercise
both blocked publication and a successful clean commit/push. Hook bypasses inside
tests simulate preexisting unsafe history only; they are not a production workflow.
