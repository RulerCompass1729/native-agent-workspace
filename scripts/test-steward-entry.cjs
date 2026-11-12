// The butler the person talks to (大管家), step 1: its entry at the top of the sidebar, designating, changing and
// revoking it, and where the window lands when the app starts. Actual isolated source GUI and NAW's own backend
// service; only native output is synthetic (the transport fixture). No native program is started and no model is
// called. The designation gives the session nothing: this script checks places, lists and words, not powers.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const scratch = require('./fixtures/test-scratch.cjs'), { createIn } = require('./fixtures/create-view.cjs'), { joinSpace } = require('./fixtures/space-membership.cjs');
const { _electron } = scratch.playwright(require('playwright'));
const locale = require('../app/ui-locale.js');
const root = path.resolve(__dirname, '..');
if (!process.env.NAW_APP_EXECUTABLE) scratch.childProcess.execFileSync(process.execPath, [path.join(root, 'scripts/build-ui.cjs')]);
const evidence = process.env.NAW_EVIDENCE_DIR || path.join(scratch.directory(path.join(os.tmpdir(), 'naw-steward-entry-evidence-')), 'evidence'); fs.mkdirSync(evidence, { recursive: true });
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-steward-entry-'));
const workspacePath = path.join(profile, 'workspace'); fs.mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
const env = { ...process.env }; for (const key of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'NAW_RUNTIME_CONFIG', 'DEEPSEEK_API_KEY', 'NAW_TEST_BUTLER_ENTRY']) delete env[key];
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], {
  execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')],
  env: { ...env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: workspacePath, NAW_APP_VERSION: require(path.join(root, 'package.json')).version },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
let app, page, sequence = 0;
const errors = [], checks = [], shots = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, tries = 240) { for (let i = 0; i < tries; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const callback = reply => { if (reply.requestId === id) { clearTimeout(timer); child.off('message', callback); reply.error ? reject(Error(reply.error)) : resolve(reply); } };
    const timer = setTimeout(() => { child.off('message', callback); reject(Error('Fixture timed out')); }, 12000);
    child.on('message', callback); child.send({ id, method, target, value });
  });
}
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
}
const snapshot = () => page.evaluate(() => workspace.initial());
async function create(name, provider) {
  const previous = new Set((await snapshot()).sessions.map(s => s.id));
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  return (await snapshot()).sessions.find(s => s.name === name && !previous.has(s.id)).id;
}
async function size(width, height) {
  await (await app.browserWindow(page)).evaluate((win, [w, h]) => win.setContentSize(w, h), [width, height]);
  await until(() => page.evaluate(w => innerWidth === w, width), `Window ${width} wide`); await delay(400);
}
async function language(value) {
  await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(value);
  await until(async () => await page.locator('#ui-language').getAttribute('aria-busy') === 'false' && await page.locator('#setup-title').innerText() === locale.format(value, 'common.settings'), 'The interface follows the language');
  await page.locator('#close-setup').click(); await page.locator('#setup-dialog').waitFor({ state: 'hidden' });
}
const shot = async name => { await delay(150); await page.screenshot({ path: path.join(evidence, name + '.png') }); shots.push(name); };
const record = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'steward.json'), 'utf8')).selected; } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
// What the sidebar shows about the butler and the lists, read from the page as a person would see it.
const sidebar = () => page.evaluate(() => {
  const shown = el => Boolean(el) && !el.hidden && el.getClientRects().length > 0, empty = document.getElementById('steward-empty'), row = document.querySelector('#steward-slot .session-row');
  return { empty: shown(empty) ? empty.innerText.replace(/\s+/g, ' ').trim() : null, emptyLabel: shown(empty) ? empty.getAttribute('aria-label') : null,
    butler: row && shown(row) ? { id: row.querySelector('.session-link').dataset.sessionId, title: row.querySelector('.session-title').textContent, status: row.querySelector('.session-metadata small').textContent, icon: row.querySelector('.agent-icon').firstChild.textContent, active: row.classList.contains('active'),
      label: row.querySelector('.session-link').getAttribute('aria-label'), draggable: row.querySelector('.session-link').getAttribute('draggable') } : null,
    listed: [...document.querySelectorAll('#session-list .session-row')].map(el => el.dataset.sessionRow), count: document.getElementById('session-group-summary').textContent,
    order: [...document.querySelector('.sidebar').children].map(el => el.id || el.className).slice(0, 4), builtIn: shown(document.getElementById('butler-row')),
    title: document.getElementById('title').textContent, badge: shown(document.getElementById('steward-badge')) ? document.getElementById('steward-badge').textContent : null };
});
const call = (method, ...args) => page.evaluate(([name, values]) => window.workspace[name](...values).then(value => ({ value }), error => ({ refused: error.message })), [method, args]);
const menuItems = () => page.getByRole('menuitem').allTextContents();
const closeMenu = async () => { await page.keyboard.press('Escape'); await delay(120); };
const select = async id => { await page.locator(`.session-row .session-link[data-session-id="${id}"]`).first().click(); await delay(250); };

