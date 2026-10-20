// Actual isolated Electron restarts on the current display. No provider calls,
// foreground windows, screen reconfiguration or changes to the user's profile.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = require('node:child_process'), { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-window-placement-ui-'));
const file = path.join(profile, 'views.json'), checks = [], errors = [];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, client, otherClient, sequence = 0;
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats') {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cb = value => { if (value.requestId === id) { clearTimeout(timer); child.off('message', cb); value.error ? reject(Error(value.error)) : resolve(value); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', cb); child.send({ id, method });
  });
}
async function launch(count) {
  assert.ok(!app);
  app = await _electron.launch({
    executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000,
  });
  await until(() => app.windows().length === count, 'Saved windows reopen');
  for (const page of app.windows()) {
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    await page.locator('#new-session').waitFor();
  }
}
async function close() { if (app) { const previous = app; app = null; await previous.close(); } }
async function geometry(page) {
  const handle = await app.browserWindow(page);
  const result = await handle.evaluate(w => ({ bounds: w.getBounds(), hidden: !w.isVisible(), focusable: w.isFocusable() }));
  await handle.dispose(); return result;
}
async function verify(page, id, draft, shared) {
  await until(async () => await page.locator('#message-input').inputValue() === draft, 'Draft restored');
  const state = await page.evaluate(() => workspace.initial());
  assert.equal(state.viewState.selected, id);
  assert.equal(state.viewState.mode, 'chat');
  assert.equal(state.viewState.sharedDraft, shared);
  const position = await geometry(page);
  assert.equal(position.hidden, true); assert.equal(position.focusable, false);
  return position.bounds;
}
async function shot(page, name) {
  if (!process.env.NAW_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service');
  client = await connect(profile, 'saved-placement-owner');
  const id = await client.call('create', { provider: 'codex', cwd: profile, name: '继续上次的工作', view: 'chat' });
  const draft = '重开后继续编辑，不自动发送', shared = '保留共同工作草稿';
  await client.call('draft', id, draft);
  const baseline = (await client.call('initial')).sessions.find(s => s.id === id);
  const connection = fs.readFileSync(path.join(profile, 'connection.json'), 'utf8');
  fs.writeFileSync(file, JSON.stringify([{
    owner: 'saved-placement-owner', active: true, selected: id, mode: 'chat', preference: 'chat',
    draft: { id, text: draft }, sharedDraft: shared, bounds: { x: 12000, y: 12000, width: 1100, height: 800 },
  }]), { mode: 0o600 });
  await launch(1);
  const page = app.windows()[0], recovered = await verify(page, id, draft, shared);
  const areas = await app.evaluate(({ screen }) => screen.getAllDisplays().map(display => display.workArea));
  assert.ok(areas.some(a => recovered.x >= a.x && recovered.y >= a.y &&
    recovered.x + recovered.width <= a.x + a.width && recovered.y + recovered.height <= a.y + a.height),
  'The recovered window, including its title bar, fits an actual current display');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[0].bounds, recovered);
  await shot(page, 'lost-display-recovered');
  checks.push('Actual saved offscreen window reopens completely inside a current display and persists its corrected position, selected conversation and drafts');
  await close();

  // Keep the first recovered position and add a deliberately partial placement.
  // This changes only synthetic saved data, never the user's display settings.
  otherClient = await connect(profile, 'partial-placement-owner');
  const otherId = await otherClient.call('create', { provider: 'claude', cwd: profile, name: '另一个窗口', view: 'chat' });
  const otherDraft = '第二个独立草稿', otherShared = '第二个共同工作草稿';
  await otherClient.call('draft', otherId, otherDraft);
  const area = areas.find(a => recovered.x >= a.x && recovered.x < a.x + a.width);
  const partial = { x: area.x - 200, y: area.y + 30, width: Math.min(1000, area.width), height: Math.min(700, area.height - 30) };
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.push({
    owner: 'partial-placement-owner', active: true, selected: otherId, mode: 'chat', preference: 'chat',
    draft: { id: otherId, text: otherDraft }, sharedDraft: otherShared, bounds: partial,
  });
  fs.writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  await launch(2);
  let first, second;
  for (const p of app.windows()) {
    const selected = (await p.evaluate(() => workspace.initial())).viewState.selected;
    if (selected === id) first = p; else if (selected === otherId) second = p;
  }
  assert.ok(first && second);
  assert.deepEqual(await verify(first, id, draft, shared), recovered);
  assert.deepEqual(await verify(second, otherId, otherDraft, otherShared), partial);
  await shot(second, 'intentional-partial-placement');
  checks.push('Restart retains the corrected position exactly and preserves a second intentionally partial window, with independent drafts and no duplicate session');
  await close(); await launch(2);
  const bounds = [];
  for (const p of app.windows()) bounds.push((await geometry(p)).bounds);
  assert.ok(bounds.some(b => JSON.stringify(b) === JSON.stringify(recovered)));
  assert.ok(bounds.some(b => JSON.stringify(b) === JSON.stringify(partial)));
  checks.push('A further restart retains both usable positions exactly');
  await close();
  const undersized = JSON.parse(fs.readFileSync(file, 'utf8'));
  undersized.find(v => v.selected === id).bounds = { x: area.x + 40, y: area.y + 40, width: 100, height: 100 };
  fs.writeFileSync(file, JSON.stringify(undersized), { mode: 0o600 });
  await launch(2);
  let smallWindow;
  for (const p of app.windows()) if ((await p.evaluate(() => workspace.initial())).viewState.selected === id) smallWindow = p;
  const usable = await verify(smallWindow, id, draft, shared);
  assert.ok(usable.width >= Math.min(850, area.width) && usable.height >= Math.min(600, area.height));
  const smallHandle = await app.browserWindow(smallWindow);
  assert.deepEqual(await smallHandle.evaluate(w => w.getMinimumSize()), [Math.min(850, area.width), Math.min(600, area.height)]);
  await smallHandle.dispose();
  await shot(smallWindow, 'undersized-record-recovered');
  const final = await client.call('initial');
  assert.equal(final.sessions.length, 2);
  assert.equal(final.sessions.find(s => s.id === id).nativeId, baseline.nativeId);
  assert.equal(fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'), connection);
  const stats = (await fixture()).stats;
  assert.deepEqual(stats, { opens: 0, inputs: 0, resizes: 0, sends: 0 });
  assert.deepEqual(errors, []);
  checks.push('An accessible but undersized saved window recovers the usable native minimum; existing service, identities and drafts survive all restarts with zero provider activity');
  console.log(JSON.stringify({ checks, recovered, partial, usable, stats, errors, modelTasks: 0 }, null, 2));
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); }
  otherClient?.close();
  if (child.connected) child.disconnect();
  await until(() => child.exitCode !== null, 'Owned test daemon exits');
});
