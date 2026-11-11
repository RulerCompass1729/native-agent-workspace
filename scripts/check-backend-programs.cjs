#!/usr/bin/env node
// Read-only check before an update is installed: could the backend that will take new sessions run
// Claude Code, Codex and Python 3 once it starts on this build? Nothing is written and no program is run.
//
//   node scripts/check-backend-programs.cjs <data directory> [--backend <key>] [--path <PATH>]
//
// <key> is "." or "backends/<id>" as in services.json; without it the currently active backend is checked,
// so pass the backend the update is predicted to activate. Discovery uses the PATH an application gets when
// it is opened from the Finder or the Dock (plus the usual install folders the app itself adds), not this
// shell's: a program found that way is found by the installed app; --path gives another PATH to assume.
// "wouldDrop" lists the entries of that backend's own locations file, which its next start takes out and keeps
// in a record beside the file; they do not count for "ok".
// Prints one JSON object and exits 0 when "ok" is true, 1 when a program is missing, 2 on a usage error.
const path = require('node:path');
const args = process.argv.slice(2), take = flag => { const at = args.indexOf(flag); return at < 0 ? undefined : args.splice(at, 2)[1]; };
const backend = take('--backend'), assumed = take('--path') || '/usr/bin:/bin:/usr/sbin:/sbin';
if (args.length !== 1 || !path.isAbsolute(args[0]) || (backend !== undefined && backend !== '.' && !/^backends\/[a-f0-9]{20}$/.test(backend))) {
  console.error('Usage: node scripts/check-backend-programs.cjs <absolute data directory> [--backend .|backends/<id>] [--path <PATH>]'); process.exit(2);
}
process.env.PATH = assumed; delete process.env.NAW_RUNTIME_CONFIG;
try {
  const key = backend || require('../app/service-layout.cjs').readLayout(args[0]).active;
  const result = require('../app/platform.cjs').backendPrograms(args[0], key);
  console.log(JSON.stringify({ ...result, pathAssumed: assumed }, null, 1)); process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ backend: backend || null, ok: false, error: String(error?.message).slice(0, 200), pathAssumed: assumed }, null, 1)); process.exitCode = 1;
}
