const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
// One hidden app, real shipped adapter/workspace/IPC, synthetic providers.
// This tests the complete daily-use path, not native login, models or fleets.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork, spawn, execFileSync } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-collaboration-ui-'));
const executablePath = process.env.NAW_APP_EXECUTABLE || require('electron'), args = process.env.NAW_APP_EXECUTABLE ? [] : [root];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [], passed = [], requests = new Set(), startupMs = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 140; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', text = '', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } }; child.on('message', cb); child.send({ id, method, text, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const input = id => page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`);
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function launch() {
  const started = performance.now();
  assert.ok(!app); app = await _electron.launch({ executablePath, args, env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (/^https?:|^wss?:/.test(r.url())) requests.add(new URL(r.url()).hostname); });
  await page.locator('#new-session').waitFor();
  startupMs.push(Math.round(performance.now() - started));
}
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('terminal'); await page.locator('#session-name').fill('伙伴'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.chatAvailable && s.terminalAvailable), 'Session ready');
  return (await snapshot()).sessions.find(s => s.provider === provider).id;
}
async function terminal(id) {
  await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#terminal-tab').click();
  await until(() => input(id).evaluate(el => document.activeElement === el), 'Selected terminal focus');
}
async function reply(text) { await fixture('release', text); await until(async () => (await snapshot()).sessions.every(s => !s.pendingTag), 'Reply settled'); }
const identities = state => state.sessions.map(s => [s.id, s.nativeId]);
async function drag(source, target, cancel = false) {
  console.log('Pointer drag', await source.getAttribute('data-session-id') || await source.getAttribute('data-room-session'), 'to', await target.getAttribute('id'), cancel ? 'cancel' : 'drop');
  await Promise.race([performDrag(source, target, cancel), delay(12000).then(() => { throw Error('Pointer drag timeout'); })]);
}
async function performDrag(source, target, cancel) {
  const a = await source.boundingBox(), b = await target.boundingBox(); assert.ok(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 4, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 18 });
  await page.mouse.move(b.x + b.width / 2 + 1, b.y + b.height / 2 + 1);
  if (cancel) await page.keyboard.press('Escape'); await page.mouse.up();
}
async function run() {
  console.log('Synthetic profile:', profile, 'Code root:', code);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon ready'); client = await connect(profile, 'collaboration-observer'); await launch();
  const a = await create('claude'), b = await create('codex'), ids = identities(await snapshot());
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.getByRole('button', { name: '参与者…', exact: true }).click(); await page.locator('#invite-button').click();
  for (const id of [a, b]) assert.ok((await page.locator(`[data-invite-session="${id}"]`).innerText()).includes(id.slice(0, 6)), 'Initial invite disambiguates names');
  await fixture('event', '', b, { method: 'turn/started', params: { threadId: 'synthetic-' + b, turn: { id: 'identity-refresh-check' } } });
  await until(async () => (await page.locator(`[data-session-id="${b}"]`).innerText()).includes('正在工作'), 'Actual state update rendered while invite stays open');
  for (const id of [a, b]) assert.ok((await page.locator(`[data-invite-session="${id}"]`).innerText()).includes(id.slice(0, 6)), 'Refresh preserves exact invite identity');
  await fixture('event', '', b, { method: 'turn/completed', params: { threadId: 'synthetic-' + b, turn: { id: 'identity-refresh-check', status: 'completed' } } });
  await page.locator('#close-invite').click(); await terminal(b);
  await fixture('event', '', b, { method: 'thread/tokenUsage/updated', params: { threadId: 'synthetic-' + b,
    tokenUsage: { total: { inputTokens: 120, cachedInputTokens: 100, outputTokens: 20 }, last: { inputTokens: 80, outputTokens: 10 }, modelContextWindow: 200000 } } });
  await until(async () => (await snapshot()).sessions.find(s => s.id === b)?.usage?.total?.inputTokens === 120);
  await page.locator('#privacy-button').click();
  assert.match(await page.locator('#trust-status').innerText(), /累计 token：输入 120/);
  assert.match(await page.locator('#trust-status').innerText(), /原生用量未报告；不能据此判断为零/);
  await page.locator('#refresh-trust').click();
  assert.match(await page.locator('#trust-status').innerText(), /其中缓存输入 100/);
  await page.locator('#close-privacy').click();
  await page.locator('#chat-tab').click(); await page.locator('#message-input').fill('PRIVATE-DRAFT'); await terminal(b); await page.keyboard.type('UNSUBMITTED');
  // Real pointer drag sequence: no dispatchEvent or synthetic DataTransfer.
  await drag(page.locator(`[data-session-id="${a}"]`), page.locator('#room-nav'));
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).roomId === 'shared', 'Mouse drag joins');
  await drag(page.locator(`[data-session-id="${b}"]`), page.locator('#room-nav'), true);
  assert.equal((await snapshot()).sessions.find(s => s.id === b).roomId, null, 'Escape cancels drag');
  await drag(page.locator(`[data-session-id="${b}"]`), page.locator('#title'));
  assert.equal((await snapshot()).sessions.find(s => s.id === b).roomId, null, 'Invalid target does not join');
  await drag(page.locator(`[data-session-id="${b}"]`), page.locator('#room-nav'));
  await until(async () => (await snapshot()).room.events.filter(e => e.kind === 'join').length === 2, 'Both joins recorded');
  await drag(page.locator(`[data-session-id="${b}"]`), page.locator('#room-nav'));
  assert.equal((await snapshot()).room.events.filter(e => e.kind === 'join').length, 2, 'Duplicate drop is a no-op');
  assert.equal((await fixture()).sends.length, 0); assert.deepEqual(identities(await snapshot()), ids);
  passed.push('Pointer drag in, cancelled/invalid drop and duplicate drop preserve native identity and send zero tasks');
  await page.locator('#room-nav').click({ button: 'right' }); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await page.locator('#rename-name').fill('周末学习小组'); await page.locator('#rename-name').press('Enter');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.equal(await page.locator('#title').innerText(), '周末学习小组');
  await fillRoomMessage(page, '@all 文本不是广播指令'); assert.equal(await page.locator('#recipient').inputValue(), ''); assert.equal(await page.locator('#forward-button').isDisabled(), true);
  await fillRoomMessage(page, ''); await page.locator('#shared-input').pressSequentially('@');
  assert.equal(await page.locator('#mention-list [role="option"]').count(), 2); await capture('mention-choices');
  assert.match(await page.locator(`[data-mention-id="${a}"]`).innerText(), /Claude/); assert.match(await page.locator(`[data-mention-id="${b}"]`).innerText(), /Codex/);
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#recipient').inputValue(), b); assert.equal(await roomBody(page), ''); assert.equal((await fixture()).sends.length, 0);
  await fillRoomMessage(page, '请核对这段共享材料'); await page.locator('#shared-input').press('Shift+Enter'); await page.keyboard.type('SECOND-LINE');
  const payload = await roomBody(page); await page.locator('#shared-input').press('Enter');
  await until(async () => (await fixture()).sends.length === 1, 'Mention sends exactly once'); assert.deepEqual((await fixture()).sends[0], { id: b, text: payload }); await reply('核查完成：只看到了明确分享的内容。\n\n' + '**长记录布局测试**\n\n'.repeat(80));
  await until(async () => await roomBody(page) === '', 'Accepted input clears');
  assert.equal((await snapshot()).room.messages.some(m => m.text.includes('PRIVATE-HISTORY')), false);
  await page.locator('#room-filter').selectOption(a); assert.equal(await page.locator('#recipient').inputValue(), b, 'Filter never retargets');
  assert.equal(await page.locator('#room-messages article.assistant').count(), 0);
  await page.locator('#room-filter').selectOption(b); await page.locator('#room-search').fill('核查完成'); await until(async () => await page.locator('#room-messages article').count() === 1, 'Filtered reply rendered');
  assert.equal(await page.locator('#room-messages time').count(), 1); await capture('filtered-timeline');
  const firstContext=page.locator('#room-messages').getByRole('button', { name: '查看上下文', exact: true });
  await firstContext.locator('xpath=ancestor::article').hover(); await firstContext.click();
  assert.equal(await page.locator('#room-search').inputValue(), ''); assert.equal(await page.locator('#room-filter').inputValue(), '');
  assert.equal(await page.locator('#room-messages').evaluate(el => el.contains(document.activeElement) && document.activeElement.tagName === 'ARTICLE'), true, 'Filtered context restores and focuses the original row');
  passed.push('Duplicate labels are disambiguated by provider/ID; keyboard @ selects one recipient, exact explicit send, time and member filtering never reroute');
  await page.locator('#room-notes').click(); await page.locator('#room-notes-text').fill('共同目标：比较两种学习方法。\n决定：先核对证据，再写结论。'); await page.locator('#save-notes').click();
  assert.equal((await fixture()).sends.length, 1, 'Notes save does not call model');
  await page.locator('#room-advanced summary').click(); await page.locator('#attach-context').click(); const context = await page.locator('#context-text').inputValue(); assert.ok(context.includes('共同目标')); assert.ok(context.includes('当前参与会话')); assert.ok(!context.includes('PRIVATE-'));
  await page.locator('#insert-context').click(); assert.equal(await roomBody(page), context); assert.equal((await fixture()).sends.length, 1);
  await page.locator('#forward-button').click(); await until(async () => (await fixture()).sends.length === 2, 'Explicit context submission'); assert.deepEqual((await fixture()).sends[1], { id: b, text: context }); await reply('本条背景已接收。');
  await page.locator('#room-search').fill('本条背景已接收');
  const secondContext=page.locator('#room-messages').getByRole('button', { name: '查看上下文', exact: true });
  await secondContext.locator('xpath=ancestor::article').hover(); await secondContext.click();
  await until(() => page.locator('#room-messages .message-body p').count().then(n => n >= 80), 'Unfiltered long Markdown committed');
  await delay(120);
  const contextTarget = page.locator('#room-messages article').filter({ has: page.getByText('本条背景已接收。', { exact: true }) });
  assert.equal(await contextTarget.evaluate(el => { const box = el.getBoundingClientRect(), list = el.parentElement.getBoundingClientRect(); return document.activeElement === el && box.top >= list.top && box.top < list.bottom - 30; }), true, 'Context target remains visible after preceding Markdown mounts');
  // A session detaches without erasing its already received context or drafts.
  await drag(page.locator(`[data-room-session="${b}"]`), page.locator('#solo-drop'));
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).roomId === null, 'Mouse drag out');
  await terminal(b); await page.keyboard.type('-CONTINUE');
  assert.equal((await fixture()).inputs.filter(x => x.id === b).map(x => x.data).join(''), 'UNSUBMITTED-CONTINUE');
  await page.locator('#chat-tab').click(); assert.equal(await page.locator('#message-input').inputValue(), 'PRIVATE-DRAFT');
  await page.locator('#advanced summary').click(); await page.getByRole('button', { name: '带上协作背景…', exact: true }).click();
  assert.match(await page.locator('#context-text').inputValue(), /已独立使用/); await page.locator('#close-context').click();
  assert.ok((await snapshot()).sessions.find(s => s.id === b).messages.some(m => m.text === context));
  await page.locator('#room-nav').click(); await page.locator('#room-record').click(); assert.equal(await page.locator('#recipient').inputValue(), '');
  await page.locator('#room-filter').selectOption(b); assert.ok((await page.locator('#room-messages').innerText()).includes('本条背景已接收')); assert.ok((await page.locator('#room-messages').innerText()).includes('离开了工作区'));
  passed.push('Shared notes persist locally; only an explicit send transmits visible context once; drag out preserves terminal, private draft and received native history');
  await page.locator('#room-filter').selectOption(''); await chooseRecipient(a); await fillRoomMessage(page, '尚在执行的共享任务'); await page.locator('#forward-button').click();
  await until(async () => (await fixture()).sends.length === 3, 'Pending task');
  await drag(page.locator(`[data-room-session="${a}"]`), page.locator('#session-list'));
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).roomId === null, 'Active session detached'); await reply('PRIVATE-AFTER-LEAVE');
  assert.equal((await snapshot()).room.messages.some(m => m.text === 'PRIVATE-AFTER-LEAVE'), false); assert.ok((await snapshot()).sessions.find(s => s.id === a).messages.some(m => m.text === 'PRIVATE-AFTER-LEAVE'));
  await page.locator('#room-nav').click(); await page.locator('#room-record').click(); await fillRoomMessage(page, '保留的合作草稿'); const before = await snapshot(); await capture('collaboration-ready');
  await app.close(); app = null; await launch(); const after = await snapshot();
  assert.deepEqual(identities(after), ids); assert.equal(after.room.name, '周末学习小组'); assert.equal(after.room.notes, before.room.notes); assert.deepEqual(after.room.events, before.room.events); assert.deepEqual(after.room.messages, before.room.messages);
  assert.equal(await roomBody(page), '保留的合作草稿'); assert.equal(await page.locator('#recipient').inputValue(), ''); assert.equal((await fixture()).sends.length, 3);
  // Intentional second window verifies one metadata writer; close it afterwards.
  await page.locator(`[data-session-menu="${b}"]`).click(); await page.getByRole('menuitem', { name: '在独立窗口打开', exact: true }).click();
  await until(() => app.windows().length === 2, 'Intentional observer window'); const second = app.windows().find(w => w !== page); await second.locator('#new-session').waitFor();
  await page.locator('#room-more').click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click(); await page.locator('#rename-name').fill('共享复盘'); await page.locator('#confirm-rename').click();
  await until(async () => await second.locator('#room-nav').getAttribute('aria-label') === '共享复盘', 'Other window sees rename');
  await second.locator('#room-nav').click(); await second.locator('#room-notes').click(); await second.locator('#room-notes-text').fill('OTHER-UNSAVED');
  await page.locator('#room-notes').click(); await page.locator('#room-notes-text').fill('先保存的版本'); await page.locator('#save-notes').click();
  await second.locator('#save-notes').click(); await second.locator('#notes-error').waitFor(); assert.equal(await second.locator('#room-notes-text').inputValue(), 'OTHER-UNSAVED'); assert.equal((await snapshot()).room.notes, '先保存的版本');
  await second.locator('#cancel-notes').click();
  await page.locator(`[data-session-id="${b}"]`).click(); await page.locator('#chat-tab').click();
  if (!await page.locator('#advanced').evaluate(el => el.open)) await page.locator('#advanced summary').click();
  await page.getByRole('button', { name: '带上协作背景…', exact: true }).click();
  await second.locator(`[data-session-id="${b}"]`).click(); await second.locator('#chat-tab').click();
  await second.locator('#send-button').getByText('接管此窗口', { exact: true }).click();
  await until(() => second.locator('#message-input').evaluate(el => !el.readOnly), 'Explicit graphical takeover');
  await second.locator('#message-input').fill('TAKEOVER-DRAFT');
  assert.equal(await page.locator('#insert-context').isVisible(), false, 'Solo context is copy-only after ownership transfer');
  assert.equal((await snapshot()).sessions.find(s => s.id === b).liveDraft, 'TAKEOVER-DRAFT'); await page.locator('#close-context').click();
  await second.close(); assert.equal(app.windows().length, 1);
  passed.push('Leaving during a task prevents its reply entering shared history; reopen preserves room/drafts/history without replay; cross-window rename works and stale notes never overwrite');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await drag(page.locator(`[data-session-id="${a}"]`), page.locator('#room-nav'));
  await drag(page.locator(`[data-session-id="${b}"]`), page.locator('#room-nav'));
  await chooseRecipient(a); await fillRoomMessage(page, 'ARCHIVE-PENDING'); await page.locator('#forward-button').click(); await until(async () => (await fixture()).sends.length === 4, 'Task before archive');
  await page.locator(`[data-session-menu="${a}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).archived, 'Session archived');
  assert.equal(await page.locator(`[data-session-id="${a}"]`).count(), 0);
  const blocked = await page.evaluate(async id => { try { await workspace.input(id, 'MUST-NOT-REACH'); return false; } catch { return true; } }, a); assert.equal(blocked, true);
  await page.locator('#archive-button').click(); assert.match(await page.locator(`[data-archived-session="${a}"]`).innerText(), /正在工作/); await capture('archived-working');
  await reply('ARCHIVED-PRIVATE-REPLY'); assert.equal((await snapshot()).room.messages.some(m => m.text === 'ARCHIVED-PRIVATE-REPLY'), false);
  await page.locator(`[data-archived-session="${a}"]`).getByRole('button', { name: '恢复会话', exact: true }).click();
  assert.equal((await snapshot()).sessions.find(s => s.id === a).roomId, null); assert.deepEqual(identities(await snapshot()), ids);
  await drag(page.locator(`[data-session-id="${a}"]`), page.locator('#room-nav'));
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  const preserved = await snapshot();
  await page.locator('#room-more').click(); await page.getByRole('menuitem', { name: '归档工作区', exact: true }).click();
  await until(async () => (await snapshot()).room.archived, 'Room archived'); assert.equal(await page.locator('#room-nav').isVisible(), false); assert.ok((await snapshot()).sessions.every(s => !s.roomId));
  await page.locator(`[data-session-menu="${a}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click(); await until(async () => (await snapshot()).sessions.find(s => s.id === a).archived, 'Former member independently archived');
  await app.close(); app = null; await launch(); assert.equal((await snapshot()).room.archived, true); assert.equal((await snapshot()).sessions.find(s => s.id === a).archived, true);
  await page.locator('#archive-button').click(); await capture('archive-resume'); await page.getByRole('button', { name: '恢复工作区', exact: true }).click();
  const restored = await snapshot(); assert.equal(restored.room.archived, false); assert.equal(restored.room.notes, preserved.room.notes); assert.deepEqual(restored.room.messages, preserved.room.messages);
  assert.equal(restored.sessions.find(s => s.id === b).roomId, 'shared'); assert.equal(restored.sessions.find(s => s.id === a).roomId, null); assert.equal(restored.sessions.find(s => s.id === a).archived, true);
  await page.locator('#archive-button').click(); await page.locator(`[data-archived-session="${a}"]`).getByRole('button', { name: '恢复会话', exact: true }).click(); assert.deepEqual(identities(await snapshot()), ids);
  assert.equal((await fixture()).sends.length, 4); assert.equal((await fixture()).inputs.some(x => x.data === 'MUST-NOT-REACH'), false);
  await page.locator(`[data-session-id="${b}"]`).click(); await page.locator('#chat-tab').click();
  await page.locator('#send-button').getByText('接管此窗口', { exact: true }).click();
  await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Explicit takeover after observer closes');
  await page.locator('#message-input').fill('ARCHIVED-UNSENT-DRAFT');
  await page.locator(`[data-session-menu="${b}"]`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).archived, 'Current session archived');
  assert.equal(await page.locator('#message-input').inputValue(), 'ARCHIVED-UNSENT-DRAFT'); assert.equal(await page.locator('#send-button').isDisabled(), true);
  await app.close(); app = null; await launch();
  assert.equal(await page.locator('#message-input').inputValue(), 'ARCHIVED-UNSENT-DRAFT'); assert.equal(await page.locator('#send-button').isDisabled(), true);
  await page.locator('#header-actions').getByRole('button', { name: '恢复会话', exact: true }).click();
  assert.equal(await page.locator('#message-input').inputValue(), 'ARCHIVED-UNSENT-DRAFT'); assert.equal((await snapshot()).sessions.find(s => s.id === b).roomId, null);
  passed.push('Session and room archives survive reopen; in-flight tasks stay native/private, archive displays working status, restore uses stable identities and skips separately archived members with no replay');
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await require('./check-theme.cjs').checkTheme(page); await capture('final-light-dark');
  // OS confirmation is stubbed only for this explicit synthetic deletion test.
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
  await page.locator('#privacy-button').click(); await page.locator('#privacy-dialog summary').filter({ hasText: '清理与完全退出' }).click(); await page.locator('#clear-shared-history').click();
  await until(async () => { const s = await snapshot(); return !s.room.messages.length && !s.room.events.length && !s.room.notes; }, 'All shared data cleared');
  assert.equal((await snapshot()).room.name, '共享复盘'); assert.ok((await snapshot()).sessions.find(s => s.id === b).messages.some(m => m.text === context));
  assert.deepEqual(errors, []); assert.equal((await fixture()).sends.length, 4);
  passed.push('Shared-history deletion includes new timeline and notes, keeps native history and room name; no hidden dispatch');
  console.log(JSON.stringify({ passed, errors, syntheticDispatches: 4, nativeProcesses: 0, modelCalls: 0, oneWindow: app.windows().length === 1 }, null, 2));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
});

async function chooseRecipient(id) { await inlineRecipient(page, id); }
