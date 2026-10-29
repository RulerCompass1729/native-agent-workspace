// Actual isolated Electron/DSH/service; synthetic native transport only.
// No provider/model turn or physical system clipboard operation.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
if (process.env.NAW_EVIDENCE_DIR) {
  const target = path.resolve(process.env.NAW_EVIDENCE_DIR); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(value => fs.realpathSync(value))) if (destination === base || destination.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository; no GUI launched.');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
}
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no test app launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T51 member actions', token, pid: process.pid, createdAt: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-member-actions-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, peer, sequence = 0; const checks = [], errors = [];
function fixture(method, target, value) {
  const id = ++sequence; return new Promise((resolve, reject) => {
    const callback = packet => { if (packet.requestId === id) { clearTimeout(timer); child.off('message', callback); packet.error ? reject(Error(packet.error)) : resolve(packet); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture reply timed out')); }, 10000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
async function until(fn, label) { for (let i = 0; i < 160; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const snapshot = () => page.evaluate(() => workspace.initial());
const check = text => { checks.push(text); console.log('PASS:', text); };
const header = id => page.locator(`#collaboration-overview .collaboration-member-status[data-member-id="${id}"]`);
const more = id => header(id).locator('[data-member-menu]');
const name = id => header(id).locator('.collaboration-member-name');
const identity = state => state.sessions.map(s => [s.id, s.nativeId, s.pid, s.model, s.nativePermissionMode, s.skipPermissions]).sort();
async function capture(name) {
  if (!process.env.NAW_SCREENSHOTS_DIR) return;
  fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_SCREENSHOTS_DIR, `${name}.png`) });
}
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => { globalThis.memberCopies = []; clipboard.writeText = text => globalThis.memberCopies.push(text); });
}
async function create(label, provider, join = true) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(label); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === label && s.provider === provider && s.state === 'idle'), 'Synthetic session ready');
  const id = (await snapshot()).sessions.find(s => s.name === label && s.provider === provider).id;
  if (join) { await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click(); }
  return id;
}
async function visibleStates(ids, menu = false) {
  const bounds = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const menuBox = menu ? await page.getByRole('menu').boundingBox() : null;
  for (const id of ids) {
    const facts = await header(id).evaluate(el => [el, ...el.children].map(n => n.getBoundingClientRect().toJSON()));
    for (const r of facts) {
      assert.ok(r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= bounds.width + 1 && r.top >= 0 && r.bottom <= bounds.height + 1, 'Every member state fact remains in the visible reading surface');
      if (menuBox) assert.ok(menuBox.y >= r.bottom - 1 || menuBox.y + menuBox.height <= r.top + 1 || menuBox.x >= r.right - 1 || menuBox.x + menuBox.width <= r.left + 1, 'The member menu must not cover any state card');
    }
  }
}
async function run() {
  console.log('Synthetic profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own synthetic service ready'); await launch();
  const a = await create('Member same', 'claude'), b = await create('Member same', 'codex'), c = await create('Member C', 'claude'), d = await create('Independent candidate', 'codex', false);
  await page.locator('#message-input').fill('UNSENT_PRIVATE_DRAFT_D');
  await until(async () => (await snapshot()).sessions.find(s => s.id === d).liveDraft === 'UNSENT_PRIVATE_DRAFT_D', 'Private draft persisted');
  await page.locator('#room-nav').click(); await header(c).waitFor();
  const original = identity(await snapshot()), stats = await fixture('stats');
  await chooseRecipient(page, c); await fillRoomMessage(page, 'UNSENT_ROOM_DRAFT');
  const roomDraft = await page.locator('#shared-input').inputValue(), recipient = await page.locator('#recipient').inputValue();
  await page.locator('#manage-members').click();
  assert.equal(await page.locator('#invite-dialog').evaluate(el => el.open), true, 'Visible invitation enters the existing picker directly');
  assert.equal(await page.locator('#members-dialog').count(), 0, 'There is one roster, with no intermediate duplicate dialog');
  assert.equal(await page.locator('#invite-list [data-invite-session]').count(), 1);
  await page.keyboard.press('Escape'); await until(() => page.locator('#invite-dialog').evaluate(el => !el.open), 'Invite cancelled');
  assert.equal(await page.locator('#manage-members').evaluate(el => document.activeElement === el), true);
  assert.deepEqual(identity(await snapshot()), original);
  assert.deepEqual((await fixture('stats')).overviewCalls, stats.overviewCalls, 'Opening/cancelling invite performs no native operation');
  await page.locator('#manage-members').click(); await page.locator(`[data-invite-session="${d}"]`).click();
  await header(d).waitFor(); await visibleStates([a, b, c, d]);
  assert.deepEqual(identity(await snapshot()), original); assert.equal((await snapshot()).sessions.length, 4);
  assert.equal((await snapshot()).sessions.find(s => s.id === d).liveDraft, 'UNSENT_PRIVATE_DRAFT_D');
  check('Direct invitation reuses one picker and the same native session; cancel restores its opener and drafts/identity remain intact');
  await capture('01-direct-invite-and-visible-members');

  peer = await require(path.join(code, 'app/service-client.cjs')).connect(profile, 'synthetic-member-actions-other-window');
  await peer.call('claim', b, 'chat');
  await fixture('nativeBlock', a, { id: 'response:selection', kind: 'response', text: 'ORIGINAL_SELECTED_A: keep this exact original while managing B.', status: 'complete' });
  const text = page.locator(`.collaboration-member-reader[data-member-id="${a}"] .message-body`).last(); await text.waitFor();
  const selected = await text.evaluate(el => { const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); return getSelection().toString(); });
  const passive = await fixture('stats'), owners = (await snapshot()).sessions.map(s => [s.id, s.owner, s.view, s.controlRevision]);
  await more(b).focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: '脱出协作', exact: true }).waitFor();
  assert.equal(await page.getByRole('menuitem').count(), 4);
  for (const name of ['脱出协作', '复制完整 NAW ID', '上移', '下移']) assert.equal(await page.getByRole('menuitem', { name, exact: true }).count(), 1);
  assert.equal(await more(b).getAttribute('aria-expanded'), 'true');
  await visibleStates([a, b, c, d], true); await capture('02-member-menu-below-status-band');
  await page.getByRole('menuitem', { name: '复制完整 NAW ID', exact: true }).click();
  assert.equal(await app.evaluate(() => globalThis.memberCopies.at(-1)), b);
  assert.equal(await more(b).evaluate(el => document.activeElement === el), true);
  assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  assert.deepEqual((await snapshot()).sessions.map(s => [s.id, s.owner, s.view, s.controlRevision]), owners);
  assert.deepEqual((await fixture('stats')).overviewCalls, passive.overviewCalls);
  check('The exact member menu wins over retained reader selection, copies only its full ID and never takes native ownership/input');

  for (const key of ['Enter', 'Space', 'Shift+F10']) {
    await more(b).focus(); await page.keyboard.press(key); await page.getByRole('menuitem', { name: '脱出协作', exact: true }).waitFor();
    await page.keyboard.press('Escape'); await until(() => page.getByRole('menu').count().then(n => n === 0), 'Menu escaped');
    assert.equal(await more(b).evaluate(el => document.activeElement === el), true);
  }
  await more(b).click(); await more(b).click(); assert.equal(await page.getByRole('menu').count(), 0);
  await more(b).click(); await page.locator('#title').click(); await until(() => page.getByRole('menu').count().then(n => n === 0), 'Outside dismissal');
  await more(b).click(); await fixture('nativeBlock', c, { id: 'response:stream', kind: 'response', text: 'OTHER_MEMBER_STREAM', status: 'streaming' });
  await page.getByRole('menuitem', { name: '脱出协作', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  check('Pointer toggle, Enter/Space/menu key, Escape, outside click and another member stream preserve one menu lifecycle and focus');

  await more(b).click(); const revision = (await snapshot()).sessions.find(s => s.id === b).memberRevision;
  await peer.call('join', b, false); await peer.call('join', b, true);
  await until(async () => (await snapshot()).sessions.find(s => s.id === b).memberRevision > revision + 1, 'Leave/rejoin revision observed');
  await until(() => page.getByRole('menu').count().then(n => n === 0), 'Old membership menu must close after renderer receives leave/rejoin');
  assert.equal(await page.getByRole('menu').count(), 0); assert.equal((await snapshot()).sessions.find(s => s.id === b).roomId, 'shared');
  assert.equal((await snapshot()).sessions.find(s => s.id === a).roomId, 'shared');
  assert.equal(await page.locator('#manage-members').evaluate(el => document.activeElement === el), true);
  check('Remote leave/rejoin invalidates the old member menu, preserving the new membership and every adjacent member');

  await more(d).click(); await page.getByRole('menuitem', { name: '脱出协作', exact: true }).click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === d).roomId, 'Exact candidate detached');
  assert.equal((await snapshot()).viewState.selected, 'room', 'Detach stays in the room');
  assert.deepEqual(identity(await snapshot()), original);
  assert.equal(await page.locator('#shared-input').inputValue(), roomDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  await page.getByRole('button', { name: '打开 Independent candidate', exact: true }).press('Enter');
  await until(async () => (await snapshot()).viewState.selected === d, 'Only deliberate Open navigates to the original');
  assert.equal(await page.locator('#message-input').inputValue(), 'UNSENT_PRIVATE_DRAFT_D');
  await page.locator('#room-nav').click(); await until(() => header(d).count().then(n => n === 0), 'Detached status removed');
  assert.equal(await page.locator('#shared-input').inputValue(), roomDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  assert.equal((await snapshot()).sessions.find(s => s.id === b).owner, owners.find(s => s[0] === b)[1]);
  check('Detach stays in the room; explicit Open uses the exact original ID, preserving identities and private/shared drafts');

  await name(a).click(); await more(b).click(); await visibleStates([a, b, c], true); await page.keyboard.press('Escape');
  await page.locator('#room-record').click(); await more(c).click(); await visibleStates([a, b, c], true); await page.keyboard.press('Escape');
  await page.locator('#room-overview').click();
  await app.browserWindow(page).then(win => win.evaluate(win => win.setSize(680, 860)));
  await page.getByRole('button', { name: '简化信息', exact: true }).click();
  await more(b).click(); await visibleStates([a, b, c], true); await capture('03-narrow-brief-menu'); await page.keyboard.press('Escape');
  const ids = identity(await snapshot()); await app.close(); app = null; await launch();
  await header(b).waitFor(); assert.deepEqual(identity(await snapshot()), ids); await visibleStates([a, b, c]);
  assert.equal(await page.locator('#shared-input').inputValue(), roomDraft);
  check('Focused/shared/brief/narrow reading keeps every state visible; reopen retains native identities, membership and drafts');
  await page.locator('#manage-members').click();
  const candidate = page.locator(`[data-invite-session="${d}"]`), oldRevision = (await snapshot()).sessions.find(s => s.id === d).memberRevision;
  await peer.call('join', d, true); await peer.call('join', d, false);
  await until(async () => (await snapshot()).sessions.find(s => s.id === d).memberRevision > oldRevision + 1, 'Candidate membership changed in another window');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const beforeStaleInvite = (await fixture('stats')).overviewCalls;
  await candidate.click(); await page.getByText('会话已变化，请关闭并重新打开邀请。', { exact: true }).waitFor();
  assert.equal(await page.locator('#invite-dialog').evaluate(el => el.open), true);
  assert.equal((await snapshot()).sessions.find(s => s.id === d).roomId, null);
  assert.deepEqual((await fixture('stats')).overviewCalls, beforeStaleInvite);
  await page.locator('#close-invite').click();
  assert.equal(await page.locator('#manage-members').evaluate(el => document.activeElement === el), true);
  assert.equal(await page.locator('#shared-input').inputValue(), roomDraft); assert.deepEqual(identity(await snapshot()), ids);
  check('A stale invitation after remote join/leave is refused without an API side effect, modal loss or draft/identity changes');
  assert.deepEqual(errors, []);
  const final = await fixture('stats'); assert.equal(final.stats.inputs, 0); assert.equal(final.stats.sends, 0);
  const result = { checks, errors, nativeStats: final.stats, workspaceCalls: final.overviewCalls, productModelCalls: 0, realProviderProcesses: 0, limits: 'Actual source GUI with synthetic transport; no physical clipboard/IME/reader, installed or cross-process CAS claim.' };
  fs.writeFileSync(path.join(profile, 'member-actions-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try {
    peer?.close(); await scratch.release();
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'released.json'), JSON.stringify({ owner: 'Codex 3', task: 'T51 member actions', token, releasedAt: new Date().toISOString(), ownedProfilesAndProcessesGone: true, profile }, null, 2));
    console.log('Owned fixture cleaned; GUI slot released.');
  } catch (error) { console.error('Cleanup unconfirmed; own GUI lock retained:', error.stack); process.exitCode = 1; }
});
