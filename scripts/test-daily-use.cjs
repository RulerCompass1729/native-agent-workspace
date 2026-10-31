// One isolated app, real shipped adapter/workspace/IPC, synthetic providers.
// This tests the complete daily-use path, not native login, models or fleets.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const plan = { task: 'T33 current daily-use source GUI', fullGuiStarts: 2, intentionalDuplicateStart: 1, ownedSyntheticDaemons: 1, syntheticSessions: 2, syntheticSends: 3, unsentSyntheticTerminalText: 'UNSUBMITTED-CODEX-ROOM-SOLO', productModels: 0, realProviders: 0, osClipboard: 0, maxRunMs: 300000 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_T33_DAILY_GUI_AUTHORIZED, '1', 'Record the finite source GUI plan before running');
assert.ok(!process.env.NAW_APP_EXECUTABLE && path.resolve(code) === root, 'This recipe qualifies source only; Main owns installed acceptance');
const evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'Private outside-repository evidence is required');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
let existing = evidence;
while (!fs.existsSync(existing)) existing = path.dirname(existing);
const destination = path.resolve(fs.realpathSync(existing), path.relative(existing, evidence));
for (const repo of [fs.realpathSync(root), fs.realpathSync(path.resolve(slot, '../..'))]) assert.ok(destination !== repo && !destination.startsWith(repo + path.sep), 'Evidence must be outside both repositories');
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no profile, daemon or GUI started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: plan.task, token, pid: process.pid, time: new Date().toISOString() }));
const testScratch = require('./fixtures/test-scratch.cjs');
const { fork, spawn } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-daily-ui-'));
const entry = path.join(profile, 'entry'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-daily-gui', version: require('../package.json').version, main: 'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),e=require('electron');
globalThis.dailyGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};
const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs')){globalThis.dailyGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};
for(const name of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[name]=()=>{globalThis.dailyGuards.clipboard++;throw Error('OS clipboard prohibited');};
e.shell.openPath=e.shell.openExternal=async()=>{globalThis.dailyGuards.external++;throw Error('External action prohibited');};
e.dialog.showOpenDialog=e.dialog.showMessageBox=async()=>{globalThis.dailyGuards.dialogs++;throw Error('OS dialog prohibited');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});WorkspaceClient.prototype.maintainService=function(){globalThis.dailyGuards.maintenance++;throw Error('Backend update prohibited');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});`);
const executablePath = require('electron'), args = [entry];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/daily-native.cjs')], env: env({ NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0, failure, fullStarts = 0; const errors = [], passed = [], requests = new Set(), startupMs = [], guardSamples = [], guiPids = [], duplicatePids = [];
const started = Date.now();
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 140; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', text = '') { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } }; child.on('message', cb); child.send({ id, method, text });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const input = id => page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`);
async function capture(name) { fs.mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + '.png') }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2)); }
async function guards() { const sample = await app.evaluate(() => globalThis.dailyGuards); assert.deepEqual(sample, { clipboard: 0, external: 0, dialogs: 0, maintenance: 0, replacement: 0 }); guardSamples.push(sample); }
function check(text) { assert.ok(Date.now() - started < plan.maxRunMs, 'Five-minute stage-entry budget'); passed.push(text); console.log('PASS:', text); }
async function launch() {
  const started = performance.now();
  assert.ok(fullStarts++ < plan.fullGuiStarts, 'At most two full GUI starts');
  assert.ok(!app); app = await _electron.launch({ executablePath, args, env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 });
  guiPids.push(app.process().pid);
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (/^https?:|^wss?:/.test(r.url())) requests.add(new URL(r.url()).hostname); });
  await page.locator('#new-session').waitFor();
  startupMs.push(Math.round(performance.now() - started));
}
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(provider + ' · 日用测试'); await createIn(page, 'terminal');
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.chatAvailable && s.terminalAvailable), 'Session ready');
  return (await snapshot()).sessions.find(s => s.provider === provider).id;
}
async function terminal(id) {
  if ((await snapshot()).viewState.selected !== id) {
    const row = page.locator(`#session-list .session-link[data-session-id="${id}"]`);
    await row.click();
  }
  await page.locator('#terminal-tab').click();
  await until(() => input(id).evaluate(el => document.activeElement === el), 'Selected terminal focus');
}
async function membership(id, join) {
  const room = (await snapshot()).rooms.find(room => room.id === 'shared');
  await page.locator(`[data-session-menu="${id}"]`).click();
  await page.getByRole('menuitem', { name: `${join ? '加入' : '离开'}「${room.name}」`, exact: true }).click();
  await until(async () => Boolean((await snapshot()).sessions.find(s => s.id === id).roomIds?.includes('shared')) === join, 'Visible membership action acknowledged');
}
async function reply(text) { await fixture('release', text); await until(async () => (await snapshot()).sessions.every(s => !s.pendingTag), 'Reply settled'); }
const identities = state => state.sessions.map(s => [s.id, s.nativeId]);
async function run() {
  console.log('Synthetic profile:', profile, 'Code root:', code);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon ready'); client = await connect(profile, 'daily-observer');
  const backend = await client.call('initial'); assert.equal(backend.servicePid, child.pid); assert.equal(backend.runtimeVersion, require('../package.json').version); assert.equal(backend.sessions.length, 0);
  await launch();
  await page.locator('#setup-button').click(); await page.locator('#setup-dialog').waitFor(); assert.match(await page.locator('#version-info').innerText(), /应用/);
  await require('./check-theme.cjs').checkTheme(page); await page.locator('#close-setup').click();
  check('Fresh app profile renders setup and light/dark controls; native environment installation is not simulated');
  const codex = await create('codex');
  // History items, not the native turn record that closes the imported turn.
  const history = state => state.sessions.find(s => s.id === codex).messages.filter(m => m.kind !== 'turn');
  await until(async () => history(await snapshot()).length === 105, 'All native history pages imported');
  let codexState = (await snapshot()).sessions.find(s => s.id === codex);
  assert.equal(new Set(history({ sessions: [codexState] }).map(m => m.id)).size, 105); assert.equal(codexState.controlRevision, 1);
  await page.locator('#chat-tab').click();
  const expected = new Set(history({ sessions: [codexState] }).map(m => m.id)), seen = new Set();
  const rendered = async () => page.locator('#messages article[data-message-id]').evaluateAll(rows => rows.map(row => row.dataset.messageId));
  await until(async () => (await rendered()).some(id => expected.has(id)), 'Initial bounded history page');
  assert.ok((await rendered()).length <= 50, 'Recent originals use the current bounded reader');
  for (let pages = 0; pages < 3; pages++) {
    for (const id of await rendered()) if (expected.has(id)) seen.add(id);
    if (seen.size === expected.size) break;
    const previous = seen.size; await page.locator('#messages').getByRole('button', { name: '显示更早的记录', exact: true }).click();
    await until(async () => (await rendered()).filter(id => expected.has(id)).length > previous, 'Explicit older originals loaded');
  }
  assert.deepEqual([...seen].sort(), [...expected].sort(), 'All 105 exact original records remain readable without initial full rendering');
  await page.locator('#messages').getByText('PRIVATE-HISTORY-104', { exact: true }).scrollIntoViewIfNeeded(); await capture('history-complete');
  await page.locator('#message-input').fill('私有中文草稿\n不分享');
  await terminal(codex); await page.keyboard.type('UNSUBMITTED-CODEX');
  assert.equal((await fixture()).inputs.filter(x => x.id === codex).map(x => x.data).join(''), 'UNSUBMITTED-CODEX');
  await page.locator('#chat-tab').click(); assert.equal(await page.locator('#message-input').inputValue(), '私有中文草稿\n不分享');
  // Explicit solo send has one exact payload, no history/context replay.
  await page.locator('#message-input').fill('SOLO-QUESTION'); await page.locator('#send-button').click();
  await until(async () => (await fixture()).sends.length === 1, 'Solo send'); assert.deepEqual((await fixture()).sends[0], { id: codex, text: 'SOLO-QUESTION' }); await reply('SOLO-ANSWER');
  await page.locator('#message-input').fill('保留独立草稿');
  check('Codex terminal attachment retains 105 history items once; bounded pages expose all originals and GUI/TUI keep identity, exact first input and private drafts');
  const claude = await create('claude'); const ids = identities(await snapshot());
  await page.locator(`[data-session-menu="${claude}"]`).click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await page.locator('#rename-name').fill('一起核查'); await page.locator('#confirm-rename').click();
  await membership(claude, true);
  await page.locator(`[data-session-id="${codex}"]`).click(); await membership(codex, true);
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.equal((await snapshot()).room.messages.length, 0, 'Joining does not expose private history');
  await chooseRecipient(claude); await fillRoomMessage(page, 'SHARED-MATERIAL'); await page.locator('#forward-button').click();
  await until(async () => (await fixture()).sends.length === 2, 'Directed Claude send'); await reply('REVIEW-MATERIAL');
  const shared = page.locator('#room-messages article.assistant').filter({ has: page.getByText('REVIEW-MATERIAL', { exact: true }) });
  await shared.hover(); await shared.getByRole('button', { name: '选择并分享：一起核查的回复', exact: true }).click(); await page.locator('#share-recipient').selectOption(codex);
  assert.equal(await page.locator('#share-text').inputValue(), 'REVIEW-MATERIAL'); await page.locator('#confirm-share').click();
  await until(async () => (await fixture()).sends.length === 3, 'Selected review to Codex'); await reply('VERIFIED-MATERIAL');
  await page.locator('#room-messages').getByText('VERIFIED-MATERIAL', { exact: true }).waitFor();
  const requestArticle = page.locator('#room-messages article').filter({ has: page.getByText('SHARED-MATERIAL', { exact: true }) });
  assert.equal(await requestArticle.locator('.message-heading .message-author').innerText(), '你 → 一起核查');
  assert.equal(await shared.locator('.message-heading .message-author').innerText(), '一起核查');
  assert.deepEqual((await fixture()).sends, [{ id: codex, text: 'SOLO-QUESTION' }, { id: claude, text: 'SHARED-MATERIAL' }, { id: codex, text: 'REVIEW-MATERIAL' }]);
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('PRIVATE-HISTORY'));
  await page.locator(`[data-session-menu="${claude}"]`).click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await page.locator('#rename-name').fill('复核伙伴'); await page.locator('#confirm-rename').click();
  await until(async () => await shared.locator('.message-heading .message-author').innerText() === '复核伙伴', 'Room authors follow renaming');
  assert.equal(await requestArticle.locator('.message-heading .message-author').innerText(), '你 → 复核伙伴');
  await page.locator('#room-messages').getByText('VERIFIED-MATERIAL', { exact: true }).scrollIntoViewIfNeeded();
  await capture('shared-review'); check('Two-agent directed verification shares only selected material; current author/recipient names follow renaming without changing saved messages');
  await page.locator('#room-overview').click();
  await page.locator(`.collaboration-member-status[data-member-id="${codex}"] .collaboration-member-name`).click();
  await page.locator('#terminal-tab').click(); await until(() => input(codex).evaluate(el => document.activeElement === el), 'Explicit original member terminal focus');
  await page.keyboard.type('-ROOM');
  await page.locator('#collaboration-overview').getByRole('button', { name: '← 返回共同工作', exact: true }).click();
  await page.locator('#room-record').click(); await chooseRecipient(claude); await fillRoomMessage(page, '下一次核查草稿');
  await page.locator(`[data-session-id="${codex}"]`).click(); await membership(codex, false);
  await terminal(codex); await page.keyboard.type('-SOLO');
  assert.equal((await fixture()).inputs.filter(x => x.id === codex).map(x => x.data).join(''), 'UNSUBMITTED-CODEX-ROOM-SOLO');
  assert.deepEqual(identities(await snapshot()), ids); assert.equal((await snapshot()).sessions.find(s => s.id === codex).roomId, null);
  await page.locator('#chat-tab').click(); assert.equal(await page.locator('#message-input').inputValue(), '保留独立草稿');
  await terminal(codex); const before = await snapshot(); await capture('detached-terminal');
  // A deliberate competing test launch keeps this app inactive and creates no new UI.
  const duplicate = spawn(executablePath, args, { env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), stdio: 'ignore' });
  duplicatePids.push(duplicate.pid);
  try { await until(() => duplicate.exitCode !== null, 'Duplicate exits'); assert.equal(duplicate.exitCode, 0); } finally { if (duplicate.exitCode === null) duplicate.kill('SIGTERM'); }
  assert.equal(app.windows().length, 1);
  await guards(); await app.close(); app = null; await launch();
  const after = await snapshot(); assert.deepEqual(identities(after), ids);
  assert.deepEqual(after.sessions.map(s => [s.id, s.messages, s.liveDraft, s.name, s.roomId]), before.sessions.map(s => [s.id, s.messages, s.liveDraft, s.name, s.roomId]));
  for (const key of ['selected', 'mode', 'roomSession', 'sharedDraft', 'roomRecipient', 'spaceId', 'sidebarSpaceFilter']) assert.deepEqual(after.viewState[key], before.viewState[key], key);
  await until(() => input(codex).evaluate(el => document.activeElement === el), 'Reopen original terminal');
  assert.equal((await fixture()).sends.length, 3); assert.equal((await fixture()).calls.filter(x => x === 'thread/items/list').length, 2, 'UI reopen does not reload the agent');
  check('Detach continues the same terminal; deliberate duplicate launch and reopen retain names, history, membership, both drafts and recipient with no replay');
  await page.locator('#privacy-button').click(); const trust = await page.locator('#trust-status').innerText();
  assert.match(trust, /不是总用量或账单/); assert.match(trust, /未报告；不能据此判断为零/); await capture('privacy-usage'); await page.locator('#close-privacy').click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(880, 660));
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.equal(await roomBody(page), '下一次核查草稿'); assert.equal(await page.locator('#recipient').inputValue(), claude);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await capture('compact-room');
  check('Usage panel distinguishes unknown native cost from shell counts; compact window retains controls and shared draft');
  assert.equal((await snapshot()).diagnostics.shellModelCalls, 0); assert.equal((await snapshot()).diagnostics.dispatches, 3);
  assert.deepEqual(errors, []); assert.ok([...requests].every(x => x === '127.0.0.1' || x === 'localhost'));
  await guards();
  // One sampled process-tree baseline, not a steady-state/per-provider benchmark.
  const processRows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu='], { encoding: 'utf8' }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const owned = new Set([app.process().pid, child.pid]);
  for (let previous = -1; previous !== owned.size;) { previous = owned.size; for (const [pid, parent] of processRows) if (owned.has(parent)) owned.add(pid); }
  const sample = processRows.filter(([pid]) => owned.has(pid));
  const resources = { startupMs, processes: sample.length, summedRssMiB: Math.round(sample.reduce((n, row) => n + row[2], 0) / 1024), sampledCpuPercent: sample.reduce((n, row) => n + row[3], 0), scope: 'Synthetic test app/services only; summed RSS may double-count shared pages; one sample, not steady-state or native costs' };
  console.log(JSON.stringify({ passed, errors, resources, syntheticDispatches: 3, nativeProcesses: 0, modelCalls: 0, oneWindow: app.windows().length === 1, observedRendererHosts: [...requests] }, null, 2));
}
const cleanup = testScratch.cleanup(async () => {
  if (app) await app.close(); if (client) { const state = await client.call('initial'); for (const s of state.sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
});
run().catch(async e => { failure = e.stack; console.error(failure); if (page) await capture('failed').catch(() => {}); process.exitCode = 1; }).finally(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed, failure, errors, profile, ownedNodePid: child.pid, ownedGuiPids: guiPids, ownedDuplicatePids: duplicatePids, fullStarts, guards: guardSamples, currentGuards: app ? await app.evaluate(() => globalThis.dailyGuards).catch(() => null) : null, fixture: child.connected ? await fixture().catch(() => null) : null }, null, 2));
  await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
  fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) }));
});

async function chooseRecipient(id) { await inlineRecipient(page, id); }
