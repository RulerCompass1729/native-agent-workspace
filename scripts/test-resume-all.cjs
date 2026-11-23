// Resume all (11-23): sessions left awaiting recovery after the service dies come back from one sidebar bar and panel.
// Real hidden Electron window and a real service restart on the same profile; synthetic native only, no model.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = fs.realpathSync(process.env.NAW_TEST_APP_ROOT || root);
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const serviceLock = require(path.join(code, 'app/service-lock.cjs'));
const locale = require(path.join(root, 'app/ui-locale.js'));
const evidence = process.env.NAW_EVIDENCE_DIR, pictures = process.env.NAW_PICTURES_DIR;
for (const dir of [evidence, pictures]) {
  if (!dir || !path.isAbsolute(dir) || [root, code].some(p => path.resolve(dir) === p || path.resolve(dir).startsWith(p + path.sep))) throw Error('External private evidence and picture directories required');
}
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const COUNT = Number(process.env.NAW_RESUME_COUNT || 23);
assert.ok(Number.isSafeInteger(COUNT) && COUNT >= 5, 'At least five: one unchecked, one failing, the rest resumed');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = process.env.NAW_GUI_TEST_SLOT || path.join(path.dirname(common), '.local/gui-test-slot.lock');
assert.ok(path.isAbsolute(slot), 'GUI slot must be absolute');
fs.mkdirSync(path.dirname(slot), { recursive: true });
const token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'resume all window test', pid: process.pid }));
const checks = [], errors = [], shots = [];
let profile, cwd, child, client, app, page, win, sequence = 0;
const zh = (key, params) => locale.format('zh', key, params);
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, rounds = 250) {
  for (let n = 0; n < rounds; n++) { if (await fn()) return; await wait(40); }
  throw Error(label);
}
function fork() {
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/resume-gate.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
}
// The gate answers resume* requests; the synthetic native answers every request with what native received.
function ask(method) {
  const id = ++sequence, key = method.startsWith('resume') ? 'resumeRequestId' : 'requestId';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timeout')); }, 8000);
    const receive = r => { if (r[key] !== id) return; clearTimeout(timer); child.off('message', receive); resolve(r); };
    child.on('message', receive); child.send({ id, method });
  });
}
async function hidden(stage) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  const frontmostPid = Number(execFileSync('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier"], { encoding: 'utf8' }).trim());
  save(stage + '-windows', { windows, frontmostPid, ownPid: app.process().pid });
  assert.ok(windows.length > 0 && windows.every(w => !w.visible && !w.focused), 'Owned windows stay hidden and unfocused');
  assert.notEqual(frontmostPid, app.process().pid, 'Owned app does not take the foreground');
}
async function check(name, test) {
  try { await test(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (e) { checks.push({ name, passed: false, error: e.stack }); console.error('FAIL ' + name + '\n' + e.stack); }
  if (app) await hidden(name.replace(/\W+/g, '-'));
  save('checks', checks);
}
async function shot(name) {
  for (const scheme of ['light', 'dark']) for (const width of [1280, 850]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark');
    await win.evaluate((w, width) => w.setContentSize(width, 820), width); await wait(250);
    const layout = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    const file = `${name}-${scheme}-${width}.png`;
    await page.screenshot({ path: path.join(pictures, file) });
    shots.push({ file, scheme, width, ...layout }); save('shots', shots);
  }
  await page.emulateMedia({ colorScheme: 'light' }); await win.evaluate(w => w.setContentSize(1280, 820));
}
const sessions = async () => (await page.evaluate(() => workspace.initial())).sessions;
const rows = () => page.evaluate(() => [...document.querySelectorAll('#resume-all-list .resume-all-row')].map(row => ({
  id: row.dataset.resumeSession, state: row.dataset.resumeState || '', checked: row.querySelector('input').checked,
  status: row.querySelector('.resume-all-status').textContent, reason: row.querySelector('.resume-all-reason').hidden ? '' : row.querySelector('.resume-all-reason').textContent,
  retry: row.querySelector('.resume-all-retry').hidden ? null : row.querySelector('.resume-all-retry').getAttribute('aria-label') })));
const queues = state => JSON.stringify((state.rooms || []).map(r => ({ id: r.id, queue: r.queue ?? null, handoffs: r.handoffs ?? null })));
async function run() {
  fs.mkdirSync(pictures, { recursive: true });
  // The window loads the built bundle (app/dsh/client.js), not renderer.js itself.
  scratch.childProcess.execFileSync(process.execPath, [path.join(code, 'scripts/build-ui.cjs')], { cwd: code, stdio: 'ignore' });
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-resume-all-')));
  cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  fork();
  save('source', { code, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--short'], { cwd: code, encoding: 'utf8' }), profile, count: COUNT });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service starts');
  client = await connectService(profile, 'human-view');
  await client.call('wakePolicy', null, false);
  const ids = [], folders = [];
  for (let n = 1; n <= COUNT + 1; n++) {
    const folder = path.join(profile, 'work', 's' + String(n).padStart(2, '0')); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const id = await client.call('create', { provider: 'codex', cwd: folder, name: 'Synthetic ' + String(n).padStart(2, '0'), view: 'chat' });
    await until(async () => (await client.call('initial')).sessions.find(s => s.id === id)?.state === 'idle', 'Synthetic session ready');
    ids.push(id); folders.push(folder);
  }
  const unchecked = ids[2], failing = ids[3], archived = ids[COUNT];
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: ids[0], mode: 'chat' }]), { mode: 0o600 });
  // The outage: the service dies without stopping anything, then starts again on the same profile.
  const oldPid = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'))).pid;
  // Records reach the disk on a checkpoint about a second later (workspace.cjs persistLater); the outage comes after it.
  const stored = () => JSON.parse(fs.readFileSync(path.join(profile, 'workspace.json'))).sessions.map(s => s.id);
  await until(() => ids.every(id => stored().includes(id)), 'Every session is saved before the outage');
  scratch.ownService(profile); client.close(); client = null;
  const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  // The launcher releases a dead service's lock before starting again (service-client.cjs); so does this restart.
  const lockFile = path.join(profile, 'service.lock'), stale = serviceLock.readLock(lockFile);
  assert.ok(stale && !serviceLock.ownerMayBeAlive(stale, profile, 'service') && serviceLock.releaseLock(lockFile, stale), 'The dead service lock is released');
  fs.rmSync(folders[3], { recursive: true }); fs.writeFileSync(folders[3], 'not a directory\n');
  fork();
  await until(() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'))).pid !== oldPid; } catch { return false; } }, 'Service restarts');
  client = await connectService(profile, 'human-view');
  const restarted = (await client.call('initial')).sessions;
  assert.deepEqual(ids.map(id => restarted.find(s => s.id === id)?.state), ids.map(() => 'recoverable'), 'Every session awaits recovery after the restart');
  app = await _electron.launch({ args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  win = await app.browserWindow(page);
  await page.locator('#session-list').waitFor(); await hidden('startup');
  await page.evaluate(id => workspace.archiveSession(id), archived);
  await until(async () => (await sessions()).find(s => s.id === archived)?.archived, 'One recoverable session is archived');
  const bar = page.locator('#resume-all-open');
  const nativeBefore = await ask('stats'), queuesBefore = queues(await page.evaluate(() => workspace.initial()));

  await check('a bar counts the sessions awaiting recovery, leaving out the archived one', async () => {
    const text = zh('resumeAll.bar', { count: COUNT });
    await until(async () => (await bar.count()) && await bar.isVisible(), 'The bar is shown');
    assert.equal(await page.locator('#resume-all-label').textContent(), text);
    assert.equal(await bar.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(await page.getByRole('button', { name: text, exact: true }).count(), 1, 'Its accessible name is the count');
    await shot('1-waiting');
  });

  await check('the panel lists each waiting session checked; the keyboard unchecks one and starts', async () => {
    await bar.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: zh('resumeAll.title') });
    await dialog.waitFor();
    const listed = await rows();
    assert.deepEqual(listed.map(r => r.id), ids.slice(0, COUNT), 'Every waiting session, oldest first; the archived one is absent');
    assert.ok(listed.every(r => r.checked && !r.state));
    const layout = await page.evaluate(() => [...document.querySelectorAll('#resume-all-list .resume-all-row')].map(row => {
      const name = row.querySelector('.resume-all-name'), box = row.querySelector('input');
      return { box: box.getBoundingClientRect().width, clipped: name.scrollWidth > name.clientWidth, left: name.getBoundingClientRect().left - row.getBoundingClientRect().left };
    }));
    assert.ok(layout.every(r => r.box <= 20 && !r.clipped && r.left < 80), 'Each row reads checkbox, icon, full name from the left: ' + JSON.stringify(layout[0]));
    assert.equal(await page.locator('#resume-all-start').textContent(), zh('resumeAll.start', { count: COUNT }));
    await page.getByRole('button', { name: zh('resumeAll.selectNone') }).click();
    assert.ok(await page.locator('#resume-all-start').isDisabled(), 'Nothing chosen: nothing to start');
    await page.getByRole('button', { name: zh('resumeAll.selectAll') }).click();
    const box = page.getByRole('checkbox', { name: /^Synthetic 03\b/ });
    await box.focus(); await page.keyboard.press('Space');
    assert.equal(await box.isChecked(), false);
    assert.equal(await page.locator('#resume-all-start').textContent(), zh('resumeAll.start', { count: COUNT - 1 }));
    await shot('2-panel');
  });

  await check('at most two resume at once, and only the chosen ones', async () => {
    await page.evaluate(() => {
      window.resumeAllMost = 0;
      new MutationObserver(() => { window.resumeAllMost = Math.max(window.resumeAllMost, document.querySelectorAll('#resume-all-list [data-resume-state="running"]').length); })
        .observe(document.getElementById('resume-all-list'), { subtree: true, attributes: true, attributeFilter: ['data-resume-state'] });
    });
    await ask('resumeHold');
    await page.locator('#resume-all-start').focus(); await page.keyboard.press('Enter');
    await until(async () => (await ask('resumeCount')).held === 2, 'Two resumes reach the service');
    await wait(300);
    const gate = await ask('resumeCount'), listed = await rows();
    assert.equal(gate.inFlight, 2);
    assert.equal(listed.filter(r => r.state === 'running').length, 2);
    assert.equal(listed.filter(r => r.state === 'queued').length, COUNT - 3);
    assert.equal(await page.locator('#resume-all-progress').textContent(), zh('resumeAll.progress', { done: 0, total: COUNT - 1 }));
    await shot('3-resuming');
    await ask('resumeRelease');
    await until(async () => !(await page.locator('#resume-all-start').isHidden()), 'Every chosen session has an outcome', 500);
    const done = await ask('resumeCount');
    save('gate', done);
    assert.equal(done.most, 2, 'Never more than two in the service');
    assert.equal(await page.evaluate(() => window.resumeAllMost), 2, 'Never more than two shown running');
    assert.ok(!done.started.includes(unchecked) && !done.started.includes(archived), 'The unchecked and the archived are not resumed');
    assert.equal(new Set(done.started).size, done.started.length, 'Each session is resumed once');
    assert.equal((await sessions()).find(s => s.id === unchecked).state, 'recoverable', 'The unchecked one still awaits recovery');
  });

  await check('one failure keeps its reason and a retry; the others are back', async () => {
    const listed = await rows(), bad = listed.find(r => r.id === failing);
    assert.equal(bad.state, 'failed');
    assert.equal(bad.reason, zh('error.workspace.originalDirectoryUnavailable'));
    assert.equal(bad.retry, zh('resumeAll.retryName', { name: 'Synthetic 04' }));
    assert.deepEqual(listed.filter(r => r.id !== failing && r.id !== unchecked).map(r => r.state), ids.slice(0, COUNT).filter(id => id !== failing && id !== unchecked).map(() => 'done'));
    const text = zh('resumeAll.progressFailed', { done: COUNT - 2, total: COUNT - 1, failed: 1 });
    assert.equal(await page.locator('#resume-all-progress').textContent(), text);
    assert.equal(await page.locator('#resume-all-label').textContent(), text);
    const back = await sessions();
    assert.ok(ids.slice(0, COUNT).filter(id => id !== failing && id !== unchecked).every(id => ['starting', 'idle'].includes(back.find(s => s.id === id).state)));
    await shot('4-partial-failure');
  });

  await check('nothing earlier is sent again', async () => {
    const nativeAfter = await ask('stats');
    save('native', { before: nativeBefore, after: nativeAfter });
    assert.deepEqual(nativeAfter.sends, nativeBefore.sends, 'No turn was started');
    assert.deepEqual(nativeAfter.inputs, nativeBefore.inputs, 'No terminal input was written');
    assert.ok(!nativeAfter.calls.includes('turn/start'));
    assert.equal(queues(await page.evaluate(() => workspace.initial())), queuesBefore, 'Queues and handoffs are unchanged');
  });

  await check('retry resumes the failed one; then the panel closes with a summary', async () => {
    fs.rmSync(folders[3]); fs.mkdirSync(folders[3], { mode: 0o700 });
    await page.evaluate(() => {
      const bar = document.getElementById('resume-all'), label = document.getElementById('resume-all-label');
      window.resumeAllBar = [];
      new MutationObserver(() => window.resumeAllBar.push({ hidden: bar.hidden, text: label.textContent }))
        .observe(bar, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    });
    await page.getByRole('button', { name: zh('resumeAll.retryName', { name: 'Synthetic 04' }) }).focus(); await page.keyboard.press('Enter');
    await until(async () => (await page.locator('#toast-text').textContent()) === zh('resumeAll.finished', { count: COUNT - 1 }), 'The summary is shown', 400);
    assert.equal(await page.locator('#resume-all-dialog').evaluate(d => d.open), false);
    const shown = !(await page.locator('#resume-all').isHidden()), changes = await page.evaluate(() => window.resumeAllBar);
    save('bar-after-done', { shownAtSummary: shown, changes });
    assert.equal(shown, false, 'One session left waiting: no bar, its own Resume stays');
    assert.ok(!changes.some(c => !c.hidden && c.text.includes(zh('resumeAll.bar', { count: 2 }).split(' · ')[0].replace('2', ''))), 'The bar never flashes a waiting count after the summary');
    assert.ok(['starting', 'idle'].includes((await sessions()).find(s => s.id === failing).state));
    await shot('5-all-done');
  });
  assert.deepEqual(errors, []);
  await hidden('final');
}
(async () => {
  let fatal, cleanupError;
  try { await run(); } catch (e) { fatal = e.stack; console.error(fatal); }
  finally {
    if (client) client.close();
    try {
      await scratch.release();
      const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
      if (owner.token === token) fs.rmSync(slot, { recursive: true });
    } catch (e) { cleanupError = e.stack; console.error(cleanupError); }
    const passed = checks.filter(c => c.passed).length, failed = checks.length - passed;
    const ok = !fatal && !cleanupError && failed === 0 && checks.length === 6;
    save('result', { passed, failed, ok, checks, fatal, cleanupError, errors, pictures, syntheticNative: true, installed: false });
    console.log(`RESULT passed=${passed} failed=${failed} fatal=${Boolean(fatal)} cleanup=${cleanupError ? 'failed' : 'complete'}`);
    if (!ok) process.exitCode = 1;
  }
})();
