const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// 887d9fea (the person, 2026-11-13: 「对于 Claude 和 codex 这样支持的,我希望两边的输入可以不要锁定」): the window that
// controls a session types into its native terminal and its conversation box whichever side the session's view is on.
// T-152/T-154 held terminal keys while a view change was pending and stopped the terminal after a failed one; now:
// 1. With the change to the terminal side held, and after it fails, keys reach the terminal at once, the status says
//    nothing about held input or an unconnected terminal, and choosing 原生终端 still moves the view.
// 2. The person alternates once each way, typing in the conversation box and in the terminal while the view is held on
//    the other side: the terminal receives exactly what was typed in it, the draft is exactly what was typed in the box.
// 3. When another view takes control, keys stop reaching the terminal, the status says so, 接管此窗口 shows and never
//    gets the keyboard, and typing never takes control back.
// Hidden app/IPC/workspace with controlled claim timing; no native processes or model tasks.
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
  const input = page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`), composer = page.locator('#message-input');
  const sent = async () => (await fixture('stats')).inputs.filter(x => x.id === id).map(x => x.data).join('');
  const where = () => page.evaluate(terminal => {
    const active = document.activeElement;
    return { status: document.querySelector('#session-status').textContent, inTerminal: Boolean(active?.closest(`[data-terminal-id="${terminal}"] .terminal-surface`)),
      onTakeControl: active?.id === 'take-control', label: active?.id || active?.textContent?.trim().slice(0, 20) || active?.tagName };
  }, id);
  const record = () => snapshot().then(s => s.sessions.find(x => x.id === id));
  const toChat = async () => { await page.locator('#chat-tab').click(); await until(async () => (await record()).view === 'chat', 'Chat view settled'); };
  const toTerminal = async () => { await page.locator('#terminal-tab').click(); await until(async () => (await record()).view === 'terminal', 'Terminal view settled'); };
  const held = () => until(async () => (await fixture('stats')).claims.includes(id), 'Control change held');
  const noHeldInputNote = status => !/输入暂存|终端未接通/.test(status);

  // A ready terminal: open it once.
  await page.locator('#terminal-tab').click(); await until(async () => (await fixture('stats')).pending.includes(id), 'Snapshot');
  await fixture('release', id); await until(() => input.evaluate(el => el === document.activeElement), 'Terminal ready');

  // 1. The change to the terminal side is held, then fails.
  await toChat(); await fixture('hold-claim', id); await page.locator('#terminal-tab').click(); await held();
  await until(() => input.evaluate(el => el === document.activeElement), 'The ready terminal takes the keyboard while the change is pending');
  await page.keyboard.type('AB'); await until(async () => await sent() === 'AB', 'Keys typed while the change is pending reach the terminal at once');
  const pending = await where(); measurements.push({ pending });
  assert.equal((await record()).view, 'chat', 'The keys reached the terminal while the view was still on the conversation side');
  assert.ok(noHeldInputNote(pending.status), `The status says nothing about held input (${pending.status})`);
  await fixture('fail-claim', id); await page.locator('#toast').filter({ hasText: 'Synthetic control failure' }).waitFor();
  const failed = await where(); measurements.push({ failed });
  assert.ok(noHeldInputNote(failed.status), `After the failure the status says nothing about held input or an unconnected terminal (${failed.status})`);
  assert.equal(failed.inTerminal, true, `The keyboard stays in the terminal (${failed.label})`);
  await page.keyboard.type('CD'); await until(async () => await sent() === 'ABCD', 'Keys typed after the failure reach the terminal');
  assert.equal((await record()).view, 'chat', 'Typing does not retry the view change');
  await capture('01-failed');
  await toTerminal(); await until(() => input.evaluate(el => el === document.activeElement), 'After choosing 原生终端 the terminal has the keyboard');
  await page.keyboard.type('EF'); await until(async () => await sent() === 'ABCDEF', 'Typing after the view change reaches the terminal once');
  passed.push('With the change to the terminal side pending and after it fails, keys reach the terminal at once with no held-input note, and choosing 原生终端 still moves the view');

  // 2. Alternate once each way while the view is held on the other side.
  const box = '对话里写一句', keys = 'TERM 12';
  await fixture('hold-claim', id); await composer.click(); await held();
  assert.equal((await record()).view, 'terminal'); assert.equal(await composer.evaluate(el => el.readOnly), false, 'The conversation box is editable while the view is on the terminal side');
  await page.keyboard.type(box); await until(async () => (await record()).liveDraft === box, 'Text typed in the box while the view is on the terminal side becomes the draft');
  await fixture('release-claim', id); await until(async () => (await record()).view === 'chat', 'The view followed to the conversation side');
  await fixture('hold-claim', id); await input.click(); await held();
  await until(() => input.evaluate(el => el === document.activeElement), 'The terminal has the keyboard');
  await page.keyboard.type(keys); await until(async () => await sent() === 'ABCDEF' + keys, 'Keys typed in the terminal while the view is on the conversation side reach it');
  assert.equal((await record()).view, 'chat');
  await fixture('release-claim', id); await until(async () => (await record()).view === 'terminal', 'The view followed to the terminal side');
  await delay(300);
  const after = await record(); measurements.push({ terminal: await sent(), draft: after.liveDraft, box: await composer.inputValue() });
  assert.equal(await sent(), 'ABCDEF' + keys, 'The terminal received exactly what was typed in it: nothing from the box, nothing lost');
  assert.equal(after.liveDraft, box, 'The draft is exactly what was typed in the box: nothing from the terminal');
  assert.equal(await composer.inputValue(), box, 'The box still shows its text');
  await capture('02-alternate');
  passed.push('Typing alternately in the conversation box and the terminal, each while the view is held on the other side: the terminal gets exactly its keys and the draft exactly the box text');

  // 3. Another view takes control during a pending change.
  await toChat(); await fixture('hold-claim', id); await input.click(); await held();
  await page.keyboard.type('GH'); await until(async () => (await sent()).endsWith('GH'), 'Keys before the takeover reach the terminal');
  await fixture('release-taken', id);
  await until(async () => (await record()).owner === 'other-test-view', 'Another view took control');
  await page.locator('#take-control').waitFor();
  const taken = await where(); measurements.push({ taken });
  assert.ok(taken.status.includes('另一个窗口控制'), taken.status); assert.ok(noHeldInputNote(taken.status), taken.status);
  assert.equal(taken.onTakeControl, false, 'The keyboard is never put on 接管');
  const before = await sent();
  await page.keyboard.type('NO PE'); await page.keyboard.press('Enter'); await delay(300);
  assert.equal(await sent(), before, 'Nothing typed after another view took control reaches the terminal');
  assert.equal((await record()).owner, 'other-test-view', 'Typing never takes control back');
  await capture('03-taken');
  passed.push('Control taken by another view: keys stop reaching the terminal, the status says so, 接管此窗口 shows without the keyboard, typing never takes control back');

  assert.equal((await fixture('stats')).sends.length, 0, 'Nothing was sent as a message');
  assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.equal(app.windows().length, 1); assert.deepEqual(errors, []); await capture('04-complete');
  console.log(JSON.stringify({ passed, measurements, errors, nativeProviderProcesses: 0, nativeModelCalls: 0, oneWindow: true }));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
}));
