// Headed desktop regression; real renderer/IPC with delayed synthetic terminals.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process');
const { _electron } = require('playwright'), { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..'), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-terminal-ready-'));
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require('../package.json').version, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, client, seq = 0; const errors = [], passed = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function native(method, target) { const id = ++seq; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } }; child.on('message', cb); child.send({ id, method, target });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const host = id => page.locator(`[data-terminal-id="${id}"]`);
const input = id => host(id).locator('.xterm-helper-textarea');
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function checkLoading(id) {
  await until(async () => (await native('stats')).pending.includes(id), 'Snapshot pending');
  await native('state', id); await delay(150); // A regular state render must not enable stdin.
  await capture('connecting');
  assert.equal(await input(id).isVisible(), false, 'Loading terminal must not expose an editable input');
  assert.equal(await page.locator('#terminal-paste').isDisabled(), true);
  await host(id).getByRole('status').getByText('正在连接原生终端…', { exact: true }).waitFor();
}
async function run() {
  console.log('Fixture profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service'); client = await connect(profile, 'terminal-test');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  for (const provider of ['claude', 'codex']) {
    await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(provider + ' terminal test'); await page.locator('#confirm-create').click();
    await until(async () => (await snapshot()).sessions.some(s => s.provider === provider), 'Created'); await page.getByRole('button', { name: '加入协作', exact: true }).click();
  }
  const [a, b] = (await snapshot()).sessions;
  await page.locator('#room-nav').click(); await page.locator(`[data-room-session="${a.id}"]`).click(); await checkLoading(a.id);
  // Switching away from a loading member must not defer any input to it.
  await page.locator(`[data-room-session="${b.id}"]`).click(); await checkLoading(b.id); await native('release', b.id);
  await input(b.id).waitFor({ state: 'visible' }); await until(async () => await input(b.id).evaluate(el => el === document.activeElement), 'Ready terminal focused');
  await page.keyboard.type('FIRST-B'); await until(async () => (await native('stats')).inputs.filter(x => x.id === b.id).map(x => x.data).join('') === 'FIRST-B', 'First input reaches B');
  await native('release', a.id); await delay(150); assert.equal(await input(b.id).evaluate(el => el === document.activeElement), true, 'Late A must not steal focus');
  await page.keyboard.type('-STILL-B');
  await until(async () => (await native('stats')).inputs.filter(x => x.id === b.id).map(x => x.data).join('') === 'FIRST-B-STILL-B', 'No dropped B input');
  assert.equal((await native('stats')).inputs.some(x => x.id === a.id), false); passed.push('Room loading, state updates and late completion preserve input target');
  await page.locator(`[data-session-id="${a.id}"]`).click(); await page.locator('#terminal-tab').click();
  await until(async () => await input(a.id).evaluate(el => el === document.activeElement), 'Solo terminal focused'); await page.keyboard.type('FIRST-A');
  await until(async () => (await native('stats')).inputs.filter(x => x.id === a.id).map(x => x.data).join('') === 'FIRST-A', 'Solo input'); passed.push('Same terminal remains usable from solo view');
  await native('replace', a.id); await checkLoading(a.id);
  await native('replace', a.id); await until(async () => (await native('stats')).pending.filter(id => id === a.id).length === 2, 'Replacement snapshot');
  await native('release', a.id); await delay(100); await checkLoading(a.id);
  await native('release', a.id); await until(async () => await input(a.id).evaluate(el => el === document.activeElement), 'Current generation ready');
  await page.keyboard.type('-CURRENT'); await until(async () => (await native('stats')).inputs.filter(x => x.id === a.id).map(x => x.data).join('') === 'FIRST-A-CURRENT', 'Only current generation input');
  passed.push('Superseded snapshot cannot enable stale input');
  await native('replace', a.id); await checkLoading(a.id); await native('fail', a.id);
  await host(a.id).getByText('终端未连接，重新选择此会话或视图可重试。', { exact: true }).waitFor();
  assert.equal(await input(a.id).isVisible(), false); assert.equal(await page.locator('#terminal-paste').isDisabled(), true);
  await page.locator('#terminal-tab').click(); await checkLoading(a.id); await native('release', a.id);
  await until(async () => await input(a.id).evaluate(el => el === document.activeElement), 'Retry focuses live input');
  passed.push('Failure stays noninteractive and explicit view retry works');
  assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.equal(app.windows().length, 1); assert.deepEqual(errors, []); await capture('ready');
  console.log(JSON.stringify({ passed, errors, nativeModelCalls: 0, providerProcesses: 0, oneWindow: true }));
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
});
