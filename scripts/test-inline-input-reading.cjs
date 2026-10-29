// Owned Electron/service flow through the real Claude observation receiver.
// Synthetic native transport only; no model, provider or daily-app operation.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
const installed = Boolean(process.env.NAW_APP_EXECUTABLE);
const { _electron } = scratch.playwright(installed ? { _electron: require('./fixtures/installed-renderer.cjs') } : require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no test app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T88 inline input', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-inline-input-'));
const workspaceRoot = path.join(profile, 'workspace'); fs.mkdirSync(workspaceRoot);
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/inline-input.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: workspaceRoot, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'test-daemon-launch.json'), JSON.stringify({ pid: child.pid, argv: child.spawnargs, appRoot: code, syntheticTransport: true }, null, 2)); }
let app, page, sequence = 0; const checks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = packet => { if (packet.requestId === id) { clearTimeout(timer); child.off('message', callback); packet.error ? reject(Error(packet.error)) : resolve(packet); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 10000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
async function until(fn, label) { for (let n = 0; n < 160; n++) { if (await fn()) return; await delay(50); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
const reader = id => page.locator(`.collaboration-member-reader[data-member-id="${id}"] .messages`);
const check = text => { checks.push(text); console.log('PASS:', text); };
const emit = (id, value) => fixture('inlineObservation', id, value);
const identity = state => state.sessions.map(s => [s.id, s.nativeId, s.pid, s.owner, s.model]).sort();
async function capture(name) { if (process.env.NAW_SCREENSHOTS_DIR) { fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_SCREENSHOTS_DIR, name + '.png') }); } }
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic session ready');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click(); return id;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own daemon ready');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: installed ? [] : [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  if (!installed) await app.evaluate(({ clipboard }) => { globalThis.inlineCopies = []; clipboard.writeText = text => globalThis.inlineCopies.push(text); });
  const a = await create('Inline A'), b = await create('Inline B'), c = await create('Inline C');
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#message-input').fill('UNSENT_PRIVATE_INLINE_DRAFT');
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).liveDraft === 'UNSENT_PRIVATE_INLINE_DRAFT', 'Private draft stored');
  const originalIdentity = identity(await snapshot());
  await fixture('bindSends', a); await page.locator('#room-nav').click(); await chooseRecipient(page, a); await fillRoomMessage(page, 'PUBLIC_APPROVED_TASK'); await page.locator('#forward-button').click();
  if (process.env.NAW_INLINE_LAYOUT === 'list') await page.getByRole('button', { name: '列表', exact: true }).click();
  await until(async () => (await fixture('stats', a)).lastSend?.text === 'PUBLIC_APPROVED_TASK', 'One explicit synthetic shared send');
  const send = (await fixture('stats', a)).lastSend;
  await emit(a, { id: 'control:turn-start', kind: 'control', turnId: send.turnId, promptId: send.promptId, status: 'running' });
  const response = { id: 'display:shared', kind: 'response', turnId: send.turnId, promptId: send.promptId, status: 'streaming' };
  await emit(a, { ...response, index: 0, delta: 'ORIGINAL_SHARED_PREFIX' });
  await until(async () => (await snapshot()).room.messages.some(m => m.text === 'ORIGINAL_SHARED_PREFIX'), 'Shared prefix positive control');
  await fillRoomMessage(page, 'UNSENT_ROOM_INLINE_DRAFT');
  const id = `prompt:${randomUUID()}`, second = `prompt:${randomUUID()}`, text = 'ORIGINAL_MIDTURN_TEXT\n你好 🙂';
  const input = { id, kind: 'input', inputMode: 'native-inline', turnId: send.turnId, title: '工作中插入', text, status: 'complete' };
  await emit(a, { id: 'control:input', kind: 'control', status: 'complete' });
  await fixture('inlineHook', a, { hook_event_name: 'UserPromptSubmit', prompt_id: randomUUID(), prompt: text });
  await emit(a, input);
  const nativeId = (await snapshot()).sessions.find(s => s.id === a).nativeId;
  const row = reader(a).locator(`[data-message-id="native:${nativeId}:${id}"]`);
  await row.waitFor(); assert.match(await row.locator('.message-heading').innerText(), /工作中插入/);
  assert.equal(await row.locator('.message-body').textContent(), text);
  assert.equal(await reader(a).locator(`[data-message-id="native:${nativeId}:${id}"]`).count(), 1);
  assert.equal(await roomBody(page), 'UNSENT_ROOM_INLINE_DRAFT');
  for (const name of ['Inline A', 'Inline B', 'Inline C']) assert.equal(await page.getByRole('button', { name: `放大 ${name} 的会话`, exact: true }).isVisible(), true);
  await capture('01-original-native-inline-three-members');
  check('Accepted native input appears with exact text/title in its own member reader while all three member identities remain available');
  const body = row.locator('.message-body'), node = await row.elementHandle();
  const selection = await body.evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range); return getSelection().toString(); });
  await emit(a, input);
  await emit(a, { id: 'control:input', kind: 'control', status: 'complete' });
  await fixture('inlineHook', a, { hook_event_name: 'UserPromptSubmit', prompt_id: randomUUID(), prompt: text });
  await emit(a, { ...input, id: second });
  await emit(b, { id: 'control:turn-start', kind: 'control', turnId: 'other-turn', status: 'running' });
  await emit(b, { id: 'display:other', kind: 'response', turnId: 'other-turn', index: 0, delta: 'OTHER_MEMBER_STREAM', status: 'streaming' });
  await reader(b).getByText('OTHER_MEMBER_STREAM', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => getSelection().toString()), selection); assert.equal(await node.evaluate(el => el.isConnected), true);
  const inputs = (await snapshot()).sessions.find(s => s.id === a).messages.filter(m => m.inputMode === 'native-inline');
  assert.equal(inputs.length, 2); assert.ok(inputs.every(m => m.text === text));
  assert.equal(await row.locator('.message-heading strong').first().innerText(), '原生会话', 'Native accepted framing is not attributed to the human');
  assert.equal((await snapshot()).sessions.find(s => s.id === a).messages.filter(m => m.role === 'user').length, 3, 'One app task plus two actual native inputs, no hook or boundary rows');
  check('Duplicate UUID updates its original row; equal text under a second UUID remains distinct; another member stream preserves selected text and row identity');
  await row.hover(); const copy = row.locator(':scope > .message-actions').getByRole('button', { name: '复制', exact: true });
  if (installed) { await copy.focus(); assert.equal(await copy.isEnabled(), true); assert.equal(await row.locator('.message-body').textContent(), text); }
  else { await copy.click(); assert.equal(await app.evaluate(() => globalThis.inlineCopies.at(-1)), text); }
  await emit(a, { ...response, index: 1, delta: 'PRIVATE_CONTINUATION' });
  const state = await snapshot(); assert.ok(!JSON.stringify(state.room.messages).includes('PRIVATE_CONTINUATION'));
  assert.ok(!JSON.stringify(state.room.messages).includes(text)); assert.equal(state.sessions.find(s => s.id === a).liveDraft, 'UNSENT_PRIVATE_INLINE_DRAFT');
  assert.equal(state.sessions.find(s => s.id === a).messages.find(m => m.id.endsWith('display:shared')).text, 'ORIGINAL_SHARED_PREFIXPRIVATE_CONTINUATION');
  check((installed ? 'Copy focus/exact source retained (source clipboard receipt reused); ' : 'Exact source copy succeeds; ') + 'private inline text and following output stay outside the old shared grant, and both drafts remain stored');
  await page.getByRole('button', { name: '放大 Inline A 的会话', exact: true }).click();
  await page.locator(`#messages [data-message-id="native:${nativeId}:${id}"]`).waitFor();
  await page.getByRole('button', { name: '← 返回共同工作', exact: true }).click();
  await page.getByRole('button', { name: '简化信息', exact: true }).click();
  await page.getByRole('button', { name: '简化信息', exact: true }).click();
  await row.waitFor(); await capture('02-returned-original-input');
  check('Existing focus, return and simplified-information controls return to the original input without sending or creating a new session');
  await page.reload(); await page.locator('#room-nav').waitFor(); await page.locator('#room-nav').click(); await row.waitFor();
  const reloaded = await snapshot(); assert.equal(identity(reloaded).length, 3); assert.deepEqual(identity(reloaded), originalIdentity);
  assert.equal(reloaded.sessions.find(s => s.id === a).messages.filter(m => m.inputMode === 'native-inline').length, 2);
  assert.equal(await row.locator('.message-body').textContent(), text);
  assert.equal(reloaded.sessions.find(s => s.id === a).liveDraft, 'UNSENT_PRIVATE_INLINE_DRAFT');
  assert.equal(await roomBody(page), 'UNSENT_ROOM_INLINE_DRAFT');
  await page.locator(`[data-session-id="${a}"]`).click();
  const privateRow = page.locator(`#messages [data-message-id="native:${nativeId}:${id}"]`); await privateRow.waitFor();
  assert.equal(await privateRow.locator('.message-body').textContent(), text); assert.equal(await page.locator('#message-input').inputValue(), 'UNSENT_PRIVATE_INLINE_DRAFT');
  check('Reload and original single-session view retain both exact native inputs, native identities and unsent drafts');
  assert.deepEqual(errors, []); const stats = (await fixture('stats')).stats; assert.equal(stats.sends, 1); assert.equal(stats.inputs, 0);
  const result = { checks, errors, stats, productModelCalls: 0, realProviderProcesses: 0, limits: (installed ? 'Installed synthetic GUI, source clipboard receipt reused; ' : 'Source synthetic GUI; ') + 'no physical clipboard/IME, real provider or T78 image display proof.' };
  fs.writeFileSync(path.join(profile, 'inline-input-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try {
    await scratch.release(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'released.json'), JSON.stringify({ owner: 'Codex 3', task: 'T88', token, profile, ownedProfilesAndProcessesGone: true, at: new Date().toISOString() }, null, 2));
    console.log('Owned fixture cleaned; canonical GUI slot released.');
  } catch (error) { console.error('Cleanup unconfirmed; own lock retained:', error.message); process.exitCode = 1; }
});
