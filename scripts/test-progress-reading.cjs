// Existing complete progress-reading journey, source GUI and synthetic providers only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const plan = { task: 'T33 current progress-reading source GUI', fullGuiStarts: 2, ownedSyntheticDaemons: 1, syntheticSessions: 2, syntheticSends: 5, terminalInputs: 0, productModels: 0, realProviders: 0, osClipboard: 0, maxRunMs: 300000 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_T33_PROGRESS_GUI_AUTHORIZED, '1', 'Record the finite source GUI plan before running');
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
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient: inlineRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-progress-ui-'));
const entry = path.join(profile, 'entry'); fs.mkdirSync(entry);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-progress-gui', version: require('../package.json').version, main: 'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),e=require('electron');
globalThis.progressGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};
const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs')){globalThis.progressGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};
for(const name of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[name]=()=>{globalThis.progressGuards.clipboard++;throw Error('OS clipboard prohibited');};
e.shell.openPath=e.shell.openExternal=async()=>{globalThis.progressGuards.external++;throw Error('External action prohibited');};
e.dialog.showOpenDialog=e.dialog.showMessageBox=async()=>{globalThis.progressGuards.dialogs++;throw Error('OS dialog prohibited');};
const {WorkspaceClient}=require(${JSON.stringify(path.join(root, 'app/workspace-client.cjs'))});WorkspaceClient.prototype.maintainService=function(){globalThis.progressGuards.maintenance++;throw Error('Backend update prohibited');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});`);
const executablePath = require('electron'), args = [entry];
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')], env: env({ NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let application, page, client, sequence = 0, failure, fullStarts = 0;
const started = Date.now(), guiPids = [], guardSamples = [];
const errors = [], checks = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); result.error ? reject(Error(result.error)) : resolve(result); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timeout')); }, 10000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function capture(name) {
  if (!page || page.isClosed()) return;
  fs.mkdirSync(evidence, { recursive: true });
  await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2));
}
async function guards() { const values = await application.evaluate(() => globalThis.progressGuards); assert.deepEqual(values, { clipboard: 0, external: 0, dialogs: 0, maintenance: 0, replacement: 0 }); guardSamples.push(values); }
async function check(text) { assert.ok(Date.now() - started < plan.maxRunMs, 'Five-minute stage-entry budget'); checks.push(text); console.log('PASS:', text); await capture('stage-' + String(checks.length).padStart(2, '0')); }
async function selectSession(id) {
  const row = page.locator(`#session-list .session-link[data-session-id="${id}"]`);
  if (!(await row.isVisible()) && (await snapshot()).viewState.sidebarSpaceFilter) await page.locator('#clear-space-filter').click();
  await row.click();
}
async function membership(id, join) {
  const room = (await snapshot()).rooms.find(room => room.id === 'shared');
  await page.locator(`[data-session-menu="${id}"]`).click();
  await page.getByRole('menuitem', { name: `${join ? '加入' : '离开'}「${room.name}」`, exact: true }).click();
  await until(async () => Boolean((await snapshot()).sessions.find(s => s.id === id).roomIds?.includes('shared')) === join, 'Visible membership acknowledged');
}
async function launch() {
  assert.ok(fullStarts++ < plan.fullGuiStarts, 'At most two full GUI starts'); assert.ok(!application);
  application = await _electron.launch({ executablePath, args, env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 });
  guiPids.push(application.process().pid);
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
}

