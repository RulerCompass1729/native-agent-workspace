const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// Real desktop/IPC/workspace, synthetic delayed replies. No native processes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process');
const { _electron } = require('playwright'), { connect } = require('../app/service-client.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root, profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-room-send-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/delayed-native.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [], passed = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function native(method, reply = '', fail = false) { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } }; child.on('message', cb); child.send({ id, method, reply, fail });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const messageRow = text => page.locator('#room-messages article').filter({ has: page.locator('.message-body').getByText(text, { exact: true }) });
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
  const a = await create('claude'); await chooseRecipient(a); await fillRoomMessage(page, '单一接收方');
  // Test the HTML form default contract separately from real pointer/keyboard activation.
  await page.locator('#room-composer').evaluate(form => form.requestSubmit()); await sent(1, a, '单一接收方'); assert.equal((await snapshot()).room.run, null);
  const first = messageRow('单一接收方');
  await first.locator('.message-delivery summary').click();
  assert.ok((await first.locator('summary').innerText()).includes('等待原生确认'));
  assert.equal(await first.locator('.delivery-payload').innerText(), '单一接收方');
  const payload = await first.locator('.delivery-payload').boundingBox();
  await page.mouse.move(payload.x + 1, payload.y + payload.height / 2); await page.mouse.down();
  await page.mouse.move(payload.x + 140, payload.y + payload.height / 2, { steps: 8 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => getSelection().toString()), '单一接收方');
  const beforeRenameAck = await page.locator('#shared-input').inputValue();
  await page.evaluate(id => workspace.rename(id, '名称在等待时变化'), a);
  await until(() => page.locator('#recipient').inputValue().then(value => value === ''), 'Rename revokes address during pending ACK');
  await complete('FIRST-REPLY');
  assert.equal(await page.locator('#shared-input').inputValue(), beforeRenameAck, 'Late successful ACK cannot clear a draft after its address changed');
  await until(async () => (await first.locator('summary').innerText()).includes('原生已接收'), 'Receipt acknowledged');
  assert.equal(await first.locator('details').getAttribute('open'), '', 'Native ACK retains the expanded details');
  assert.equal(await page.evaluate(() => getSelection().toString()), '单一接收方', 'Native ACK preserves the payload selection');
  assert.ok((await first.locator('.delivery-body').innerText()).includes('不是其完整模型上下文'));
  assert.equal(await first.locator('.delivery-payload').count(), 1);
  await page.evaluate(id => workspace.rename(id, 'claude · 共享测试'), a); await chooseRecipient(a);
  passed.push('Submitted human message is visible before ACK; one native receipt updates without collapsing its exact payload');
  assert.equal(await page.locator('#run-button').isDisabled(), true); passed.push('One member: default form sends only to its recipient, without starting a run');
  const b = await create('codex'); await chooseRecipient(b); await fillRoomMessage(page, '只分享这段'); await page.locator('#shared-input').press('Shift+Enter');
  assert.equal(await roomBody(page), '只分享这段\n'); assert.equal((await native('stats')).sends.length, 1);
  await page.locator('#forward-button').click(); await sent(2, b, '只分享这段'); assert.equal((await snapshot()).room.run, null); await complete('SECOND-REPLY\nSECOND-LINE');
  await fillRoomMessage(page, 'x'.repeat(6000)); assert.ok((await page.locator('#shared-input').inputValue()).length > 6000);
  await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click(); await page.locator('#run-dialog').waitFor();
  assert.equal(await page.locator('#run-preview').innerText(), 'x'.repeat(6000)); await page.locator('#cancel-run').click(); await fillRoomMessage(page, '');
  const s = await snapshot(); assert.ok(s.room.messages.some(m => m.text === 'SECOND-REPLY\nSECOND-LINE'));
  const sharedReply = page.locator('#room-messages .message.assistant .message-body p').filter({ hasText: 'SECOND-REPLY' });
  await sharedReply.waitFor();
  const lineTops = await sharedReply.evaluate(el => {
    const node = el.firstChild, range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 12); const first = range.getBoundingClientRect().top;
    const at = node.textContent.indexOf('SECOND-LINE'); range.setStart(node, at); range.setEnd(node, at + 11);
    return [first, range.getBoundingClientRect().top];
  });
  assert.ok(lineTops[1] - lineTops[0] > 10, 'Shared completed reply preserves native single newline');
  passed.push('Shared completed reply retains native line breaks in the same main reader');
  await sharedReply.scrollIntoViewIfNeeded(); await capture('shared-native-lines'); assert.equal(s.sessions.find(x => x.id === a).messages.filter(m => m.role === 'user').length, 1);
  await chooseRecipient(a); await fillRoomMessage(page, '键盘发送'); await page.locator('#forward-button').focus(); await page.keyboard.press('Enter'); await sent(3, a, '键盘发送'); assert.equal((await snapshot()).room.run, null); await complete('KEYBOARD-REPLY');
  passed.push('Pointer and keyboard send once to selected recipient; Shift Enter remains a newline');
  await fillRoomMessage(page, '显式自动核查'); await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click();
  assert.equal((await native('stats')).sends.length, 3); assert.ok(await page.locator('#confirm-run').isDisabled());
  await page.locator('#run-consent').check(); await page.locator('#confirm-run').click(); await sent(4, a, '显式自动核查');
  const running = (await snapshot()).room.run; assert.equal(running.mode, 'replies'); assert.deepEqual(running.ids, [a, b]);
  await native('release', 'FIRST-CHECK'); await until(async () => (await native('stats')).sends.length === 5, 'Second authorized turn');
  const handoff = messageRow('FIRST-CHECK');
  await handoff.locator('.message-delivery summary').click();
  assert.equal(await handoff.locator('.delivery-payload').innerText(), (await native('stats')).sends.at(-1).text);
  assert.ok((await handoff.locator('summary').innerText()).includes('codex · 共享测试'));
  await page.locator('#room-filter').selectOption(b);
  await handoff.waitFor(); assert.equal(await handoff.locator('.delivery-payload').count(), 1, 'Recipient filter includes the handoff source');
  await page.locator('#room-filter').selectOption('');
  await native('release', 'SECOND-CHECK'); await until(async () => (await native('stats')).sends.length === 6, 'Third authorized turn');
  await native('release', 'FINAL-CHECK'); await until(async () => (await snapshot()).room.run.status === 'completed', 'Reply limit ends exchange');
  assert.equal((await snapshot()).room.run.nativeWorkUnknown, true); assert.equal((await native('stats')).sends.length, 6);
  assert.equal(await messageRow('FINAL-CHECK').locator('summary').innerText(), '本条未由工作区转发');
  await messageRow('SECOND-CHECK').locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await messageRow('SECOND-CHECK').locator('details').getAttribute('open'), '');
  await capture('handoff-delivery-details');
  passed.push('Automatic handoff exposes its actual task wrapper, keyboard expansion and recipient filtering without an extra dispatch');
  passed.push('Explicit finite reply authorization routes three replies once, retains unknown native work, and stops at its limit');
  await chooseRecipient(b); await fillRoomMessage(page, '暂停后的定向发送'); await page.locator('#room-composer').evaluate(form => form.requestSubmit()); await sent(7, b, '暂停后的定向发送'); await complete('FINAL-REPLY');
  assert.equal((await snapshot()).room.run.id, running.id); assert.equal((await snapshot()).room.run.status, 'completed'); passed.push('Default submission after a paused run does not restart automatic collaboration');
  await fillRoomMessage(page, '   '); assert.equal(await page.locator('#forward-button').isDisabled(), true); assert.equal(await page.locator('#run-button').isDisabled(), true);
  await fillRoomMessage(page, '等待确认的发送'); await page.locator('#forward-button').click(); await sent(8, b, '等待确认的发送');
  await page.locator('#room-composer').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  assert.equal(await page.locator('#forward-button').isDisabled(), true); assert.equal(await page.locator('#run-button').isDisabled(), true);
  await fillRoomMessage(page, '发送期间的新草稿'); await native('release', '', true);
  await page.locator('#toast').filter({ hasText: 'Synthetic acceptance failure' }).waitFor(); await delay(150);
  assert.ok((await messageRow('等待确认的发送').locator('summary').innerText()).includes('接收结果未确认'));
  assert.equal((await native('stats')).sends.length, 8); assert.equal(await roomBody(page), '发送期间的新草稿');
  await app.close(); app = null; await launch(); await page.locator('#shared-input').waitFor();
  assert.equal(await roomBody(page), '发送期间的新草稿'); assert.equal((await native('stats')).sends.length, 8);
  await messageRow('等待确认的发送').locator('summary').click();
  assert.equal(await messageRow('等待确认的发送').locator('.delivery-payload').innerText(), '等待确认的发送');
  assert.equal(await page.locator('#recipient').inputValue(), b, 'Reopen retains the intended recipient, not the first member');
  assert.equal(await page.locator('#recipient').getAttribute('title'), 'codex · 共享测试');
  // Simulate an older view without this field, then an unavailable saved ID.
  for (const savedRecipient of [undefined, 'no-longer-a-member']) {
    await app.close(); app = null;
    const file = path.join(profile, 'views.json'), views = JSON.parse(fs.readFileSync(file));
    for (const view of views) { if (require('../app/room-mention.js').valid(view.roomMention, view.sharedDraft)) view.sharedDraft = require('../app/room-mention.js').body(view.roomMention, view.sharedDraft); delete view.roomMention; if (savedRecipient === undefined) delete view.roomRecipient; else view.roomRecipient = savedRecipient; }
    fs.writeFileSync(file, JSON.stringify(views)); await launch(); await page.locator('#shared-input').waitFor();
    assert.equal(await roomBody(page), '发送期间的新草稿'); assert.equal(await page.locator('#recipient').inputValue(), '');
    assert.equal(await page.locator('#forward-button').isDisabled(), true); await page.locator('#room-composer').evaluate(form => form.requestSubmit()); assert.equal((await native('stats')).sends.length, 8);
  }
  passed.push('Reopen retains the recipient; legacy or unavailable recipient requires an explicit choice with no dispatch');
  passed.push('Blank and pending sends are blocked; late failure and reopen retain the newer draft without replay');
  await chooseRecipient(b); const departedDraft = await page.locator('#shared-input').inputValue();
  await page.locator('#room-messages article').filter({ has: page.getByText('FIRST-REPLY', { exact: true }) }).getByRole('button', { name: '选择并分享', exact: true }).click();
  await page.locator('#share-recipient').selectOption(b); await client.call('join', b, false);
  await until(async () => await page.locator('#recipient').inputValue() === '', 'Departed room recipient cleared');
  assert.equal(await page.locator('#share-recipient').inputValue(), ''); assert.equal(await page.locator('#confirm-share').isDisabled(), true);
  assert.equal(await page.locator('#share-text').inputValue(), 'FIRST-REPLY'); await page.locator('#cancel-share').click();
  assert.equal(await page.locator('#forward-button').isDisabled(), true); await page.locator('#room-composer').evaluate(form => form.requestSubmit());
  await client.call('join', a, false); await until(async () => (await snapshot()).sessions.every(s => !s.roomId), 'Empty room');
  await client.call('join', a, true); await until(async () => (await snapshot()).sessions.some(s => s.roomId), 'Rejoined'); await delay(100);
  assert.equal(await page.locator('#recipient').inputValue(), ''); assert.equal(await page.locator('#forward-button').isDisabled(), true);
  assert.equal(await roomBody(page), '发送期间的新草稿'); assert.equal((await native('stats')).sends.length, 8);
  await chooseRecipient(a); await page.locator('#forward-button').click(); await sent(9, a, '发送期间的新草稿'); await complete('EXPLICIT-RECIPIENT-REPLY');
  passed.push('Recipient departure clears both sharing selectors; empty/rejoined room keeps drafts and requires an explicit new recipient');
  await capture('directed-ready');
  await client.call('stop', a); await until(async () => await page.locator('#forward-button').isDisabled(), 'Ended recipient disabled');
  await page.locator('#room-composer').evaluate(form => form.requestSubmit()); assert.equal((await native('stats')).sends.length, 9);
  assert.equal(await page.locator('#forward-button').evaluate(el => el.classList.contains('primary')), true); assert.equal(await page.locator('#run-button').evaluate(el => el.classList.contains('primary')), false);
  await page.locator('#room-messages').getByText('EXPLICIT-RECIPIENT-REPLY', { exact: true }).scrollIntoViewIfNeeded(); await capture('directed-default');
  assert.deepEqual(errors, []); assert.equal(app.windows().length, 1); console.log(JSON.stringify({ passed, errors, syntheticDispatches: 9, nativeProviderProcesses: 0, nativeModelCalls: 0, oneWindow: true }));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
});

async function chooseRecipient(id) { await inlineRecipient(page, id); }
