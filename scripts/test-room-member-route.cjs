// Real isolated renderer/service, existing synthetic NativeHost. No provider,
// product model, OS clipboard, installed/daily app or native-user input.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const { chooseRecipient, fillRoomMessage } = require('./room-input.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const baselineOnly = process.env.NAW_ROUTE_BASELINE_ONLY === '1';
const evidence = process.env.NAW_EVIDENCE_DIR, screenshots = process.env.NAW_SCREENSHOTS_DIR;
// Match the established scratch boundary before creating a profile or process.
if (evidence) {
  let existing = path.resolve(evidence); while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(fs.realpathSync(existing), path.relative(existing, path.resolve(evidence)));
  for (const base of [root, code].map(p => fs.realpathSync(p))) assert.ok(real !== base && !real.startsWith(base + path.sep), 'Evidence must be outside source roots');
  fs.mkdirSync(real, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no profile/process launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex 3', task: 'T163 member route ' + (baselineOnly ? 'pinned baseline' : 'candidate'), token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-member-route-'));
const child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/collaboration-overview.cjs')],
  env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let application, page, sequence = 0, failure, cleanupConfirmed = false;
const checks = [], errors = [], witnesses = [], start = Date.now(), delay = ms => new Promise(r => setTimeout(r, ms));
const record = name => { checks.push(name); console.log('PASS ' + name); };
async function until(fn, label) { for (let i = 0; i < 120; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', callback); result.error ? reject(Error(result.error)) : resolve(result); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture reply timed out')); }, 10000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
const tab = id => page.locator(`#room-member-tabs [data-room-session="${id}"]`);
// T-121 A: clicking the open member's tab returns to all members, so open a member only when its tab is not pressed.
const openTab = async id => { if (await tab(id).getAttribute('aria-pressed') !== 'true') await tab(id).click(); };
async function capture(name) { if (!screenshots) return; fs.mkdirSync(screenshots, { recursive: true }); const file = path.join(screenshots, name + '.png'); await page.screenshot({ path: file }); witnesses.push(file); }
async function settle() { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
async function closeNotice() { if (await page.locator('#toast-close').isVisible()) await page.locator('#toast-close').click(); }
async function create(name, provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Synthetic session created');
  const id = (await snapshot()).sessions.find(s => s.name === name).id;
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: '加入此空间', exact: true }).click();
  await until(() => page.locator('#toast-close').isVisible(), 'Join notice'); await closeNotice(); return id;
}
async function sendShared(id, body) {
  await fixture('bindSends', id); await chooseRecipient(page, id); await fillRoomMessage(page, body); await page.locator('#forward-button').click();
  await until(async () => Boolean((await fixture('stats', id)).lastSend), 'One explicit synthetic shared send');
  await fixture('complete', id, { text: 'Synthetic completion', response: 'Synthetic completion' });
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).state === 'idle', 'Synthetic turn settled');
}
function identity(state) { return state.sessions.map(s => [s.id, s.nativeId]).sort((a, b) => a[0].localeCompare(b[0])); }
function controls(packet) { return Object.fromEntries(['claim', 'input', 'send', 'queue', 'steer', 'forward', 'approve', 'answer', 'run', 'resume', 'pause'].map(k => [k, packet.overviewCalls[k] || 0])); }
async function detach(id) {
  // Represents a membership change from another view, within this owned fixture.
  await page.evaluate(async id => { const state = await workspace.initial(), s = state.sessions.find(s => s.id === id); await workspace.spaceAction('shared', 'join', [id, false, { nativeId: s.nativeId, placementRevision: s.placementRevision || 0, connectionRevision: s.connectionRevision || 0 }]); }, id);
  await until(async () => page.evaluate(async id => !window.nativeWorkspaceSpaces.isMember((await workspace.initial()).sessions.find(s => s.id === id), 'shared'), id), 'Member departed in fixture');
}
async function visibleStates(ids) {
  for (const id of ids) {
    const box = await tab(id).boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })); assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
    assert.ok((await tab(id).locator('.room-member-state').innerText()).length > 0);
  }
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic daemon ready');
  application = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  const a = await create('Route A', 'claude'), b = await create('Route B', 'codex'), c = await create('Route C historical', 'claude');
  await page.locator('#room-nav').click(); await page.locator('#collaboration-overview').waitFor();
  if (baselineOnly) {
    assert.equal(await page.locator('#room-member-tabs').isVisible(), false); assert.equal(await page.locator('#member-related-records').count(), 0);
    await capture('00-baseline-hidden-member-entry'); record('Pinned baseline RED: existing member tabs hidden and no view-only related route'); return;
  }
  await sendShared(c, 'SYNTHETIC_SHARED_C historical exchange'); await sendShared(a, 'SYNTHETIC_SHARED_A current exchange');
  await detach(c); const d = await create('Route D', 'codex'); await page.locator('#room-nav').click();
  for (const id of [a, b, d]) for (let i = 0; i < 22; i++) await fixture('nativeBlock', id, { id: 'route-response-' + i, kind: 'response', turnId: 'route-turn', status: 'complete', text: `SYNTHETIC_PRIVATE_${id.slice(0, 4)}_${i}: Original conversation text.\n\nReading and temporary filters do not share this private material.` });
  await fixture('approval', b, { requestId: 17, method: 'item/commandExecution/requestApproval', params: { command: 'echo synthetic-permission', cwd: '/synthetic', availableDecisions: ['accept', 'decline'] } });
  await fixture('fleet', d, { event: 'thread/started', id: 'route-child-unknown', stale: false });
  await chooseRecipient(page, b); await fillRoomMessage(page, 'Unsent room route draft');
  const roomDraft = await page.locator('#shared-input').inputValue(), recipient = await page.locator('#recipient').inputValue(), ids = identity(await snapshot());
  await page.locator('#room-record').click(); await until(() => page.locator('#room-filter').locator(`option[value="${c}"]`).count(), 'Historical participant candidate');
  await page.locator('#room-filter').selectOption(c); await page.locator('#room-search').fill('saved-history-no-match');
  await page.locator('#room-record-clear').waitFor(); assert.equal(await page.locator('#room-messages .message-body').count(), 0);
  await page.locator('#room-record-clear').click(); assert.match(await page.locator('#room-messages').innerText(), /SYNTHETIC_SHARED_A/); await page.locator('#room-record-restore').click();
  assert.equal(await page.locator('#room-filter').inputValue(), c); assert.equal(await page.locator('#room-search').inputValue(), 'saved-history-no-match');
  record('Historical filter is explicit and clear/restore preserves recipient and unsent room draft');
  await tab(b).click(); assert.equal(await page.locator('#message-input').isEditable(), true); await page.locator('#message-input').fill('Unsent permission-wait draft'); assert.equal(await page.locator('#send-button').isDisabled(), true); const permissionBefore = { draft: await page.locator('#message-input').inputValue(), requests: (await snapshot()).sessions.find(s => s.id === b).approvals.map(r => r.requestId) }; assert.equal(permissionBefore.requests.length, 1);
  await tab(a).click(); await page.locator('#member-related-records').waitFor(); await visibleStates([a, b, d]);
  await page.locator('#message-input').fill('Unsent private A route draft'); await until(async () => (await snapshot()).sessions.find(s => s.id === a).liveDraft === 'Unsent private A route draft', 'Private draft saved');
  await page.locator('#message-input').evaluate(el => el.setSelectionRange(3, 9));
  await page.locator('#messages').evaluate(el => el.scrollTop = 240); await settle();
  const top = await page.locator('#messages').evaluate(el => el.scrollTop); assert.ok(top > 30);
  const selected = await page.locator('#messages').evaluate(el => { const body = [...el.querySelectorAll('.message-body')].find(n => n.getBoundingClientRect().top >= el.getBoundingClientRect().top); const r = document.createRange(); r.selectNodeContents(body); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(r); return selection.toString(); });
  await fixture('nativeBlock', d, { id: 'other-member-update', kind: 'response', turnId: 'other-turn', status: 'streaming', text: 'OTHER_MEMBER_UPDATE stays private' }); await settle();
  assert.ok(Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - top) < 3); assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  await capture('01-member-full-conversation');
  const before = controls(await fixture('stats')); await page.locator('#member-related-records').click();
  await page.locator('#room-record-return').waitFor(); assert.match(await page.locator('#room-record-scope').innerText(), /Route A.*临时查看/);
  assert.match(await page.locator('#room-messages').innerText(), /SYNTHETIC_SHARED_A/); assert.doesNotMatch(await page.locator('#room-messages').innerText(), /SYNTHETIC_SHARED_C|SYNTHETIC_PRIVATE|OTHER_MEMBER_UPDATE/);
  assert.equal(await page.locator('#room-filter').inputValue(), c); assert.equal(await page.locator('#room-search').inputValue(), 'saved-history-no-match');
  assert.equal(await page.locator('#shared-input').inputValue(), roomDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient); await visibleStates([a, b, d]); await capture('02-related-shared-exchanges');
  await page.locator('#room-record-return').click(); await page.locator('#member-related-records').waitFor(); await settle();
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private A route draft'); assert.ok(Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - top) < 3);
  assert.equal(await page.evaluate(() => getSelection().toString()), selected); assert.deepEqual(await page.locator('#message-input').evaluate(el => [el.selectionStart, el.selectionEnd]), [3, 9]);
  assert.deepEqual(controls(await fixture('stats')), before); assert.deepEqual(identity(await snapshot()), ids);
  record('Member/related/return preserves original text selection, reading, caret, both drafts, recipient and native identities without input/control/send');
  await page.locator('#terminal-tab').click(); await page.locator('#native-pane').waitFor(); await fixture('output', a, { data: 'SYNTHETIC_NATIVE_A\r\n' }); await settle();
  const terminalIdentity = await page.locator('#terminal-area .terminal-surface').evaluate(el => { window.__routeTerminal = el; return el.dataset.sessionId || ''; });
  const afterExplicitNative = controls(await fixture('stats')); await page.locator('#member-related-records').click();
  await until(async () => (await snapshot()).viewState.roomViews?.shared?.roomRecordScope === a, 'Temporary route persisted'); await page.reload(); await page.locator('#room-record-return').waitFor();
  assert.match(await page.locator('#room-messages').innerText(), /SYNTHETIC_SHARED_A/); assert.equal(await page.locator('#shared-input').inputValue(), roomDraft);
  await page.locator('#room-record-return').click(); await page.locator('#native-pane').waitFor(); assert.equal(await page.locator('#terminal-tab').getAttribute('class'), 'active');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private A route draft'); assert.deepEqual(identity(await snapshot()), ids); assert.deepEqual(controls(await fixture('stats')), afterExplicitNative);
  await capture('03-reload-return-native-mode'); record('Reload retains related scope, return member/native mode, both drafts and identities; passive restore never claims or sends');
  const otherSpace = await page.evaluate(() => workspace.spaceCreate('SYNTHETIC_OTHER_ROUTE')); await page.locator(`#additional-spaces [data-space-id="${otherSpace}"] .room-nav`).click(); await page.locator('#room-nav').click(); await page.locator('#native-pane').waitFor(); assert.equal(await page.locator('#terminal-tab').getAttribute('class'), 'active'); assert.equal(await page.locator('#shared-input').inputValue(), roomDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient); assert.deepEqual(controls(await fixture('stats')), afterExplicitNative);
  record('Switching through an empty second space preserves the first space saved member/native mode and drafts without a native claim');
  await tab(b).click(); assert.equal(await page.locator('#message-input').isEditable(), true); assert.equal(await page.locator('#send-button').isDisabled(), true); assert.equal(await page.locator('#message-input').inputValue(), permissionBefore.draft); assert.deepEqual((await snapshot()).sessions.find(s => s.id === b).approvals.map(r => r.requestId), permissionBefore.requests); assert.ok((await tab(b).innerText()).includes('待'));
  await tab(a).click(); await page.locator('#native-pane').waitFor(); assert.deepEqual(controls(await fixture('stats')), afterExplicitNative);
  const e = await create('Route E with a longer readable member name', 'claude'); await page.locator('#room-nav').click(); await openTab(a);
  await page.locator('#chat-tab').click(); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 600)); await settle(); await visibleStates([a, b, d, e]); await capture('04-narrow-four-member-states');
  // Rejoin the same historical logical/native pair; this is the owned fixture,
  // not a migration or a provider/native session creation.
  await page.evaluate(async id => { const s = (await workspace.initial()).sessions.find(s => s.id === id); await workspace.spaceAction('shared', 'join', [id, true, { nativeId: s.nativeId, placementRevision: s.placementRevision || 0, connectionRevision: s.connectionRevision || 0 }]); }, c);
  await until(() => tab(c).count(), 'Fifth existing member tab'); await visibleStates([a, b, c, d, e]);
  const geometry = await page.evaluate(() => ({ chatHeight: document.getElementById('messages').clientHeight, privateBottom: document.getElementById('composer-wrap').getBoundingClientRect().bottom, viewport: innerHeight, font: getComputedStyle(document.getElementById('message-input')).fontSize }));
  assert.ok(geometry.chatHeight >= 80); assert.ok(geometry.privateBottom <= geometry.viewport + 1); assert.equal(geometry.font, '14px'); await capture('05-narrow-five-member-states');
  record('Permission/input guards survive tab changes; four/five member statuses remain visible at850x600 with reading and14px private draft');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860)); await openTab(a); await page.locator('#member-related-records').click(); await detach(a);
  await until(() => page.locator('#room-record-return').isDisabled(), 'Departed return disabled'); assert.equal(await tab(a).count(), 0); assert.match(await page.locator('#room-messages').innerText(), /SYNTHETIC_SHARED_A/);
  assert.equal(await page.locator('#shared-input').inputValue(), roomDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  const final = await fixture('stats'); assert.equal(final.stats.inputs, 0); assert.equal(final.stats.sends, 2); assert.deepEqual(errors, []);
  record('Departure while reading retains historical shared originals and refuses stale member return; exactly2explicit synthetic sends and0native input');
  return { ids, geometry, permissionBefore, beforePassive: before, afterExplicitNative, finalStats: final.stats, workspaceCalls: final.overviewCalls, terminalIdentityBeforeReload: terminalIdentity };
}
let details;
run().then(value => { details = value; }).catch(async error => { failure = error.stack; process.exitCode = 1; console.error(error.stack); if (page && !page.isClosed()) await capture('failure').catch(() => {}); }).finally(async () => {
  try { await scratch.release(); const lease = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(lease.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); cleanupConfirmed = true; }
  catch (error) { console.error('Cleanup not confirmed, own lease retained:', error.stack); process.exitCode = 1; }
  const result = { at: new Date().toISOString(), baselineOnly, checks, details, errors, failure, witnesses, elapsedMs: Date.now() - start, ownedCleanupConfirmed: cleanupConfirmed, canonicalOwnTokenReleased: cleanupConfirmed, productModels: 0, realProviderProcesses: 0, osClipboard: 0,
    limits: 'Synthetic NativeHost through actual source GUI/service; not installed/native provider/physical IME/locked CUA/5-column real sending. Text selection/caret checked within same renderer; reload checks draft/mode/reading context, not physical edit-line preservation.' };
  if (evidence) fs.writeFileSync(path.join(evidence, 'member-route-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
});
