# Reviewed installer candidate

`scripts/install-daily.cjs` is a parameter-only update operator. It has no default
application or data directory. It is not a replacement authorization for an
already approved version-specific installer. Existing pinned operators and their
approval files stay unchanged. A new daily use needs its own reviewed approval.

The operator retains backend/native process, session, model/settings, flushed UI
and native draft checks. It does not stop native sessions, restore their stores,
change automatic backend switching, or deliberately restart services. Ordinary
application startup remains responsible for eligible ended-session backends.

## Failure policy

| Failure point | Terminal result | Action |
| --- | --- | --- |
| Before asking the old GUI to quit | `unchanged` | No app replacement or quit. |
| After quit, before attempting the new launch | `rolled-back` only after verification | Restore the old bundle and byte-for-byte original `installation.json` (or its original absence); launch old app and verify one fully launched GUI and retained backend/session/settings/drafts. |
| Old relaunch or its verification fails | `recovery-required` | Record both the original and recovery failure; do not claim reopening succeeded. |
| New launch attempted, including an `open` error or subsequent GUI/backend/session verification failure | `recovery-required` | Preserve new bundle, receipt and stores. No automatic downgrade or store overwrite. |
| All checks pass | `installed` | Keep rollback archive, remove the archived launchable old copy. |

A real isolated old→new→old bootstrap showed that the old service read a draft
written by the newer service; the backup did not restore itself. This is evidence
of new writes surviving, not proof of general backward compatibility. Restoring
a pre-update backup would lose that newer draft. This is why the exposure boundary
is set and journaled **before** calling LaunchServices, even when launch throws.

On a post-launch failure, the integrator must preserve the report, receipt, stores
and partial pre-start backups, inspect actual backend identities and new writes,
and obtain approval for a compatible recovery. The operator never automatically
opens the old archive. `restartBackups` contains only the workspace and room-record
files of eligible backends, not a complete transactional store backup.

Every caught JavaScript exception or terminal result writes a private `result.json`: phase, primary/recovery
errors, whether new code could have run, observed bundle/GUI/receipt state, and
recovery instructions. `rolled-back` is still a failed update (nonzero exit).
The private journal is updated before changing phases. Result records include the
original receipt hash/absence, confirmed receipt restoration, and a separate
verification-passed marker when only old-bundle cleanup failed. A process kill, power loss
or unwritable filesystem cannot promise a final receipt: inspect the journal;
a result-write error is reported to stderr and is never treated as success.

The displaced bundle is inventoried (paths, bytes and file hashes), archived and
checked with `unzip -t` before removing that exact copy. A targeted `lsof` check
before archiving and again before removal refuses a bundle still in use, including
a mapped backend executable, or one whose use cannot be determined. If archive/removal fails,
the report explicitly flags the remaining launchable backup; it does not hide it
or claim a clean success. Original input candidates are not swept away. Existing
GUI test leases are never stolen. All evidence may contain private paths/session
identifiers and belongs outside Git.

## Preparing an approval

Prepare a fresh private result parent and a clean committed release tree. The JSON
approval has `format: 1`, `applyAllowed` (false until actual authorization), absolute
`app`, `candidate`, `data`, `release`, `slot`, `resultDir`; `oldVersion`, `newVersion`,
`commit`, `bundleId`, and `executableName`. `resultDir` must not already exist when
invoking the CLI. App, candidate, data and result locations must not overlap.

Pin these fields after review:

- `operatorSha256`: this installer file.
- `code.platform` and `code.inspector`: `{path, sha256}` for `install-platform.cjs`
  and `install-runtime.cjs`. Any additional code pins are checked too.
- `swift`: `{path, sha256}` for `install-apps.swift`; rechecked before each use.
- `coldLaunch`: `{path, sha256}` for the reviewed cold-launch result. Its `pass`
  must be true and its `commit`/`cdhash` must match the approved new build.
- `archive` and `previousArchive`: `{path, sha256}` for the approved distributions.
- `newSignature` and `oldSignature`: each `{cdhash, requirement}`, the actual
  designated requirement (not the diagnostic `Executable=` line). Both builds
  must match their separately approved values, bundle identifier and executable;
  the new bundle also matches the source revision and version.

Obtain an independent SHA-256 of the **whole final approval file**, including its
paths, flags and pins. Supply that hash out of band on the command line; a hash
stored inside the same editable approval does not establish approval. Changing
`applyAllowed` therefore requires a new externally confirmed hash.

```sh
node scripts/install-daily.cjs --approval "$APPROVAL" \
  --approval-sha256 "$APPROVAL_SHA256" --result-dir "$RESULT_DIR"
# Only after the person approves this exact candidate/configuration:
node scripts/install-daily.cjs --approval "$APPROVAL" \
  --approval-sha256 "$APPROVAL_SHA256" --result-dir "$RESULT_DIR" --apply
```

Use a separate approval/result destination for each check/apply invocation. This
avoids overwriting earlier receipts. The code and archive pins are checked before
loading support modules; the release commit/clean state is checked before importing
its read-only service client. The GUI command line must be exactly the approved executable (no extra profile
or debug arguments). The Swift helper quits only the precise executable path; another running copy with the same bundle identifier causes refusal.

## Zero-model failure tests

Unit tests cover terminal paths, receipt bytes/absence/concurrent edits, approval
and helper tampering, foreign app instances and occupied leases. The opt-in macOS
fixture additionally runs real signed synthetic AppKit bundles and actual release
backend code with one ended synthetic session. It uses hidden launches, explicit
credential-free child environments, its own data/profile and the canonical GUI
slot. No native/provider session or model turn is started.

```sh
node --test app/tests/installer-recovery.test.cjs
node scripts/test-installer-failures.cjs \
  --old-release "$OLD_RELEASE" --release "$NEW_RELEASE" \
  --old-version "$OLD_VERSION" --new-version "$NEW_VERSION" \
  --scratch "$ISOLATED_SCRATCH" --slot "$CANONICAL_GUI_SLOT" \
  --evidence "$PRIVATE_EVIDENCE"
```

Use a private scratch outside protected Desktop/Documents folders for independent
LaunchServices fixture identities. The fixture copies the required public runtime
sources/dependencies there; it does not grant macOS privacy permissions. Its
application has no visible windows: this verifies actual GUI processes and service
bootstrap, not a human visual acceptance of the NAW window. Cases corrupt an
installed synthetic executable, kill an actually launched new GUI, remove the old
fixture executable before reopening, withhold new backend activation, and write a
synthetic draft via real RPC. The cold-launch marker in this synthetic fixture is explicitly fixture-only; it
does not qualify a real NAW build. Tests also feed the written receipt to the
pinned release's actual `appBuildInfo` reader, using real plist/receipt/executable
files with the synthetic packaged executable path. The fixture's platform module is explicitly pinned
in its test-only approval and never selected by the production platform.

This qualification does not install or authorize the candidate on daily data.
A future installation still requires its signed-build and daily-use acceptance.
