# Third-party provenance

As of 2026-10-17. Original workspace code is Apache-2.0. This project uses
DeepSeek Harness 0.2.1-rc.2 as its UI foundation, through an original companion
plugin and an explicit UI-only host composition. It does not modify or bundle
Claude Code or Codex executables. Provider software and services retain their
own terms. This is an independent product, not an official DSH distribution.

| Input | Pinned version / source | Distribution treatment |
| --- | --- | --- |
| DSH UI/host packages | 0.2.1-rc.2; npm integrity pins in package-lock.json | MIT and vendored original notices retained with each package; original plugin source in app/dsh; no upstream model/tool/account/telemetry plugins mounted |
| DSH SDK protocol | 0.2.1-rc.2 | MIT notice retained; its JSON-RPC line transport is reused for the session-local Claude MCP tool; no remote broker or model client is mounted |
| xterm.js and headless | 6.0.0 | Full MIT notices preserved; headless npm omission supplemented from the same xterm.js release |
| xterm fit / serialize | 0.11.0 / 0.14.0 | Full MIT notices preserved; serialize omission supplemented from xterm.js |
| ws | 8.22.0 | MIT notice preserved in the persistent runtime copy |
| Electron | 44.9.0 | Unmodified runtime before application metadata/ad-hoc signing; full Electron and Chromium notices copied inside the app |
| Electron Packager | 20.3.0 | BSD-2-Clause build tool; not an application runtime dependency |
| Playwright | 1.64.1 | Apache-2.0 test tool; not shipped in the application |

The packaging script installs a clean, locked production dependency tree with
installation scripts disabled. It checks for package notices and emits
DEPENDENCIES.json. Browser bundles contain dependencies that are not listed as
production npm dependencies: docs/browser-notices.json records a conservative
source-derived input closure from upstream revision
687f282e8625c6b8d11ff58211a90524be2e4317. The build retrieves public tarballs,
checks their pinned SHA-512 integrity, and preserves full license/notice texts
in third-party/browser. This closure includes extra source inputs; it is not a
claim that every listed package executes in the browser. The published bundle's
embedded build marker is not treated as a verified public Git revision.

Upstream fonts retain their included licenses. Vendored Cordis, Cosmokit and
Schemastery retain the original Shigma notices. Dependencies remain under their
own licenses; the repository's Apache license does not relicense them.

Generated bundles, dependency trees, local application builds, provider histories
and test evidence are excluded from Git. A local build does not authorize an
unreviewed binary upload: scan and review the exact distribution separately.
See docs/licensing.md and docs/publication.md.

The original `app/claude-bridge` integration uses the public Claude Code Mods
API ([reference](https://code.claude.com/docs/en/plugins/mods/api)), verified
against the installed 2.1.302 type definitions. Those generated definitions,
provider binaries, credentials and native test kit are not redistributed. The
bridge is loaded with a session-local plugin directory; it does not install a
global plugin or change the provider's license. The addressed-message extension
was verified against native 2.1.309. It reuses the DSH protocol transport above;
the native MCP call runs through Claude's permission/hook path before the
root-bound bridge can stage a handoff. Generated provider declarations are not
redistributed.
