// One source GUI, synthetic NativeHost, snapshot-write lifetime race and retry.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
assert.equal(process.env.NAW_TERMINAL_BOOTSTRAP_GUI_AUTHORIZED, '1');
assert.ok(process.env.NAW_EVIDENCE_DIR && process.env.NAW_SCREENSHOTS_DIR);
const evidence = path.resolve(process.env.NAW_EVIDENCE_DIR), pictures = path.resolve(process.env.NAW_SCREENSHOTS_DIR);
for (const dir of [evidence, pictures]) {
  let parent = dir; while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const real = path.join(fs.realpathSync(parent), path.relative(parent, dir));
  assert.ok(real !== root && !real.startsWith(root + path.sep), 'Evidence must be outside this checkout');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
const files = ['app/renderer/renderer.js', 'app/dsh/client.js', 'scripts/test-terminal-bootstrap.cjs', 'scripts/fixtures/terminal-bootstrap.cjs'];
const hashes = () => Object.fromEntries(files.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const sourceBefore = hashes(), common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; fs.writeFileSync(path.join(evidence, 'occupied.json'), JSON.stringify({ at: new Date().toISOString(), launches: 0 })); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T79 terminal bootstrap', token, pid: process.pid, at: new Date().toISOString() }));
const started = Date.now(), checks = [], errors = [];
let profile, child, app, page, guiPid, requestId = 0, failure, cleaned = false, details;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 160; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const onMessage = value => { if (value.requestId !== id) return; clearTimeout(timer); child.off('message', onMessage); value.error ? reject(Error(value.error)) : resolve(value); };
    const timer = setTimeout(() => { child.off('message', onMessage); reject(Error('Owned fixture timeout')); }, 8000);
    child.on('message', onMessage); child.send({ id, method, target });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
async function guard() { const s = await snapshot(); assert.equal(s.servicePid, child.pid); assert.equal(s.runtimeVersion, version); return s; }
async function create(name) {
  await guard(); await page.locator('#new-session').click(); await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic session ready');
}
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-terminal-bootstrap-'));
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/terminal-bootstrap.cjs')], env: { ...process.env, NAW_APP_VERSION: version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic service');
  app = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  guiPid = app.process().pid; page = await app.firstWindow(); page.setDefaultTimeout(5000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); await guard();
  const frontend = await app.evaluate(({ app }) => ({ version: app.getVersion(), pid: process.pid })); assert.equal(frontend.pid, guiPid); assert.equal(frontend.version, version);
  await create('Bootstrap target'); await page.locator('#message-input').fill('TARGET UNSENT DRAFT');
  await create('Bootstrap unrelated'); await page.locator('#message-input').fill('UNRELATED UNSENT DRAFT');
  await until(async () => (await snapshot()).sessions.every(s => !!s.liveDraft), 'Both private drafts saved');
  // Seed an existing view-draft scope, then load it through normal bootstrap.
  // The empty default space intentionally has no sidebar navigation entry.
  await page.evaluate(async () => {
    const s = await workspace.initial(), view = s.viewState;
    await workspace.viewState({ ...view, terminalLayout: 'hidden', roomViews: { ...view.roomViews, shared: { ...view.roomViews?.shared, sharedDraft: 'ORIGINAL UNSENT SHARED DRAFT' } } });
  });
  await page.reload(); await page.locator('#new-session').waitFor(); await guard();
  assert.equal((await snapshot()).viewState.terminalLayout, 'hidden', 'Begin with the native pane collapsed, before any snapshot gate');
  await until(async () => (await snapshot()).viewState.roomViews?.shared?.sharedDraft === 'ORIGINAL UNSENT SHARED DRAFT', 'Shared draft saved');
  const before = await guard(), target = before.sessions.find(s => s.name === 'Bootstrap target');
  assert.equal(before.sessions.length, 2); await fixture('seed', target.id); const initial = await fixture('stats', target.id); const epochA = initial.runtimes.find(r => r.id === target.id).epoch;
  await page.locator('#sessions-flat').click(); await page.locator(`[data-session-id="${target.id}"]`).click();
  await page.evaluate(id => {
    if (typeof window.Terminal?.prototype?.write !== 'function') throw Error('Real xterm write unavailable');
    const write = window.Terminal.prototype.write;
    window.bootstrapWitness = { writes: [], held: false, released: false, epoch: null };
    window.bootstrapStateOff = workspace.onState(s => { window.bootstrapWitness.epoch = s.sessions.find(r => r.id === id)?.terminalState?.epoch; });
    window.Terminal.prototype.write = function (data, done) {
      window.bootstrapWitness.writes.push(data);
      if (!window.bootstrapWitness.held && typeof data === 'string' && data.includes('T79_EPOCH_A') && typeof done === 'function') {
        return write.call(this, data, () => { window.bootstrapWitness.held = true; window.bootstrapRelease = () => { window.bootstrapWitness.released = true; done(); }; });
      }
      return write.call(this, data, done);
    };
  }, target.id);
  await page.locator('#terminal-tab').click(); await until(() => page.evaluate(() => !!window.bootstrapRelease), 'Actual parsed snapshot callback held');
  const bound = await guard(), control = bound.sessions.find(s => s.id === target.id);
  await fixture('output', target.id); const drift = await fixture('epoch', target.id); const epochB = drift.runtimes.find(r => r.id === target.id).epoch; assert.notEqual(epochA, epochB);
  await until(() => page.evaluate(epoch => window.bootstrapWitness.epoch === epoch, epochB), 'Renderer received the new lifetime');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  const host = page.locator(`.terminal-host[data-terminal-id="${target.id}"]`);
  await page.evaluate(() => window.bootstrapRelease());
  await until(async () => (await host.locator('.terminal-loading').innerText()).includes('终端未连接'), 'Existing retry state shown');
  assert.equal(await host.locator('.terminal-surface').isHidden(), true);
  const staleWitness = await page.evaluate(() => window.bootstrapWitness);
  assert.ok(!staleWitness.writes.some(s => s.includes('T79_OLD_QUEUED')), 'Do not flush stale output after the snapshot');
  const failed = await guard(), unchanged = failed.sessions.find(s => s.id === target.id);
  assert.equal(unchanged.nativeId, control.nativeId); assert.equal(unchanged.owner, control.owner); assert.equal(unchanged.controlRevision, control.controlRevision);
  await page.screenshot({ path: path.join(pictures, '01-old-lifetime-rejected.png') });
  checks.push('New epoch during real xterm write leaves the old surface hidden and clears queued old output');
  await page.locator('#terminal-tab').click();
  await until(async () => (await host.locator('.terminal-surface').isVisible()) && (await host.locator('.xterm-rows').innerText()).includes('T79_EPOCH_B'), 'Explicit original retry displays the fresh snapshot');
  assert.ok(!(await host.locator('.xterm-rows').innerText()).includes('T79_EPOCH_A'));
  const after = await guard();
  assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId, s.owner, s.liveDraft]), before.sessions.map(s => [s.id, s.nativeId, s.owner, s.liveDraft]));
  assert.equal(after.viewState.roomViews.shared.sharedDraft, before.viewState.roomViews.shared.sharedDraft);
  const stats = await fixture('stats', target.id);
  for (const k of ['input', 'send', 'queue', 'steer', 'forward', 'startRun', 'approve', 'answer', 'resume', 'interrupt', 'pause']) { assert.equal(typeof stats.calls[k], 'number', k); assert.equal(stats.calls[k], 0, k); }
  assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore); assert.ok(Date.now() - started < 150000);
  await page.screenshot({ path: path.join(pictures, '02-explicit-retry-fresh-display.png') });
  checks.push('Explicit retry uses the same native identity; both private drafts, shared draft and unrelated session are preserved');
  details = { frontend, epochA, epochB, before, control, failed, after, stats, staleWitness };
}
run().catch(async e => { failure = e.stack; process.exitCode = 1; if (page && !page.isClosed()) await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {}); console.error(e.stack); })
  .finally(async () => {
    try { await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); cleaned = true; }
    catch (e) { process.exitCode = 1; console.error('Owned cleanup unconfirmed; canonical lease retained', e.stack); }
    const result = { at: new Date().toISOString(), checks, details, errors, failure, elapsedMs: Date.now() - started, guiPid, daemonPid: child?.pid, profileGone: profile ? !fs.existsSync(profile) : true, ownedCleanupConfirmed: cleaned, canonicalOwnTokenReleased: cleaned, sourceBefore, sourceAfter: hashes(), scope: 'Owned source GUI and synthetic NativeHost only; no actual native/provider/model/clipboard/daily/installed qualification' };
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  });
