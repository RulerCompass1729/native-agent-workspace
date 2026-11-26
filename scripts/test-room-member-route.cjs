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
// R248 ③: the left list switches members; the member tabs above the main area are always hidden (renderer.js render).
// openSidebarRow leaves the open member as it is, so clicking its row again is harmless.
const row = id => page.locator(`#session-list .session-row[data-session-row="${id}"]`);
const tab = id => row(id).locator('.session-link');
const openTab = id => tab(id).click();
const memberTab = () => page.locator('#room-member');
const feed = () => page.locator('#space-feed .feed-list');
const person = id => page.locator(`#space-feed .feed-person[data-person="${id}"]`);
const onTab = async id => (await page.locator(id).getAttribute('aria-current')) === 'page';
// A member view whose terminal is closed offers 打开终端 in place of the 终端 tab (renderPaneSwitches).
const showTerminal = async () => page.locator(await page.locator('#terminal-tab').isVisible() ? '#terminal-tab' : '#open-native-terminal').click();
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
// While one member is open, every member's state is on its left row: the state dot and the row's accessible name.
async function visibleStates(ids) {
  for (const id of ids) {
    await tab(id).scrollIntoViewIfNeeded();
    const box = await tab(id).boundingBox(); assert.ok(box && box.width > 0 && box.height > 0);
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })); assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1);
    assert.equal(await row(id).evaluate(el => el.classList.contains('in-current-space')), true);
    const facts = await row(id).evaluate(el => ({ label: el.querySelector('.session-link').getAttribute('aria-label') || '', name: el.querySelector('.session-title').textContent, dot: el.querySelector('.agent-icon>.state-dot')?.className || '' }));
    assert.ok(facts.name && facts.label.startsWith(facts.name + ' · ') && facts.label.split(' · ').length >= 4 && facts.dot, 'State on the left row: ' + JSON.stringify(facts));
  }
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned synthetic daemon ready');
  application = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  const a = await create('Route A', 'claude'), b = await create('Route B', 'codex'), c = await create('Route C historical', 'claude');
  // R248 ①: a space opens on its 总览.
  await page.locator('#room-nav').click(); await page.locator('#space-summary').waitFor();
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
  // R248 ②/R249: the 记录 view's member filter and search are the 信息流's names and search box. Its 清除/恢复 pair went
  // with that view; a name is pressed again and the box emptied instead. The feed keeps both while hidden (F6).
  const search = page.locator('#space-feed .feed-search');
  await page.locator('#room-stream').click(); await until(() => person(c).count(), 'Historical participant candidate');
  await person(c).click(); await until(async () => /SYNTHETIC_SHARED_C/.test(await feed().innerText()) && !/SYNTHETIC_SHARED_A/.test(await feed().innerText()), 'Historical member lines only');
  await search.fill('saved-history-no-match'); await until(async () => await feed().locator('[data-feed-id]').count() === 0, 'No line matches');
  await page.locator('#room-summary').click(); await page.locator('#room-stream').click();
  assert.equal(await search.inputValue(), 'saved-history-no-match'); assert.equal(await person(c).getAttribute('aria-pressed'), 'true');
  await search.fill(''); await person(c).click();
  // The members' own 22 replies each are newer, so the two shared lines are past the first page: find them by their words.
  await until(async () => await person(c).getAttribute('aria-pressed') === 'false' && await feed().locator('[data-feed-id]').count() > 2, 'Every line again');
  await search.fill('SYNTHETIC_SHARED');
  await until(async () => /SYNTHETIC_SHARED_A/.test(await feed().innerText()) && /SYNTHETIC_SHARED_C/.test(await feed().innerText()), 'Both shared exchanges');
  assert.equal(await page.locator('#shared-input').inputValue(), roomDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient);
  record('Historical filter is explicit, its words stay across tabs, and clearing it preserves recipient and unsent room draft');
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
  // 相关往来 opens the 信息流 on this member (space-feed.js showPerson); the 成员 tab still names it and is the way back.
  await until(async () => await onTab('#room-stream') && await person(a).getAttribute('aria-pressed') === 'true', 'Feed on Route A'); assert.match(await memberTab().innerText(), /Route A/);
  assert.match(await feed().innerText(), /SYNTHETIC_SHARED_A/); assert.doesNotMatch(await feed().innerText(), /SYNTHETIC_SHARED_C|SYNTHETIC_PRIVATE|OTHER_MEMBER_UPDATE/);
  assert.equal(await search.inputValue(), 'SYNTHETIC_SHARED', 'The search words stay');
  assert.equal(await page.locator('#shared-input').inputValue(), roomDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient); await visibleStates([a, b, d]); await capture('02-related-shared-exchanges');
  await memberTab().click(); await page.locator('#member-related-records').waitFor(); await settle();
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private A route draft'); assert.ok(Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - top) < 3);
  assert.equal(await page.evaluate(() => getSelection().toString()), selected); assert.deepEqual(await page.locator('#message-input').evaluate(el => [el.selectionStart, el.selectionEnd]), [3, 9]);
  assert.deepEqual(controls(await fixture('stats')), before); assert.deepEqual(identity(await snapshot()), ids);
  record('Member/related/return preserves original text selection, reading, caret, both drafts, recipient and native identities without input/control/send');
  await showTerminal(); await page.locator('#native-pane').waitFor(); await fixture('output', a, { data: 'SYNTHETIC_NATIVE_A\r\n' }); await settle();
  const terminalIdentity = await page.locator('#terminal-area .terminal-surface').evaluate(el => { window.__routeTerminal = el; return el.dataset.sessionId || ''; });
  const afterExplicitNative = controls(await fixture('stats')); await page.locator('#member-related-records').click();
  // R248 ①: a reopened window lands on the 总览 with no member open, not on the last view; the 成员 tab returns to
  // the member it names in its saved native mode.
  await until(async () => { const view = (await snapshot()).viewState.roomViews?.shared; return view?.roomMemberChoice === a && view.roomMemberViews?.[a]?.mode === 'terminal'; }, 'Member and its native mode persisted');
  await page.reload(); await page.locator('#space-summary').waitFor(); assert.equal(await onTab('#room-summary'), true);
  await page.locator('#room-stream').click(); await search.fill('SYNTHETIC_SHARED_A'); await until(async () => /SYNTHETIC_SHARED_A/.test(await feed().innerText()), 'Shared line after reload'); assert.equal(await page.locator('#shared-input').inputValue(), roomDraft);
  assert.match(await memberTab().innerText(), /Route A/); await memberTab().click(); await page.locator('#native-pane').waitFor(); assert.equal(await page.locator('#terminal-tab').evaluate(el => el.classList.contains('active')), true);
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private A route draft'); assert.deepEqual(identity(await snapshot()), ids); assert.deepEqual(controls(await fixture('stats')), afterExplicitNative);
  await capture('03-reload-return-native-mode'); record('Reload lands on the 总览 (R248 ①); the 成员 tab returns the member in its native mode with both drafts and identities; passive restore never claims or sends');
  const otherSpace = await page.evaluate(() => workspace.spaceCreate('SYNTHETIC_OTHER_ROUTE')); await page.locator(`#additional-spaces [data-space-id="${otherSpace}"] .room-nav`).click(); await page.locator('#room-nav').click(); await page.locator('#space-summary').waitFor(); await memberTab().click(); await page.locator('#native-pane').waitFor(); assert.equal(await page.locator('#terminal-tab').evaluate(el => el.classList.contains('active')), true); assert.equal(await page.locator('#shared-input').inputValue(), roomDraft); assert.equal(await page.locator('#recipient').inputValue(), recipient); assert.deepEqual(controls(await fixture('stats')), afterExplicitNative);
  record('Switching through an empty second space preserves the first space saved member/native mode and drafts without a native claim');
  await tab(b).click(); assert.equal(await page.locator('#message-input').isEditable(), true); assert.equal(await page.locator('#send-button').isDisabled(), true); assert.equal(await page.locator('#message-input').inputValue(), permissionBefore.draft); assert.deepEqual((await snapshot()).sessions.find(s => s.id === b).approvals.map(r => r.requestId), permissionBefore.requests); assert.ok((await tab(b).getAttribute('aria-label')).includes('待'));
  await tab(a).click(); await page.locator('#native-pane').waitFor(); assert.deepEqual(controls(await fixture('stats')), afterExplicitNative);
  const e = await create('Route E with a longer readable member name', 'claude'); await page.locator('#room-nav').click(); await openTab(a);
  await page.locator('#chat-tab').click(); await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(850, 600)); await settle(); await visibleStates([a, b, d, e]); await capture('04-narrow-four-member-states');
  // Rejoin the same historical logical/native pair; this is the owned fixture,
  // not a migration or a provider/native session creation.
  await page.evaluate(async id => { const s = (await workspace.initial()).sessions.find(s => s.id === id); await workspace.spaceAction('shared', 'join', [id, true, { nativeId: s.nativeId, placementRevision: s.placementRevision || 0, connectionRevision: s.connectionRevision || 0 }]); }, c);
  await until(() => row(c).evaluate(el => el.classList.contains('in-current-space')), 'Fifth existing member row'); await visibleStates([a, b, c, d, e]);
  const geometry = await page.evaluate(() => ({ chatHeight: document.getElementById('messages').clientHeight, privateBottom: document.getElementById('composer-wrap').getBoundingClientRect().bottom, viewport: innerHeight, font: getComputedStyle(document.getElementById('message-input')).fontSize }));
  assert.ok(geometry.chatHeight >= 80); assert.ok(geometry.privateBottom <= geometry.viewport + 1); assert.equal(geometry.font, '14px'); await capture('05-narrow-five-member-states');
  record('Permission/input guards survive tab changes; four/five member statuses remain visible at850x600 with reading and14px private draft');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860)); await openTab(a); await page.locator('#member-related-records').click(); await detach(a);
  // R248 ②: no 返回 button is left. The 成员 tab no longer names the departed member and does not open it.
  await until(async () => !(await memberTab().innerText()).includes('Route A') && !(await row(a).evaluate(el => el.classList.contains('in-current-space'))), 'Departed member is not returned to');
  assert.match(await feed().innerText(), /SYNTHETIC_SHARED_A/);
  await memberTab().click(); await until(async () => { const view = (await snapshot()).viewState; return view.roomSession && view.roomSession !== a; }, 'The 成员 tab opens a current member');
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
