const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual Electron layout and IPC; no providers, inference or global clipboard.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-terminal-layout-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const delay = ms => new Promise(r => setTimeout(r, ms));
let app, page, client, sequence = 0;
const errors = [], observations = [];
async function until(fn, label) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 10000);
  const cb = r => { if (r.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(r); } }; child.on('message', cb); child.send({ id, method, target, value });
}); }
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service'); client = await connect(profile, 'layout-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#session-name').fill('Layout task'); await createIn(page, 'chat');
  const snap = () => page.evaluate(() => workspace.initial());
  await until(async () => (await snap()).sessions[0]?.state === 'idle', 'Created'); const id = (await snap()).sessions[0].id;
  await fixture('nativeBlock', id, { id: 'reply', role: 'assistant', kind: 'text', text: 'Original native output', status: 'complete' });
  await until(async () => (await fixture('stats')).pending.includes(id), 'Snapshot pending'); await fixture('release', id);
  await page.locator('.terminal-surface').waitFor({ state: 'visible' });
  await app.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { ServiceClient } = load('./app/service-client.cjs'), call = ServiceClient.prototype.call;
    globalThis.layoutResizes = []; ServiceClient.prototype.call = function (method, ...args) { if (method === 'resize') globalThis.layoutResizes.push(args); return call.call(this, method, ...args); };
  });
  await page.locator('#message-input').fill('Unsent task draft');
  await fixture('set-owner', id, 'migration-connection'); await until(() => page.locator('#message-input').evaluate(el => el.readOnly), 'Observer is readonly');
  await page.locator('#take-control').click(); await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Takeover editable');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent task draft');
  await delay(250);
  await page.evaluate(() => {
    window.layoutChurn = { removed: 0, mutations: 0 }; const surface = document.querySelector('.terminal-surface');
    new MutationObserver(records => { for (const r of records) { window.layoutChurn.mutations++; window.layoutChurn.removed += r.removedNodes.length; } }).observe(surface, { childList: true, attributes: true });
  });
  const before = await app.evaluate(() => globalThis.layoutResizes.length);
  for (let i = 0; i < 20; i++) { await fixture('state', id); await delay(40); }
  await delay(200); const after = await app.evaluate(() => globalThis.layoutResizes.length);
  const geometry = await page.evaluate(() => {
    const area = document.querySelector('#terminal-area').getBoundingClientRect(), screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { area: { width: area.width, height: area.height }, screen: { width: screen.width, height: screen.height }, churn: window.layoutChurn };
  });
  observations.push({ check: 'Stable native pane during twenty state updates', resizeCalls: after - before, geometry }); console.log(JSON.stringify(observations)); await capture('stable-layout');
  assert.ok(geometry.screen.width <= geometry.area.width, 'Native columns fit the pane');
  assert.ok(geometry.screen.height <= geometry.area.height, 'Native rows fit the pane');
  assert.equal(geometry.churn.removed, 0, 'State updates retain the terminal surface');
  assert.equal(after - before, 0, 'Unchanged geometry must not issue resize requests');
  const rows = page.locator(`[data-terminal-id="${id}"] .xterm-rows`);
  let nativeSequence = 0;
  const output = data => fixture('terminal', id, { data, sequence: ++nativeSequence, cols: 53, rows: 30 });
  await output('\x1b[1;1H\x1b[JOriginal stable native frame');
  await until(async () => (await rows.textContent()).includes('Original stable native frame'), 'Initial native frame');
  await output('\x1b[1;1H\x1b[J');
  await until(async () => !(await rows.textContent()).trim(), 'Native clear appears unchanged');
  await output('Native content after intentional clear');
  await until(async () => (await rows.textContent()).includes('Native content after intentional clear'), 'Later native content remains visible');
  observations.push({ check: 'Native output and intentional clear pass through unchanged' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 650));
  await delay(250);
  const changed = await app.evaluate(() => globalThis.layoutResizes.length); assert.ok(changed > after, 'Window resizing sends new native dimensions');
  await fixture('state', id); await delay(200); assert.equal(await app.evaluate(() => globalThis.layoutResizes.length), changed, 'The new size settles without another resize loop');
  await page.locator('#terminal-maximize').click(); await delay(250);
  const maximized = await app.evaluate(() => globalThis.layoutResizes.length); assert.ok(maximized > changed, 'Maximizing the terminal resizes the original display');
  await page.locator('#terminal-maximize').click(); await delay(250);
  await fixture('set-owner', id, 'other-window'); await until(() => page.locator('#message-input').evaluate(el => el.readOnly), 'Owner change keeps input gated');
  const beforeObserver = await app.evaluate(() => globalThis.layoutResizes.length);
  await page.evaluate(() => window.workspace.stageImages('not-a-session', 'not-a-native-thread', [Uint8Array.of(1)]).then(() => { throw Error('Unexpected import'); }, e => { window.rejectedImage = e.message; }));
  assert.ok(await page.evaluate(() => window.rejectedImage));
  await fixture('state', id); await delay(200); assert.equal(await app.evaluate(() => globalThis.layoutResizes.length), beforeObserver, 'Readonly views never resize the native process');
  await page.locator('#take-control').click(); await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Retake original display'); await delay(250);
  assert.ok(await app.evaluate(() => globalThis.layoutResizes.length) > beforeObserver, 'Taking control reapplies the current visible geometry');
  await capture('resized-and-retaken');
  assert.equal((await snap()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ observations, resized: changed > after, maximized: maximized > changed, observerDoesNotResize: true, retakeResizes: true, modelTasks: 0 }));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
}));
