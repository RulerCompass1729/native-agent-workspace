// Actual isolated source GUI/service. Only native output is synthetic.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  const target = path.resolve(evidence); let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const destination = path.join(fs.realpathSync(existing), path.relative(existing, target));
  for (const base of [root, code].map(p => fs.realpathSync(p))) assert.ok(destination !== base && !destination.startsWith(base + path.sep));
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; nothing started.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex4', task: 'T92 membership navigation', token, pid: process.pid, time: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-membership-navigation-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/membership-navigation.cjs')],
  env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const checks = [], errors = [], measurements = [];
let app, page, peer, sequence = 0, failure = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = reply => { if (reply.requestId === id) { clearTimeout(timer); child.off('message', callback); reply.error ? reject(Error(reply.error)) : resolve(reply); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timed out')); }, 12000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const check = text => { checks.push(text); console.log('PASS:', text); };
async function launch() {
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await app.evaluate(require('./fixtures/membership-navigation.cjs').install);
}
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
async function capture(name) { if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') }); }
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture started'); await launch();
  const header = id => page.locator(`.collaboration-member-status[data-member-id="${id}"]`);
  const more = id => header(id).locator('.collaboration-member-more');
  const terminal = id => page.locator(`#terminal-area [data-terminal-id="${id}"] .xterm-helper-textarea`);
  const active = () => page.evaluate(() => ({ tag: document.activeElement?.tagName, id: document.activeElement?.id, member: document.activeElement?.closest('[data-member-id]')?.dataset.memberId }));
  const hold = (method, id, phase = 'before') => app.evaluate((_, args) => globalThis.navigationFixture.hold(...args), [method, id, phase]);
  const release = (method, id, fail = false) => app.evaluate((_, args) => globalThis.navigationFixture.release(...args), [method, id, fail]);
  const pending = (method, id, phase) => until(async () => (await app.evaluate(() => globalThis.navigationFixture.status())).waiting.some(p => p.id === `${method}:${id ?? 'room'}` && (!phase || p.phase === phase)), 'Actual original IPC handler reached owned gate');
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const view = async () => { await settle(); return (await snapshot()).viewState; };
  const identity = s => s.sessions.map(x => [x.id, x.nativeId, x.owner, x.model, x.nativePermissionMode, x.skipPermissions]);
  async function stableCalls(before, label) {
    const after = await fixture('stats');
    for (const key of ['claim', 'terminal']) assert.equal(after.overviewCalls[key], before.overviewCalls[key], label + ' never claims or opens a native view');
    assert.equal(after.stats.sends, before.stats.sends); return after;
  }
  async function joinFromSolo(id) {
    await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#session-header-more').click();
    await page.getByRole('menuitem', { name: '加入协作', exact: true }).click();
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).roomId, 'Existing session rejoined');
  }
  async function detachMenu(id) { await more(id).click(); await page.getByRole('menuitem', { name: '脱出协作', exact: true }).click(); }
  async function left(id) { await until(async () => !(await snapshot()).sessions.find(s => s.id === id).roomId, 'Exact member left'); await settle(); }
  async function archive(id) {
    await page.locator(`.session-more[data-session-menu="${id}"]`).click();
    await page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).archived, 'Exact session archived');
  }
  const ids = [];
  for (const name of ['Navigation A', 'Navigation B', 'Navigation C', 'Navigation D']) {
    const id = await create(name); ids.push(id); await until(async () => (await snapshot()).sessions.find(s => s.id === id).state === 'idle', 'Synthetic session idle');
    await page.locator('#message-input').fill('Original private draft ' + name);
    await until(async () => (await snapshot()).sessions.find(s => s.id === id).liveDraft === 'Original private draft ' + name, 'Private draft saved');
    await fixture('nativeBlock', id, { id: 'original', kind: 'response', text: 'Original source for ' + name, status: 'complete' });
    if (ids.length < 4) { await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入协作', exact: true }).click(); }
  }
  const [a, b, c, d] = ids;
  peer = await require(path.join(code, 'app/service-client.cjs')).connect(profile, 'owned-navigation-peer');
  await peer.call('claim', c, 'chat');
  await page.locator('#room-nav').click(); await header(c).waitFor();
  await chooseRecipient(page, a); await fillRoomMessage(page, 'Original shared draft');
  const shared = await page.locator('#shared-input').inputValue(), recipient = await page.locator('#recipient').inputValue();
  const original = identity(await snapshot()), baseline = await fixture('stats');
  await detachMenu(b); await left(b);
  assert.equal((await view()).selected, 'room', 'Removing a nonfocused member never navigates away from the room');
  assert.deepEqual(identity(await snapshot()), original); await stableCalls(baseline, 'Room detach');
  assert.equal(await more(c).evaluate(el => document.activeElement === el), true, 'Focus moves to the next member action');
  assert.equal(await page.locator('#shared-input').inputValue(), shared); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  const openB = page.getByRole('button', { name: '打开 Navigation B', exact: true }); await openB.waitFor();
  await capture('01-room-detach-stays');
  if (evidence) fs.writeFileSync(path.join(evidence, 'action-notice-accessibility.txt'), await page.locator('#toast').ariaSnapshot());
  await openB.focus(); await delay(6700); assert.equal(await openB.isVisible(), true, 'Action notice remains keyboard usable beyond the old timeout');
  await capture('01b-action-notice-keyboard'); await openB.press('Enter'); await until(async () => (await view()).selected === b, 'Explicit Open navigates to the same original');
  assert.equal(await page.locator('#message-input').inputValue(), 'Original private draft Navigation B');
  check('Room detach keeps view, ownership, native identity, drafts and nearby focus; only a persistent explicit Open button navigates');
  await capture('01-explicit-open');

  await joinFromSolo(b); const solo = await view(), soloCalls = await fixture('stats');
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '脱出协作', exact: true }).click(); await left(b);
  await until(() => page.locator('#toast .toast-action').count().then(n => n === 0), 'No redundant Open for the current solo session');
  assert.equal((await view()).selected, b); assert.equal((await view()).mode, solo.mode); await stableCalls(soloCalls, 'Solo detach');
  assert.equal(await page.locator('#message-input').inputValue(), 'Original private draft Navigation B');
  await joinFromSolo(b); await page.locator('#room-nav').click();
  await page.locator('#collaboration-overview').getByRole('button', { name: '列表', exact: true }).click();
  await header(b).locator('.collaboration-member-name').click();
  if (await page.locator('#toast-close').isVisible()) await page.locator('#toast-close').click();
  await hold('join', b, 'after'); const focusedCalls = await fixture('stats');
  await page.locator('#header-actions').getByRole('button', { name: '脱出协作', exact: true }).click(); await pending('join', b, 'after');
  await left(b); const beforeReply = await view();
  assert.equal(beforeReply.selected, 'room'); assert.equal(beforeReply.roomSession, ''); assert.equal(beforeReply.mode, 'chat');
  await stableCalls(focusedCalls, 'Focused state-before-reply removal'); await capture('02-state-before-reply-stays');
  await release('join', b); await page.getByRole('button', { name: '打开 Navigation B', exact: true }).waitFor();
  assert.equal((await view()).selected, 'room');
  check('Solo detach preserves its mode; focused List removal returns to the room even when state arrives before the reply');

  await hold('join', a); const rejected = await fixture('stats'); await detachMenu(a); await pending('join', a, 'before');
  await page.getByRole('button', { name: '打开 Navigation B', exact: true }).focus(); await release('join', a, true);
  await page.locator('#toast-text').getByText('Synthetic navigation operation failed', { exact: false }).waitFor();
  assert.equal(await page.locator('#toast .toast-action').count(), 0); assert.equal((await active()).id, 'toast-close');
  assert.equal((await snapshot()).sessions.find(s => s.id === a).roomId, 'shared'); await stableCalls(rejected, 'Rejected detach');
  assert.equal((await view()).selected, 'room');
  await hold('join', c); await detachMenu(c); await pending('join', c, 'before');
  await page.locator(`[data-session-id="${d}"]`).click(); await page.locator('#message-input').fill('Human newer private draft');
  await release('join', c); await left(c);
  assert.equal((await view()).selected, d); assert.equal(await page.locator('#message-input').inputValue(), 'Human newer private draft');
  assert.equal((await active()).id, 'message-input');
  await joinFromSolo(c); await page.locator('#room-nav').click(); await hold('join', c); await detachMenu(c); await pending('join', c, 'before');
  await page.locator('#shared-input').fill('Human newer shared draft'); await release('join', c); await left(c);
  assert.equal((await view()).selected, 'room'); assert.equal((await active()).id, 'shared-input'); assert.equal(await page.locator('#shared-input').inputValue(), 'Human newer shared draft');
  check('Rejected and delayed operations preserve newer human navigation, input focus and drafts; new notices remove stale Open actions');

  await archive(d); await page.locator('#archive-button').click();
  const archived = id => page.locator(`[data-archived-session="${id}"]`).getByRole('button', { name: '恢复会话', exact: true });
  await hold('restoreSession', d, 'after'); const restoring = await fixture('stats'); await archived(d).click(); await pending('restoreSession', d, 'after');
  assert.equal((await view()).selected, 'room'); await stableCalls(restoring, 'Archive restoration before reply');
  await release('restoreSession', d); await page.getByRole('button', { name: '打开 Navigation D', exact: true }).waitFor();
  assert.equal((await view()).selected, 'room'); assert.equal((await active()).id, 'archive-button'); await capture('03-restored-session-stays');
  await page.getByRole('button', { name: '打开 Navigation D', exact: true }).press('Space');
  await until(async () => (await view()).selected === d, 'Explicit restored-session Open'); assert.equal(await page.locator('#message-input').inputValue(), 'Human newer private draft');
  await page.locator(`[data-session-id="${a}"]`).click(); await archive(a);
  const currentRestore = page.locator('#header-actions').getByRole('button', { name: '恢复会话', exact: true }); const currentBefore = await view(); await currentRestore.click();
  await until(async () => !(await snapshot()).sessions.find(s => s.id === a).archived, 'Current archived session restored');
  assert.equal((await view()).selected, a); assert.equal((await view()).mode, currentBefore.mode);
  await until(() => page.locator('#toast .toast-action').count().then(n => n === 0), 'No redundant Open after restoring current session');
  await joinFromSolo(a); await page.locator(`[data-session-id="${d}"]`).click();
  await page.locator('#room-more').click(); await page.getByRole('menuitem', { name: '归档工作区', exact: true }).click();
  await until(async () => (await snapshot()).room.archived, 'Owned room archived');
  await hold('restoreRoom', undefined); const roomRestoreCalls = await fixture('stats');
  await page.locator('[data-archived-room]').getByRole('button', { name: '恢复工作区', exact: true }).click(); await pending('restoreRoom', undefined, 'before');
  await page.locator('#message-input').fill('Human draft while room restores'); await release('restoreRoom', undefined);
  await until(async () => !(await snapshot()).room.archived, 'Owned room restored');
  assert.equal((await view()).selected, d); assert.equal((await active()).id, 'message-input');
  assert.equal(await page.locator('#message-input').inputValue(), 'Human draft while room restores'); await stableCalls(roomRestoreCalls, 'Room restoration'); await capture('04-restored-room-keeps-newer-input');
  await page.getByRole('button', { name: '打开 共同工作', exact: true }).click(); await until(async () => (await view()).selected === 'room', 'Explicit restored-room Open');
  assert.equal(await page.locator('#shared-input').inputValue(), 'Human newer shared draft');
  check('Archived sessions and room restore in place; current mode and newer drafts survive until deliberate Open');

  await header(a).locator('.collaboration-member-name').dragTo(page.locator('#solo-drop')); await left(a);
  assert.equal((await view()).selected, 'room'); assert.equal((await view()).roomSession, '');
  assert.equal(await page.locator('.collaboration-member-reader').count(), 0);
  assert.equal(await page.locator('#shared-input').inputValue(), 'Human newer shared draft');
  check('The drag-out entry point and last-member removal keep the empty room and original shared draft visible');

  const staleOpenA = page.getByRole('button', { name: '打开 Navigation A', exact: true }); await staleOpenA.waitFor();
  await page.locator(`[data-session-id="${a}"]`).click(); await joinFromSolo(a);
  await page.locator('#terminal-tab').click(); await terminal(a).waitFor({ state: 'attached' }); await page.locator(`#terminal-area [data-terminal-id="${a}"] .terminal-surface`).waitFor();
  await until(async () => (await snapshot()).sessions.find(s => s.id === a).view === 'terminal', 'Native view settled');
  await page.locator('#chat-tab').click(); await until(async () => (await snapshot()).sessions.find(s => s.id === a).view === 'chat', 'Native view back to chat');
  await fixture('navigation-hold-claim', a); await page.locator('#terminal-tab').click();
  await until(async () => (await fixture('stats')).navigation.waitingClaims.includes(a), 'Real view claim held');
  await terminal(a).focus(); await page.keyboard.type('retained native text');
  const queued = await fixture('stats');
  await staleOpenA.press('Enter');
  assert.equal((await view()).selected, a); assert.equal((await view()).mode, 'terminal');
  assert.ok((await fixture('stats')).navigation.waitingClaims.includes(a), 'An old Open notice cannot replace the pending native view intent');
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '脱出协作', exact: true }).click(); await left(a);
  assert.equal((await view()).selected, a); assert.equal((await view()).mode, 'terminal'); await stableCalls(queued, 'Solo detach with queued input');
  await until(() => page.locator('#toast .toast-action').count().then(n => n === 0), 'No current-session Open can cancel the queued edit'); await capture('05-native-queue-after-detach');
  assert.equal((await fixture('stats')).navigation.inputs.length, queued.navigation.inputs.length);
  await fixture('navigation-release-claim', a);
  await until(async () => (await fixture('stats')).navigation.inputs.length === queued.navigation.inputs.length + 1, 'Existing queued input settles once after detach');
  assert.equal((await fixture('stats')).navigation.inputs.at(-1).data, 'retained native text');
  assert.equal(await page.locator('.terminal-input-recovery:visible').count(), 0);
  check('Solo terminal detach preserves an already queued native edit and its original pending view claim without cancelling or replaying it');

  await joinFromSolo(a); await page.locator('#room-nav').click(); await header(a).locator('.collaboration-member-name').click();
  await page.locator('#terminal-tab').click(); await until(async () => (await snapshot()).sessions.find(s => s.id === a).view === 'terminal', 'Focused native view settled');
  if (await page.locator('#toast-close').isVisible()) await page.locator('#toast-close').click();
  const textarea = terminal(a); await textarea.focus();
  await until(() => textarea.evaluate(el => document.activeElement === el), 'Original native IME origin focused');
  await textarea.evaluate(el => { globalThis.navigationImeTrace = []; for (const type of ['compositionstart', 'compositionend', 'input', 'blur']) el.addEventListener(type, e => globalThis.navigationImeTrace.push({ type, data: e.data, value: el.value }), true); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '保留输入', selectionStart: 4, selectionEnd: 4 });
  await until(() => textarea.inputValue().then(t => t.includes('保留输入')), 'Chromium owns the marked original text');
  const compositionBefore = await fixture('stats'); await peer.call('join', a, false);
  await until(async () => (await view()).selected === 'room' && !(await view()).roomSession, 'Remote focused removal keeps room');
  assert.equal(await page.locator('#toast .toast-action:visible').count(), 0, 'Remote removal never produces a success Open notice');
  const recovery = page.locator(`#terminal-area [data-terminal-id="${a}"] .terminal-input-recovery textarea`);
  await until(async () => {
    const received = (await fixture('stats')).navigation.inputs.slice(compositionBefore.navigation.inputs.length).map(x => x.data).join('');
    return received.includes('保留输入') || (await recovery.inputValue()).includes('保留输入');
  }, 'Original composition is either accepted at its origin or retained as unconfirmed before reopening');
  const compositionAfter = await fixture('stats'), received = compositionAfter.navigation.inputs.slice(compositionBefore.navigation.inputs.length), retained = await recovery.inputValue();
  assert.ok(received.every(x => x.id === a)); assert.equal(received.map(x => x.data).join('') + retained, '保留输入');
  measurements.push({ name: 'original-composition', received, retained, trace: await page.evaluate(() => globalThis.navigationImeTrace) });
  await cdp.detach(); await page.locator(`[data-session-id="${a}"]`).click();
  if (retained) assert.equal(await recovery.isVisible(), true);
  assert.equal((await snapshot()).sessions.find(s => s.id === a).liveDraft, 'Original private draft Navigation A');
  check('Remote focused removal keeps the room and preserves Chromium composition once at its original session, without Enter or another target');
  const final = await fixture('stats'); assert.equal(final.stats.sends, 0); assert.equal((await snapshot()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  measurements.push({ name: 'final-native-actions', stats: final.stats, calls: final.overviewCalls, inputs: final.navigation.inputs,
    handlerGates: await app.evaluate(() => globalThis.navigationFixture.status()), identities: identity(await snapshot()) });
  await capture('02-retained-origin-input');
}
run().catch(async error => {
  console.error(error.stack); process.exitCode = 1; failure = error.stack;
  if (evidence && page && !page.isClosed()) {
    await capture('failure');
    const details = await page.evaluate(async () => ({ view: (await workspace.initial()).viewState,
      toast: document.getElementById('toast')?.innerText, target: document.querySelector('[data-search-target]')?.dataset.messageId }));
    fs.writeFileSync(path.join(evidence, 'failure-details.json'), JSON.stringify({ error: error.stack, ...details, fixture: await fixture('stats') }, null, 2));
  }
}).finally(async () => {
  try {
    if (evidence) fs.writeFileSync(path.join(evidence, 'membership-navigation-result.json'), JSON.stringify({ flowPassed: !failure, failure, checks, errors, measurements, profile, token }, null, 2));
    peer?.close();
    if (app) await app.evaluate(() => globalThis.navigationFixture?.close()).catch(() => {});
    await scratch.release(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token);
    fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ profile, token, profileExists: fs.existsSync(profile), time: new Date().toISOString() }, null, 2));
    console.log('Owned fixture cleaned; GUI slot released.');
  } catch (e) { console.error('Cleanup not confirmed; owned lock retained:', e.stack); process.exitCode = 1; }
});
