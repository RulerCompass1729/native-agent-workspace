// Hidden desktop regression: the real app and service, whose connection the service's side ends. The window must
// work again without the person, with its draft kept and no input sent twice. Synthetic native transport, no model.
const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork, execFileSync } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..');
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-service-reconnect-'));
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/connection-drop.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(root, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [], draft = '草稿：断开后保留';
let app, page, sequence = 0, output = 0;
async function until(fn, label, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await delay(50)) if (await fn()) return;
  throw Error(typeof label === 'function' ? await label() : label);
}
function fixture(method, target, value, reply = 'requestId') {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = result => { if (result[reply] === id) { clearTimeout(timer); child.off('message', callback); resolve(result); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 8000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
const drop = refuseMs => fixture('drop-connections', null, refuseMs, 'dropId');
const snapshot = () => page.evaluate(() => workspace.initial());
const events = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'connection-events.json'), 'utf8')); } catch { return []; } };
const restoredCount = () => events().filter(e => e.event === 'restored').length;
const banner = () => page.evaluate(() => ({ button: !document.getElementById('reconnect-button').hidden, alert: document.getElementById('alert').hidden ? '' : document.getElementById('alert').textContent, shown: window.reconnectButtonShown }));
// The lock state is recorded, not required: the run reports which state it covered.
function screenLocked() {
  try { return /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], { encoding: 'utf8' })); }
  catch { return null; }
}
async function worksAgain(id, label, inputs) {
  const state = await snapshot();
  assert.equal(state.sessions[0].id, id, label + ': the same session');
  assert.equal(await page.locator('#message-input').inputValue(), draft, label + ': the draft is kept');
  assert.equal((await fixture('inspect')).inputs, inputs, label + ': no input was sent again');
  const text = `AFTER_${++output}_OUTPUT`;
  await fixture('terminal-output', id, { epoch: state.sessions[0].terminalState.epoch, sequence: output, data: `\r\n${text}` });
  await page.locator('#terminal-tab').click();
  await page.locator('#terminal-area').getByText(text, { exact: false }).waitFor();
  await page.locator('#terminal-area .xterm-helper-textarea').press('k');
  await until(async () => (await fixture('inspect')).inputs === inputs + 1, label + ': a new key reaches the session once');
  await page.locator('#chat-tab').click();
  return inputs + 1;
}
async function run() {
  const lockedAtStart = screenLocked();
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill('断连自动恢复'); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions[0]?.state === 'idle', 'Ready');
  const id = (await snapshot()).sessions[0].id;
  await page.locator('#message-input').fill(draft);
  await page.locator('#terminal-tab').click(); await page.locator('#terminal-area .xterm-screen').waitFor();
  await until(async () => (await snapshot()).sessions[0].terminalState?.alive, 'Display alive');
  await fixture('accept-input', id, true);
  await page.locator('#terminal-area .xterm-helper-textarea').press('a');
  await until(async () => (await fixture('inspect')).inputs === 1, 'Input before the connection closes');
  await page.locator('#chat-tab').click();
  await page.evaluate(() => {
    window.reconnectButtonShown = 0; const button = document.getElementById('reconnect-button');
    new MutationObserver(() => { if (!button.hidden) window.reconnectButtonShown++; }).observe(button, { attributes: true });
  });
  let inputs = 1;

  assert.ok((await drop(0)).dropped >= 1, 'The service closed this window\'s connection');
  await until(() => restoredCount() === 1, async () => `The window stayed disconnected after the service closed its connection: ${JSON.stringify(await banner())}`);
  assert.deepEqual(await banner(), { button: false, alert: '', shown: 0 }, 'A connection that is back at once shows no notice');
  inputs = await worksAgain(id, 'Brief close', inputs);
  checks.push('A connection the service closed is back without the person and without a notice; draft kept, nothing sent again, terminal output and input continue');

  await drop(4000);
  await until(async () => (await banner()).button, 'An outage past three seconds shows the existing notice', 6000);
  assert.equal((await banner()).alert, '本地服务断开。草稿已保留，不会自动重发输入。');
  await until(async () => restoredCount() === 2 && !(await banner()).button, async () => `The notice did not clear by itself: ${JSON.stringify(await banner())}`, 20000);
  assert.equal((await banner()).alert, '');
  inputs = await worksAgain(id, 'Longer outage', inputs);
  checks.push('While the service refuses connections the existing notice shows; it clears by itself when the service accepts again, with no click');

  // The service ends a connection whose reader has stopped for long enough (service-transport.cjs createWriter).
  const frames = 4000, epoch = (await snapshot()).sessions[0].terminalState.epoch;
  const held = app.evaluate(() => { const end = Date.now() + 2500; while (Date.now() < end); });
  await delay(300);
  for (let i = 0; i < frames; i++) child.send({ id: 0, method: 'terminal-output', target: id, value: { epoch, sequence: ++output, data: 'x'.repeat(64) } });
  await held;
  await until(() => restoredCount() === 3, async () => `A held main process did not end with a restored connection: ${JSON.stringify(events().slice(-3))} ${JSON.stringify(await banner())}`, 15000);
  const closed = events().filter(e => e.event === 'closed').at(-1);
  assert.ok(closed.loopDelayMs >= 1500, `The record names the held event loop: ${JSON.stringify(closed)}`);
  inputs = await worksAgain(id, 'Held main process', inputs);
  checks.push(`A main process held for 2.5 s while ${frames} terminal frames arrive loses its connection (${closed.reasons.join(',')}, loopDelayMs ${closed.loopDelayMs}) and gets it back by itself`);

  assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.equal(app.windows().length, 1); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, events: events(), screenLocked: { start: lockedAtStart, end: screenLocked() }, modelTasks: 0, nativeProcesses: 0, errors }, null, 2));
}
run().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close(); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}));
