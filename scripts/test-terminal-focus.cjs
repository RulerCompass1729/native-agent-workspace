const testScratch = require('./fixtures/test-scratch.cjs');
// Headed app/IPC/workspace with controlled snapshot and claim timing.
// No native provider processes or model tasks are started.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright')), { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..'), profile = testScratch.directory(path.join(os.tmpdir(), 'naw-terminal-focus-'));
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require('../package.json').version, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [], passed = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target) { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } }; child.on('message', cb); child.send({ id, method, target });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const input = id => page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`);
const focused = id => input(id).evaluate(el => el === document.activeElement);
const text = async id => (await fixture('stats')).inputs.filter(x => x.id === id).map(x => x.data).join('');
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function chooseRoom(id) {
  if (!(await page.locator('#room-view').isVisible())) await page.locator('#room-nav').click();
  const tab = page.locator(`[data-room-session="${id}"]`); if (await tab.getAttribute('aria-pressed') !== 'true') await tab.click();
}
async function toChat(id) { await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click(); await page.locator('#message-input').waitFor(); }
async function holdAndChoose(id) { await fixture('hold-claim', id); await chooseRoom(id); await until(async () => (await fixture('stats')).claims.includes(id), 'Claim held'); }
async function run() {
  console.log('Fixture profile:', profile); await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service'); client = await connect(profile, 'focus-test');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  for (const provider of ['claude', 'codex']) {
    await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(provider + ' · 焦点测试'); await page.locator('#confirm-create').click();
    await until(async () => (await snapshot()).sessions.some(s => s.provider === provider), 'Created'); await page.getByRole('button', { name: '加入协作', exact: true }).click();
  }
  const [a, b] = (await snapshot()).sessions;
  await holdAndChoose(a.id); await until(async () => (await fixture('stats')).pending.includes(a.id), 'A snapshot'); await fixture('release', a.id);
  await input(a.id).waitFor({ state: 'visible' }); assert.equal(await page.locator('#terminal-paste').isDisabled(), true); assert.equal(await text(a.id), '');
  await fixture('release-claim', a.id);
  await until(() => focused(a.id), 'Snapshot-first terminal receives focus after control acknowledgement');
  await page.keyboard.type('FIRST-A'); await until(async () => await text(a.id) === 'FIRST-A', 'First input arrives exactly once');
  await capture('first-input');
  passed.push('Snapshot before control: first input goes to the selected member after acknowledgement');
  await toChat(a.id); await holdAndChoose(a.id); await chooseRoom(b.id);
  await until(async () => (await fixture('stats')).pending.includes(b.id), 'B snapshot'); await fixture('release', b.id); await until(() => focused(b.id), 'B focus');
  await fixture('release-claim', a.id); await delay(150); assert.equal(await focused(b.id), true);
  await page.keyboard.type('ONLY-B'); await until(async () => await text(b.id) === 'ONLY-B', 'Late A cannot redirect input'); assert.equal(await text(a.id), 'FIRST-A');
  passed.push('Late control acknowledgement cannot steal focus or redirect input from a newly selected member');
  await toChat(a.id); await holdAndChoose(a.id); await page.locator('#terminal-display').click();
  await fixture('release-claim', a.id); await delay(150);
  assert.equal(await page.locator('#terminal-display-dialog').evaluate(el => el.open && el.contains(document.activeElement)), true);
  await page.locator('#close-terminal-display').click(); await until(() => focused(a.id), 'Explicit dialog close restores terminal');
  passed.push('A late acknowledgement respects an open dialog; closing it returns to the terminal');
  await toChat(a.id); await holdAndChoose(a.id); await page.locator(`[data-session-menu="${b.id}"]`).click();
  await until(() => page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'), 'Menu has keyboard focus');
  await fixture('release-claim', a.id); await delay(150);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'), true);
  await page.keyboard.press('Escape'); assert.equal(await page.locator(`[data-session-menu="${b.id}"]`).getAttribute('aria-expanded'), 'false');
  passed.push('A late acknowledgement preserves another session menu and its keyboard focus');
  await toChat(a.id); await holdAndChoose(a.id); await page.locator('#room-record').click(); await page.locator('#shared-input').fill('保留共享草稿');
  await fixture('release-claim', a.id); await delay(150); assert.equal(await page.locator('#shared-input').evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator('#shared-input').inputValue(), '保留共享草稿'); assert.equal(await text(a.id), 'FIRST-A');
  passed.push('Leaving the member view for the shared draft cancels delayed focus');
  await toChat(a.id); await holdAndChoose(a.id); await fixture('fail-claim', a.id);
  await page.locator('#toast').filter({ hasText: 'Synthetic control failure' }).waitFor();
  assert.equal(await page.locator('#terminal-paste').isDisabled(), true); assert.equal(await focused(a.id), false);
  await delay(150); assert.equal((await snapshot()).sessions.find(s => s.id === a.id).view, 'chat'); assert.equal((await fixture('stats')).claims.length, 0);
  await page.locator(`[data-room-session="${a.id}"]`).click(); await until(() => focused(a.id), 'Explicit retry focuses');
  passed.push('Failed control change stays gated and reports the error; explicit reselection retries');
  await toChat(a.id); await holdAndChoose(a.id); await fixture('release-taken', a.id); await delay(150);
  assert.equal((await snapshot()).sessions.find(s => s.id === a.id).owner, 'other-test-view');
  assert.equal(await page.locator('#terminal-paste').isDisabled(), true); assert.equal(await focused(a.id), false);
  assert.equal(await text(a.id), 'FIRST-A'); await page.locator('#take-control').waitFor();
  passed.push('An intervening owner change keeps the view read-only; focus recovery never reclaims control');
  assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.equal(app.windows().length, 1); assert.deepEqual(errors, []); await capture('focus-complete');
  console.log(JSON.stringify({ passed, errors, nativeProviderProcesses: 0, nativeModelCalls: 0, oneWindow: true }));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
}));