async function create(name, provider = 'claude') {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name), 'Session created');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon');
  client = await connect(profile, 'progress-observer'); const backend = await client.call('initial');
  assert.equal(backend.servicePid, child.pid); assert.equal(backend.runtimeVersion, require('../package.json').version); assert.equal(backend.sessions.length, 0);
  await launch();
  const a = await create('Reading A'), b = await create('Reading B', 'codex');
  const text = Array.from({ length: 100 }, (_, i) => `Result line ${i}: local output`).join('\n');
  await fixture('nativeBlock', a, { id: 'tool:read', kind: 'tool', turnId: 'a', title: 'Read', input: 'fixture.txt', text, status: 'complete' });
  await fixture('nativeBlock', b, { id: 'tool:read', kind: 'tool', turnId: 'b', title: 'Read', text: 'Other session result', status: 'complete' });
  await selectSession(a);
  // Tool records are folded process rows in the reader; open one to read its whole body.
  const result = page.locator('#messages .message.tool'), details = result.locator('.process-details').first(); await details.waitFor();
  if (!(await details.evaluate(el => el.open))) await details.locator(':scope > summary').click();
  await result.locator('.message-body').waitFor();
  assert.match(await result.innerText(), /Result line 0/); assert.equal(await page.locator('.native-progress').count(), 0);
  await page.locator('#messages').hover(); await page.mouse.wheel(0, -1000000); await delay(100); await page.mouse.wheel(0, 260); await delay(200);
  const position = await page.locator('#messages').evaluate(el => el.scrollTop); assert.ok(position > 100);
  await page.locator('#message-input').fill('Unsent private draft');
  await selectSession(b); assert.match(await page.locator('#messages').innerText(), /Other session result/);
  await selectSession(a); await delay(150);
  assert.ok(Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - position) < 3);
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private draft');
  await check('Native tool body/input use the main reader; session switch retains draft and reading position');
  await page.locator('#terminal-tab').click(); await page.locator('#chat-tab').click(); await delay(150);
  assert.ok(Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - position) < 3);
  await membership(a, true); await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('Result line'));
  await selectSession(a); await membership(a, false);
  assert.equal((await snapshot()).sessions.find(s => s.id === a).messages.find(m => m.kind === 'tool').text, text);
  await check('GUI/TUI switching and joining/leaving preserve private original content without sharing it');
  await fixture('legacyService', b); await fixture('progress', b, { id: 'legacy-read', source: 'claude-native-message', kind: 'tool-output', title: 'Legacy Read', status: 'observed', text: 'Retained backend output' });
  await selectSession(b);
  // The folded row shows the latest text as its label; its body holds the same text.
  const legacyRow = page.locator('#messages [data-message-id="legacy-observation:legacy-read"]');
  await legacyRow.filter({ hasText: 'Retained backend output' }).waitFor();
  await fixture('progress', b, { id: 'legacy-read', source: 'claude-native-message', kind: 'tool-output', text: 'Retained backend live update' });
  await legacyRow.filter({ hasText: 'Retained backend live update' }).waitFor();
  assert.equal(await page.locator('#messages [data-message-id="legacy-observation:legacy-read"]').count(), 1);
  await check('Retained service progress snapshot and live updates remain readable inline without a camera panel');
  await fixture('progress', b, { id: 'legacy-read', source: 'claude-native-message', kind: 'tool-output', status: 'running', text: 'Last received running output' });
  await legacyRow.filter({ hasText: 'Last received running output' }).waitFor();
  await fixture('state', b, 'disconnected');
  await page.locator('#messages').getByText('连接状态尚未确认。保留最后收到的过程记录，当前运行情况未知。', { exact: true }).waitFor();
  await fixture('progress', b, { id: 'legacy-read', source: 'claude-native-message', kind: 'tool-output', status: 'running', text: 'Late disconnected event' });
  assert.match(await page.locator('#messages').innerText(), /Last received running output/);
  assert.ok(!(await page.locator('#messages').innerText()).includes('Late disconnected event'));
  await fixture('state', b, 'idle');
  await legacyRow.filter({ hasText: 'Late disconnected event' }).waitFor();
  await check('Retained connection loss freezes last records and ignores late live output; reconnection reloads native observations');
  assert.equal((await fixture('stats')).stats.sends, 0);
  for (const id of [a, b]) {
    await selectSession(id);
    await membership(id, true);
    await fixture('bindSends', id);
  }
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  async function sendTo(id, text) {
    await inlineRecipient(page, id);
    await fillRoomMessage(page, text); await page.locator('#forward-button').click();
    await until(async () => (await fixture('stats', id)).lastSend?.text === text, 'Directed native send');
    return (await fixture('stats', id)).lastSend;
  }
  const sa = await sendTo(a, 'Shared task for A'), sb = await sendTo(b, 'Shared task for B');
  await fixture('nativeBlock', a, { ...sa, id: 'display:shared-a', kind: 'response', text: 'Alpha shared output', status: 'streaming' });
  await page.locator('#room-messages').getByText('Alpha shared output', { exact: true }).waitFor();
  const ar = (await snapshot()).room.messages.find(m => m.text === 'Alpha shared output');
  const arow = page.locator(`[data-message-id="${ar.id}"]`), element = await arow.elementHandle();
  await fixture('nativeBlock', b, { ...sb, id: 'display:shared-b', kind: 'response', text: 'Beta shared output', status: 'streaming' });
  await page.locator('#room-messages').getByText('Beta shared output', { exact: true }).waitFor();
  assert.match(await arow.innerText(), /Reading A/);
  await fillRoomMessage(page, 'Unsent room draft'); await page.locator('#shared-input').focus();
  await fixture('nativeBlock', a, { ...sa, id: 'display:shared-a', kind: 'response', text: 'Alpha shared output continued', status: 'streaming' });
  await arow.getByText('Alpha shared output continued', { exact: true }).waitFor();
  assert.equal(await element.evaluate(el => el.isConnected), true);
  assert.equal(await roomBody(page), 'Unsent room draft');
  assert.equal(await page.locator('#shared-input').evaluate(el => document.activeElement === el), true);
  assert.equal(await page.locator('.native-progress').count(), 0);
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('Result line'));
  await check('Two directed agent streams update stable labelled blocks in one room reader, preserving draft/focus and excluding private history');
  await page.locator('#room-filter').selectOption(a);
  await arow.waitFor(); assert.ok(!(await page.locator('#room-messages').innerText()).includes('Beta shared output'));
  await page.locator('#room-filter').selectOption('');
  const finalText = 'Alpha shared output continued';
  await fixture('complete', a, { messageId: ar.nativeMessageId, text: finalText });
  await until(async () => (await snapshot()).room.messages.find(m => m.id === ar.id)?.finalReply, 'Final updates the same block');
  assert.equal((await snapshot()).room.messages.filter(m => m.text === finalText).length, 1);
  await arow.locator('.message-delivery summary').click();
  assert.match(await arow.innerText(), /本条未由工作区转发/);
  assert.equal((await fixture('stats')).stats.sends, 2);
  await check('Member filter preserves stream identity; final replaces its block without duplicating or dispatching visible progress');
  await selectSession(b);
  await membership(b, false);
  await until(async () => !(await snapshot()).sessions.find(s => s.id === b).roomId, 'Native membership confirmed');
  await fixture('nativeBlock', b, { ...sb, id: 'display:shared-b', kind: 'response', text: 'Beta private continuation', status: 'streaming' });
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.match(await page.locator('#room-messages').innerText(), /Beta shared output/);
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('Beta private continuation'));
  assert.match(await page.locator('#room-messages').innerText(), /共享已停止/);
  await check('Leaving freezes the already shared prefix while later native content remains private');
  await fillRoomMessage(page, '');
  const originalParent = (await snapshot()).room.messages.find(m => m.text === 'Shared task for A');
  // Message actions appear while the pointer is over the message, as for a person.
  await arow.hover(); await arow.getByRole('button', { name: '回复 · 2 条讨论记录', exact: true }).click();
  assert.equal(await page.locator('#thread-heading').isVisible(), true);
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('Beta shared output'));
  await inlineRecipient(page, a);
  await fillRoomMessage(page, 'Follow up only'); await page.locator('#forward-button').click();
  await until(async () => (await fixture('stats', a)).lastSend?.text === 'Follow up only', 'Thread send');
  const sc = (await fixture('stats', a)).lastSend;
  const follow = (await snapshot()).room.messages.find(m => m.text === 'Follow up only');
  assert.equal(follow.replyTo, originalParent.id);
  assert.equal(sc.text, 'Follow up only');
  await fixture('nativeBlock', a, { ...sc, id: 'display:follow-up', kind: 'response', text: 'Reply within discussion', status: 'streaming' });
  await page.locator('#room-messages').getByText('Reply within discussion', { exact: true }).waitFor();
  await page.locator(`[data-message-id="${follow.id}"] .message-delivery summary`).click();
  assert.equal(await page.locator(`[data-message-id="${follow.id}"] .delivery-payload`).innerText(), 'Follow up only');
  await fillRoomMessage(page, 'Unsent discussion draft');
  await selectSession(a); await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  assert.equal(await roomBody(page), 'Unsent discussion draft');
  assert.match(await page.locator('#reply-label').innerText(), /Shared task for A/);
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'discussion.png') }); }
  await check('Reply opens one discussion, native reply streams in that thread, and only the explicit new text is delivered');
  await guards(); await application.close(); application = null;
  await launch(); await page.locator('#shared-input').waitFor();
  assert.equal(await roomBody(page), 'Unsent discussion draft');
  assert.match(await page.locator('#reply-label').innerText(), /Shared task for A/);
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('Beta shared output'));
  assert.equal((await fixture('stats')).stats.sends, 3);
  await page.locator('#room-messages').getByRole('button', { name: '查看 Reading A 的共享轨迹', exact: true }).first().click();
  assert.equal(await page.locator('#room-filter').inputValue(), a);
  await page.locator('#room-filter').selectOption('');
  await page.locator('#search-button').click();
  await page.locator('#search-options > summary').click();
  await page.locator('#search-scope').selectOption('room'); await page.locator('#search-input').fill('Beta shared output');
  await page.locator('#search-results .search-result').first().click();
  await page.locator('#room-messages').getByText('Beta shared output', { exact: true }).waitFor();
  await page.locator('#return-reading').click();
  assert.equal(await page.locator('#thread-heading').isVisible(), true);
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('Beta shared output'));
  assert.equal(await roomBody(page), 'Unsent discussion draft');
  await check('Clicking an author filters its shared trajectory; search into another discussion and return preserve thread draft and reading scope');
  await page.locator('#thread-back').click();
  await page.locator('#room-messages').getByText('Beta shared output', { exact: true }).waitFor();
  assert.equal(await page.locator('#reply-context').isVisible(), true, 'Draft stays attached until explicitly cancelled');
  await page.locator('#cancel-reply').click();
  assert.equal(await roomBody(page), 'Unsent discussion draft');
  assert.equal(await page.locator('#reply-context').isVisible(), false);
  await check('App reopen preserves thread and draft without resending; return to all discussions and cancel reply preserve draft text');
  await fillRoomMessage(page, '');
  const followAnswer = (await snapshot()).room.messages.find(m => m.text === 'Reply within discussion');
  await fixture('complete', a, { messageId: followAnswer.nativeMessageId, text: 'Reply within discussion' });
  await fixture('complete', b, { text: 'Private end' });
  await selectSession(b); await membership(b, true);
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator(`[data-message-id="${originalParent.id}"]`).hover(); await page.locator(`[data-reply-to="${originalParent.id}"]`).click();
  await inlineRecipient(page, a);
  await fillRoomMessage(page, 'New finite check only');
  await page.locator('#room-advanced summary').click(); await page.locator('#run-button').click();
  await page.locator('#run-limit').selectOption('2'); await page.locator('#run-consent').check(); await page.locator('#confirm-run').click();
  await until(async () => (await fixture('stats', a)).lastSend?.text === 'New finite check only', 'Threaded run starts');
  const ra = (await fixture('stats', a)).lastSend;
  await fixture('nativeBlock', a, { ...ra, id: 'display:run-a', kind: 'response', text: 'First bounded answer', status: 'complete' });
  const raRow = (await snapshot()).room.messages.find(m => m.text === 'First bounded answer');
  await fixture('complete', a, { messageId: raRow.nativeMessageId, text: 'First bounded answer' });
  await until(async () => (await fixture('stats')).stats.sends === 5, 'One authorized next recipient');
  const rb = (await fixture('stats', b)).lastSend;
  assert.ok(rb.text.includes('First bounded answer')); assert.ok(!rb.text.includes('Shared task for A'));
  await fixture('nativeBlock', b, { ...rb, id: 'display:run-b', kind: 'response', text: 'Second bounded answer', status: 'complete' });
  const rbRow = (await snapshot()).room.messages.find(m => m.text === 'Second bounded answer');
  await fixture('complete', b, { messageId: rbRow.nativeMessageId, text: 'Second bounded answer' });
  await until(async () => (await snapshot()).room.run.status !== 'running', 'Reply cap stops exchange');
  const threaded = await snapshot(), runId = threaded.room.run.id;
  const index = require('../app/room-threads.js').threadIndex(threaded.room.messages);
  for (const row of threaded.room.messages.filter(m => m.runId === runId)) assert.equal(index.roots.get(row.id), originalParent.id);
  await page.locator('#room-messages').getByText('Second bounded answer', { exact: true }).waitFor();
  assert.equal(await page.locator('#thread-heading').isVisible(), true);
  assert.ok(!(await page.locator('#room-messages').innerText()).includes('Beta shared output'));
  await check('Finite two-agent exchange stays in the existing thread including task, authorization and completion events; no unrelated history enters either payload');

  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'shared-streams.png') }); }
  assert.deepEqual(errors, []); const stats = (await fixture('stats')).stats; assert.equal(stats.sends, 5); assert.equal(stats.inputs, 0); await guards();
  console.log(JSON.stringify({ checks, errors, modelCalls: 0, stats, profile }, null, 2));
}
const cleanup = testScratch.cleanup(async () => {
  if (application) await application.close();
  if (child.exitCode === null) { await fixture('stop'); if (client) { await client.call('shutdown'); client.close(); } else child.kill('SIGTERM'); }
  if (child.connected) child.disconnect(); await until(() => child.exitCode !== null, 'Owned fixture daemon exits');
});
run().catch(async e => {
  failure = e.stack; await capture('failed').catch(() => {});
  if (page && !page.isClosed()) fs.writeFileSync(path.join(profile, 'failure.txt'), await page.locator('body').innerText().catch(() => ''));
  console.error(failure); process.exitCode = 1;
}).finally(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, failure, errors, profile, ownedNodePid: child.pid, ownedGuiPids: guiPids, fullStarts, guards: guardSamples, currentGuards: application ? await application.evaluate(() => globalThis.progressGuards).catch(() => null) : null, fixture: child.connected ? await fixture('stats').catch(() => null) : null }, null, 2));
  await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
  fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile) }));
});
