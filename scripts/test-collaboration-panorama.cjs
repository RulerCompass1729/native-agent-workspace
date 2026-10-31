// Whole panorama -> real space -> existing member -> original reading place.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const plan = { task: 'T53 cross-space panorama source GUI', guiStarts: 2, fakeDaemons: 1, syntheticSessions: 100,
  spaces: 10, memberships: 118, explicitClaims: 1, nativeSends: 0, nativeInputs: 0, productModels: 0, osClipboard: 0, maxRunMs: 450000 };
if (process.argv.includes('--plan')) { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.equal(process.env.NAW_T53_PANORAMA_GUI_AUTHORIZED, '1', 'Record this finite source GUI plan before running');
assert.ok(!process.env.NAW_APP_EXECUTABLE && !process.env.NAW_TEST_APP_ROOT, 'This recipe is source-only');
const evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'Private absolute outside-repository evidence is required');
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.resolve(common, '..', '.local/gui-test-slot.lock'), token = randomUUID();
let existing = evidence; while (!fs.existsSync(existing)) existing = path.dirname(existing);
const destination = path.resolve(fs.realpathSync(existing), path.relative(existing, evidence));
for (const repo of [fs.realpathSync(root), fs.realpathSync(path.resolve(slot, '../..'))]) assert.ok(destination !== repo && !destination.startsWith(repo + path.sep), 'Evidence must be outside both repositories');
const scratch = require('./fixtures/test-scratch.cjs');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no profile, backend or GUI started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: plan.task, token, pid: process.pid, time: new Date().toISOString() }));
const env = additions => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH'].includes(key))), ...additions });
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-panorama-')), entry = path.join(profile, 'entry'), work = path.join(profile, 'work');
fs.mkdirSync(entry); fs.mkdirSync(work);
fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'naw-owned-panorama-gui', version: require('../package.json').version, main: 'main.cjs' }));
const entryCode = [
  "const e=require('electron'),cp=require('node:child_process'),path=require('node:path');",
  "globalThis.panoramaGuards={clipboard:0,external:0,dialogs:0,maintenance:0,replacement:0};globalThis.panoramaCalls=[];globalThis.panoramaIPC=[];",
  "const handle=e.ipcMain.handle.bind(e.ipcMain);e.ipcMain.handle=(name,listener)=>!name.startsWith('workspace:')?handle(name,listener):handle(name,(event,...args)=>{globalThis.panoramaIPC.push({method:name.slice(10),id:typeof args[0]==='string'?args[0]:null,action:name==='workspace:spaceAction'?args[1]:null});return listener(event,...args);});",
  "const spawn=cp.spawn;cp.spawn=function(bin,args,...rest){if(Array.isArray(args)&&args.some(x=>typeof x==='string'&&path.basename(x)==='daemon.cjs')){globalThis.panoramaGuards.replacement++;throw Error('Replacement backend prohibited');}return spawn.call(this,bin,args,...rest);};",
  "for(const key of ['readText','writeText','readImage','writeImage','read','write','readBuffer','writeBuffer','clear'])e.clipboard[key]=()=>{globalThis.panoramaGuards.clipboard++;throw Error('OS clipboard prohibited');};",
  "e.shell.openExternal=e.shell.openPath=async()=>{globalThis.panoramaGuards.external++;throw Error('External action prohibited');};",
  "for(const key of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[key]=()=>{globalThis.panoramaGuards.dialogs++;throw Error('OS dialog prohibited');};",
  "const {WorkspaceClient}=require(" + JSON.stringify(path.join(root, 'app/workspace-client.cjs')) + ");const call=WorkspaceClient.prototype.call;WorkspaceClient.prototype.call=function(method,...args){globalThis.panoramaCalls.push({method,id:typeof args[0]==='string'?args[0]:null,action:method==='spaceAction'?args[1]:null});return call.call(this,method,...args);};WorkspaceClient.prototype.maintainService=function(){globalThis.panoramaGuards.maintenance++;throw Error('Backend update prohibited');};",
  "require(" + JSON.stringify(path.join(root, 'app/main.cjs')) + ");",
].join('\n');
fs.writeFileSync(path.join(entry, 'main.cjs'), entryCode);
const child = fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')],
  env: env({ NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: root, NAW_APP_VERSION: require('../package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, fullStarts = 0, sequence = 0, failure, navigationStart = 0, ipcNavigationStart = 0;
const guiPids = [], samples = [], callBatches = [], ipcBatches = [], originBatches = [], selectionDiagnostics = [], checks = [], errors = [], started = Date.now();
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
async function guards() { const result = await app.evaluate(() => globalThis.panoramaGuards); assert.deepEqual(result, { clipboard: 0, external: 0, dialogs: 0, maintenance: 0, replacement: 0 }); samples.push(result); }
async function capture(name) {
  fs.mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + '.png') });
  fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(await snapshot(), null, 2));
  fs.writeFileSync(path.join(evidence, name + '.ui.json'), JSON.stringify(await page.evaluate(() => ({
    title: document.querySelector('#title').textContent, privateDraft: document.querySelector('#message-input').value,
    sharedDraft: document.querySelector('#shared-input').value, panorama: [...document.querySelectorAll('[data-panorama-session]')].map(row => ({
      id: row.dataset.panoramaSession, hidden: row.hidden, state: row.dataset.state, stale: row.dataset.stale,
      text: row.innerText, spaces: [...row.querySelectorAll('[data-panorama-space]')].map(el => el.dataset.panoramaSpace),
    })), selection: getSelection().toString(),
  })), null, 2));
}
async function check(text) { assert.ok(Date.now() - started < plan.maxRunMs, 'Finite stage-entry budget'); checks.push(text); console.log('PASS:', text); await capture('stage-' + checks.length); }
async function launch() {
  assert.ok(fullStarts++ < plan.guiStarts);
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }), timeout: 70000 });
  guiPids.push(app.process().pid); page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#panorama-nav').waitFor(); await guards();
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focusable: win.isFocusable() }))), [{ visible: false, focusable: false }]);
}
async function settleDisplays() {
  for (let n = 0; n < 8; n++) {
    const observed = await fixture();
    assert.deepEqual(observed.waitingInputs, []);
    if (!observed.pending.length) { await delay(30); if (!(await fixture()).pending.length) return; }
    for (const id of new Set(observed.pending)) await fixture('release', id);
  }
  throw Error('Owned passive display snapshots did not settle');
}
function member(id) { return page.locator('#panorama-view [data-panorama-session="' + id + '"]'); }
async function selectQuote(row) {
  const quote = row.locator('blockquote'); await quote.scrollIntoViewIfNeeded();
  const geometry = await quote.evaluate(el => {
    const text = el.firstChild; if (!text || text.nodeType !== Node.TEXT_NODE || text.length < 18) throw Error('Original text missing');
    const point = offset => { const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); const box = range.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };
    const rawFrom = point(0), to = point(16);
    // Chromium floors the recorded press position. Keep the tested short span;
    // the collapse click and press start at the floored glyph-0 point.
    const from = { x: Math.floor(rawFrom.x), y: Math.floor(rawFrom.y) };
    const hit = p => { const n = document.elementFromPoint(p.x, p.y); return n && { tag: n.tagName, id: n.id, cls: n.className }; };
    return { rawFrom, from, to, hitStart: hit(from), hitEnd: hit(to), hasFocus: document.hasFocus(), userSelect: getComputedStyle(el).userSelect,
      ancestors: [...(function* () { for (let n = el; n; n = n.parentElement) yield n; })()].map(n => ({ tag: n.tagName, cls: n.className, draggable: n.draggable, select: getComputedStyle(n).userSelect })) };
  });
  const diagnostic = { geometry }; selectionDiagnostics.push(diagnostic);
  // Reuse the qualified document-selection gesture: first a real click makes
  // the current reading surface active and collapses any previous selection.
  await page.mouse.click(geometry.from.x, geometry.from.y);
  diagnostic.beforeDrag = await page.evaluate(() => { const s = getSelection(); return { selected: s.toString(), rangeCount: s.rangeCount, type: s.type, hasFocus: document.hasFocus() }; });
  assert.equal(diagnostic.beforeDrag.selected, '');
  // Send the same mouse protocol directly to this owned page. Keep the original
  // short glyph endpoints and acceptance floor; do not widen a failed selection.
  const input = await page.context().newCDPSession(page);
  let gestureFailure;
  try {
    await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, modifiers: 0, force: 0.5, pointerType: 'mouse', ...geometry.from, clickCount: 1 });
    try {
      for (let i = 1; i <= 12; i++) {
        await input.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, modifiers: 0, force: 0.5, pointerType: 'mouse',
          x: geometry.from.x + (geometry.to.x - geometry.from.x) * i / 12, y: geometry.from.y + (geometry.to.y - geometry.from.y) * i / 12 });
        await delay(16);
      }
    } finally { await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, modifiers: 0, ...geometry.to, clickCount: 1 }); }
    await until(async () => await page.evaluate(() => getSelection().toString().length >= 8), 'Original short source selection did not settle');
  } catch (error) { gestureFailure = error; }
  finally { try { await input.detach(); } catch (error) { gestureFailure ||= error; } }
  const reading = await page.evaluate(() => { const s = getSelection(); return { selected: s.toString(), rangeCount: s.rangeCount, type: s.type, hasFocus: document.hasFocus() }; });
  Object.assign(diagnostic, reading); if (gestureFailure) throw gestureFailure;
  assert.ok(reading.selected.length >= 8);
  assert.equal(await quote.evaluate(el => { const s = getSelection(); return el.contains(s.anchorNode) && el.contains(s.focusNode); }), true);
  return reading.selected;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned service ready');
  client = await connect(profile, 'panorama-seed'); const initial = await client.call('initial');
  assert.equal(initial.servicePid, child.pid); assert.equal(initial.runtimeVersion, require('../package.json').version); assert.equal(initial.sessions.length, 0);
  const ids = [];
  for (let i = 0; i < 100; i++) ids.push(await client.call('create', { provider: i === 2 ? 'codex' : 'claude', cwd: work, name: i < 2 ? '同名成员' : '成员 ' + String(i + 1).padStart(3, '0'), view: 'chat' }));
  await launch(); const rooms = ['shared'];
  for (let i = 1; i < 10; i++) rooms.push(await page.evaluate(name => workspace.spaceCreate(name), '空间 ' + String.fromCharCode(65 + i)));
  for (let i = 0; i < 100; i++) {
    const destinations = i === 0 ? [rooms[0], rooms[1]] : i === 1 ? [rooms[0]] : i === 2 ? [rooms[1]] : [rooms[2 + (i - 3) % 8]];
    if (i >= 3 && i < 20) destinations.push(rooms[2 + (i - 2) % 8]);
    for (const room of destinations) await page.evaluate(({ room, id }) => workspace.spaceAction(room, 'join', [id, true]), { room, id: ids[i] });
    await fixture('messageItem', ids[i], { id: 'source-' + i, role: 'assistant', text: 'Source ' + i + ': original text for this existing session. No shared grant or new task.', status: 'complete' });
  }
  await fixture('native-activity', ids[0], { turnId: 'synthetic-turn', observedAt: Date.now() - 30000, label: 'Synthetic existing progress' });
  await fixture('set-state', ids[1], 'disconnected'); await fixture('set-state', ids[2], 'approval');
  const identities = (await snapshot()).sessions.map(s => [s.id, s.nativeId]);
  const ownersBefore = (await snapshot()).sessions.map(s => [s.id, s.owner]);
  navigationStart = (await app.evaluate(() => globalThis.panoramaCalls)).length;
  ipcNavigationStart = (await app.evaluate(() => globalThis.panoramaIPC)).length;
  await page.evaluate(() => {
    const api = window.nativeWorkspacePanorama, create = api.create;
    const trace = window.panoramaOriginDiagnostics = { events: [], dropped: 0 };
    const log = value => { if (trace.events.length < 128) trace.events.push(value); else trace.dropped++; };
    const describe = point => ({ hasRange: Boolean(point?.range), collapsed: point?.range?.collapsed,
      startConnected: point?.startNode?.isConnected, endConnected: point?.endNode?.isConnected,
      focusId: point?.focusId, source: point?.source, pointerCaptured: point?.pointerCaptured });
    api.create = options => {
      const controller = create({ ...options, onReadingLost: () => { log({ kind: 'readingLost' }); return options.onReadingLost?.(); } });
      const capture = controller.captureOrigin, restore = controller.restoreOrigin;
      controller.captureOrigin = (...args) => { const point = capture(...args); log({ kind: 'capture', ...describe(point) }); return point; };
      controller.restoreOrigin = point => {
        log({ kind: 'restoreBefore', ...describe(point) });
        try { const restored = restore(point); log({ kind: 'restoreAfter', restored, toast: document.querySelector('#toast-text').textContent, toastHidden: document.querySelector('#toast').hidden }); return restored; }
        catch (error) { log({ kind: 'restoreError', message: error.message }); throw error; }
      };
      return controller;
    };
  });
  await page.locator('#panorama-nav').click();
  await until(async () => await page.locator('#panorama-view [data-panorama-session]:visible').count() === 100, 'All unique sessions visible in primary panorama');
  assert.equal(await member(ids[0]).count(), 1); assert.equal(await member(ids[0]).locator('[data-panorama-space]').count(), 2);
  assert.ok(await member(ids[2]).isVisible()); assert.match(await page.locator('#panorama-view').innerText(), /100 \/ 100 个会话 · 118 条空间归属/);
  assert.equal(await member(ids[0]).getAttribute('data-stale'), 'true'); assert.match(await member(ids[1]).innerText(), /连接状态待核对|已断开/); assert.match(await member(ids[2]).innerText(), /等待确认/);
  await check('Primary panorama reaches all 100 unique sessions across ten real spaces, 118 memberships, one shared S, B-only U, missing clocks and stale/disconnected/waiting facts');
  const invalid = await page.evaluate(async () => {
    const before = await workspace.initial(); let rejected = false;
    try {
      await workspace.readingState({ ...before.viewState.readingPositions, 'invalid-candidate': { top: 1, follow: false, anchor: '', offset: 0 } },
        { ...before.viewState.panorama, query: 'x'.repeat(1001) });
    } catch { rejected = true; }
    const after = await workspace.initial();
    return { rejected, before: before.viewState.readingPositions, after: after.viewState.readingPositions,
      beforeMeta: before.viewState.panorama, afterMeta: after.viewState.panorama };
  });
  assert.equal(invalid.rejected, true); assert.deepEqual(invalid.after, invalid.before); assert.deepEqual(invalid.afterMeta, invalid.beforeMeta);
  await member(ids[2]).locator('.panorama-member-heading > button').click();
  await settleDisplays();
  assert.equal((await snapshot()).viewState.selected, ids[2]); assert.deepEqual((await snapshot()).sessions.map(s => [s.id, s.owner]), ownersBefore);
  assert.equal(await page.locator('#message-input').getAttribute('readonly'), '');
  await page.locator('#return-panorama').click(); await fixture('set-state', ids[2], 'idle');
  await member(ids[2]).locator('.panorama-member-heading > button').click(); await page.locator('#take-control').click();
  await settleDisplays();
  await until(async () => (await snapshot()).sessions.find(s => s.id === ids[2]).owner === (await snapshot()).owner, 'One explicit control claim');
  const draft = 'PRIVATE UNSENT panorama draft'; await page.locator('#message-input').fill(draft);
  await until(async () => (await snapshot()).viewState.draft?.text === draft, 'Private draft saved');
  await page.locator('#return-panorama').click();
  const owners = (await snapshot()).sessions.map(s => [s.id, s.owner]);
  let overview = page.locator('#panorama-view');
  await overview.getByRole('combobox').selectOption(rooms[1]); await overview.getByRole('searchbox').fill(ids[2]);
  await overview.getByRole('button', { name: '网格', exact: true }).click();
  const selected = await selectQuote(member(ids[2]));
  await member(ids[2]).locator('.panorama-member-heading > button').click();
  await settleDisplays();
  await fixture('messageItem', ids[1], { id: 'other-stream', role: 'assistant', text: 'Another member updated while U is being read', status: 'complete' });
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  await page.locator('#return-panorama').click();
  assert.equal(await overview.getByRole('searchbox').inputValue(), ids[2]); assert.equal(await overview.getByRole('combobox').inputValue(), rooms[1]);
  assert.equal(await overview.getAttribute('data-layout'), 'grid'); assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.panoramaFocus), ids[2]);
  assert.deepEqual((await snapshot()).sessions.map(s => [s.id, s.owner]), owners);
  await check('Observation keeps another owner; one explicit takeover is separate. Exact-ID member zoom returns to original filter/grid/source selection while another member streams, preserving the private unsent draft');
  // Release an aborted pointer outside the panorama, then navigate from the
  // keyboard. A stale pointer snapshot must not override this newer origin.
  const sourceButton = member(ids[2]).locator('.panorama-source');
  const sourceBox = await sourceButton.boundingBox(), headerBox = await page.locator('#title').boundingBox();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2); await page.mouse.down();
  await page.mouse.move(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2, { steps: 8 }); await page.mouse.up();
  const listButton = overview.getByRole('button', { name: '列表', exact: true });
  await listButton.focus(); assert.equal(await listButton.evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  await sourceButton.focus(); assert.equal(await page.evaluate(() => document.activeElement.dataset.panoramaSource), ids[2]);
  await page.keyboard.press('Enter'); await settleDisplays();
  await page.locator('#messages [data-message-id="source-2"][data-search-target="true"]').waitFor();
  assert.equal((await snapshot()).viewState.selected, ids[2]);
  await page.locator('#return-panorama').click();
  assert.equal(await overview.getAttribute('data-layout'), 'list');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.panoramaSource), ids[2]);
  await overview.getByRole('button', { name: '网格', exact: true }).click();
  await selectQuote(member(ids[2])); await member(ids[2]).locator('.panorama-member-heading > button').click();
  await settleDisplays();
  const changedOriginal = 'Changed original source: do not select neighbouring or replacement text.';
  await fixture('messageItem', ids[2], { id: 'source-2', role: 'assistant', text: changedOriginal, status: 'complete' });
  await until(async () => (await page.locator('#messages [data-message-id="source-2"]').innerText()).includes(changedOriginal), 'Edited original text reached the current member reader');
  await page.locator('#return-panorama').click();
  assert.equal(await page.evaluate(() => getSelection().toString()), '');
  await page.getByText('原文已变化，原选区没有替换成其他内容。', { exact: true }).waitFor();
  await check('An edited original source invalidates its saved selection; returning does not select replacement text or a neighbouring participant');
  await overview.getByRole('searchbox').fill(''); await overview.getByRole('combobox').selectOption('');
  // Pressure only historical geometry, then call the unchanged production
  // pruner. This proves the actual focus path supplies its active return key;
  // it is not a claim that 130 native histories were read or created.
  await page.evaluate(() => {
    const api = window.nativeWorkspacePanorama, original = api.pruneReading;
    window.panoramaReadingPressure = [];
    api.pruneReading = function(positions, active, limit) {
      if (!active.length) return original(positions, active, limit);
      const pressured = { ...positions };
      for (let i = 0; i < 130; i++) pressured['synthetic-history-' + i] = { top: i, follow: false, anchor: '', offset: 0 };
      const result = original(pressured, active, limit);
      window.panoramaReadingPressure.push({ active, before: Object.keys(pressured).length, after: Object.keys(result).length,
        kept: active.every(key => Object.hasOwn(result, key)) });
      return result;
    };
  });
  const roomDrafts = {};
  for (const room of rooms.slice(0, 2)) {
    const reference = member(ids[0]).locator('[data-panorama-space="' + room + '"]');
    if (room === rooms[0]) await reference.click();
    else {
      await reference.focus(); assert.equal(await page.evaluate(() => document.activeElement.dataset.panoramaSpace), room);
      await page.keyboard.press('Enter');
    }
    assert.equal((await snapshot()).viewState.spaceId, room);
    await chooseRecipient(page, ids[0]); await fillRoomMessage(page, 'Unsent scope draft ' + room);
    await until(async () => (await snapshot()).viewState.roomViews?.[room]?.sharedDraft === await page.locator('#shared-input').inputValue(), 'Scoped draft persisted');
    roomDrafts[room] = (await snapshot()).viewState.roomViews[room];
    const status = page.locator('.collaboration-member-status[data-member-id="' + ids[0] + '"]');
    await status.locator('.collaboration-member-name').click();
    await settleDisplays();
    assert.equal((await snapshot()).viewState.spaceId, room);
    await page.locator('.collaboration-back:visible').click();
    assert.equal(await page.locator('#shared-input').inputValue(), roomDrafts[room].sharedDraft);
    await page.locator('#return-panorama').click();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.panoramaSpace), room);
  }
  const state = await snapshot();
  for (const room of rooms.slice(0, 2)) {
    assert.equal(state.viewState.roomViews[room].sharedDraft, roomDrafts[room].sharedDraft);
    assert.equal(state.viewState.roomViews[room].roomRecipient, ids[0]);
  }
  assert.deepEqual(state.sessions.map(s => [s.id, s.owner]), owners);
  const pressure = await page.evaluate(() => window.panoramaReadingPressure);
  assert.ok(pressure.length >= 2 && pressure.every(sample => sample.before > 128 && sample.after === 128 && sample.kept));
  fs.writeFileSync(path.join(evidence, 'reading-pressure.json'), JSON.stringify(pressure, null, 2));
  await check('Panorama -> A/B -> same S -> exact space -> panorama preserves both distinct @S drafts, private U draft and active return keys under controlled >128 historical-geometry pressure; no recipient rebinding or input claim');
  await overview.getByRole('button', { name: '列表', exact: true }).click();
  await overview.locator('.panorama-members').hover(); await page.mouse.wheel(0, 1400);
  await until(async () => (await snapshot()).viewState.panorama.top > 300, 'Panorama reading position persisted');
  const nonzeroOrigin = await overview.locator('.panorama-members').evaluate(el => {
    const viewport = el.getBoundingClientRect();
    const button = [...el.querySelectorAll('.panorama-member-heading > button')].find(candidate => {
      const box = candidate.getBoundingClientRect(); return box.top >= viewport.top && box.bottom <= viewport.bottom;
    });
    return { top: el.scrollTop, id: button?.closest('[data-panorama-session]').dataset.panoramaSession };
  });
  assert.ok(nonzeroOrigin.top > 300 && ids.includes(nonzeroOrigin.id), 'An existing member is visible at the nonzero reading position');
  await member(nonzeroOrigin.id).locator('.panorama-member-heading > button').click(); await settleDisplays();
  assert.equal((await snapshot()).viewState.selected, nonzeroOrigin.id);
  await page.locator('#return-panorama').click();
  const returnedTop = await overview.locator('.panorama-members').evaluate(el => el.scrollTop);
  assert.ok(Math.abs(returnedTop - nonzeroOrigin.top) < 3, 'Member zoom returns to the same nonzero panorama position');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.panoramaFocus), nonzeroOrigin.id);
  fs.writeFileSync(path.join(evidence, 'nonzero-return.json'), JSON.stringify({ ...nonzeroOrigin, returnedTop }, null, 2));
  const before = await snapshot(); await guards(); callBatches.push(await app.evaluate(() => globalThis.panoramaCalls)); ipcBatches.push(await app.evaluate(() => globalThis.panoramaIPC)); originBatches.push(await page.evaluate(() => window.panoramaOriginDiagnostics)); await app.close(); app = null;
  await launch();
  overview = page.locator('#panorama-view');
  await until(async () => (await snapshot()).viewState.selected === 'panorama' && await overview.locator('.panorama-members').evaluate(el => el.scrollTop) > 300, 'Same primary panorama reopened');
  const after = await snapshot();
  assert.deepEqual(after.sessions.map(s => [s.id, s.nativeId]), identities); assert.deepEqual(after.sessions.map(s => [s.id, s.owner]), owners);
  assert.equal(after.viewState.panorama.layout, 'list'); assert.ok(Math.abs(after.viewState.panorama.top - before.viewState.panorama.top) < 3);
  assert.deepEqual(after.viewState.roomViews, before.viewState.roomViews);
  await member(ids[2]).locator('.panorama-member-heading > button').click(); assert.equal(await page.locator('#message-input').inputValue(), draft);
  await settleDisplays();
  const stats = await fixture(); assert.deepEqual(stats.inputs, []); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.interruptions, []);
  assert.deepEqual(stats.pending, []); assert.deepEqual(stats.waitingInputs, []);
  const calls = [...callBatches.flat(), ...await app.evaluate(() => globalThis.panoramaCalls)];
  const navigation = calls.slice(navigationStart);
  const allowed = new Set(['initial', 'uiReady', 'viewState', 'readingState', 'draft', 'terminalSnapshot', 'resize', 'observe', 'unobserve', 'claim']);
  assert.deepEqual(navigation.filter(c => !allowed.has(c.method)), [], 'Unexpected native/shared/lifecycle policy actions are forbidden');
  assert.equal(navigation.filter(c => c.method === 'claim').length, 1, 'Only the explicit takeover claimed input');
  for (const call of navigation.filter(c => ['terminal', 'terminalSnapshot', 'resize', 'observe', 'unobserve'].includes(c.method))) assert.ok([ids[0], ids[2], nonzeroOrigin.id].includes(call.id), 'Only the deliberately opened existing members have passive displays');
  for (const call of navigation.filter(c => ['claim', 'draft'].includes(c.method))) assert.equal(call.id, ids[2]);
  const ipc = [...ipcBatches.flat(), ...await app.evaluate(() => globalThis.panoramaIPC)];
  const navIPC = ipc.slice(ipcNavigationStart);
  assert.deepEqual(navIPC.filter(c => !allowed.has(c.method)), [], 'All main IPC routes, including local/shared handlers, are accounted separately from WCP');
  assert.equal(navIPC.filter(c => c.method === 'claim').length, 1);
  fs.writeFileSync(path.join(evidence, 'call-accounting.json'), JSON.stringify({ navigationStart, setup: calls.slice(0, navigationStart), navigation,
    ipcNavigationStart, setupIPC: ipc.slice(0, ipcNavigationStart), navigationIPC: navIPC }, null, 2));
  assert.deepEqual(errors, []); await guards();
  await check('Nonzero panorama member zoom returns to its original scroll and focus; close/reopen retains 100 native identities, owners, list/scroll, scoped/private drafts; exactly one explicit claim, no navigation sends/native input/approval/model/provider process');
}
const cleanup = scratch.cleanup(async () => {
  if (app) await app.close();
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); }
  else if (child.exitCode === null) child.kill('SIGTERM');
  if (child.connected) child.disconnect(); await until(() => child.exitCode !== null, 'Owned fake service exits');
});
run().catch(async error => { failure = error.stack; process.exitCode = 1; console.error(failure); if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, failure, errors, profile, fullStarts, ownedNodePid: child.pid, ownedGuiPids: guiPids, guards: samples,
    calls: [...callBatches.flat(), ...(app ? await app.evaluate(() => globalThis.panoramaCalls).catch(() => []) : [])],
    ipc: [...ipcBatches.flat(), ...(app ? await app.evaluate(() => globalThis.panoramaIPC).catch(() => []) : [])],
    originDiagnostics: [...originBatches, ...(app && page && !page.isClosed() ? [await page.evaluate(() => window.panoramaOriginDiagnostics || null).catch(() => null)] : [])],
    currentGuards: app ? await app.evaluate(() => globalThis.panoramaGuards).catch(() => null) : null, selectionDiagnostics,
    fixture: child.connected ? await fixture().catch(() => null) : null }, null, 2));
  await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token);
  fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
  fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), profileGone: !fs.existsSync(profile) }));
});