(async () => {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Own fixture ready');
  await launch(); await size(1280, 800);
  const say = (key, params) => locale.format('zh', key, params);
  const dialog = page.locator('#steward-dialog'), picks = () => dialog.locator('.steward-pick').evaluateAll(rows => rows.map(row => [row.querySelector('strong').textContent, row.querySelector('small').textContent, row.querySelector('input').disabled, row.querySelector('input').checked]));

  // 1. A new profile: the entry is at the top of the sidebar and says nobody is designated. The built-in butler's own
  //    row stays hidden (its switch is closed). The chooser has nobody to offer and says what to do.
  let seen = await sidebar();
  assert.deepEqual([seen.empty, seen.emptyLabel, seen.butler, seen.builtIn, seen.badge], [`${say('butler.name')} ${say('butler.row.empty')}`, say('steward.emptyLabel'), null, false, null]);
  assert.deepEqual(seen.order, ['brand', 'steward-entry', 'butler-row', 'new-session'], 'The entry sits right under the brand, above everything else');
  assert.equal(record(), undefined, 'Nothing is written before the person designates');
  await page.locator('#steward-empty').click(); await dialog.waitFor({ state: 'visible' });
  assert.deepEqual([await picks(), await page.locator('#steward-none').innerText(), await page.locator('#steward-confirm').isDisabled()], [[], say('steward.choose.none'), true]);
  await page.locator('#steward-cancel').click(); await dialog.waitFor({ state: 'hidden' });
  checks.push('With nobody designated the entry is at the top of the sidebar and says so; the built-in butler row stays hidden; the chooser says there is no session to choose');

  // The cast: a space with one member, and two sessions of the person's own.
  await page.locator('#create-first-space').click(); await page.locator('#space-create-name').fill('网站改版'); await page.locator('#confirm-space-create').click(); await page.locator('#space-create-dialog').waitFor({ state: 'hidden' });
  const member = await create('Claude 前端', 'claude'); await joinSpace(page);
  const main = await create('Claude 主会话', 'claude');
  await fixture('history', main, [
    { id: 'u1', type: 'userMessage', turnId: 't1', content: [{ type: 'text', text: '把今天交上来的两件合进去。' }] },
    { id: 'a1', type: 'agentMessage', turnId: 't1', text: '两件都已合入，全量测试通过。' }]);
  const docs = await create('Codex 文档', 'codex');
  const all = (await snapshot()).sessions, spaceId = all.find(s => s.id === member).roomIds[0], nativeOf = id => all.find(s => s.id === id).nativeId;
  seen = await sidebar(); assert.deepEqual([seen.listed, seen.count], [[member, main, docs], '3']);

  // 2. Designating from the entry: the chooser lists the person's sessions, says why the member cannot be chosen,
  //    and nothing changes until the person confirms.
  await page.locator('#steward-empty').click(); await dialog.waitFor({ state: 'visible' });
  const ready = say('state.idle') && (await page.locator(`#session-list .session-row[data-session-row="${docs}"] .session-metadata small`).innerText());
  assert.deepEqual(await picks(), [['Claude 前端', say('steward.choose.inSpace', { space: '网站改版' }), true, false], ['Claude 主会话', ready, false, false], ['Codex 文档', ready, false, false]]);
  assert.equal((await dialog.locator('.butler-note').innerText()).trim(), say('steward.choose.intro')); assert.equal(await page.locator('#steward-confirm').isDisabled(), true);
  await shot('zh-1280-chooser');
  await dialog.locator(`input[value="${main}"]`).check(); assert.equal(await page.locator('#steward-confirm').isDisabled(), false); assert.equal(record(), undefined, 'Choosing is not designating');
  await page.locator('#steward-confirm').click(); await dialog.waitFor({ state: 'hidden' });
  await until(async () => (await sidebar()).butler?.id === main, 'The butler\'s row is in the entry\'s place');
  seen = await sidebar();
  assert.deepEqual(seen.butler, { id: main, title: say('butler.name'), status: say('steward.rowStatus', { name: 'Claude 主会话', status: ready }), icon: '◆', active: true, label: seen.butler.label, draggable: null });
  assert.ok(seen.butler.label.startsWith(say('steward.rowLabel', { details: 'Claude 主会话 · Claude · ' })), seen.butler.label);
  assert.deepEqual([seen.empty, seen.listed, seen.count, seen.title, seen.badge], [null, [member, docs], '2', 'Claude 主会话', '◆ ' + say('butler.name')], 'It left the list, the count follows, and the window shows its conversation with the mark');
  assert.deepEqual(record(), { sessionId: main, nativeId: nativeOf(main) }); assert.deepEqual((await snapshot()).steward, { sessionId: main, nativeId: nativeOf(main) });
  assert.equal((await page.locator('#messages').innerText()).includes('两件都已合入，全量测试通过。'), true, 'The conversation is the session\'s own');
  await shot('zh-1280-butler');
  checks.push('Designating from the entry: the chooser lists the sessions and why a space member cannot be chosen; after confirming, the session is the row at the top named for the butler, it is no longer among Sessions, the window shows its own conversation with the mark, and the record holds only its two ids');

  // 3. The entry is the conversation: from another session, one click on the row comes back to it.
  await select(docs); seen = await sidebar(); assert.deepEqual([seen.title, seen.badge, seen.butler.active], ['Codex 文档', null, false]);
  await page.locator('#steward-slot .session-link').click(); await until(async () => (await sidebar()).title === 'Claude 主会话', 'The row opens the butler\'s conversation');
  assert.equal((await sidebar()).butler.active, true);
  checks.push('From another session, the row at the top opens the butler\'s conversation');

  // 4. Its menus: change and revoke are offered on it; reordering and spaces are not. On another session,
  //    "make it the butler" stands above the secretary's item; a space member is not offered it.
  await page.locator('#session-header-more').click(); let items = await menuItems(); await shot('zh-1280-butler-menu'); await closeMenu();
  assert.deepEqual(items.slice(0, 4), [say('header.share'), say('header.usage'), say('menu.stewardChange'), say('menu.stewardRevoke')], 'No space to join; change and revoke');
  await page.locator('#steward-slot .session-row').click({ button: 'right' }); items = await menuItems(); await closeMenu();
  for (const key of ['menu.stewardChange', 'menu.stewardRevoke', 'menu.rename', 'menu.archiveSession']) assert.ok(items.includes(say(key)), key);
  for (const text of [say('menu.moveUp'), say('menu.moveDown'), say('menu.stewardSet'), say('menu.joinSpace', { name: '网站改版' })]) assert.equal(items.includes(text), false, text);
  await page.locator(`#session-list .session-row[data-session-row="${docs}"]`).click({ button: 'right' }); items = await menuItems(); await shot('zh-1280-session-menu'); await closeMenu();
  assert.ok(items.indexOf(say('menu.stewardSet')) >= 0 && items.indexOf(say('menu.stewardSet')) < items.indexOf(say('menu.queueSecretarySet')), 'Offered above the secretary\'s item');
  await page.locator(`#session-list .session-row[data-session-row="${member}"]`).click({ button: 'right' }); items = await menuItems(); await closeMenu();
  assert.equal(items.includes(say('menu.stewardSet')), false, 'A space member is not offered the designation');
  // Renaming it from its row renames the session; the row is still named for the butler and says the new name below.
  await page.locator('#steward-slot .session-row').click({ button: 'right' }); await page.getByRole('menuitem', { name: say('menu.rename'), exact: true }).click();
  await page.locator('#rename-name').fill('主线'); await page.locator('#confirm-rename').click();
  await until(async () => (await sidebar()).butler?.status === say('steward.rowStatus', { name: '主线', status: ready }), 'The row follows the new name');
  seen = await sidebar(); assert.deepEqual([seen.butler.title, seen.title, seen.listed], [say('butler.name'), '主线', [member, docs]]);
  await page.locator('#steward-slot .session-row').click({ button: 'right' }); await page.getByRole('menuitem', { name: say('menu.rename'), exact: true }).click();
  await page.locator('#rename-name').fill('Claude 主会话'); await page.locator('#confirm-rename').click();
  await until(async () => (await sidebar()).title === 'Claude 主会话', 'Renamed back');
  checks.push('The butler\'s menus offer change and revoke and no reordering or spaces; another session of the person\'s is offered "make it the butler" above the secretary\'s item, a space member is not; renaming the butler from its row renames the session and the row stays named for the butler');

  // 5. The rules the main process holds, whatever the window offers: a member cannot be designated, an unknown
  //    session cannot, the butler cannot be joined to a space, and each refusal changes nothing.
  assert.deepEqual(await call('steward', member), { refused: say('error.steward.inSpace') });
  assert.deepEqual(await call('steward', 'no-such-session'), { refused: say('error.steward.invalid') });
  assert.deepEqual(await call('spaceAction', spaceId, 'join', [main, true]), { refused: say('error.steward.joinSpace') });
  assert.deepEqual(await call('join', main, true), { refused: say('error.steward.joinSpace') });
  assert.deepEqual(record(), { sessionId: main, nativeId: nativeOf(main) }); assert.deepEqual((await snapshot()).sessions.find(s => s.id === main).roomIds || [], [], 'The butler is still outside every space');
  // The header's own join control is switched off for the butler (its hidden property, whatever the layout shows), and on for another session.
  const joinControl = () => page.evaluate(() => [...document.querySelectorAll('#header-actions > .header-secondary')].filter(control => control.dataset.action).map(control => control.hidden));
  assert.deepEqual(await joinControl(), [true]); await select(docs); assert.deepEqual(await joinControl(), [false]); await select(main);
  checks.push('The main process refuses to designate a space member or an unknown session, and to join the butler to a space; nothing changes');

  // 6. Changing: the chooser marks who is the butler now; choosing it again is not a change; choosing another
  //    session moves the designation, and the earlier one is back among Sessions.
  await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: say('menu.stewardChange'), exact: true }).click(); await dialog.waitFor({ state: 'visible' });
  assert.deepEqual((await picks())[0], ['Claude 主会话', say('steward.choose.current'), false, true]); assert.equal(await page.locator('#steward-confirm').isDisabled(), true);
  await dialog.locator(`input[value="${docs}"]`).check(); await page.locator('#steward-confirm').click(); await dialog.waitFor({ state: 'hidden' });
  await until(async () => (await sidebar()).butler?.id === docs, 'The designation moved');
  seen = await sidebar(); assert.deepEqual([seen.listed, seen.count, seen.title, seen.butler.status], [[member, main], '2', 'Codex 文档', say('steward.rowStatus', { name: 'Codex 文档', status: ready })]);
  assert.deepEqual(record(), { sessionId: docs, nativeId: nativeOf(docs) });
  // And from a session's own menu, without the chooser.
  await page.locator(`#session-list .session-row[data-session-row="${main}"]`).click({ button: 'right' }); await page.getByRole('menuitem', { name: say('menu.stewardSet'), exact: true }).click();
  await until(async () => (await sidebar()).butler?.id === main, 'Designated from the session\'s menu');
  assert.deepEqual((await sidebar()).listed, [member, docs]);
  checks.push('Changing from the butler\'s menu and designating from a session\'s menu both move the designation; the earlier butler is back among Sessions');

  // 7. Small window and English: the row is the first thing in the narrow rail, and the words follow the language.
  await select(main); await size(850, 600);
  const rail = await page.evaluate(() => { const row = document.querySelector('#steward-slot .session-row').getBoundingClientRect(), next = document.getElementById('new-session').getBoundingClientRect(), side = document.querySelector('.sidebar').getBoundingClientRect();
    return { inside: row.left >= side.left && row.right <= side.right + 0.5, above: row.bottom <= next.top + 0.5, narrow: side.width < 120, icon: document.querySelector('#steward-slot .agent-icon').getClientRects().length > 0 }; });
  assert.deepEqual(rail, { inside: true, above: true, narrow: true, icon: true }); await shot('zh-850-butler');
  await language('en'); await size(1280, 800);
  seen = await sidebar(); assert.deepEqual([seen.butler.title, seen.badge], [locale.format('en', 'butler.name'), '◆ ' + locale.format('en', 'butler.name')]);
  assert.ok(seen.butler.label.startsWith(locale.format('en', 'steward.rowLabel', { details: 'Claude 主会话 · Claude · ' })));
  await shot('en-1280-butler'); await language('zh');
  checks.push('In the 850 by 600 window the row is the first icon of the narrow rail; in English the row, the mark and the labels are English');

  // 8. Where the window lands when the app starts: on the butler's conversation, whatever was open before; a
  //    reload of the page stays where it was.
  await select(docs); assert.equal((await sidebar()).title, 'Codex 文档'); await delay(400);
  await app.close(); await launch();
  await until(async () => (await sidebar()).title === 'Claude 主会话', 'A new start of the app lands on the butler');
  seen = await sidebar(); assert.deepEqual([seen.butler.id, seen.butler.active, seen.badge], [main, true, '◆ ' + say('butler.name')]);
  await select(docs); await delay(400); await page.reload(); await page.locator('#new-session').waitFor();
  await until(async () => (await sidebar()).title === 'Codex 文档', 'A reload stays where the window was');
  checks.push('A new start of the app lands on the butler\'s conversation though another session was open; a reload of the page stays where it was');

  // 9. Revoking: the entry says nobody is designated again, the session is back among Sessions and keeps running;
  //    with nobody designated a new start goes back to where the window was.
  await select(main); await page.locator('#session-header-more').click(); await page.getByRole('menuitem', { name: say('menu.stewardRevoke'), exact: true }).click();
  await until(async () => (await sidebar()).butler === null, 'Revoked');
  seen = await sidebar(); assert.deepEqual([seen.empty, seen.listed, seen.count, seen.badge, seen.title], [`${say('butler.name')} ${say('butler.row.empty')}`, [member, main, docs], '3', null, 'Claude 主会话']);
  assert.equal(record(), null); assert.equal((await snapshot()).sessions.find(s => s.id === main).state, 'idle', 'The session keeps running');
  await shot('zh-1280-empty');
  await select(docs); await delay(400); await app.close(); await launch();
  await until(async () => (await sidebar()).title === 'Codex 文档', 'With nobody designated the window is where it was');
  assert.equal((await sidebar()).butler, null);
  checks.push('Revoking puts the session back among Sessions, running, and the entry says nobody is designated; with nobody designated a new start of the app is where the window was');

  assert.deepEqual(errors, []);
  const result = { checks, screenshots: shots.length, nativeProgramsStarted: 0, promptsSent: 0, paidModelCalls: 0, evidence };
  fs.writeFileSync(path.join(evidence, 'steward-entry-result.json'), JSON.stringify(result, null, 1)); console.log(JSON.stringify(result));
})().catch(async error => {
  if (page && !page.isClosed()) { fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); }
  console.error(error.stack, '\nEvidence:', evidence); process.exitCode = 1;
}).finally(async () => { await scratch.release().catch(error => { console.error('Cleanup:', error.message); process.exitCode = 1; }); });
