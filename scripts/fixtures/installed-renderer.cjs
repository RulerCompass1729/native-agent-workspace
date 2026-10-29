// Renderer-only acceptance of hardened installed bundles. No Node inspector or
// production test hooks. The caller owns the canonical GUI lease and profile.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { chromium } = require('playwright');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function launch({ executablePath, env, timeout = 70000 }) {
  const profile = fs.realpathSync(env.NAW_DATA_DIR), info = fs.lstatSync(profile);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid() && !(info.mode & 0o077));
  assert.equal(env.NAW_TEST_PARENT_PID, String(process.pid));
  assert.ok(path.isAbsolute(executablePath) && executablePath.includes('.app/Contents/MacOS/'));
  const bundle = path.resolve(path.dirname(executablePath), '../..');
  const attest = () => {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
    const signature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', bundle], { encoding: 'utf8' });
    assert.equal(signature.status, 0); const cdhash = signature.stderr.match(/^CDHash=(\w+)$/m)?.[1]; assert.ok(cdhash);
    const revision = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :NAWSourceRevision', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    if (env.NAW_TEST_EXPECTED_SOURCE) assert.equal(revision, env.NAW_TEST_EXPECTED_SOURCE);
    if (env.NAW_TEST_EXPECTED_CDHASH) assert.equal(cdhash, env.NAW_TEST_EXPECTED_CDHASH);
    return { bundle, cdhash, revision, executableSha256: createHash('sha256').update(fs.readFileSync(executablePath)).digest('hex') };
  };
  const artifact = attest();
  const portFile = path.join(profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });
  const childEnv = { ...env }; delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executablePath, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '', browser, exited = false, spawnError;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  child.on('exit', () => { exited = true; }); child.on('error', error => { spawnError = error; });
  const deadline = Date.now() + timeout;
  const wait = async (fn, label) => {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (exited) throw Error(`Owned installed app exited before ${label}: ${stderr}`);
      const value = await fn(); if (value) return value; await delay(50);
    }
    throw Error(`Owned installed app timed out: ${label}`);
  };
  const close = async () => {
    if (!exited && browser?.isConnected()) {
      const session = await browser.newBrowserCDPSession();
      // Electron may exit before acknowledging Browser.close. Its actual child
      // exit is the completion signal, rather than an unbounded CDP response.
      session.send('Browser.close').catch(error => { stderr += '\n' + error.message; });
    }
    for (let i = 0; i < 200 && !exited; i++) await delay(50);
    if (!exited) {
      child.kill('SIGTERM');
      for (let i = 0; i < 100 && !exited; i++) await delay(50);
      throw Error('Owned installed app did not close normally; cleanup fallback used');
    }
    await browser?.close().catch(() => {});
    assert.deepEqual(attest(), artifact, 'The signed installed artifact stays unchanged');
  };
  try {
    if (env.NAW_EVIDENCE_DIR) {
      fs.mkdirSync(env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(env.NAW_EVIDENCE_DIR, 'installed-launch-' + child.pid + '.json'), JSON.stringify({ at: new Date().toISOString(), pid: child.pid, executable: child.spawnfile, argv: child.spawnargs, profile, ...artifact }, null, 2));
    }
    const port = await wait(() => {
      if (!fs.existsSync(portFile)) return;
      const [number, target] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      assert.match(number, /^\d+$/); assert.ok(+number > 0 && +number < 65536);
      assert.ok(target.startsWith('/devtools/browser/')); return +number;
    }, 'private renderer CDP endpoint');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    assert.equal(browser.contexts().length, 1);
    const context = browser.contexts()[0];
    await wait(() => context.pages().find(page => !page.isClosed()), 'first renderer');
    return { windows: () => context.pages().filter(page => !page.isClosed()), firstWindow: async () => context.pages().find(page => !page.isClosed()), process: () => child, close, port };
  } catch (error) { await close().catch(cleanup => { error.message += '\n' + cleanup.message; }); throw error; }
}
module.exports = { launch };
