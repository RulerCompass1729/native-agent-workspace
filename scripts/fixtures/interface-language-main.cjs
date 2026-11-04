// Source-only GUI fixture: guard the clipboard before the application starts.
const path = require('node:path'), electron = require('electron');
const code = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
electron.app.setName('Native Agent Workspace');
electron.app.getAppPath = () => code;
electron.app.getVersion = () => require(path.join(code, 'package.json')).version;
globalThis.t60ClipboardAttempts = [];
const clipboard = electron.clipboard, guards = new Map();
for (const name of Object.getOwnPropertyNames(clipboard)) if (typeof clipboard[name] === 'function') {
  const guard = () => { globalThis.t60ClipboardAttempts.push(name); throw Error('OS clipboard prohibited in this fixture'); };
  clipboard[name] = guard;
  if (clipboard[name] !== guard) throw Error('Clipboard guard could not be installed');
  guards.set(name, guard);
}
if (!guards.has('readText') || !guards.has('writeText')) throw Error('Clipboard API inventory is not qualified');
try { clipboard.readText(); } catch (error) { if (error.message !== 'OS clipboard prohibited in this fixture') throw error; }
globalThis.t60ClipboardGuardProof = { blocked: true, baseline: globalThis.t60ClipboardAttempts.length };
require(path.join(code, 'app/main.cjs'));
