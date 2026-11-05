// Actual isolated source GUI with synthetic transport. No native/provider/model
// input, clipboard or daily application. Baseline and candidate are separate runs.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = path.resolve(process.env.NAW_TEST_APP_ROOT || root);
const baseline = process.env.NAW_COMPACT_BASELINE === '1';
assert.equal(process.env.NAW_COMPACT_GUI_AUTHORIZED, '1', 'Explicit finite source GUI authorization required');
const evidence = path.resolve(process.env.NAW_EVIDENCE_DIR), pictures = path.resolve(process.env.NAW_SCREENSHOTS_DIR);
for (const target of [evidence, pictures]) {
  let existing = target; while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const source of [root, code].map(p => fs.realpathSync(p))) assert.ok(real !== source && !real.startsWith(source + path.sep), 'Evidence outside source roots');
  fs.mkdirSync(real, { recursive: true, mode: 0o700 });
}
const frozen = () => Object.fromEntries(['app/renderer/renderer.js', 'app/renderer/styles.css', 'app/dsh/client.js'].map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(code, file))).digest('hex')]));
const sourceBefore = frozen();
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied: no profile/process launched'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T163/UI001 compact grouped sidebar', baseline, token, pid: process.pid, at: new Date().toISOString() }));
let profile, child, application, page, sequence = 0, failure, cleanupConfirmed = false, details, guiPid;
const checks = [], errors = [], witnesses = [], start = Date.now(), delay = ms => new Promise(r => setTimeout(r, ms));
const record = text => { checks.push(text); console.log('PASS ' + text); };
async function until(fn, label) { for (let n = 0; n < 100; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); result.error ? reject(Error(result.error)) : resolve(result); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture deadline')); }, 8000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const surface = () => page.locator('.naw[data-native-surface="sidebar"]');
const group = () => surface().locator('[data-session-group="shared"]');
const row = id => group().locator('[data-session-row="' + id + '"]');
const toggle = () => group().locator('.session-space-toggle');
async function capture(name) { const file = path.join(pictures, name + '.png'); await page.screenshot({ path: file }); witnesses.push(file); }
async function settle() { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
async function create(name, provider) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="' + provider + '"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Fixture created');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入此空间', exact: true }).click();
  await page.locator('#toast-close').waitFor(); await page.locator('#toast-close').click(); return id;
}
const stable = state => ({ pairs: state.sessions.map(s => [s.id, s.nativeId]).sort(), drafts: state.sessions.map(s => [s.id, s.liveDraft || '']).sort(), shared: state.viewState.roomViews?.shared?.sharedDraft || '' });
async function measure() {
  return group().evaluate(el => {
    const rect = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const font = e => { const c = getComputedStyle(e); return { size: c.fontSize, weight: c.fontWeight, family: c.fontFamily }; };
    return { sidebar: rect(el.closest('.naw')), group: rect(el), heading: rect(el.querySelector('h3')), toggle: rect(el.querySelector('.session-space-toggle')), svg: el.querySelector('svg') ? rect(el.querySelector('svg')) : null,
      rows: [...el.querySelectorAll('.session-row')].map(r => ({ id: r.dataset.sessionRow, rect: rect(r), link: rect(r.querySelector('.session-link')), name: r.querySelector('.session-title').textContent, state: r.querySelector('.session-metadata small').textContent, nameFont: font(r.querySelector('.session-title')), stateFont: font(r.querySelector('.session-metadata small')), stateRect: rect(r.querySelector('.session-metadata small')), stateScrollHeight: r.querySelector('.session-metadata small').scrollHeight, draggable: r.querySelector('.session-link').draggable, accessible: r.querySelector('.session-link').getAttribute('aria-label') })) };
  });
}
async function run() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-sidebar-compact-'));
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own daemon ready');
  application = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  guiPid = application.process().pid; page = await application.firstWindow(); page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await (await application.browserWindow(page)).evaluate(w => w.setContentSize(1240, 850));
  const ids = []; for (const [name, provider] of [['Jun', 'claude'], ['Mira', 'codex'], ['Sol', 'claude'], ['Kai', 'codex']]) ids.push(await create(name, provider));
  await rowOrFlat(ids[0]).locator('.session-link').click(); await page.locator('#message-input').fill('UNSENT compact private draft');
  await until(async () => (await snapshot()).sessions.find(s => s.id === ids[0]).liveDraft === 'UNSENT compact private draft', 'Private draft persisted');
  await fixture('state', ids[1], 'working');
  await fixture('approval', ids[2], { requestId: 41, method: 'item/commandExecution/requestApproval', params: { command: 'echo synthetic', cwd: '/synthetic', availableDecisions: ['accept', 'decline'] } });
  await page.locator('#sessions-grouped').click(); await until(async () => await group().locator('.session-row').count() === 4, 'Four single-home rows'); await settle();
  const identityBefore = stable(await snapshot()), initial = await measure();
  details = { identityBefore, initial }; fs.writeFileSync(path.join(evidence, 'initial-geometry.json'), JSON.stringify(details, null, 2));
  assert.equal(initial.rows.length, 4); assert.ok(initial.rows.every(r => r.draggable && r.state && r.accessible));
  assert.equal(new Set(initial.rows.map(r => r.id)).size, 4); assert.equal(await surface().locator('.session-row').count(), 4);
  await capture('01-expanded'); record('Four unique grouped members retain status, accessibility and drag metadata');
  if (!baseline) {
    assert.ok(Math.abs(initial.svg.width - 22) < 0.1 && Math.abs(initial.svg.height - 22) < 0.1);
    assert.ok(initial.toggle.width >= 40 && initial.toggle.height >= 44);
    assert.ok(initial.rows.every(r => r.rect.height >= 40 && r.stateRect.height + 1 >= r.stateScrollHeight));
    const old = JSON.parse(fs.readFileSync(process.env.NAW_COMPACT_BASELINE_RESULT)).details.initial;
    assert.ok(Math.abs(old.sidebar.width - initial.sidebar.width) < 0.5, 'Same actual sidebar width');
    assert.deepEqual(initial.rows.map(r => [r.name, r.state, r.nameFont, r.stateFont]), old.rows.map(r => [r.name, r.state, r.nameFont, r.stateFont]), 'Same content and original member fonts');
    assert.ok(initial.group.height < old.group.height, 'Actual grouped occupied height reduced');
    record('22px icon and 40x44 target; unchanged content/fonts; measured occupied height reduced');
  }
  const beforeFold = await snapshot(); await toggle().focus(); await page.keyboard.press('Enter');
  await until(async () => await toggle().getAttribute('aria-expanded') === 'false', 'Keyboard folds');
  assert.equal(await row(ids[0]).isVisible(), false); assert.equal((await snapshot()).viewState.selected, beforeFold.viewState.selected);
  assert.equal(await group().locator('.session-space-attention').isVisible(), true);
  await page.locator('#sessions-flat').click(); await page.locator('#sessions-grouped').click();
  assert.equal(await toggle().getAttribute('aria-expanded'), 'false');
  await until(async () => (await snapshot()).viewState.sidebarCollapsedGroups?.includes('shared'), 'Fold saved');
  await page.reload(); await page.locator('#new-session').waitFor();
  await until(async () => await toggle().getAttribute('aria-expanded') === 'false', 'Reload preserves group/fold');
  assert.deepEqual(stable(await snapshot()), identityBefore);
  await toggle().focus(); await page.keyboard.press('Space'); await until(async () => await toggle().getAttribute('aria-expanded') === 'true', 'Space unfolds');
  await group().locator('.session-space-heading').click(); assert.equal((await snapshot()).viewState.selected, 'room');
  assert.equal(await toggle().getAttribute('aria-expanded'), 'true');
  record('Independent keyboard disclosure, attention, separate space entry and reload preserve identity/drafts/fold');
  await group().locator('.session-space-heading').focus(); await page.keyboard.press('Shift+F10'); await page.getByRole('menu').waitFor(); await page.keyboard.press('Escape');
  await row(ids[0]).locator('.session-more').click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await page.locator('#rename-name').fill('Jun renamed'); await page.locator('#rename-name').press('Enter');
  await until(async () => (await snapshot()).sessions.find(s => s.id === ids[0]).name === 'Jun renamed', 'Rename persisted');
  assert.equal(await row(ids[0]).locator('.session-title').textContent(), 'Jun renamed');
  assert.deepEqual(stable(await snapshot()), identityBefore); record('Space keyboard menu and existing member inline rename retain IDs and drafts');
  await fixture('fleet', ids[3], { event: 'thread/started', id: 'synthetic-child-unknown', stale: false }); await settle();
  const afterStateUpdate = await measure(); assert.ok(afterStateUpdate.rows.every(r => r.stateRect.height + 1 >= r.stateScrollHeight)); await capture('02-status-and-rename');
  await (await application.browserWindow(page)).evaluate(w => w.setContentSize(950, 700));
  await until(async () => await surface().getAttribute('data-collapsed') === 'true', 'Existing collapsed shell');
  const collapsed = await surface().evaluate(el => ({ platform: document.documentElement.dataset.platform, width: el.closest('.pI_x6G_sidebarCol').getBoundingClientRect().width }));
  await (await application.browserWindow(page)).evaluate(w => w.setContentSize(1240, 850));
  await until(async () => await surface().getAttribute('data-collapsed') === 'false', 'Expanded shell restored');
  assert.equal(await toggle().getAttribute('aria-expanded'), 'true'); assert.deepEqual(stable(await snapshot()), identityBefore);
  record('Current status rows stay unclipped after a fleet update and original collapsed-shell round trip retains expanded state');
  const final = await fixture('stats'); assert.equal(final.stats.inputs, 0); assert.equal(final.stats.sends, 0);
  for (const [name, count] of Object.entries(final.overviewCalls)) if (!['claim', 'terminal', 'terminalSnapshot'].includes(name)) assert.equal(count, 0, name);
  assert.deepEqual(errors, []); assert.deepEqual(frozen(), sourceBefore);
  return { initial, afterStateUpdate, collapsed, identityBefore, finalStats: final.stats, workspaceCalls: final.overviewCalls, uninstrumentedControlKeys: ['run', 'resume', 'pause'].filter(name => !Object.hasOwn(final.overviewCalls, name)) };
}
function rowOrFlat(id) { return surface().locator('[data-session-row="' + id + '"]').first(); }
run().then(value => { details = value; }).catch(async error => { failure = error.stack; process.exitCode = 1; console.error(failure); if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); cleanupConfirmed = true; }
  catch (error) { console.error('Own cleanup unconfirmed; lease retained', error.stack); process.exitCode = 1; }
  const result = { at: new Date().toISOString(), baseline, checks, details, errors, failure, witnesses, elapsedMs: Date.now() - start, ownDaemonPid: child?.pid, ownGuiPid: guiPid, ownedCleanupConfirmed: cleanupConfirmed, profileGone: profile ? !fs.existsSync(profile) : true, canonicalOwnTokenReleased: cleanupConfirmed, sourceBefore, sourceAfter: frozen(), productModels: 0, realProviders: 0, osClipboard: 0, limits: 'Actual source GUI/service with synthetic NativeHost; no installed/provider/IME/physical-native or cross-platform rail proof. Locale semantic bindings covered by existing unit checks.' };
  fs.writeFileSync(path.join(evidence, 'sidebar-compact-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
});
