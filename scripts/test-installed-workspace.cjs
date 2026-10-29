// Black-box installed acceptance: renderer CDP, actual IPC/service/filesystem,
// existing synthetic native transport. No main-process monkeypatch or clipboard.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs');
const installed = require('./fixtures/installed-renderer.cjs');
const renderer = scratch.playwright({ _electron: installed })._electron;
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT;
assert.ok(code && process.env.NAW_APP_EXECUTABLE, 'Explicit installed bundle required');
const evidence = path.resolve(process.env.NAW_EVIDENCE_DIR || '');
assert.ok(process.env.NAW_EVIDENCE_DIR && !evidence.startsWith(root + path.sep), 'Private evidence outside repository required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; nothing launched'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Main', task: 'Installed workspace batch', pid: process.pid, token, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-installed-workspace-'));
const legacy = path.join(profile, 'workspace'); fs.mkdirSync(legacy);
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/process-groups.cjs'), '--require', path.join(__dirname, 'fixtures/collaboration-notices.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: legacy },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, sequence = 0; const checks = [], errors = [], launches = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const handler = packet => { if (packet.requestId !== id) return; clearTimeout(timer); child.off('message', handler); packet.error ? reject(Error(packet.error)) : resolve(packet); };
    const timer = setTimeout(() => { child.off('message', handler); reject(Error('Fixture response timeout')); }, 10000);
    child.on('message', handler); child.send({ id, method, target, value });
  });
}
const state = () => page.evaluate(() => workspace.initial());
const check = text => { checks.push(text); console.log('PASS: ' + text); };
const shot = name => page.screenshot({ path: path.join(evidence, name + '.png') });
async function launch() {
  app = await renderer.launch({ executablePath: process.env.NAW_APP_EXECUTABLE, env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) } });
  launches.push({ pid: app.process().pid, executable: process.env.NAW_APP_EXECUTABLE, code, rendererPort: app.port });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
}
async function open(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(name);
  return page.locator('#chosen-folder').innerText();
}
async function create(name) {
  const cwd = await open(name); await page.locator('#confirm-create').click(); await page.locator('#create-dialog').waitFor({ state: 'hidden' });
  await until(async () => (await state()).sessions.some(s => s.name === name && s.state === 'idle'), 'Created synthetic native session');
  const s = (await state()).sessions.find(s => s.name === name); assert.equal(s.cwd, cwd); return s;
}
const ids = s => s.sessions.map(x => [x.id, x.nativeId, x.owner, x.pid, x.cwd]);
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture service'); await launch();
  const cancelled = await open('Cancelled preview'); assert.equal(fs.existsSync(cancelled), false); await page.locator('#cancel-create').click(); assert.equal(fs.existsSync(cancelled), false);
  const a = await create('Installed process A'), b = await create('Installed process B');
  assert.notEqual(a.cwd, b.cwd); for (const s of [a, b]) { assert.equal(path.dirname(s.cwd), legacy + '-sessions'); assert.equal(fs.statSync(s.cwd).mode & 0o777, 0o700); assert.deepEqual(fs.readdirSync(s.cwd), []); }
  check('Hardened installed GUI creates distinct private folders only on submit, cancel creates nothing');
  const collision = await open('Retained collision'); fs.mkdirSync(collision); fs.writeFileSync(path.join(collision, 'keep'), 'ORIGINAL');
  await page.locator('#confirm-create').click(); await until(async () => (await page.locator('#create-error').innerText()).includes('已存在'), 'Visible collision');
  assert.equal(fs.readFileSync(path.join(collision, 'keep'), 'utf8'), 'ORIGINAL'); assert.equal(await page.locator('#session-name').inputValue(), 'Retained collision');
  assert.equal((await state()).sessions.length, 2); await page.locator('#cancel-create').click(); check('Collision retains original files/name and never launches a native session');
  const original = ids(await state()), before = await fixture('stats');
  const sash = page.locator('#sidebar-session-sash'), box = await sash.boundingBox(); assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 35, { steps: 8 }); await page.mouse.up();
  await until(async () => Array.isArray((await state()).sidebar.weights), 'Pointer sizing saved'); const weights = (await state()).sidebar.weights;
  await sash.press('ArrowUp'); await until(async () => JSON.stringify((await state()).sidebar.weights) !== JSON.stringify(weights), 'Keyboard sizing saved');
  const savedWeights = (await state()).sidebar.weights;
  await page.locator('#workspace-toggle').press('ArrowLeft'); await page.locator('#workspace-group-body').waitFor({ state: 'hidden' });
  await page.locator('#workspace-toggle').press('ArrowRight'); await page.locator('#workspace-group-body').waitFor({ state: 'visible' });
  await page.locator('#archive-button').click(); await page.locator('#archive-group-body').waitFor({ state: 'visible' }); assert.equal(await page.locator('#archive-dialog').count(), 0);
  const after = await fixture('stats'); for (const key of ['inputs', 'sends', 'opens']) assert.equal(after.stats[key], before.stats[key]);
  assert.deepEqual(ids(await state()), original); check('Pointer/keyboard section sizing and three folds persist metadata without controlling or sending to native sessions');
  await shot('01-installed-sidebar-and-private-folders');
  await page.locator('#message-input').fill('UNSENT_INSTALLED_DRAFT'); await until(async () => (await state()).sessions.find(s => s.id === b.id).liveDraft === 'UNSENT_INSTALLED_DRAFT', 'Unsent draft saved');
  await fixture('processTurn', b.id, { turnId: 'installed-native-turn', state: 'working' });
  const emit = (id, status, text) => fixture('nativeBlock', b.id, { id, kind: 'tool', title: 'Read', turnId: 'installed-native-turn', status, text });
  await emit('tool:one', 'complete', 'EXACT_FIRST_ORIGINAL'); await emit('tool:two', 'running', 'EXACT_SECOND_ORIGINAL 你好🙂');
  const group = page.locator('#messages [data-process-group]').first(); await group.waitFor();
  await until(() => group.locator(':scope > details').evaluate(el => el.open), 'Running process group open');
  await emit('tool:two', 'complete', 'EXACT_SECOND_ORIGINAL 你好🙂');
  await fixture('nativeBlock', b.id, { id: 'turn:installed-native-turn', kind: 'turn', turnId: 'installed-native-turn', status: 'complete', text: '' });
  await until(() => group.locator(':scope > details').evaluate(el => !el.open), 'Native turn closes group');
  await group.locator(':scope > details > summary').click(); assert.match(await group.innerText(), /2 次读取/);
  const rows = group.locator('[data-message-id]'); assert.equal(await rows.count(), 2);
  for (const row of await rows.all()) { const details = row.locator(':scope > details'); if (!await details.evaluate(el => el.open)) await details.locator(':scope > summary').click(); }
  assert.match(await group.innerText(), /EXACT_FIRST_ORIGINAL/); assert.match(await group.innerText(), /EXACT_SECOND_ORIGINAL 你好🙂/);
  await group.locator(':scope > details > summary').click(); check('Original tool messages stream inside one group, native completion closes it, user can expand every exact original');
  await shot('02-installed-native-process-group'); await app.close(); app = null; await launch();
  assert.deepEqual(ids(await state()), original); assert.deepEqual((await state()).sidebar.weights, savedWeights);
  assert.equal((await state()).sidebar.archiveCollapsed, false); assert.equal(await page.locator('#message-input').inputValue(), 'UNSENT_INSTALLED_DRAFT');
  await until(() => page.locator('#messages [data-process-group]').first().locator(':scope > details').evaluate(el => !el.open), 'Manual close survives reopen');
  check('Normal owned GUI close/reopen preserves native identities, unsent draft, section sizing, archive and manual group choices');
  for (const s of [a, b]) {
    await page.locator(`[data-session-id="${s.id}"]`).click();
    await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
  }
  await page.locator('#room-nav').click(); await page.locator('#room-overview').click();
  const noticeText = require('./fixtures/collaboration-notices.cjs').text;
  for (const width of [900, 1500]) {
    await page.setViewportSize({ width, height: 850 });
    const notice = page.locator(`.collaboration-member-reader[data-member-id="${a.id}"] [data-message-id="fixture-notice-${a.id}"]`);
    await notice.waitFor(); const body = notice.locator('.message-body'); assert.equal(await body.textContent(), noticeText);
    const size = await body.boundingBox(); assert.ok(size.width > 140, 'Original notice body has readable width');
    await notice.hover();
    const geometry = await notice.evaluate(el => Object.fromEntries(['.message-body', '.message-actions', '.message-heading'].map(selector => { const n = el.querySelector(selector); return [selector, { rect: n.getBoundingClientRect().toJSON(), display: getComputedStyle(n).display, position: getComputedStyle(n).position }]; })));
    fs.writeFileSync(path.join(evidence, 'notice-geometry-' + width + '.json'), JSON.stringify(geometry, null, 2)); await shot('notice-before-check-' + width);
    const bodyRect = geometry['.message-body'].rect, actions = geometry['.message-actions'].rect;
    assert.ok(actions.y >= bodyRect.bottom - 1, 'Copy actions remain below original notice');
    assert.equal(await notice.locator('.message-heading').evaluate(el => getComputedStyle(el).display), 'flex');
    await shot('03-installed-member-notice-' + width);
  }
  check('Narrow and wide collaboration readers retain exact native notice text, readable width and nonoverlapping copy actions');
  assert.deepEqual(errors, []); const stats = await fixture('stats'); assert.equal(stats.stats.inputs, 0); assert.equal(stats.stats.sends, 0);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, errors, launches, stats, profile, productModelCalls: 0, providers: 0, osClipboardOperations: 0, limits: ['Synthetic native transport', 'No OS picker or physical input', 'Native-provider recovery qualified separately'] }, null, 2));
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  try { if (app) await app.close(); await scratch.release(); assert.equal(fs.existsSync(profile), false); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
  catch (error) { console.error('Cleanup failed: ' + error.stack); process.exitCode = 1; }
});
