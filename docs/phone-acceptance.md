# Phone browser acceptance

This runner serves the phone part of the product vision: find and talk to the
right existing agent without making the person repeat a manual device test after
every edit. It is a development browser trial, not a claim of iOS equivalence.

```sh
node scripts/phone-acceptance.cjs <source-directory-or-local-git-ref> \
  --output /private/evidence/phone-trial
```

No model, provider, real pairing, tailnet, Serve, system service or installation is
used. No dependency is downloaded. The daemon uses synthetic native transports;
Main's mobile functions, broker, authorization, HTTP handler, Unix RPC, RoomState,
confirmation execution and phone assets come from the specified target. Main's
Electron window/IPC context and the carrier identity are fixture boundaries.
An ephemeral, untrusted localhost certificate stays in owned scratch.

The default is WebKit and Chromium, Chinese and English, iPhone 13 user agent,
390×844 CSS pixels, touch and DPR 3. Existing executables may be selected with
`NAW_WEBKIT_EXECUTABLE` / `NAW_CHROMIUM_EXECUTABLE`; the singular
`NAW_BROWSER_EXECUTABLE` is useful with `--engines webkit` or `--engines chromium`.
The loopback proxy adds 80 ms RTT and limits each response to 256 KiB/s. It does
not alter response payloads or bypass Origin/CSRF or authorization.

Individual journeys are repeatable with `--cases` (comma separated). All include
the necessary isolated service and pairing setup. For example:

```sh
node scripts/phone-acceptance.cjs <lane> --cases navigation --output /private/evidence/back
node scripts/phone-acceptance.cjs <lane> --cases busy,steer --output /private/evidence/input
node scripts/phone-acceptance.cjs <lane> --cases consent --engines chromium --output /private/evidence/uv
node scripts/phone-acceptance.cjs <lane> --cases keyboard --output /private/evidence/keyboard
```

Cases: `read`, `send`, `navigation`, `busy`, `steer`, `workspace`, `consent`,
`reminders`, `keyboard`, `lifecycle`, `pairing`. `busy` requires queued input;
`steer` separately verifies one instruction into the original Codex native turn.
The native stub holds a queued message until the harness explicitly drains it.
Cancellation of a replacement must preserve the old device; activation of its
successor and explicit logout must invalidate the superseded credential.

The keyboard surrogate focuses the textarea, reduces the browser viewport to
390×460 and reads the real `visualViewport` and element hit targets. It scrolls
the actual scroll container and checks the latest message against the composer,
rather than merely checking that the nodes exist. `--keyboard-overlay-fault`
deliberately covers the page in the isolated browser; the hit-target assertion
must then fail. No product CSS or source is changed by that control.

Optional `--shape /private/shape.json` replaces the fleet's synthetic distributions.
The input accepts only bounded role/kind/length/count metadata. It rejects extra
fields, invalid totals and excessive loads rather than silently truncating them.
The reference Butler uses the reported 309-row distribution; the remaining fleet
keeps the supplied distributions. Two known, synthetic latest-message markers
per thread make the visual oracle independent of a possibly broken projection.
No real names, IDs, directories or message content enter this fixture.

`scripts/phone-shape.py FILE... --output /private/shape.json` is a separate,
explicitly authorized metadata collector. It counts JSON string tokens without
decoding message values; only public role/kind enums and UTF-16 lengths survive.
Never point the browser runner at a daily profile. Neither command needs secrets.

The report keeps failures as failures and exits nonzero. It records browser/DOM
assertions against daemon calls, queue state and executed confirmations; send
arrival and visible-result times are separate. The initial send-feedback budget
is 1,500 ms; the blocked-read back budget is 500 ms. Calibrate a small control on
the same host/network before interpreting performance failures. Do not increase
a threshold solely to make a failing build pass.

Outputs are `report.md`, `report.json`, numbered viewport PNGs, metadata-only
network timings and a screenshot-only `cold-read.md`. Give a new reader only the
numbered screenshots and that task sheet, not code or the assertion report.
Cold reading is a separate human judgment; the runner does not score visual
comprehension by itself.

Chromium's virtual authenticator counts credential creation and verified
assertion ceremonies. These are not counts of physical Face ID dialogs. WebKit
uses basic pairing and checks that cookie-only access cannot enable approvals.
Reload/offline tests do not simulate an actual iPhone lock screen. This runner
does not cover physical biometric prompts, iOS Safari build differences, real
Tailscale/cellular behavior, home-screen Web App storage/lifecycle or notification
delivery. An iOS Simulator can improve Safari/WebKit and standalone lifecycle
coverage; it still cannot prove physical Face ID or a real mobile network.
Cross-process Mac restart/persistent pairing is a separate service-side contract:
browser reload is not evidence for it. A persistence delivery must also retain
its independent-process restart and revocation regressions.

Owned profiles and processes are finalized on success, failure and cancellation.
Only the explicit report and screenshots are retained. Generic scratch export is
disabled before its helper is loaded, so transcripts, keys, codes and cookies
cannot be copied into an evidence directory by that export path.
