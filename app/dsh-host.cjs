const { uiError } = require('./ui-errors.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validPreference } = require('./ui-locale.js');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// DSH signs browser cookies for each listener authority, but Chromium sends
// cookies across ports. Random ports otherwise accumulate enough old UI cookies
// to exceed Node's request-header limit after repeated launches. Only retire
// this composition's loopback authentication; native provider auth is elsewhere.
async function resetUiAuthentication(browserSession) {
  const cookies = await browserSession.cookies.get({ domain: '127.0.0.1' });
  for (const cookie of cookies) {
    if (cookie.domain === '127.0.0.1' && cookie.path === '/' && cookie.httpOnly && /^dsh-auth-[A-Za-z0-9_-]{43}$/.test(cookie.name)) {
      await browserSession.cookies.remove(`${cookie.secure ? 'https' : 'http'}://127.0.0.1/`, cookie.name);
    }
  }
  await browserSession.cookies.flushStore();
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
async function waitForPrevious(filename) {
  let previous;
  try { previous = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw Object.assign(new Error('UI host record is unreadable'), { code: 'NAW_UI_RECORD' }); }
  // Never signal a PID read from disk. Its original process may have exited.
  for (let i = 0; i < 30 && alive(previous.pid); i++) await delay(100);
  if (alive(previous.pid)) throw Object.assign(new Error('Previous UI host is still running'), { code: 'NAW_UI_BUSY' });
}

// Run the pinned DSH UI composition behind the local desktop view.
// Its UI may restart; the native session service is a separate owner.
async function startDsh(dataDir, { onLocale } = {}) {
  const registry = path.join(dataDir, 'ui-host.json');
  await waitForPrevious(registry);
  const home = path.join(dataDir, 'dsh');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['--disable-sigusr1', '--require', path.join(__dirname, 'ui-parent-lease.cjs'), path.join(__dirname, 'dsh-server.mjs'), home], {
    cwd: dataDir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'LC_ALL'].filter(key => process.env[key]).map(key => [key, process.env[key]])), ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
  });
  // Listen before the URL is ready: the first accepted snapshot precedes it.
  child.on('message', value => {
    if (value?.type !== 'ui-locale') return;
    const warning = ['unavailable', 'migrationNotSaved'].includes(value.warning) ? value.warning : null;
    if (Object.hasOwn(value, 'preference') && validPreference(value.preference) && Number.isSafeInteger(value.revision) && value.revision >= 0) {
      try { onLocale?.({ preference: value.preference, revision: value.revision, explicit: value.explicit === true, warning }); } catch {}
    } else if (warning) { try { onLocale?.({ warning }); } catch {} }
  });
  if (child.pid) fs.writeFileSync(registry, JSON.stringify({ pid: child.pid, parentPid: process.pid }), { mode: 0o600 });
  child.once('exit', () => {
    try { if (JSON.parse(fs.readFileSync(registry, 'utf8')).pid === child.pid) fs.rmSync(registry); } catch {}
  });
  const stop = () => { if (child.connected) child.disconnect(); else if (child.exitCode === null) child.kill('SIGTERM'); };
  const url = await new Promise((resolve, reject) => {
    let pending = ''; const timer = setTimeout(() => { stop(); reject(uiError("error.dshStartupTimeout")); }, 60000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { pending += chunk; if (pending.length > 100000) pending = pending.slice(-50000); const match = pending.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/[^\s]*)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    // Tokens may appear in DSH diagnostics. Keep them out of logs and the UI.
    child.stderr.on('data', () => {});
    child.once('error', () => { clearTimeout(timer); reject(uiError("error.dshStartupFailed")); });
    child.once('exit', code => { clearTimeout(timer); reject(uiError("error.dshExited", { arg1: code })); });
  });
  return { child, stop, url, origin: new URL(url).origin };
}
module.exports = { startDsh, resetUiAuthentication };
