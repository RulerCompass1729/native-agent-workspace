// T69/T108: seven synthetic sessions, one original plus two new spaces.
// Run only after Main's precise GUI handoff; this recipe never tests the daily app.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), scratch = require('./fixtures/test-scratch.cjs');
const { connectService } = require('../app/service-connection.cjs');
const { RoomState } = require('../app/room-state.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID(), owner = randomUUID();
const evidence = process.env.NAW_T69_EVIDENCE_DIR, checks = [], errors = [], launches = [], launchProofs = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let profile, guiEntry, child, client, app, page, sequence = 0, lease = false, started, ids, originals, originalHistory, a, b, localFile, failure;
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceHashes = () => Object.fromEntries(Buffer.concat([execFileSync('git', ['ls-files', '-z'], { cwd: root }), execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }), Buffer.from('app/dsh/client.js\0')]).toString().split('\0').filter(f => f && /^(app|scripts)\//.test(f)).map(f => [f, hash(fs.readFileSync(path.join(root, f)))]));
let frozen;
async function until(read, label) { for (let i = 0; i < 140; i++) { if (await read()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value, channel) {
  const id = ++sequence; return new Promise((resolve, reject) => {
    const receive = reply => { if (reply.requestId !== id || (reply.channel || '') !== (channel || '')) return; clearTimeout(timer); child.off('message', receive); reply.error ? reject(Error(reply.error)) : resolve(reply); };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture request timed out')); }, 5000);
    child.on('message', receive); child.send({ id, method, target, value, ...(channel ? { channel } : {}) });
  });
}
const snapshot = () => client.call('initial');
const members = (s, id) => s.sessions.filter(r => r.roomIds ? r.roomIds.includes(id) : id === 'shared' && r.roomId === id);
const roomRow = id => page.locator(`[data-space-id="${id}"]`);
async function open(id, click = true) {
  if (click) await roomRow(id).locator('.room-nav').click();
  else await page.evaluate(id => workspace.viewState({ selected: 'room', mode: 'chat', spaceId: id }), id);
  await until(async () => (await page.evaluate(() => workspace.initial())).viewState.spaceId === id, 'Window space selection persisted');
}
async function refresh() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function choose(id, body) {
  await page.locator('#shared-input').fill(body); await page.locator('#shared-input').evaluate(el => el.setSelectionRange(0, 0));
  await page.locator('#shared-input').pressSequentially('@'); await page.locator(`[data-mention-id="${id}"]`).click();
  await until(async () => (await page.evaluate(() => workspace.initial())).viewState.roomViews?.[(await page.evaluate(() => workspace.initial())).viewState.spaceId]?.roomMention?.id === id, 'Scoped mention persisted');
}
async function flow(name, run) {
  assert.ok(checks.length < 15); assert.ok(Date.now() - started < 600000, 'Finite source GUI budget');
  await run(); const state = await snapshot();
  assert.equal(state.sessions.length, 7); assert.deepEqual(state.sessions.map(s => [s.id, s.nativeId]), originals);
  assert.deepEqual(state.sessions.map(s => s.liveDraft), ids.map((_, i) => `Private draft ${i}`));
  assert.equal(hash(JSON.stringify(state.room.messages)), originalHistory);
  const stats = await fixture('stats'); assert.equal(stats.stats.inputs, 0);
  checks.push({ name, stats: stats.stats }); console.log('PASS:', name);
  await page.screenshot({ path: path.join(evidence, `${String(checks.length).padStart(2, '0')}.png`) });
}
async function launch() {
  assert.ok(launches.length < 2, 'Two owned GUI launches maximum');
  assert.ok(child.connected && child.exitCode === null && child.signalCode === null, 'Owned fixture must be connected before each GUI launch');
  process.kill(child.pid, 0); // Read-only liveness check of this exact owned child.
  app = await _electron.launch({ executablePath: require('electron'), args: [guiEntry], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  launches.push(app.process().pid); page = await app.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message)); await page.locator('#new-space').waitFor();
  const connected = await page.evaluate(() => workspace.initial());
  assert.equal(connected.servicePid, child.pid, 'The GUI must use the exact owned synthetic daemon');
  launchProofs.push({ guiPid: app.process().pid, servicePid: connected.servicePid, expectedServicePid: child.pid, runtimeVersion: connected.runtimeVersion });
  await app.evaluate(({ clipboard, dialog, shell }, file) => {
    globalThis.t69 = { clipboard: 0, filePickers: 0, external: 0 };
    for (const name of ['writeText', 'readText', 'readImage', 'writeImage', 'read', 'write', 'readBuffer', 'writeBuffer', 'clear']) clipboard[name] = () => { globalThis.t69.clipboard++; throw Error('OS clipboard prohibited'); };
    shell.openPath = shell.openExternal = async () => { globalThis.t69.external++; throw Error('External viewer prohibited'); };
    dialog.showMessageBox = async (_win, options) => { if (!options.message.startsWith('清除「')) throw Error('Unexpected system confirmation'); return { response: 1 }; };
    dialog.showOpenDialog = async (_win, options) => { if (!options.title.startsWith('添加到「')) throw Error('Unexpected file picker'); globalThis.t69.filePickers++; return { canceled: false, filePaths: [file] }; };
  }, localFile);
}
async function roomAction(name) {
  await page.locator('#room-header-more').click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
async function newSpace(name, viaMenu = false) {
  const file = path.join(profile, 'collaboration-spaces.json'), before = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).rooms.map(r => r.id) : [];
  if (viaMenu) { await page.locator('#workspace-toggle').focus(); await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: '新建协作空间…', exact: true }).click(); }
  else await page.locator('#new-space').click();
  await page.locator('#space-create-name').fill(name); await page.locator('#confirm-space-create').click();
  await until(() => JSON.parse(fs.readFileSync(path.join(profile, 'collaboration-spaces.json'), 'utf8')).rooms.length > before.length, 'New space stored');
  return JSON.parse(fs.readFileSync(path.join(profile, 'collaboration-spaces.json'), 'utf8')).rooms.find(r => !before.includes(r.id)).id;
}
async function seed() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-t69-spaces-'));
  // Keep the ordinary production bootstrap, but fail closed if it ever tries
  // to replace the fixture with an uninstrumented backend. This private entry
  // is test-only; the app's source, settings and runtime copy stay unchanged.
  guiEntry = path.join(profile, 'gui-entry'); fs.mkdirSync(guiEntry, { mode: 0o700 });
  fs.writeFileSync(path.join(guiEntry, 'package.json'), JSON.stringify({ name: 'naw-t69-owned-source-gui', version: require('../package.json').version, main: 'main.cjs' }), { mode: 0o600 });
  fs.writeFileSync(path.join(guiEntry, 'main.cjs'), `const cp = require('node:child_process'), path = require('node:path');
const spawn = cp.spawn;
cp.spawn = function(executable, args, options) {
  if (Array.isArray(args) && args.some(arg => typeof arg === 'string' && path.basename(arg) === 'daemon.cjs')) throw Error('Owned fixture is unavailable; replacement backend prohibited');
  return spawn.call(this, executable, args, options);
};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});
`, { mode: 0o600 });
  localFile = path.join(profile, 'synthetic-result.md'); fs.writeFileSync(localFile, 'LOCAL SYNTHETIC RESULT', { mode: 0o600 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(root, 'scripts/fixtures/multispace.cjs')], env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(profile, 'workspace'), NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic daemon ready'); client = await connectService(profile, owner);
  ids = []; for (let i = 0; i < 7; i++) { const id = await client.call('create', { provider: i % 2 ? 'claude' : 'codex', cwd: profile, name: `Synthetic ${i}`, view: 'chat' }); ids.push(id); await client.call('draft', id, `Private draft ${i}`); }
  for (const id of ids.slice(0, 4)) await client.call('join', id, true);
  await fixture('bindSends', ids[0]); let record = (await snapshot()).sessions[0]; await client.call('forward', ids[0], 'Original shared request', record.nativeId);
  const sent = await fixture('stats', ids[0]); await fixture('nativeBlock', ids[0], { id: 'display:original', turnId: sent.lastSend.turnId, kind: 'response', text: 'Original shared response', status: 'complete' });
  await fixture('complete', ids[0], { text: 'Original shared response', messageId: 'display:original' });
  const room = new RoomState(profile); room.notes('Original shared note', 0);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner, selected: 'room', mode: 'chat', active: true, sharedDraft: 'Original shared unsent' }]), { mode: 0o600 });
  const initial = await snapshot(); assert.equal(initial.runtimeVersion, require('../package.json').version, 'The fixture version must match the source GUI before bootstrap can run'); originals = initial.sessions.map(s => [s.id, s.nativeId]); originalHistory = hash(JSON.stringify(initial.room.messages));
}
async function run() {
  assert.equal(process.env.NAW_T69_GUI_AUTHORIZED, '1', 'A fresh exact Main source GUI handoff is required');
  assert.ok(evidence && path.isAbsolute(evidence), 'Explicit private screenshot/evidence path required');
  try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no own profile or GUI started'); process.exitCode = 75; return; }
  lease = true; started = Date.now(); fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T69/T108 bounded source GUI', token, pid: process.pid, time: new Date().toISOString() }));
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); frozen = sourceHashes(); await seed(); await launch();
  await flow('01 original space, identities, native drafts and saved shared draft', async () => { assert.equal(await page.locator('#shared-input').inputValue(), 'Original shared unsent'); assert.ok((await snapshot()).room.messages.some(m => m.text === 'Original shared response')); });
  await flow('02 visible plus creates second space without native creation', async () => { a = await newSpace('Research A'); await roomRow(a).waitFor(); });
  await flow('03 keyboard menu creates third space and right click exposes same creation action', async () => { b = await newSpace('Delivery B', true); await page.locator('#workspace-toggle').click({ button: 'right' }); await page.getByRole('menuitem', { name: '新建协作空间…', exact: true }).waitFor(); await page.keyboard.press('Escape'); });
  await flow('04 invite accepts sessions already in another space', async () => {
    for (const destination of [a, b]) { await open(destination); for (const id of ids.slice(0, 3)) { await page.locator('#manage-members').click(); await page.locator(`[data-invite-session="${id}"]`).click(); await page.locator('#invite-dialog').waitFor({ state: 'hidden' }); await until(async () => members(await snapshot(), destination).some(s => s.id === id), 'Invite membership acknowledged'); } }
    const s = await snapshot(); assert.equal(members(s, a).length, 3); assert.equal(members(s, b).length, 3); assert.equal(members(s, 'shared').length, 4);
  });
  await flow('05 rename captures target space', async () => { await roomRow(b).locator('.session-more').click(); await page.getByRole('menuitem', { name: '重命名…', exact: true }).click(); await page.locator('#rename-name').fill('Delivery renamed'); await page.locator('#confirm-rename').click(); await until(() => fs.readFileSync(path.join(profile, 'collaboration-spaces.json'), 'utf8').includes('Delivery renamed'), 'Rename persisted'); });
  await flow('06 independent unsent shared drafts survive switching', async () => { await open(a); await page.locator('#shared-input').fill('A independent unsent'); await open(b); await page.locator('#shared-input').fill('B independent unsent'); await open(a); assert.equal(await page.locator('#shared-input').inputValue(), 'A independent unsent'); });
  await flow('07 notes are scoped and first notes remain intact', async () => { await roomAction('共享笔记'); await page.locator('#room-notes-text').fill('A local note'); await page.locator('#save-notes').click(); await open(b); await roomAction('共享笔记'); assert.equal(await page.locator('#room-notes-text').inputValue(), ''); await page.locator('#cancel-notes').click(); assert.equal(new RoomState(profile).value.notes, 'Original shared note'); });
  await flow('08 file references and original preview stay local to one space', async () => { await open(a); await roomAction('空间文件…'); await page.locator('#add-space-files').click(); await page.getByRole('button', { name: 'synthetic-result.md', exact: true }).click(); assert.equal(await page.locator('#file-content').innerText(), 'LOCAL SYNTHETIC RESULT'); await page.locator('#close-file').click(); await open(b); await roomAction('空间文件…'); assert.equal(await page.locator('.space-file-row').count(), 0); await page.locator('#close-space-files').click(); });
  await flow('09 flat badges include overflow, full accessible names, and native status', async () => { await page.locator('#clear-space-filter').click(); await page.locator('#sessions-flat').click(); const row = page.locator(`[data-session-row="${ids[0]}"]`); assert.equal(await row.locator('.space-badge-more').innerText(), '+1'); const badgeBounds = await row.locator('.space-badge-more').evaluate(el => { const badge = el.getBoundingClientRect(), wrap = el.parentElement.getBoundingClientRect(), link = el.closest('.session-link').getBoundingClientRect(); return { visible: badge.width > 0 && badge.height > 0, inside: [wrap, link].every(box => badge.left >= box.left && badge.right <= box.right + 1 && badge.top >= box.top && badge.bottom <= box.bottom + 1), exposed: document.elementFromPoint(badge.left + badge.width / 2, badge.top + badge.height / 2) === el }; }); assert.deepEqual(badgeBounds, { visible: true, inside: true, exposed: true }, 'The +N badge must actually fit inside its visible row'); const label = await row.locator('.session-link').getAttribute('aria-label'); assert.ok(label.includes('Research A') && label.includes('Delivery renamed')); assert.ok(!(await row.locator('small').first().innerText()).includes('协作中')); });
  await flow('10 hover and keyboard focus highlight member relationships', async () => { await roomRow(a).locator('.room-nav').hover(); assert.equal(await page.locator('.session-row.space-highlight').count(), 3); assert.equal(await page.locator('.session-row.space-dim').count(), 4); await roomRow(a).locator('.room-nav').focus(); await page.locator('#sessions-flat').focus(); assert.equal(await page.locator('.session-row.space-dim').count(), 0); });
  await flow('11 click filters members and a second click restores all', async () => { await open(a); assert.equal(await page.locator('.session-row').count(), 3); await open(a); assert.equal(await page.locator('.session-row').count(), 7); });
  await flow('12 both orders, grouped same-session references and independent second-window draft', async () => {
    await page.locator('#sessions-flat').click(); await page.locator(`[data-session-row="${ids[0]}"] .session-more`).click(); await page.getByRole('menuitem', { name: '下移', exact: true }).click();
    await until(async () => (await page.evaluate(() => workspace.initial())).sidebar.order.indexOf(ids[0]) > (await page.evaluate(() => workspace.initial())).sidebar.order.indexOf(ids[1]), 'Flat order persisted');
    await page.locator('#sessions-grouped').click(); assert.equal(await page.locator(`[data-session-row="${ids[0]}"]`).count(), 3); assert.equal(await page.locator('[data-session-group="independent"] .session-row').count(), 3);
    const bOrder = (await page.evaluate(() => workspace.initial())).rooms.find(r => r.id === b).memberOrder;
    await page.locator(`[data-session-group="${a}"] [data-session-row="${ids[1]}"] .session-more`).click(); await page.getByRole('menuitem', { name: '上移', exact: true }).click();
    await until(async () => (await page.evaluate(() => workspace.initial())).rooms.find(r => r.id === a).memberOrder[0] === ids[1], 'Group A order persisted');
    assert.deepEqual((await page.evaluate(() => workspace.initial())).rooms.find(r => r.id === b).memberOrder, bOrder);
    const nextWindow = app.waitForEvent('window'); await page.evaluate(() => workspace.newWindow()); const second = await nextWindow; await second.locator('#new-space').waitFor();
    await second.locator(`[data-space-id="${b}"] .room-nav`).click(); await second.locator('#shared-input').fill('Second window B draft');
    assert.equal(await page.locator('#shared-input').inputValue(), 'A independent unsent'); await second.close();
  });
  await flow('13 drag adds membership, preserves old space and undo removes only this addition', async () => { await page.locator(`[data-session-group="shared"] [data-session-row="${ids[3]}"] .session-link`).dragTo(roomRow(a).locator('.room-nav')); await until(async () => members(await snapshot(), a).some(s => s.id === ids[3]), 'Drag add acknowledged'); assert.ok(members(await snapshot(), 'shared').some(s => s.id === ids[3])); await page.getByRole('button', { name: '撤销加入「Research A」', exact: true }).click(); await until(async () => !members(await snapshot(), a).some(s => s.id === ids[3]), 'Undo exact addition');
    await page.locator(`[data-session-group="shared"] [data-session-row="${ids[3]}"] .session-link`).dragTo(roomRow(a).locator('.room-nav')); await page.getByRole('button', { name: '撤销加入「Research A」', exact: true }).waitFor();
    await page.evaluate(async ({ id, space }) => { await workspace.spaceAction(space, 'join', [id, false]); await workspace.spaceAction(space, 'join', [id, true]); }, { id: ids[3], space: a });
    await page.getByRole('button', { name: '撤销加入「Research A」', exact: true }).click(); await page.locator('#toast-text').filter({ hasText: '这次撤销没有执行' }).waitFor();
    assert.ok(members(await snapshot(), a).some(s => s.id === ids[3]));
  });
  await flow('14 late A acceptance cannot clear an equal B draft or retarget original reply', async () => {
    await open(a); await fixture('bindSends', ids[1]); await choose(ids[1], 'Same unsent body'); const raw = await page.locator('#shared-input').inputValue(); await fixture('holdSend', ids[1], undefined, 't69'); await page.locator('#forward-button').click(); await until(async () => (await fixture('pending', undefined, undefined, 't69')).pending.includes(ids[1]), 'Held A ACK');
    await open(b); await choose(ids[1], 'Same unsent body'); assert.equal(await page.locator('#shared-input').inputValue(), raw); await fixture('releaseSend', ids[1], undefined, 't69'); await until(async () => (await page.evaluate(() => workspace.initial())).viewState.roomViews?.[a]?.sharedDraft === '', 'A acceptance has cleared the original A draft in the actual view'); assert.equal(await page.locator('#shared-input').inputValue(), raw);
    const sent = await fixture('stats', ids[1]); await fixture('nativeBlock', ids[1], { id: 'display:a-only', turnId: sent.lastSend.turnId, promptId: sent.lastSend.promptId, kind: 'response', text: 'Original A answer only', status: 'complete' }); await fixture('complete', ids[1], { text: 'Original A answer only', messageId: 'display:a-only' });
    const s = await snapshot(); assert.ok(s.rooms.find(r => r.id === a).messages.some(m => m.text === 'Original A answer only')); assert.ok(!JSON.stringify(s.rooms.find(r => r.id === b)).includes('Original A answer only'));
    await page.evaluate(async ({ a, b, ids }) => {
      let s = await workspace.initial(); const runIds = [ids[0], ids[2]], names = Object.fromEntries(runIds.map(id => [id, s.sessions.find(x => x.id === id).name])), contexts = Object.fromEntries(runIds.map(id => [id, s.sessions.find(x => x.id === id).nativeId]));
      await workspace.spaceAction(b, 'join', [ids[5], true]); await workspace.spaceAction(a, 'run', [runIds, 'Synthetic A finite exchange', 2, 'replies', names, contexts]);
    }, { a, b, ids });
    await until(async () => (await snapshot()).rooms.find(r => r.id === a).run?.status === 'running', 'Synthetic A active');
    await choose(ids[5], 'Independent B request'); await page.locator('#forward-button').click();
    await until(async () => (await snapshot()).rooms.find(r => r.id === b).messages.some(m => m.text === 'Independent B request'), 'B send recorded');
    assert.equal((await snapshot()).rooms.find(r => r.id === a).run.status, 'running');
    const beforePauseB = hash(JSON.stringify((await snapshot()).rooms.find(r => r.id === b)));
    await page.evaluate(a => workspace.spaceAction(a, 'pause', []), a);
    await until(async () => (await snapshot()).rooms.find(r => r.id === a).run?.status === 'paused', 'Explicit A pause confirmed');
    assert.equal(hash(JSON.stringify((await snapshot()).rooms.find(r => r.id === b))), beforePauseB, 'Pausing A preserves B');

  });
  await flow('15 source search, reopen preferences and all original identities/drafts', async () => {
    await page.locator('#search-button').click(); await page.locator('#search-input').fill('Original A answer only'); await page.locator('.search-result').filter({ hasText: 'Research A' }).click(); await page.locator('#return-reading').waitFor(); await page.locator('#return-reading').click();
    await open(b);
    await fixture('storageFailure', undefined, undefined, 't69'); await until(async () => (await page.locator('#alert').innerText()).includes('Synthetic space save failure'), 'Storage warning visible');
    await page.locator('#privacy-button').click(); await page.locator('#privacy-dialog details').last().locator('summary').click();
    await page.locator('#clear-shared-history').click(); await until(async () => await page.locator('#trust-refresh-status').innerText() === '部分后台未确认清除；其他空间未清除，未自动重试。', 'Clear refusal is visible inside the same privacy dialog');
    assert.ok((await snapshot()).rooms.find(r => r.id === b).messages.some(m => m.text === 'Independent B request'));
    await fixture('storageRecovered', undefined, undefined, 't69'); await page.locator('#clear-shared-history').click();
    await until(async () => (await snapshot()).rooms.find(r => r.id === b).messages.length === 0, 'Only B cleared'); await page.locator('#close-privacy').click();
    assert.ok((await snapshot()).rooms.find(r => r.id === a).messages.some(m => m.text === 'Original A answer only'));
    await roomRow(b).locator('.session-more').click(); await page.getByRole('menuitem', { name: '归档工作区', exact: true }).click();
    await page.locator('#archive-button').click(); await page.locator(`[data-archived-room="${b}"]`).getByRole('button', { name: '恢复工作区', exact: true }).click(); await roomRow(b).waitFor();
    await page.locator('#sessions-flat').click(); if (await page.locator('#clear-space-filter').isVisible()) await page.locator('#clear-space-filter').click();
    await page.locator(`[data-session-row="${ids[6]}"] .session-more`).click(); await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
    await page.locator(`[data-archived-session="${ids[6]}"]`).getByRole('button', { name: '恢复会话', exact: true }).click();
    await open(b); await page.locator('#sessions-grouped').click(); await app.close(); app = null; await launch();
    await until(async () => (await page.evaluate(() => workspace.initial())).viewState.spaceId === b, 'Selected space restored'); assert.equal(await page.locator('#sessions-grouped').getAttribute('aria-pressed'), 'true');
    assert.equal((await page.evaluate(() => workspace.initial())).viewState.roomViews.shared.sharedDraft, 'Original shared unsent');
  });
  assert.deepEqual(sourceHashes(), frozen, 'All tested source remains frozen');
  assert.deepEqual(errors, []); assert.equal((await app.evaluate(() => globalThis.t69)).clipboard, 0); assert.equal((await app.evaluate(() => globalThis.t69)).external, 0);
}
const cleanup = scratch.cleanup(async () => { if (client && child?.connected) { await fixture('stop'); await client.call('shutdown').catch(() => {}); } client?.close(); });
(async () => {
  try { await run(); } catch (error) { failure = error; process.exitCode = 1; if (page && !page.isClosed() && evidence) { await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack + '\n' + await page.locator('body').innerText().catch(() => '')); } }
  finally {
    if (lease) {
      try {
        const raw = { checks, errors, failure: failure?.stack || null, launches, launchProofs, guiEntrySha256: guiEntry && fs.existsSync(path.join(guiEntry, 'main.cjs')) ? hash(fs.readFileSync(path.join(guiEntry, 'main.cjs'))) : null, synthetic: child?.connected ? await fixture('stats').catch(() => null) : null, sourceBefore: frozen, sourceAfter: frozen ? sourceHashes() : null };
        fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(raw, null, 2));
      } catch (recordError) { failure ||= recordError; process.exitCode = 1; console.error('Evidence save failed:', recordError.message); }
      // Evidence failure must never bypass strict owned-process cleanup.
      await cleanup();
      assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
      fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfileGone: !fs.existsSync(profile), launches, cleanup: 'existing strict scratch owner cleanup completed' }, null, 2));
    }
  }
  if (failure) console.error(failure.stack);
})();
