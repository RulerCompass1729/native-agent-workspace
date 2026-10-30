// T75A: real hidden Electron/DSH/IPC, three synthetic native sessions.
// Five bounded journeys; no model/provider/native input/system clipboard.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = root;
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
const evidence = process.env.NAW_EVIDENCE_DIR;
const onlyGroup = Number(process.env.NAW_T75_GUI_GROUP || 0);
assert.ok(Number.isSafeInteger(onlyGroup) && onlyGroup >= 0 && onlyGroup <= 5);
const guiBudget = Number(process.env.NAW_T75_GUI_REMAINING_MS || 900000);
assert.ok(Number.isSafeInteger(guiBudget) && guiBudget > 0 && guiBudget <= 900000);
const files = ['app/renderer/collaboration-overview.js', 'app/renderer/context-menu.js', 'app/renderer/renderer.js', 'app/renderer/styles.css', 'app/renderer/index.html', 'app/renderer/reading-list.js', 'app/main.cjs', 'app/preload.cjs', 'app/workspace.cjs', 'app/workspace-client.cjs', 'app/dsh/bootstrap.js', 'app/dsh/client.js', 'scripts/test-member-header-menu.cjs'];
const hashes = () => Object.fromEntries(files.map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
const sourceBefore = hashes(), checks = [], measurements = [], events = [], errors = [];
let profile, owned, workspacePath, child, app, page, peer, failure, slotOwned = false, started, sequence = 0, activeGroup = '', identities, drafts, roomDraft;
let a, b, c; const delay = ms => new Promise(r => setTimeout(r, ms));
function setup() {
  assert.ok(evidence, 'Explicit evidence destination required');
  let existing = path.resolve(evidence); while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const target = path.join(fs.realpathSync(existing), path.relative(existing, path.resolve(evidence)));
  assert.ok(target !== root && !target.startsWith(root + path.sep));
  try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('OCCUPIED: no profile/daemon/GUI launched'); process.exit(75); }
  slotOwned = true; started = Date.now();
  fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T75A five source GUI journeys', token, pid: process.pid, time: new Date().toISOString() }));
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-t75-header-')); owned = fs.realpathSync(profile);
  workspacePath = path.join(profile, 'workspace'); fs.mkdirSync(workspacePath, { mode: 0o700 });
  assert.ok(fs.realpathSync(workspacePath).startsWith(owned + path.sep));
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(root, 'scripts/fixtures/collaboration-overview.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: workspacePath, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
}
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const callback = packet => { if (packet.requestId === id) { clearTimeout(timer); child.off('message', callback); packet.error ? reject(Error(packet.error)) : resolve(packet); } };
  const timer = setTimeout(() => { child.off('message', callback); reject(Error('Synthetic fixture timed out')); }, 10000);
  child.on('message', callback); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const header = id => page.locator(`.collaboration-member-status[data-member-id="${id}"]`);
const name = id => header(id).locator('.collaboration-member-name');
const more = id => header(id).locator('[data-member-menu]');
const reader = id => page.locator(`.collaboration-member-reader[data-member-id="${id}"]`);
const identity = s => s.sessions.map(({ id, nativeId, cwd, model, nativePermissionMode, skipPermissions }) => ({ id, nativeId, cwd, model, nativePermissionMode, skipPermissions }));
const ownerState = s => s.sessions.map(({ id, owner, controlRevision }) => ({ id, owner, controlRevision }));
const menu = () => page.getByRole('menu');
async function settle() { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
async function capture(label) { await page.screenshot({ path: path.join(evidence, label + '.png') }); }
async function drainEvents() { if (page && !page.isClosed()) events.push(...await page.evaluate(() => window.t75Events.splice(0))); }
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard, ipcMain }) => {
    globalThis.t75 = { copies: [], clipboardReads: 0, blockedClipboard: 0, counts: {} };
    clipboard.writeText = value => globalThis.t75.copies.push(value);
    clipboard.readText = () => { globalThis.t75.clipboardReads++; return 'Synthetic clipboard fixture'; };
    for (const method of ['readImage', 'writeImage', 'read', 'write', 'readBuffer', 'writeBuffer', 'clear']) clipboard[method] = () => { globalThis.t75.blockedClipboard++; throw Error('System clipboard prohibited'); };
    for (const name of ['input', 'send', 'forward', 'run', 'approve', 'answer', 'queue', 'steer', 'copy', 'pasteText', 'pasteNativeContent', 'claim', 'join']) {
      const channel = 'workspace:' + name, original = ipcMain._invokeHandlers.get(channel); if (!original) throw Error(channel);
      globalThis.t75.counts[name] = 0; ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args) => { globalThis.t75.counts[name]++; return original(...args); });
    }
  });
  await page.evaluate(() => {
    window.t75Events = [];
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'click', 'keydown', 'focusin']) document.addEventListener(type, e => {
      const target = e.target, item = { type, time: performance.now(), tag: target.tagName, cls: target.className, member: target.closest?.('[data-member-id]')?.dataset.memberId, key: e.key, code: e.code, button: e.button, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey };
      window.t75Events.push(item);
    }, true);
  });
}
async function create(label, provider, draft) {
  const before = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#session-name').fill(label); await createIn(page, 'chat');
  const record = (await snapshot()).sessions.find(s => !before.has(s.id)); assert.ok(record); assert.ok(fs.realpathSync(record.cwd).startsWith(owned + path.sep));
  await page.locator('#message-input').fill(draft); await until(async () => (await snapshot()).sessions.find(s => s.id === record.id).liveDraft === draft, 'Private fixture draft persisted');
  await page.evaluate(id => workspace.join(id, true), record.id); return record.id;
}
async function selectText(locator) { return locator.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return s.toString(); }); }
async function menuReady(id) {
  await menu().waitFor(); await settle(); assert.equal(await menu().count(), 1); assert.equal(await more(id).getAttribute('aria-expanded'), 'true');
  const box = await menu().boundingBox(), band = await header(id).evaluate(el => (el.closest('.collaboration-statuses') || el).getBoundingClientRect().toJSON());
  assert.ok(box && box.width > 40 && box.height > 20); assert.ok(box.y >= band.bottom - 2 || box.y + box.height <= band.top + 2, 'Menu stays outside the original status band');
  return { box, band, anchor: await more(id).boundingBox(), items: await page.getByRole('menuitem').allTextContents() };
}
async function closeMenu(id) { await page.keyboard.press('Escape'); await until(async () => await menu().count() === 0, 'Menu closes'); assert.equal(await more(id).evaluate(el => document.activeElement === el), true); }
async function rightTitle(id, target = name(id)) { await target.click({ button: 'right' }); return menuReady(id); }
async function checkUnchanged() { const s = await snapshot(); assert.deepEqual(identity(s), identities); assert.equal(s.sessions.length, 3); assert.ok(s.sessions.every(x => fs.realpathSync(x.cwd).startsWith(owned + path.sep))); assert.equal(s.diagnostics.dispatches, 0); }
async function group(label, action) {
  if (onlyGroup && Number(label[0]) !== onlyGroup) return;
  assert.ok(checks.length < 5); assert.ok(Date.now() - started < guiBudget, 'Own GUI time cap'); activeGroup = label;
  const before = await fixture('stats'); await action(); await checkUnchanged();
  measurements.push({ group: label, before, after: await fixture('stats'), ipc: await app.evaluate(() => globalThis.t75) });
  await drainEvents(); checks.push(label); console.log('PASS:', label); await capture(String(checks.length).padStart(2, '0') + '-journey');
}
async function run() {
  setup(); await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic daemon ready'); await launch();
  a = await create('Same synthetic member', 'codex', 'Private draft A'); b = await create('Same synthetic member', 'claude', 'Private draft B'); c = await create('Long synthetic member name retained across narrow views and menus', 'codex', 'Private draft C');
  await page.locator('#room-nav').click(); await header(c).waitFor();
  peer = await require('../app/service-client.cjs').connect(profile, 't75-owned-other-window'); await peer.call('claim', b, 'chat');
  await fixture('history', a, [{ id: 't75-original', type: 'agentMessage', text: 'ORIGINAL A selected reading text.\n\n[Retained link](https://example.test/retained)' }]);
  await chooseRecipient(page, c); await fillRoomMessage(page, 'Unsent shared fixture draft'); roomDraft = await page.locator('#shared-input').inputValue();
  identities = identity(await snapshot()); drafts = Object.fromEntries((await snapshot()).sessions.map(s => [s.id, s.liveDraft]));
  await group('1 exact original menu, member ID and more anchor with retained selection', async () => {
    const selected = await selectText(reader(a).locator('[data-message-id="t75-original"] .message-body'));
    const owners = ownerState(await snapshot());
    for (const id of [a, b, c]) {
      assert.equal(await header(id).locator('[data-member-menu]').count(), 1);
      await more(id).click(); const original = await menuReady(id); await closeMenu(id);
      await selectText(reader(a).locator('[data-message-id="t75-original"] .message-body'));
      const actual = await rightTitle(id); assert.deepEqual(actual.items, original.items);
      for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(actual.box[key] - original.box[key]) <= 3, 'Original anchor position, not pointer coordinates');
      await page.getByRole('menuitem', { name: '复制完整 NAW ID', exact: true }).click();
      assert.equal(await app.evaluate(() => globalThis.t75.copies.at(-1)), id); assert.equal(await more(id).evaluate(el => document.activeElement === el), true);
      assert.equal(await page.evaluate(() => getSelection().toString()), selected);
    }
    assert.deepEqual(ownerState(await snapshot()), owners); assert.equal((await snapshot()).viewState.roomSession || '', '');
    await rightTitle(b, header(b).locator('.collaboration-member-state')); await closeMenu(b);
  });
  await group('2 menu keys, original toggle and measured CDP Ctrl-click boundary', async () => {
    for (const key of ['ContextMenu', 'Shift+F10']) {
      const expectedSelection = await selectText(reader(a).locator('[data-message-id="t75-original"] .message-body'));
      assert.ok(expectedSelection.includes('ORIGINAL A selected reading text.'));
      await name(b).focus(); const beforeSelection = await page.evaluate(() => getSelection().toString()); assert.equal(beforeSelection, expectedSelection);
      await page.keyboard.press(key); const opened = await menuReady(b);
      const afterSelection = await page.evaluate(() => getSelection().toString()); assert.equal(afterSelection, expectedSelection);
      assert.ok(opened.items.includes('复制完整 NAW ID'));
      measurements.push({ group: '2 selected-reader menu key', key, beforeSelection, afterSelection, opened });
      await closeMenu(b);
    }
    await rightTitle(b); await name(b).click({ button: 'right' }); await until(async () => await menu().count() === 0, 'Repeated right-click toggles closed');
    assert.equal(await more(b).getAttribute('aria-expanded'), 'false'); await rightTitle(b); await closeMenu(b);
    await drainEvents(); const before = (await snapshot()).viewState.roomSession || '';
    await page.keyboard.down('Control'); try { await name(b).click(); } finally { await page.keyboard.up('Control'); }
    await settle(); const after = (await snapshot()).viewState.roomSession || '', observed = await page.evaluate(() => window.t75Events.splice(0)); events.push(...observed);
    const contextEvents = observed.filter(e => e.type === 'contextmenu'), count = await menu().count();
    measurements.push({ group: 'CDP-Control-left-click', before, after, menuCount: count, events: observed, qualified: contextEvents.length > 0 && before === after, limit: contextEvents.length ? 'CDP event sequence only, no physical mouse qualification' : 'CDP did not synthesize an OS contextmenu; physical Ctrl-click unqualified' });
    if (contextEvents.length) assert.equal(after, before, 'A delivered contextmenu cannot also passively enlarge the member');
    if (count) await closeMenu(b);
    if (after) await page.getByRole('button', { name: '← 返回共同工作', exact: true }).click();
  });
  await group('3 list, narrow, brief and passive focused states remain usable', async () => {
    await page.getByRole('button', { name: '列表', exact: true }).click(); await header(b).scrollIntoViewIfNeeded(); await rightTitle(b); await closeMenu(b);
    const win = await app.browserWindow(page); await win.evaluate(w => w.setContentSize(950, 760)); await settle();
    await header(c).scrollIntoViewIfNeeded(); await name(c).focus(); await page.keyboard.press('Shift+F10'); await menuReady(c); await closeMenu(c);
    await win.evaluate(w => w.setContentSize(1240, 850)); await page.getByRole('button', { name: '网格', exact: true }).click();
    const owner = (await snapshot()).sessions.find(s => s.id === b).owner;
    await name(b).click(); await until(async () => (await snapshot()).viewState.roomSession === b, 'Passive member enlarged'); await rightTitle(b); await closeMenu(b);
    assert.equal((await snapshot()).sessions.find(s => s.id === b).owner, owner); await page.getByRole('button', { name: '← 返回共同工作', exact: true }).click();
    await page.getByRole('button', { name: '简化信息', exact: true }).click(); await rightTitle(a); await closeMenu(a); await page.getByRole('button', { name: '简化信息', exact: true }).click();
  });
  await group('4 stale membership and removed targets close and cannot act', async () => {
    const n = await app.evaluate(() => globalThis.t75.copies.length), rev = (await snapshot()).sessions.find(s => s.id === b).memberRevision;
    await rightTitle(b); await peer.call('join', b, false); await peer.call('join', b, true);
    await until(async () => (await snapshot()).sessions.find(s => s.id === b).memberRevision > rev + 1 && await menu().count() === 0, 'Old membership menu rejected');
    assert.equal(await page.locator('#manage-members').evaluate(el => document.activeElement === el), true); assert.equal(await app.evaluate(() => globalThis.t75.copies.length), n);
    await rightTitle(c); await peer.call('join', c, false); await until(async () => await header(c).count() === 0 && await menu().count() === 0, 'Removed anchor and stale menu gone');
    assert.equal(await page.locator('#manage-members').evaluate(el => document.activeElement === el), true); assert.equal(await app.evaluate(() => globalThis.t75.copies.length), n);
    await peer.call('join', c, true); await header(c).waitFor();
  });
  await group('5 body, link, editor, terminal and reopening preserve their old paths', async () => {
    const body = reader(a).locator('[data-message-id="t75-original"] .message-body'); const selected = await selectText(body);
    await body.click({ button: 'right' }); await page.getByRole('menuitem', { name: '复制', exact: true }).waitFor(); assert.equal(await page.getByRole('menuitem', { name: '脱出协作', exact: true }).count(), 0);
    await page.getByRole('menuitem', { name: '复制', exact: true }).click(); assert.equal(await app.evaluate(() => globalThis.t75.copies.at(-1)), selected);
    await page.evaluate(() => getSelection().removeAllRanges()); const link = reader(a).locator('a[href="https://example.test/retained"]'); await link.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '复制链接', exact: true }).click(); assert.equal(await app.evaluate(() => globalThis.t75.copies.at(-1)), 'https://example.test/retained');
    const input = reader(a).locator('textarea[data-composer-session]'); await input.fill('Unsent column draft A'); drafts[a] = 'Unsent column draft A';
    await input.focus(); await input.evaluate(el => el.setSelectionRange(0, 6)); await page.keyboard.press('Shift+F10');
    for (const label of ['剪切', '复制', '粘贴', '全选']) assert.equal(await page.getByRole('menuitem', { name: label, exact: true }).count(), 1);
    await page.keyboard.press('Escape'); await until(async () => await menu().count() === 0, 'Editor menu closes'); assert.equal(await input.inputValue(), drafts[a]);
    await name(a).click(); await page.locator('#terminal-tab').click(); const terminal = page.locator(`[data-terminal-id="${a}"] .xterm-screen`); await terminal.waitFor();
    await terminal.click({ button: 'right' }); await page.getByRole('menuitem', { name: '粘贴', exact: true }).waitFor(); assert.equal(await page.getByRole('menuitem', { name: '脱出协作', exact: true }).count(), 0);
    await page.locator('#title').click(); await until(async () => await menu().count() === 0, 'Terminal menu dismisses without terminal keyboard input');
    await page.locator('#room-nav').click(); await until(async () => (await snapshot()).sessions.find(s => s.id === a).liveDraft === drafts[a], 'Column draft persisted');
    let state = await snapshot(); assert.equal(state.viewState.sharedDraft, roomDraft); for (const s of state.sessions) assert.equal(s.liveDraft, drafts[s.id]);
    const stats = await fixture('stats'), ipc = await app.evaluate(() => globalThis.t75); measurements.push({ group: 'before-reopen', stats, ipc });
    assert.equal(stats.stats.inputs, 0); assert.equal(stats.stats.sends, 0); for (const key of ['input', 'send', 'forward', 'run', 'approve', 'answer', 'queue', 'steer', 'pasteText', 'pasteNativeContent']) assert.equal(ipc.counts[key], 0);
    assert.equal(ipc.clipboardReads, 0); assert.equal(ipc.blockedClipboard, 0); assert.ok(ipc.copies.length >= 5); await drainEvents(); await app.close(); app = null; await launch();
    state = await snapshot(); assert.equal(state.viewState.sharedDraft, roomDraft); for (const s of state.sessions) assert.equal(s.liveDraft, drafts[s.id]); assert.equal(await menu().count(), 0);
  });
  assert.deepEqual(errors, []); assert.equal(checks.length, onlyGroup ? 1 : 5);
  const finalStats = await fixture('stats'), finalIpc = await app.evaluate(() => globalThis.t75);
  assert.equal(finalStats.stats.inputs, 0); assert.equal(finalStats.stats.sends, 0);
  for (const key of ['input', 'send', 'forward', 'run', 'approve', 'answer', 'queue', 'steer', 'pasteText', 'pasteNativeContent']) assert.equal(finalIpc.counts[key], 0);
  assert.equal(finalIpc.clipboardReads, 0); assert.equal(finalIpc.blockedClipboard, 0);
  measurements.push({ group: 'final-counters', stats: finalStats, ipc: finalIpc });
}
run().catch(async error => { failure = error.stack; process.exitCode = 1; console.error(error.stack); if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  if (!slotOwned) return;
  let cleanupError;
  try {
    await drainEvents().catch(() => {}); const sourceAfter = hashes(); assert.deepEqual(sourceAfter, sourceBefore);
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: !failure, failure, requestedGroup: onlyGroup || 'all', activeGroup, checks, errors, measurements, events, profile, token, started, guiElapsedMs: Date.now() - started, sourceBefore, sourceAfter, qualification: 'Source Electron44/realDSH/daemon/IPC with synthetic native transport; memory-only copy sink; no product model/provider/native input/OS clipboard. CDP Control-click and physical mouse/VoiceOver/installed qualifications kept separate.' }, null, 2));
  } catch (e) { cleanupError = e; process.exitCode = 1; console.error(e.stack); }
  try {
    peer?.close(); await scratch.release(); assert.equal(fs.existsSync(profile), false);
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, profile, exists: fs.existsSync(profile), releasedAt: new Date().toISOString(), ownedLeaseMs: Date.now() - started, immediateAfterOwnedCleanup: true, cleanupError: cleanupError?.message }, null, 2));
    console.log('Owned profile/process cleanup confirmed; canonical slot immediately released.');
  } catch (e) { console.error('Cleanup unconfirmed; retain own slot:', e.stack); process.exitCode = 1; }
});
