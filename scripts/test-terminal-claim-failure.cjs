const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// T-152: a ready terminal takes the keyboard at once while its control change is pending, and holds what is typed.
// When that change fails or another view takes control, the status stops saying input is held, the keyboard moves
// off the terminal to the native pane (nothing there can be pressed: no retry, no 接管), text typed while waiting is
// kept, and nothing typed reaches the native terminal; choosing 原生终端 retries. Focus elsewhere in the terminal's
// host (its unsent-input box) is left alone. Headed app/IPC/workspace with controlled claim timing; no native
// processes or model tasks.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright')), { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..'), profile = testScratch.directory(path.join(os.tmpdir(), 'naw-claim-failure-'));
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require('../package.json').version, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [], passed = [], measurements = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target) { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } }; child.on('message', cb); child.send({ id, method, target });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function run() {
  console.log('Fixture profile:', profile); await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service'); client = await connect(profile, 'claim-failure-test');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check(); await page.locator('#session-name').fill('claude · 认领失败'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.length === 1, 'Created'); const id = (await snapshot()).sessions[0].id;
  const input = page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`), recovery = page.locator(`[data-terminal-id="${id}"] .terminal-input-recovery`);
  const sent = async () => (await fixture('stats')).inputs.filter(x => x.id === id).map(x => x.data).join('');
  const where = () => page.evaluate(terminal => {
    const active = document.activeElement;
    return { status: document.querySelector('#session-status').textContent, onPane: active?.id === 'native-pane', inTerminal: Boolean(active?.closest(`[data-terminal-id="${terminal}"] .terminal-surface`)),
      onTab: active?.id === 'terminal-tab', onTakeControl: active?.id === 'take-control', label: active?.id || active?.textContent?.trim().slice(0, 20) || active?.tagName };
  }, id);
  const record = () => snapshot().then(s => s.sessions.find(x => x.id === id));
  const toChat = async () => { await page.locator('#chat-tab').click(); await until(async () => (await record()).view === 'chat', 'Chat view settled'); };
  const holdAndOpen = async () => {
    await fixture('hold-claim', id); await page.locator('#terminal-tab').click();
    await until(async () => (await fixture('stats')).claims.includes(id), 'Control change held');
    await until(() => input.evaluate(el => el === document.activeElement), 'The ready terminal takes the keyboard while control is pending');
    assert.ok((await where()).status.includes('输入暂存，尚未发送'), 'While control is pending the status says input is held');
  };

  // A ready terminal: open it once.
  await page.locator('#terminal-tab').click(); await until(async () => (await fixture('stats')).pending.includes(id), 'Snapshot');
  await fixture('release', id); await until(() => input.evaluate(el => el === document.activeElement), 'Terminal ready');

  // 1. The control change fails before anything is typed.
  await toChat(); await holdAndOpen(); await fixture('fail-claim', id);
  await page.locator('#toast').filter({ hasText: 'Synthetic control failure' }).waitFor();
  const failed = await where(); measurements.push({ failed });
  assert.equal(failed.status.includes('输入暂存'), false, `After the failure the status no longer says input is held (${failed.status})`);
  // T-154: the terminal is still shown but takes no keys; the status says so, and how to retry.
  assert.ok(failed.status.endsWith(' · 终端未接通，可点「原生终端」重试'), `The status says the terminal is not connected (${failed.status})`);
  assert.equal(failed.inTerminal, false, 'The keyboard left the terminal'); assert.equal(failed.onPane, true, `The keyboard is on the native pane (${failed.label})`);
  // Keep typing, with a space and Enter: nothing is pressed, nothing retries, nothing is sent.
  await page.keyboard.type('ab cd'); await page.keyboard.press('Enter'); await page.keyboard.press('Space'); await delay(300);
  const typedOn = await where(); measurements.push({ typedOn });
  assert.equal((await record()).view, 'chat', 'Typing after the failure does not retry the control change'); assert.equal(await sent(), '', 'Nothing typed after the failure reaches the terminal');
  assert.equal(typedOn.status.includes('输入暂存'), false); assert.equal(typedOn.onPane, true, 'The keyboard stays on the native pane');
  await capture('01-failed');
  await page.locator('#terminal-tab').click();
  await until(async () => (await record()).view === 'terminal', 'Choosing 原生终端 retries the control change');
  await until(() => input.evaluate(el => el === document.activeElement), 'After the retry the terminal takes the keyboard');
  assert.equal(await page.locator('#native-pane').getAttribute('tabindex'), null, 'The pane is not left in the tab order');
  await until(async () => !(await where()).status.includes('终端未接通'), 'After the retry the status no longer says the terminal is not connected');
  await page.keyboard.type('RETRY'); await until(async () => await sent() === 'RETRY', 'Typing after the retry reaches the terminal once');
  passed.push('A failed control change: the status stops saying input is held, the keyboard moves to the native pane, typing on (space and Enter included) neither retries nor sends, and choosing 原生终端 retries');

  // 2. Another view takes control after text was typed while waiting.
  await toChat(); await holdAndOpen(); await page.keyboard.type('TAKEN');
  await fixture('release-taken', id);
  await until(async () => (await record()).owner === 'other-test-view', 'Another view took control');
  await recovery.waitFor(); await page.locator('#take-control').waitFor();
  const taken = await where(); measurements.push({ taken, kept: await recovery.locator('textarea').inputValue() });
  assert.equal(taken.status.includes('输入暂存'), false, `The status no longer says input is held (${taken.status})`); assert.ok(taken.status.includes('另一个窗口控制'), taken.status);
  assert.equal(taken.status.includes('终端未接通'), false, 'Under another window\'s control the status says that, not that a retry would help');
  assert.equal(taken.inTerminal, false); assert.equal(taken.onPane, true, `The keyboard is on the native pane (${taken.label})`); assert.equal(taken.onTakeControl, false, 'The keyboard is never put on 接管');
  assert.equal(await recovery.locator('textarea').inputValue(), 'TAKEN', 'What was typed while waiting is kept, not sent');
  await page.keyboard.type('NO PE'); await page.keyboard.press('Enter'); await delay(300);
  assert.equal(await sent(), 'RETRY', 'Nothing typed while waiting or afterwards reaches the terminal'); assert.equal((await record()).owner, 'other-test-view', 'Typing never takes control back');
  await capture('02-taken');
  passed.push('Control taken by another view: the status says so and not that input is held, the keyboard moves to the native pane (not 接管), the text typed while waiting is kept, nothing typed reaches the terminal or takes control');

  // 3. Taken before anything is typed, while the person has moved to the unsent-input box (still open from case 2):
  // the status is corrected and the keyboard stays where the person put it.
  await page.locator('#take-control').click(); await until(async () => (await record()).owner === (await snapshot()).owner, 'Explicit takeover');
  await until(() => input.evaluate(el => el === document.activeElement), 'Terminal after takeover');
  await toChat(); await holdAndOpen(); assert.ok(await recovery.isVisible(), 'The unsent-input box is still open');
  const dismiss = recovery.getByRole('button', { name: '关闭提示', exact: true }); await dismiss.focus();
  await fixture('release-taken', id);
  await until(async () => (await record()).owner === 'other-test-view', 'Taken again');
  await until(async () => !(await where()).status.includes('输入暂存'), 'The status no longer says input is held');
  const quiet = await where(); measurements.push({ quiet });
  assert.ok(await dismiss.evaluate(el => el === document.activeElement), `Focus stays on the unsent-input box's button (${quiet.label})`); assert.equal(await sent(), 'RETRY');
  await dismiss.click(); await recovery.waitFor({ state: 'hidden' });
  passed.push('Taken with nothing typed: the status is corrected at once; focus the person had put in the unsent-input box stays there');

  assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.equal(app.windows().length, 1); assert.deepEqual(errors, []); await capture('03-complete');
  console.log(JSON.stringify({ passed, measurements, errors, nativeProviderProcesses: 0, nativeModelCalls: 0, oneWindow: true }));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
}));
