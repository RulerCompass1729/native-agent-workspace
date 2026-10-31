// Whole existing background-preview -> explicit current draft journey.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const plan = { task: 'T53 selected-space context source GUI', guiStarts: 1, pageReloads: 1, fakeDaemons: 1,
  logicalSessions: 3, spaces: 3, setupMemberships: 5, explicitClaims: 0, interceptedCopies: 2,
  productModels: 0, realProviders: 0, nativeCLI: 0, nativeInput: 0, sends: 0, approvals: 0, osClipboard: 0,
  maxRunMs: 450000, budgetKind: 'stage-entry guard; launch70s, locator12s, fixture8s, until10s; not a hard wall deadline' };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_CONTEXT_GUI_AUTHORIZED, '1', 'Record the finite source GUI plan first');
assert.ok(!process.env.NAW_APP_EXECUTABLE && !process.env.NAW_TEST_APP_ROOT, 'Source-only test');
const evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence) && !fs.existsSync(evidence), 'New private outside-repository evidence is required');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
let ancestor = evidence; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
const destination = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, evidence));
for (const repo of [fs.realpathSync(root), fs.realpathSync(path.resolve(slot, '../..'))]) assert.ok(destination !== repo && !destination.startsWith(repo + path.sep));
const scratch = require('./fixtures/test-scratch.cjs');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const mentions = require('../app/room-mention.js');
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no profile/backend/GUI started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: plan.task, token, pid: process.pid, time: new Date().toISOString() }));
const env = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...extra });
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-context-')), entry = path.join(profile, 'entry'), work = path.join(profile, 'work');
fs.mkdirSync(entry); fs.mkdirSync(work);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-context-gui', version: require('../package.json').version, main: 'main.cjs' }));
fs.writeFileSync(path.join(entry, 'main.cjs'), [
  "const e=require('electron'),cp=require('node:child_process'),path=require('node:path');",
  "globalThis.contextGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};globalThis.contextCopies=[];globalThis.contextCalls=[];globalThis.contextIPC=[];",
  "const handle=e.ipcMain.handle.bind(e.ipcMain);e.ipcMain.handle=(name,listener)=>!name.startsWith('workspace:')?handle(name,listener):handle(name,(event,...args)=>{globalThis.contextIPC.push({method:name.slice(10),id:typeof args[0]==='string'?args[0]:null,action:name==='workspace:spaceAction'?args[1]:null});return listener(event,...args);});",
  "const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(x=>typeof x==='string'&&path.basename(x)==='daemon.cjs')){globalThis.contextGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};",
  "for(const key of ['readText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[key]=()=>{globalThis.contextGuards.clipboard++;throw Error('OS clipboard prohibited');};e.clipboard.writeText=text=>{globalThis.contextCopies.push(text);};",
  "e.shell.openExternal=e.shell.openPath=async()=>{globalThis.contextGuards.external++;throw Error('External action prohibited');};",
  "for(const key of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[key]=()=>{globalThis.contextGuards.dialogs++;throw Error('OS dialog prohibited');};",
  "const {WorkspaceClient}=require(" + JSON.stringify(path.join(root, 'app/workspace-client.cjs')) + ");const call=WorkspaceClient.prototype.call;WorkspaceClient.prototype.call=function(method,...args){globalThis.contextCalls.push({method,id:typeof args[0]==='string'?args[0]:null});return call.call(this,method,...args);};WorkspaceClient.prototype.maintainService=function(){globalThis.contextGuards.maintenance++;throw Error('Backend update prohibited');};",
  "require(" + JSON.stringify(path.join(root, 'app/main.cjs')) + ");",
].join('\n'));
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: env({ NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root, NAW_APP_VERSION: require('../package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, guiPid, pageReloads = 0, sequence = 0, failure, navigationStart, ipcNavigationStart;
const checks = [], errors = [], guardSamples = [], started = Date.now();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, message) { for (let i = 0; i < 200; i++) { if (await test()) return; await delay(50); } throw Error(message); }
function fixture(method = 'stats', target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', receive); resolve(result); } };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Synthetic fixture timeout')); }, 8000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
async function settleDisplays() {
  for (let i = 0; i < 8; i++) {
    const state = await fixture(); assert.deepEqual(state.waitingInputs, []);
    if (!state.pending.length) { await delay(30); if (!(await fixture()).pending.length) return; }
    for (const id of new Set(state.pending)) await fixture('release', id);
  }
  throw Error('Owned passive snapshots did not settle');
}
async function guards() {
  const values = await app.evaluate(() => globalThis.contextGuards);
  assert.deepEqual(values, { clipboard: 0, external: 0, dialogs: 0, maintenance: 0, replacement: 0 }); guardSamples.push(values);
  assert.ok(await app.evaluate(() => globalThis.contextCopies.length) <= plan.interceptedCopies);
}
async function capture(name) {
  fs.mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2));
  fs.writeFileSync(path.join(evidence, name + '.ui.json'), JSON.stringify(await page.evaluate(() => ({
    dialogOpen: document.querySelector('#context-dialog').open, text: document.querySelector('#context-text').value,
    error: document.querySelector('#context-error').textContent, sharedDraft: document.querySelector('#shared-input').value,
    privateDraft: document.querySelector('#message-input').value, scopeLocked: document.querySelector('#context-spaces').disabled,
    choices: [...document.querySelectorAll('[data-context-space]')].map(el => ({ id: el.dataset.contextSpace, checked: el.checked, disabled: el.matches(':disabled') })),
  })), null, 2));
}
async function check(text) { assert.ok(Date.now() - started < plan.maxRunMs, 'Finite stage-entry budget'); checks.push(text); await guards(); console.log('PASS:', text); await capture('stage-' + checks.length); }
const scope = id => page.locator('[data-context-space="' + id + '"]');
async function openBackground() { if (!await page.locator('#room-advanced').evaluate(el => el.open)) await page.locator('#room-advanced summary').click(); await page.locator('#attach-context').click(); await page.locator('#context-dialog[open]').waitFor(); }
async function closeBackground() { await page.locator('#close-context').click(); await until(async () => await page.locator('[data-context-space]').count() === 0, 'Dismissal cleared transient scope choices'); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned fixture ready');
  client = await connect(profile, 'context-seed'); const before = await client.call('initial');
  assert.equal(before.servicePid, child.pid); assert.equal(before.runtimeVersion, require('../package.json').version); assert.equal(before.sessions.length, 0);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(await client.call('create', { provider: i === 2 ? 'codex' : 'claude', cwd: work, name: i < 2 ? '同名成员' : 'Only B', view: 'chat' }));
  await client.call('draft', ids[2], 'PRIVATE_U_UNSENT');
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'context-gui-window', active: true, selected: 'room', mode: 'chat', preference: 'chat', roomSession: '', sharedDraft: '' }]), { mode: 0o600 });
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 });
  guiPid = app.process().pid; page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#room-nav').waitFor();
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focusable: win.isFocusable() }))), [{ visible: false, focusable: false }]);
  const b = await page.evaluate(() => workspace.spaceCreate('Scope B')), outside = await page.evaluate(() => workspace.spaceCreate('UNSELECTED_R'));
  for (const [room, id] of [['shared', ids[0]], ['shared', ids[1]], [b, ids[0]], [b, ids[2]], [outside, ids[2]]]) await page.evaluate(({ room, id }) => workspace.spaceAction(room, 'join', [id, true]), { room, id });
  for (const [room, text] of [['shared', 'ALLOWED_A_SHARED_NOTE'], [b, 'ALLOWED_B_SHARED_NOTE'], [outside, 'PRIVATE_R_NOTE']]) await page.evaluate(async ({ room, text }) => {
    const s = await workspace.initial(); await workspace.spaceAction(room, 'notes', [text, s.rooms.find(value => value.id === room).metadataRevision]);
  }, { room, text });
  for (const id of ids) await fixture('messageItem', id, { id: 'private-' + id, role: 'assistant', text: 'PRIVATE_NATIVE_HISTORY', status: 'complete' });
  await fixture('native-activity', ids[0], { turnId: 'context-turn', observedAt: Date.now() - 30000, label: 'PRIVATE_ACTIVITY_LABEL' });
  await fixture('set-state', ids[1], 'approval');
  await page.locator('[data-space-id="' + b + '"] .room-nav').click(); await chooseRecipient(page, ids[2]); await fillRoomMessage(page, 'PRIVATE_B_ROOM_DRAFT');
  await until(async () => (await snapshot()).viewState.roomViews?.[b]?.sharedDraft?.includes('PRIVATE_B_ROOM_DRAFT'), 'B private room draft persisted');
  await page.locator('#room-nav').click(); await chooseRecipient(page, ids[0]); await fillRoomMessage(page, 'Original A unsent body');
  await until(async () => { const view = (await snapshot()).viewState; return view.roomRecipient === ids[0] && view.sharedDraft.includes('Original A unsent body'); }, 'Original explicit recipient and body persisted');
  const original = await snapshot(), identities = original.sessions.map(s => [s.id, s.nativeId]), owners = original.sessions.map(s => [s.id, s.owner]);
  assert.equal(original.servicePid, child.pid); assert.equal(identities.length, 3); assert.ok(identities.every(([id, nativeId]) => nativeId === 'synthetic-' + id));
  const bDraft = structuredClone(original.viewState.roomViews[b]), originalDraft = await page.locator('#shared-input').inputValue();
  navigationStart = (await app.evaluate(() => globalThis.contextCalls)).length; ipcNavigationStart = (await app.evaluate(() => globalThis.contextIPC)).length;
  assert.deepEqual((await app.evaluate(() => globalThis.contextCalls)).slice(0, navigationStart).filter(call => call.method === 'claim'), []);
  assert.deepEqual((await app.evaluate(() => globalThis.contextIPC)).slice(0, ipcNavigationStart).filter(call => call.method === 'claim'), []);
  await openBackground(); assert.equal(await scope('shared').isChecked(), true); assert.equal(await scope(b).isChecked(), false);
  assert.ok((await page.locator('#context-text').inputValue()).includes(ids[0])); assert.ok(!(await page.locator('#context-text').inputValue()).includes(ids[2]));
  await scope(b).check(); let preview = await page.locator('#context-text').inputValue();
  assert.match(preview, /3 个唯一会话记录 · 4 条归属/); assert.ok(preview.includes('ALLOWED_A_SHARED_NOTE') && preview.includes('ALLOWED_B_SHARED_NOTE'));
  assert.match(preview, /最后观察/); assert.match(preview, /等待确认/);
  assert.ok(!preview.includes('PRIVATE_') && !preview.includes(outside) && !preview.includes('UNSELECTED_R'));
  await page.locator('#copy-context').click(); assert.deepEqual(await app.evaluate(() => globalThis.contextCopies), [preview]);
  await scope('shared').uncheck(); await scope(b).uncheck();
  assert.equal(await page.locator('#context-text').inputValue(), ''); assert.equal(await page.locator('#copy-context').isDisabled(), true); assert.equal(await page.locator('#insert-context').isDisabled(), true);
  await scope('shared').check(); await scope(b).check(); preview = await page.locator('#context-text').inputValue();
  await check('Explicit A/B scope yields three unique records and four references, omits private native/shared drafts and unselected R, and empty scope fails closed without copying or inserting stale text');
  await page.locator('#context-text').fill(preview + '\nHuman review'); await page.locator('#context-text').press('End'); await page.locator('#context-text').press('Enter'); await page.locator('#context-text').type('Manual line');
  const edited = await page.locator('#context-text').inputValue(); assert.equal(edited, preview + '\nHuman review\nManual line'); assert.equal(await scope(b).isDisabled(), true);
  await fixture('messageItem', ids[1], { id: 'other-stream', role: 'assistant', text: 'PRIVATE_OTHER_STREAM', status: 'complete' });
  await page.locator('#room-view [data-message-id="other-stream"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#context-text').inputValue(), edited);
  await closeBackground(); assert.equal(await page.locator('#shared-input').inputValue(), originalDraft);
  await openBackground(); assert.equal(await scope(b).isChecked(), false); assert.ok(!(await page.locator('#context-text').inputValue()).includes('Human review'));
  await check('Editing and Enter remain in the background textarea, scope freezes, another member stream cannot overwrite it, and cancellation clears transient edits while the original draft remains');
  await scope(b).check(); preview = await page.locator('#context-text').inputValue(); await page.locator('#context-text').fill(preview + '\nExplicitly reviewed');
  const insertText = await page.locator('#context-text').inputValue(); await page.locator('#insert-context').click();
  await until(async () => !(await page.locator('#context-dialog').evaluate(el => el.open)), 'Explicit insertion completed');
  await until(async () => await page.locator('[data-context-space]').count() === 0, 'Insertion dismissal cleared transient state');
  const inserted = await snapshot(), insertedDraft = inserted.viewState.sharedDraft, insertedBody = mentions.body(inserted.viewState.roomMention, insertedDraft);
  assert.ok(insertedDraft.startsWith(originalDraft) && insertedDraft.includes(insertText)); assert.equal(inserted.viewState.roomRecipient, ids[0]);
  assert.deepEqual(inserted.viewState.roomMention, original.viewState.roomMention); assert.deepEqual(inserted.viewState.roomViews[b], bDraft);
  assert.deepEqual(inserted.sessions.map(s => [s.id, s.owner]), owners); assert.equal(inserted.sessions.find(s => s.id === ids[2]).liveDraft, 'PRIVATE_U_UNSENT');
  await check('Only explicit insertion appends the reviewed preview to original A draft, preserving its exact S mention/recipient, B untouched draft, private U draft and every native owner');
  await fillRoomMessage(page, 'X'.repeat(15750)); const longDraft = await page.locator('#shared-input').inputValue();
  await until(async () => (await snapshot()).viewState.sharedDraft === longDraft, 'Long draft saved before refusal');
  await openBackground(); assert.ok(longDraft.length <= 16000 && longDraft.length + (await page.locator('#context-text').inputValue()).length + 2 > 16000);
  await page.locator('#insert-context').click(); assert.match(await page.locator('#context-error').textContent(), /16000/);
  assert.equal(await page.locator('#shared-input').inputValue(), longDraft); assert.ok(await page.locator('#context-dialog').evaluate(el => el.open));
  await check('Combined draft above16000 is refused visibly; both the original long draft and background preview remain unsent and editable');
  await closeBackground(); await fillRoomMessage(page, insertedBody);
  await until(async () => (await snapshot()).viewState.sharedDraft === insertedDraft, 'Explicit inserted draft restored after negative case');
  if (await page.locator('#clear-space-filter').isVisible()) await page.locator('#clear-space-filter').click();
  await page.locator('[data-session-id="' + ids[2] + '"]').click(); await settleDisplays();
  assert.equal((await snapshot()).viewState.mode, 'chat'); assert.equal(await page.locator('#message-input').inputValue(), 'PRIVATE_U_UNSENT');
  if (!await page.locator('#advanced').evaluate(el => el.open)) await page.locator('#advanced > summary').click();
  await page.locator('#advanced-content').getByRole('button', { name: '带上协作背景…', exact: true }).click();
  assert.equal(await page.locator('#insert-context').isVisible(), false); await scope(b).check();
  const soloText = await page.locator('#context-text').inputValue(); await page.locator('#copy-context').click();
  const copies = await app.evaluate(() => globalThis.contextCopies); assert.equal(copies.length, 2); assert.equal(copies[1], soloText);
  assert.ok(!soloText.includes('PRIVATE_')); assert.equal(await page.locator('#message-input').inputValue(), 'PRIVATE_U_UNSENT');
  await check('The existing solo entry remains copy-only through intercepted Main copy, with original private U draft and input owner unchanged and zero OS clipboard use');
  await closeBackground(); await page.locator('#room-nav').click(); pageReloads++; await page.reload(); await page.locator('#shared-input').waitFor();
  await until(async () => (await snapshot()).viewState.sharedDraft === insertedDraft, 'Explicitly inserted draft survives renderer reopen');
  const after = await snapshot(); assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId]), identities); assert.deepEqual(after.sessions.map(s => [s.id, s.owner]), owners);
  assert.deepEqual(after.viewState.roomViews[b], bDraft); assert.equal(after.viewState.roomRecipient, ids[0]);
  await openBackground(); assert.equal(await scope('shared').isChecked(), true); assert.equal(await scope(b).isChecked(), false);
  assert.ok(!(await page.locator('#context-text').inputValue()).includes('Explicitly reviewed')); await closeBackground(); await settleDisplays();
  const state = await fixture(); for (const key of ['inputs', 'sends', 'interruptions', 'pending', 'waitingInputs']) assert.deepEqual(state[key], []);
  const calls = await app.evaluate(() => globalThis.contextCalls), ipc = await app.evaluate(() => globalThis.contextIPC);
  const allowed = new Set(['initial', 'uiReady', 'viewState', 'readingState', 'terminalSnapshot', 'resize', 'observe', 'unobserve', 'copy']);
  assert.deepEqual(calls.slice(navigationStart).filter(call => !allowed.has(call.method)), []);
  assert.deepEqual(ipc.slice(ipcNavigationStart).filter(call => !allowed.has(call.method)), []);
  assert.equal(ipc.slice(ipcNavigationStart).filter(call => call.method === 'copy').length, 2);
  for (const call of calls.slice(navigationStart).filter(call => ['terminalSnapshot', 'resize', 'observe', 'unobserve'].includes(call.method))) assert.equal(call.id, ids[2]);
  fs.writeFileSync(path.join(evidence, 'call-accounting.json'), JSON.stringify({ navigationStart, setup: calls.slice(0, navigationStart), navigation: calls.slice(navigationStart), ipcNavigationStart, setupIPC: ipc.slice(0, ipcNavigationStart), navigationIPC: ipc.slice(ipcNavigationStart) }, null, 2));
  assert.deepEqual(errors, []);
  await check('Renderer reload retains exact native identities/owners and both draft scopes; a fresh preview resets its transient selection, with zero claim/send/input/approval and only two intercepted copies');
}
const cleanup = scratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { for (const record of (await client.call('initial')).sessions) await client.call('stop', record.id); await client.call('shutdown'); client.close(); }
  else if (child.exitCode === null) child.kill('SIGTERM');
  if (child.connected) child.disconnect(); await until(() => child.exitCode !== null, 'Owned fake service exits');
});
run().catch(async error => { failure = error.stack; process.exitCode = 1; console.error(failure); if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, failure, errors, profile, fullStarts: guiPid ? 1 : 0, pageReloads, ownedNodePid: child.pid, ownedGuiPids: guiPid ? [guiPid] : [], guardSamples,
    calls: app ? await app.evaluate(() => globalThis.contextCalls).catch(() => null) : null,
    ipc: app ? await app.evaluate(() => globalThis.contextIPC).catch(() => null) : null,
    currentGuards: app ? await app.evaluate(() => globalThis.contextGuards).catch(() => null) : null,
    interceptedCopies: app ? await app.evaluate(() => globalThis.contextCopies).catch(() => null) : null,
    fixture: child.connected ? await fixture().catch(() => null) : null }, null, 2));
  await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
  fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
  fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), profileGone: !fs.existsSync(profile) }));
});
