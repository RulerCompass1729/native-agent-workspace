// T69 merge: existing owned source launcher, eight finite zero-model GUI groups.
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
const evidence = process.env.NAW_T69_MERGE_EVIDENCE_DIR, checks = [], errors = [], launches = [], launchProofs = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let profile, guiEntry, child, client, app, page, sequence = 0, lease = false, started, ids, originals, originalHistory, a, b, localFile, failure, c, d, secondary;
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceHashes = () => Object.fromEntries(Buffer.concat([execFileSync('git', ['ls-files', '-z'], { cwd: root }), execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }), Buffer.from('app/dsh/client.js\0')]).toString().split('\0').filter(f => f && /^(app|scripts)\//.test(f)).map(f => [f, hash(fs.readFileSync(path.join(root, f)))]));
if (process.argv.includes('--plan')) { console.log(JSON.stringify({ task: 'T69 merge source GUI', groups: 8, maxElectronStarts: 2, sameProfileReopen: true, intentionalSecondWindow: true, syntheticClearConfirmation: 1, realOSConfirmations: 0, syntheticLogicalSessions: 3, syntheticSeedSends: 2, maxMs: 900000, osClipboard: 0, productModels: 0, requiresNewMainGrant: true }, null, 2)); process.exit(0); }
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

function isolatedEnv(additions) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions };
}
const metadata = () => new RoomState(profile);
const target = name => metadata().spaces.rooms.find(room => room.name === name);
async function capture(name) {
  await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify({ backend: await snapshot(), spaces: metadata().spaces }, null, 2));
}
async function flow(name, run) {
  assert.ok(checks.length < 8); assert.ok(Date.now() - started < 900000, 'Finite fifteen-minute source GUI budget');
  await run(); const state = await snapshot();
  assert.equal(state.sessions.length, 3); assert.deepEqual(state.sessions.map(s => [s.id, s.nativeId]), originals);
  assert.deepEqual(state.sessions.map(s => s.liveDraft), ids.map((_, i) => `Private draft ${i}`));
  assert.equal(hash(JSON.stringify(state.room.messages)), originalHistory);
  const stats = await fixture('stats'); assert.deepEqual(stats.stats, { inputs: 0, opens: 0, resizes: 0, sends: 2 });
  const metrics = await app.evaluate(() => globalThis.t69Merge);
  assert.equal(metrics.osClipboard, 0); assert.equal(metrics.external, 0);
  checks.push({ name, stats: stats.stats, copyRequests: metrics.copyPayloads.length, faults: (await fixture('stats', null, null, 't69merge')).faults });
  console.log('PASS:', name); await capture(String(checks.length).padStart(2, '0'));
}
async function launch() {
  assert.ok(launches.length < 2, 'Two owned Electron starts maximum');
  assert.ok(child.connected && child.exitCode === null && child.signalCode === null, 'Exact owned fixture must be live');
  process.kill(child.pid, 0);
  app = await _electron.launch({ executablePath: require('electron'), args: [guiEntry], env: isolatedEnv({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 });
  launches.push(app.process().pid); page = await app.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-space').waitFor(); const current = await page.evaluate(() => workspace.initial());
  assert.equal(current.servicePid, child.pid, 'No replacement or unowned service');
  launchProofs.push({ guiPid: app.process().pid, servicePid: current.servicePid, expectedServicePid: child.pid, runtimeVersion: current.runtimeVersion });
}
async function roomAction(name) { await page.locator('#room-header-more').click(); await page.getByRole('menuitem', { name, exact: true }).click(); }
async function form(name, disposition = 'keep') {
  await roomAction('合并协作空间…');
  for (const input of await page.locator('#space-merge-sources input').all()) [a, b].includes(await input.getAttribute('value')) ? await input.check() : await input.uncheck();
  await page.locator('#space-merge-name').fill(name); await page.locator('#space-merge-disposition').selectOption(disposition);
  await page.locator('#preview-space-merge').click(); await page.locator('#confirm-space-merge').waitFor();
}
async function submit(name) {
  await page.locator('#confirm-space-merge').click();
  await until(() => target(name)?.merge.stage === 'ready', 'Confirmed merge metadata');
  const id = target(name).id;
  await until(async () => (await page.evaluate(() => workspace.initial())).viewState.spaceId === id, 'Completed C selected'); return id;
}
async function seed() {
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-t69-merge-'));
  guiEntry = path.join(profile, 'gui-entry'); fs.mkdirSync(guiEntry, { mode: 0o700 });
  fs.writeFileSync(path.join(guiEntry, 'package.json'), JSON.stringify({ name: 'naw-owned-merge-source-gui', version: require('../package.json').version, main: 'main.cjs' }), { mode: 0o600 });
  fs.writeFileSync(path.join(guiEntry, 'main.cjs'), `const cp=require('node:child_process'),path=require('node:path'),electron=require('electron');
const spawn=cp.spawn;cp.spawn=function(executable,args,options){if(Array.isArray(args)&&args.some(arg=>typeof arg==='string'&&path.basename(arg)==='daemon.cjs'))throw Error('Replacement backend prohibited');return spawn.call(this,executable,args,options);};
globalThis.t69Merge={osClipboard:0,external:0,copyPayloads:[]};
electron.clipboard.writeText=text=>{globalThis.t69Merge.copyPayloads.push(text);};
for(const name of ['readText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])electron.clipboard[name]=()=>{globalThis.t69Merge.osClipboard++;throw Error('OS clipboard prohibited');};
electron.shell.openPath=electron.shell.openExternal=async()=>{globalThis.t69Merge.external++;throw Error('External viewer prohibited');};
electron.dialog.showMessageBox=async(_win,options)=>{if(options.message==='清除「Recovered E」的共享记录？')return {response:1};throw Error('Unexpected OS confirmation');};
electron.dialog.showOpenDialog=async()=>{throw Error('Unexpected OS file chooser');};
require(${JSON.stringify(path.join(root, 'app/main.cjs'))});
`, { mode: 0o600 });
  const localB = path.join(profile, 'b', 'result.md'); localFile = path.join(profile, 'a', 'result.md');
  for (const [file, text] of [[localFile, 'A LOCAL ORIGINAL'], [localB, 'B LOCAL ORIGINAL']]) { fs.mkdirSync(path.dirname(file), { mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 }); }
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(root, 'scripts/fixtures/space-merge.cjs')], env: isolatedEnv({ NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: path.join(profile, 'workspace'), NAW_APP_VERSION: require('../package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic daemon ready'); client = await connectService(profile, owner);
  ids = []; for (let i = 0; i < 3; i++) { const id = await client.call('create', { provider: i % 2 ? 'claude' : 'codex', cwd: profile, name: i ? 'Same name' : 'Jun', view: 'chat' }); ids.push(id); await client.call('draft', id, `Private draft ${i}`); }
  const room = new RoomState(profile); a = room.create('Source A'); b = room.create('Source B');
  for (const [space, roster] of [[a, [ids[0], ids[1]]], [b, [ids[0], ids[2]]]]) for (const id of roster) await client.call('spaceAction', space, 'join', [id, true], {});
  await fixture('bindSends', ids[0]);
  for (const [space, name, file] of [[a, 'A', localFile], [b, 'B', localB]]) {
    const record = (await snapshot()).sessions[0];
    await client.call('spaceAction', space, 'forward', [ids[0], `${name} original shared request`, record.nativeId], { [ids[0]]: require('../app/collaboration-spaces.cjs').membershipRevision(record, space) });
    const sent = await fixture('stats', ids[0]);
    await fixture('nativeBlock', ids[0], { id: `tool:${name}`, turnId: sent.lastSend.turnId, kind: 'tool', text: `${name} exact original tool`, status: 'complete' });
    await fixture('complete', ids[0], { text: `${name} complete original [material](${file})` });
    room.notes(`${name} original note`, room.metadata(space).revision, space); room.addFiles([file], space);
  }
  room.notes('Original shared note', 0);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner, selected: 'room', mode: 'chat', active: true, spaceId: a, sharedDraft: 'Source A unsent', roomViews: { shared: { sharedDraft: 'Original shared unsent' }, [a]: { sharedDraft: 'Source A unsent' }, [b]: { sharedDraft: 'Source B unsent' } } }]), { mode: 0o600 });
  const initial = await snapshot(); originals = initial.sessions.map(s => [s.id, s.nativeId]); originalHistory = hash(JSON.stringify(initial.room.messages));
  assert.equal(initial.runtimeVersion, require('../package.json').version);
}
async function run() {
  assert.equal(process.env.NAW_T69_MERGE_GUI_AUTHORIZED, '1', 'A NEW exact Main merge GUI handoff is required; old I95 is exhausted');
  assert.ok(evidence && path.isAbsolute(evidence));
  try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no own profile or GUI started'); process.exitCode = 75; return; }
  lease = true; started = Date.now(); fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T69 merge source GUI eight groups', token, pid: process.pid, time: new Date().toISOString() }));
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); process.env.NAW_EVIDENCE_DIR = path.join(evidence, 'scratch'); frozen = sourceHashes();
  await seed(); await launch();
  await flow('01 ordinary merge menu, cancel and native-alias refusal', async () => {
    const before = metadata().spaces.rooms.length;
    await page.locator('#workspace-toggle').focus(); await page.keyboard.press('Shift+F10'); await page.getByRole('menuitem', { name: '合并协作空间…', exact: true }).click();
    await page.locator('#close-space-merge').click(); assert.equal(metadata().spaces.rooms.length, before);
    await fixture('alias', ids[2], originals[0][1], 't69merge');
    await form('Alias blocked'); assert.equal(await page.locator('#confirm-space-merge').isDisabled(), true); await capture('01-alias-blocked');
    await page.locator('#close-space-merge').click(); await fixture('alias', ids[2], originals[2][1], 't69merge');
    await until(async () => (await page.evaluate(() => workspace.initial())).sessions.find(s => s.id === ids[2]).nativeId === originals[2][1], 'Synthetic alias restored');
    assert.equal(metadata().spaces.rooms.length, before);
  });
  await flow('02 keep sources and confirm an independent C with three original members and separate same-name references', async () => {
    await open(a); await form('Merged C'); c = await submit('Merged C');
    assert.equal(metadata().metadata(a).archived, false); assert.equal(metadata().metadata(b).archived, false);
    assert.equal(members(await snapshot(), c).length, 3); assert.equal(metadata().metadata(c).files.length, 2);
    assert.notEqual(metadata().metadata(c).files[0].path, metadata().metadata(c).files[1].path);
  });
  await flow('03 original reading, disclosure, virtual copy, selection and source navigation survive another stream', async () => {
    await page.locator('#room-record').click();
    const importedHuman = (await snapshot()).rooms.find(room => room.id === c).messages.find(m => m.role === 'human');
    assert.match(await page.locator(`[data-message-id="${importedHuman.id}"] .message-delivery > summary`).innerText(), /来源接收记录/);
    const message = (await snapshot()).rooms.find(room => room.id === c).messages.find(m => m.text === 'A exact original tool');
    const row = page.locator(`[data-message-id="${message.id}"]`); await row.scrollIntoViewIfNeeded();
    const details = row.locator('details').first(); if (!await details.evaluate(el => el.open)) await details.locator(':scope > summary').click({ position: { x: 8, y: 8 } });
    const copy = row.locator('button[aria-label^="复制："]'); assert.equal(await copy.count(), 1);
    const label = await copy.getAttribute('aria-label'), bodyId = await copy.getAttribute('aria-controls');
    await row.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await app.evaluate(() => globalThis.t69Merge.copyPayloads.at(-1)), message.text);
    const selected = await page.evaluate(id => { const body = document.getElementById(id), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); let text; while ((text = walker.nextNode()) && !text.textContent.includes('A exact original tool')) {} if (!text) throw Error('Original tool text missing'); const range = document.createRange(); range.selectNodeContents(text); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); window.mergeEvents = 0; workspace.onState(() => window.mergeEvents++); return selection.toString(); }, bodyId);
    const last = await fixture('stats', ids[0]); await fixture('nativeBlock', ids[0], { id: 'tool:late-private', turnId: last.lastSend.turnId, kind: 'tool', text: 'LATE PRIVATE ORIGINAL', status: 'complete' });
    await until(async () => await page.evaluate(() => window.mergeEvents > 0), 'Actual state event observed'); await refresh();
    assert.equal(await page.evaluate(() => getSelection().toString()), selected); assert.equal(await details.evaluate(el => el.open), true);
    await details.locator(':scope > summary').click({ position: { x: 8, y: 8 } }); assert.equal(await details.evaluate(el => el.open), false);
    await row.getByRole('button', { name: '查看原空间「Source A」中的来源记录', exact: true }).click();
    await until(async () => (await page.evaluate(() => workspace.initial())).viewState.spaceId === a, 'Original source navigation');
    assert.equal((await snapshot()).rooms.find(room => room.id === c).messages.some(m => m.text === 'LATE PRIVATE ORIGINAL'), false);
  });
  await flow('04 second-window source edit rejects a stale preview without creating a room or discarding drafts', async () => {
    await open(a); await form('Stale rejected'); const before = metadata().spaces.rooms.length;
    const created = app.waitForEvent('window'); await page.evaluate(() => workspace.newWindow()); secondary = await created; secondary.setDefaultTimeout(7000); await secondary.locator('#new-space').waitFor();
    await secondary.locator(`[data-space-id="${a}"] .room-nav`).click(); await secondary.locator('#shared-input').fill('OTHER WINDOW A UNSENT');
    await secondary.locator('#room-header-more').click(); await secondary.getByRole('menuitem', { name: '共享笔记', exact: true }).click();
    await secondary.locator('#room-notes-text').fill('A revised in other window'); await secondary.locator('#save-notes').click(); await secondary.locator('#notes-dialog').waitFor({ state: 'hidden' });
    await page.locator('#confirm-space-merge').click(); await page.locator('#space-merge-error').waitFor(); assert.match(await page.locator('#space-merge-error').innerText(), /重新预览/);
    assert.equal(metadata().spaces.rooms.length, before); await page.locator('#close-space-merge').click();
    assert.equal((await page.evaluate(() => workspace.initial())).viewState.roomViews[a].sharedDraft, 'Source A unsent');
  });
  await flow('05 target disk refusal leaves sources and recovers the same operation only after an explicit action', async () => {
    await open(a); await form('Recovered E'); await fixture('failImport', null, null, 't69merge'); await page.locator('#confirm-space-merge').click();
    await until(() => target('Recovered E')?.merge.stage === 'failed', 'Owned synthetic write refusal recorded'); await page.locator('#space-merge-error').waitFor();
    const id = target('Recovered E').id; assert.equal(metadata().metadata(a).archived, false); assert.equal(metadata().metadata(b).archived, false); await capture('05-target-refusal');
    await page.locator('#close-space-merge').click(); await fixture('storageRecovered', null, null, 't69');
    await roomRow(id).locator('.session-more').click(); await page.getByRole('menuitem', { name: '合并详情…', exact: true }).click(); await page.locator('#recover-space-merge').waitFor(); await page.locator('#recover-space-merge').click();
    await until(() => metadata().metadata(id).merge.stage === 'ready', 'Same target recovered'); assert.equal(target('Recovered E').id, id);
    const operationId = metadata().metadata(id).merge.batch.operationId;
    await page.locator('#open-space-merge-target').click(); await page.locator('#privacy-button').click(); await page.locator('#privacy-dialog details').last().locator('summary').click();
    await page.locator('#clear-shared-history').click();
    await until(() => metadata().metadata(id).merge === undefined, 'Imported profile bodies cleared');
    assert.equal((await snapshot()).rooms.find(room => room.id === id).messages.length, 0);
    assert.equal(metadata().metadata(id).clearedMerge.operationId, operationId);
    assert.ok((await snapshot()).rooms.find(room => room.id === c).messages.some(message => message.text === 'A exact original tool'));
    await page.locator('#close-privacy').click();
  });
  await flow('06 partial source archive is visible and explicit recovery does not re-import or replay', async () => {
    await open(a); await form('Archived D', 'archive'); await fixture('failArchive', a, 1, 't69merge'); await page.locator('#confirm-space-merge').click();
    await until(() => target('Archived D')?.merge.stage === 'partial', 'Partial source archive recorded'); d = target('Archived D').id;
    assert.equal(metadata().metadata(a).archived, false); assert.equal(metadata().metadata(b).archived, true); await capture('06-partial-archive');
    await page.locator('#recover-space-merge').waitFor(); await page.locator('#recover-space-merge').click(); await until(() => metadata().metadata(d).merge.stage === 'ready', 'Explicit remaining archive completed');
    assert.equal(metadata().metadata(a).archived, true); assert.equal(metadata().metadata(b).archived, true);
    assert.equal((await snapshot()).rooms.find(room => room.id === d).snapshotBatches.length, 1); await page.locator('#open-space-merge-target').click();
  });
  await flow('07 undo restores sources and preserves a newly typed unsent D draft without needing sent C work', async () => {
    await page.locator('#room-record').click(); await page.locator('#shared-input').fill('D POSITIVE UNSENT LATER');
    await until(async () => (await page.evaluate(() => workspace.initial())).viewState.roomViews[d].sharedDraft === 'D POSITIVE UNSENT LATER', 'Positive D draft stored');
    await roomAction('合并详情…'); await page.locator('#undo-space-merge').click(); await until(() => metadata().metadata(d).merge.stage === 'undone', 'Organization undone');
    assert.equal(metadata().metadata(d).archived, false); assert.equal(metadata().metadata(a).archived, false); assert.equal(metadata().metadata(b).archived, false);
    assert.equal((await page.evaluate(() => workspace.initial())).viewState.roomViews[d].sharedDraft, 'D POSITIVE UNSENT LATER');
    await page.locator('#close-space-merge').click();
  });
  await flow('08 same profile reopen retains imported originals, all identities and positive drafts', async () => {
    if (secondary && !secondary.isClosed()) await secondary.close();
    await open(d); const old = JSON.stringify((await snapshot()).rooms.find(room => room.id === d).messages);
    await app.close(); app = null; await launch();
    await until(async () => (await page.evaluate(() => workspace.initial())).viewState.spaceId === d, 'Reopened D view');
    assert.equal(await page.locator('#shared-input').inputValue(), 'D POSITIVE UNSENT LATER');
    assert.equal(JSON.stringify((await snapshot()).rooms.find(room => room.id === d).messages), old);
    assert.equal(metadata().metadata(d).merge.stage, 'undone');
    const views = JSON.parse(fs.readFileSync(path.join(profile, 'views.json'), 'utf8'));
    assert.ok(views.some(view => view.roomViews?.[a]?.sharedDraft === 'OTHER WINDOW A UNSENT'));
  });
  assert.deepEqual(sourceHashes(), frozen); assert.deepEqual(errors, []);
}

const cleanup = scratch.cleanup(async () => { if (client && child?.connected) { await fixture('stop'); await client.call('shutdown').catch(() => {}); } client?.close(); });
(async () => {
  try { await run(); } catch (error) { failure = error; process.exitCode = 1; if (page && !page.isClosed() && evidence) { await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack + '\n' + await page.locator('body').innerText().catch(() => '')); } }
  finally {
    if (lease) {
      try {
        const raw = { checks, errors, failure: failure?.stack || null, launches, launchProofs, guiEntrySha256: guiEntry && fs.existsSync(path.join(guiEntry, 'main.cjs')) ? hash(fs.readFileSync(path.join(guiEntry, 'main.cjs'))) : null, metrics: app ? await app.evaluate(() => globalThis.t69Merge).catch(() => null) : null, synthetic: child?.connected ? await fixture('stats').catch(() => null) : null, sourceBefore: frozen, sourceAfter: frozen ? sourceHashes() : null };
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
