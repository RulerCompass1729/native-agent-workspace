// Real desktop/IPC/workspace, synthetic delayed replies. No native processes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process');
const { _electron } = require('playwright'), { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..'), profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-room-send-'));
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/delayed-native.cjs')], env: { ...process.env, NAW_APP_VERSION: require('../package.json').version, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [], passed = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function native(method, reply = '', fail = false) { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } }; child.on('message', cb); child.send({ id, method, reply, fail });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(provider + ' · 共享测试'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider), 'Created'); await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click(); return (await snapshot()).sessions.find(s => s.provider === provider).id;
}
async function sent(count, id, text) {
  await until(async () => (await native('stats')).sends.length === count, 'Exact dispatch count'); assert.deepEqual((await native('stats')).sends.at(-1), { id, text });
}
async function complete(reply) { await native('release', reply); await until(async () => (await snapshot()).sessions.every(s => !s.pendingTag), 'Reply settles'); }
async function launch() {
  assert.ok(!app, 'One test UI at a time');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
}
async function run() {
  console.log('Fixture profile:', profile); await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon'); client = await connect(profile, 'room-test'); await launch();
  const a = await create('claude'); await page.locator('#recipient').selectOption(a); await page.locator('#shared-input').fill('单一接收方');
  // Test the HTML form default contract separately from real pointer/keyboard activation.
  await page.locator('#room-composer').evaluate(form => form.requestSubmit()); await sent(1, a, '单一接收方'); assert.equal((await snapshot()).room.run, null); await complete('FIRST-REPLY');
  assert.equal(await page.locator('#run-button').isDisabled(), true); passed.push('One member: default form sends only to its recipient, without starting a run');
  const b = await create('codex'); await page.locator('#recipient').selectOption(b); await page.locator('#shared-input').fill('只分享这段'); await page.locator('#shared-input').press('Shift+Enter');
  assert.equal(await page.locator('#shared-input').inputValue(), '只分享这段\n'); assert.equal((await native('stats')).sends.length, 1);
  await page.locator('#forward-button').click(); await sent(2, b, '只分享这段'); assert.equal((await snapshot()).room.run, null); await complete('SECOND-REPLY');
  const s = await snapshot(); assert.ok(s.room.messages.some(m => m.text === 'SECOND-REPLY')); assert.equal(s.sessions.find(x => x.id === a).messages.filter(m => m.role === 'user').length, 1);
  await page.locator('#recipient').selectOption(a); await page.locator('#shared-input').fill('键盘发送'); await page.locator('#forward-button').focus(); await page.keyboard.press('Enter'); await sent(3, a, '键盘发送'); assert.equal((await snapshot()).room.run, null); await complete('KEYBOARD-REPLY');
  passed.push('Pointer and keyboard send once to selected recipient; Shift Enter remains a newline');
  await page.locator('#shared-input').fill('显式自动核查'); await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click(); await sent(4, a, '显式自动核查');
  const running = (await snapshot()).room.run; assert.equal(running.status, 'running'); assert.deepEqual(running.ids, [a, b]); assert.equal(running.maxSteps, 3); await complete('UNKNOWN-FLEET-REPLY');
  await until(async () => (await snapshot()).room.run.status === 'paused', 'Unknown fleet pauses'); await delay(150); assert.equal((await native('stats')).sends.length, 4); assert.ok((await snapshot()).room.messages.some(m => m.text === 'UNKNOWN-FLEET-REPLY'));
  passed.push('Only explicit automatic action starts a run; unknown native state keeps reply and stops further handoff');
  await page.locator('#recipient').selectOption(b); await page.locator('#shared-input').fill('暂停后的定向发送'); await page.locator('#room-composer').evaluate(form => form.requestSubmit()); await sent(5, b, '暂停后的定向发送'); await complete('FINAL-REPLY');
  assert.equal((await snapshot()).room.run.id, running.id); assert.equal((await snapshot()).room.run.status, 'paused'); passed.push('Default submission after a paused run does not restart automatic collaboration');
  await page.locator('#shared-input').fill('   '); assert.equal(await page.locator('#forward-button').isDisabled(), true); assert.equal(await page.locator('#run-button').isDisabled(), true);
  await page.locator('#shared-input').fill('等待确认的发送'); await page.locator('#forward-button').click(); await sent(6, b, '等待确认的发送');
  await page.locator('#room-composer').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  assert.equal(await page.locator('#forward-button').isDisabled(), true); assert.equal(await page.locator('#run-button').isDisabled(), true);
  await page.locator('#shared-input').fill('发送期间的新草稿'); await native('release', '', true);
  await page.locator('#toast').filter({ hasText: 'Synthetic acceptance failure' }).waitFor(); await delay(150);
  assert.equal((await native('stats')).sends.length, 6); assert.equal(await page.locator('#shared-input').inputValue(), '发送期间的新草稿');
  await app.close(); app = null; await launch(); await page.locator('#shared-input').waitFor();
  assert.equal(await page.locator('#shared-input').inputValue(), '发送期间的新草稿'); assert.equal((await native('stats')).sends.length, 6);
  assert.equal(await page.locator('#recipient').inputValue(), b, 'Reopen retains the intended recipient, not the first member');
  assert.equal(await page.locator('#recipient').getAttribute('title'), 'codex · 共享测试');
  // Simulate an older view without this field, then an unavailable saved ID.
  for (const savedRecipient of [undefined, 'no-longer-a-member']) {
    await app.close(); app = null;
    const file = path.join(profile, 'views.json'), views = JSON.parse(fs.readFileSync(file));
    for (const view of views) { if (savedRecipient === undefined) delete view.roomRecipient; else view.roomRecipient = savedRecipient; }
    fs.writeFileSync(file, JSON.stringify(views)); await launch(); await page.locator('#shared-input').waitFor();
    assert.equal(await page.locator('#shared-input').inputValue(), '发送期间的新草稿'); assert.equal(await page.locator('#recipient').inputValue(), '');
    assert.equal(await page.locator('#forward-button').isDisabled(), true); await page.locator('#room-composer').evaluate(form => form.requestSubmit()); assert.equal((await native('stats')).sends.length, 6);
  }
  passed.push('Reopen retains the recipient; legacy or unavailable recipient requires an explicit choice with no dispatch');
  passed.push('Blank and pending sends are blocked; late failure and reopen retain the newer draft without replay');
  await page.locator('#recipient').selectOption(b);
  await page.locator('#room-messages article').filter({ has: page.getByText('FIRST-REPLY', { exact: true }) }).getByRole('button', { name: '选择并分享', exact: true }).click();
  await page.locator('#share-recipient').selectOption(b); await client.call('join', b, false);
  await until(async () => await page.locator('#recipient').inputValue() === '', 'Departed room recipient cleared');
  assert.equal(await page.locator('#share-recipient').inputValue(), ''); assert.equal(await page.locator('#confirm-share').isDisabled(), true);
  assert.equal(await page.locator('#share-text').inputValue(), 'FIRST-REPLY'); await page.locator('#cancel-share').click();
  assert.equal(await page.locator('#forward-button').isDisabled(), true); await page.locator('#room-composer').evaluate(form => form.requestSubmit());
  await client.call('join', a, false); await until(async () => (await snapshot()).sessions.every(s => !s.roomId), 'Empty room');
  await client.call('join', a, true); await until(async () => (await snapshot()).sessions.some(s => s.roomId), 'Rejoined'); await delay(100);
  assert.equal(await page.locator('#recipient').inputValue(), ''); assert.equal(await page.locator('#forward-button').isDisabled(), true);
  assert.equal(await page.locator('#shared-input').inputValue(), '发送期间的新草稿'); assert.equal((await native('stats')).sends.length, 6);
  await page.locator('#recipient').selectOption(a); await page.locator('#forward-button').click(); await sent(7, a, '发送期间的新草稿'); await complete('EXPLICIT-RECIPIENT-REPLY');
  passed.push('Recipient departure clears both sharing selectors; empty/rejoined room keeps drafts and requires an explicit new recipient');
  await capture('directed-ready');
  await client.call('stop', a); await until(async () => await page.locator('#forward-button').isDisabled(), 'Ended recipient disabled');
  await page.locator('#room-composer').evaluate(form => form.requestSubmit()); assert.equal((await native('stats')).sends.length, 7);
  assert.equal(await page.locator('#forward-button').evaluate(el => el.classList.contains('primary')), true); assert.equal(await page.locator('#run-button').evaluate(el => el.classList.contains('primary')), false);
  await page.locator('#room-messages').getByText('EXPLICIT-RECIPIENT-REPLY', { exact: true }).scrollIntoViewIfNeeded(); await capture('directed-default');
  assert.deepEqual(errors, []); assert.equal(app.windows().length, 1); console.log(JSON.stringify({ passed, errors, syntheticDispatches: 7, nativeProviderProcesses: 0, nativeModelCalls: 0, oneWindow: true }));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
});
