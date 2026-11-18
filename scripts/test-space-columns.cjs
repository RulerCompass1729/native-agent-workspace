// Space navigation through the actual renderer, preload and synthetic service. No model or real native runtime.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'An outside-repository screenshot directory is required');
assert.ok(process.env.HOME && fs.realpathSync(process.env.HOME) !== fs.realpathSync(os.userInfo().homedir), 'Use an explicit isolated HOME');
const gitEnv = { ...process.env }; delete gitEnv.GIT_ASKPASS;
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();
for (const repository of [root, path.dirname(common)]) assert.ok(!path.resolve(evidence).startsWith(repository + path.sep), 'Private evidence stays outside the repository');
const slot = path.resolve(common, '../.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no GUI or service started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex B', task: 'space members as columns', token, pid: process.pid }));
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs'), { createIn } = require('./fixtures/create-view.cjs'), locale = require('../app/ui-locale.js');
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-space-columns-'));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'].includes(key))), NAW_DATA_DIR: profile, NAW_WORKSPACE: path.join(profile, 'work'), NAW_TEST_APP_ROOT: root, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh', NAW_TEST_VISIBLE: '0', NAW_APP_VERSION: require('../package.json').version };
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
let app, page, client, seq = 0, errors = ''; const checks = [], shots = [];
child.stderr.on('data', data => { errors += data; }); const closed = new Promise(resolve => child.once('close', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 240; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.off('message', read); reject(Error('Fixture timeout: ' + method)); }, 10000); const read = r => { if (r.requestId === id) { clearTimeout(timer); child.off('message', read); resolve(r); } }; child.on('message', read); child.send({ id, method, target, value }); }); }
const check = label => { checks.push(label); console.log('PASS:', label); };
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await delay(120); }
const cleanup = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { try { await client.call('shutdown'); } catch {} client.close(); client = null; }
  if (child.exitCode === null && child.signalCode === null) { await Promise.race([closed, delay(1500)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  await closed;
});
async function run() {
  fs.mkdirSync(path.join(evidence, 'images'), { recursive: true });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service'); client = await connect(profile, 'columns-gui-person'); scratch.ownService(profile);
  const ids = [], providers = ['claude', 'codex'];
  for (let i = 0; i < 10; i++) {
    const id = await client.call('create', { name: i < 8 ? `Demo · ${providers[i % 2]} ${i + 1}` : i === 8 ? 'Independent demo' : 'Synthetic steward', provider: providers[i % 2], cwd: path.join(profile, 'work'), view: 'chat' }); ids.push(id);
    await fixture('history', id, [{ id: 'reply-' + i, type: 'agentMessage', turnId: 'demo-' + i, text: 'Synthetic content. No task was sent.\n\n' + Array.from({ length: 80 }, (_, n) => `Paragraph ${n + 1}: retained native session identity.`).join('\n\n') }]);
    await client.call('draft', id, 'Private unsent draft ' + i);
  }
  const steward = (await client.call('initial')).sessions.find(s => s.id === ids[9]);
  fs.writeFileSync(path.join(profile, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: steward.id, nativeId: steward.nativeId } }), { mode: 0o600 });
  const sourceEntry = require('./fixtures/synthetic-source-boot.cjs').createSourceEntry({ profile, code: root, fixturePid: child.pid });
  app = await _electron.launch({ executablePath: require('electron'), args: [sourceEntry], env, timeout: 60000 }); page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.locator('#new-session').waitFor(); if (await page.locator('#setup-dialog').isVisible()) await page.keyboard.press('Escape');
  await require('./fixtures/default-space.cjs').revealDefaultSpace(page);
  assert.ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focused: win.isFocused() })))).every(win => !win.visible && !win.focused)); check('Hidden, unfocused source window with fake HOME');
  const room = await page.evaluate(() => workspace.spaceCreate('Demo'));
  for (const id of ids.slice(0, 8)) await page.evaluate(({ room, id }) => workspace.spaceAction(room, 'join', [id, true]), { room, id });
  async function enter() {
    if (await page.locator('#spaces-nav').isVisible()) {
      await page.locator('#spaces-nav').click(); await page.getByRole('menuitem', { name: locale.format('zh', 'navigation.spaceItem', { name: 'Demo', count: 8 }), exact: true }).click();
    } else await page.locator(`.room-row[data-space-id="${room}"] .room-nav`).click();
    await page.locator('#room-overview').click(); await settle();
  }
  await enter();
  for (let n = 0; n < 20; n++) { const pending = (await fixture()).pending; if (!pending.length) break; await fixture('release', pending[0]); }
  await settle();
  const original = (await client.call('initial')).sessions.map(s => ({ id: s.id, nativeId: s.nativeId, provider: s.provider, roomIds: s.roomIds }));
  assert.equal(await page.locator('#room-member-tabs button:visible').count(), 0);
  assert.equal(await page.locator('.collaboration-member-chip:visible').count(), 0);
  assert.equal(await page.locator('#sessions-group:visible, #workspace-group:visible, #session-view-switch:visible').count(), 0);
  assert.equal(await page.locator('.collaboration-name-text').first().textContent(), 'claude 1');
  assert.ok((await page.locator('.collaboration-member-name').first().getAttribute('aria-label')).includes('Demo · claude 1')); check('One member list: column names only, short visible aliases retain full accessible identity');
  const { chooseRecipient, fillRoomMessage, roomBody } = require('./room-input.cjs');
  await chooseRecipient(page, ids[6]); await fillRoomMessage(page, 'Shared unsent draft');
  await page.locator('#switch-space').click(); await page.getByRole('menuitem', { name: locale.format('zh', 'navigation.spaceItem', { name: 'Demo', count: 8 }), exact: true }).waitFor({ state: 'visible' }); await page.screenshot({ path: path.join(evidence, 'images', 'space-menu.png'), scale: 'css' }); await page.keyboard.press('Escape');
  await page.locator('#independent-nav').click();
  const itemText = await page.getByRole('menuitem').allTextContents(); assert.equal(itemText.length, 1); assert.ok(itemText[0].includes('Independent demo'));
  await page.screenshot({ path: path.join(evidence, 'images', 'independent-menu.png'), scale: 'css' });
  await page.getByRole('menuitem').click(); await page.locator('#message-input').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#message-input').inputValue(), 'Private unsent draft 8'); check('Independent menu excludes all space members and the butler; original private draft survives');
  await enter(); assert.equal(await roomBody(page), 'Shared unsent draft'); assert.equal(await page.locator('#recipient').inputValue(), ids[6]); check('Space draft and exact recipient scope survive leaving and returning');
  await page.locator('#spaces-nav').click(); await page.getByRole('menuitem', { name: locale.format('zh', 'navigation.spaceItem', { name: '共同工作', count: 0 }), exact: true }).click();
  await until(async () => (await page.evaluate(() => workspace.initial())).viewState.spaceId === 'shared', 'Default space selected through rail');
  await enter(); assert.equal(await roomBody(page), 'Shared unsent draft'); assert.equal(await page.locator('#recipient').inputValue(), ids[6]); check('Switching to another space and back keeps each space draft and addressed member');
  await page.locator('#room-header-more').click(); await page.getByRole('menuitem', { name: locale.format('zh', 'menu.rename'), exact: true }).click(); await page.locator('#rename-name').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.header-identity #rename-editor').count(), 1); assert.equal(await page.locator('#sessions-group').isVisible(), false);
  await page.locator('#rename-name').fill('Unsent space name'); await page.screenshot({ path: path.join(evidence, 'images', 'space-rename.png'), scale: 'css' }); await page.locator('#cancel-rename').click();
  assert.equal(await page.locator('#title').textContent(), 'Demo'); check('Space rename opens the same editor in the title, cancellation leaves name and rail intact');
  await page.locator('.steward-slot .session-link').click(); await page.locator('#message-input').waitFor({ state: 'visible' }); assert.equal(await page.locator('#message-input').inputValue(), 'Private unsent draft 9');
  await enter(); check('Existing butler route stays reachable without a duplicate member list or a new native session');
  await page.locator(`.collaboration-member-status[data-member-id="${ids[0]}"] .collaboration-member-name`).click();
  await page.locator('#conversation-pane-toolbar #room-member-tabs button').waitFor({ state: 'visible' }); assert.equal(await page.locator('#room-tabs #room-member-tabs').count(), 0);
  assert.equal(await page.locator('#room-member-tabs button').count(), 1);
  assert.equal(await page.locator('#message-input').inputValue(), 'Private unsent draft 0');
  await page.locator('#open-native-terminal').click(); await page.locator('#native-pane').waitFor({ state: 'visible' });
  if ((await fixture()).pending.includes(ids[0])) await fixture('release', ids[0]);
  assert.ok((await page.locator('#native-pane-title').textContent()).includes('Demo · claude 1'));
  await page.screenshot({ path: path.join(evidence, 'images', 'focused-member.png'), scale: 'css' });
  await page.locator('#close-native-terminal').click(); await page.locator('#collaboration-overview').waitFor({ state: 'visible' });
  await page.locator(`.collaboration-member-status[data-member-id="${ids[0]}"] .collaboration-member-name`).click(); await page.locator('#room-member-tabs button').click(); await page.locator('#collaboration-overview').waitFor({ state: 'visible' }); check('Current member heading, native terminal open/close, and return to overview reuse existing routes');
  await fixture('native-permission', ids[0], { requests: [{ id: 'synthetic-permission' }] });
  await until(async () => (await client.call('initial')).sessions.find(s => s.id === ids[0]).state === 'approval', 'Permission fixture');
  await page.locator('#room-record').click(); await page.locator('#room-overview').click();
  assert.equal((await client.call('initial')).sessions.find(s => s.id === ids[0]).state, 'approval'); assert.equal((await fixture()).inputs.length, 0); check('Navigation does not approve, clear or type through a pending native permission');
  await fixture('native-permission', ids[0], null); await fixture('state', ids[0]);
  for (const lang of ['zh', 'en']) {
    if (lang === 'en') { await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(lang); await page.waitForFunction(value => document.querySelector('#new-session').getAttribute('aria-label') === value, locale.format(lang, 'sidebar.newSession')); await page.keyboard.press('Escape'); }
    for (const theme of ['light', 'dark']) {
      await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme); await page.emulateMedia({ colorScheme: theme });
      for (const width of [1280, 1600]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().forEach(win => win.setContentSize(width, 900)), width); await page.locator('#room-overview').click(); await settle();
        await page.locator('.collaboration-readers').evaluate(e => e.scrollTop = 0); await settle();
        await page.screenshot({ path: path.join(evidence, 'images', `${lang}-${theme}-${width}-top.png`), scale: 'css' });
        for (let n = 0; n < 8 && !await page.locator(`.collaboration-member-status[data-member-id="${ids[6]}"]`).isVisible(); n++) { await page.locator('.collaboration-show-more').click(); await settle(); }
        const sticky = await page.evaluate(() => {
          const outer = document.querySelector('.collaboration-readers'), head = document.querySelector('.collaboration-member-status');
          outer.scrollLeft = Math.min(120, outer.scrollWidth - outer.clientWidth);
          const u = head.closest('.collaboration-member-unit').getBoundingClientRect(), r = head.getBoundingClientRect();
          return { scrollLeft: outer.scrollLeft, leftDelta: r.left - u.left, rightDelta: r.right - u.right };
        });
        assert.equal(sticky.leftDelta, 0); assert.equal(sticky.rightDelta, 0);
        await page.locator('.collaboration-readers').evaluate(e => e.scrollLeft = 0);
        const target = page.locator(`.collaboration-member-status[data-member-id="${ids[6]}"]`); await target.scrollIntoViewIfNeeded();
        const metrics = await page.evaluate(() => ({ width: innerWidth, hiddenMemberLists: document.querySelectorAll('#room-member-tabs button').length === 0 && [...document.querySelectorAll('.collaboration-member-chip')].every(e => !e.getClientRects().length), names: [...document.querySelectorAll('.collaboration-member-unit:not([hidden]) .collaboration-name-text')].map(e => ({ name: e.textContent, width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height, clipped: e.scrollWidth > e.clientWidth + 1, accessible: e.closest('.collaboration-member-name').getAttribute('aria-label'), title: e.closest('.collaboration-member-name').title })), menu: document.getElementById('switch-space').getBoundingClientRect().toJSON(), rail: [...document.querySelectorAll('#space-rail-routes button')].map(e => ({ width: e.clientWidth, contents: e.scrollWidth, display: getComputedStyle(e).display })) }));
        assert.equal(metrics.hiddenMemberLists, true); assert.ok(metrics.names.length >= 7);
        // Paging may shorten names to keep the state readable; full identity must remain available.
        assert.ok(metrics.names.every(n => n.width >= 40 && n.height >= 12 && n.accessible.includes(n.name) && n.title.includes(n.name)), 'Visible name fragments and full accessible/hover identities are retained');
        assert.ok(metrics.menu.width > 0 && metrics.menu.x >= 0 && metrics.menu.right <= width);
        assert.ok(metrics.rail.every(button => button.display === 'grid' && button.contents <= button.width + 1), 'Rail controls fit without wrapping or overflow');
        const key = `${lang}-${theme}-${width}`; await page.screenshot({ path: path.join(evidence, 'images', key + '.png'), scale: 'css' }); shots.push({ key, ...metrics, sticky }); check(key + ': target 7 visible, readable names with full accessible identity, one member list, aligned heading, rail labels fit');
      }
    }
  }
  await page.locator('#switch-space').focus(); await page.keyboard.press('Enter'); await page.getByRole('menuitem', { name: locale.format('en', 'navigation.spaceItem', { name: 'Demo', count: 8 }), exact: true }).waitFor({ state: 'visible' }); await page.keyboard.press('Escape'); assert.equal(await page.evaluate(() => document.activeElement.id), 'switch-space'); check('Space title menu is keyboard reachable and Escape restores focus');
  const after = (await client.call('initial')).sessions.map(s => ({ id: s.id, nativeId: s.nativeId, provider: s.provider, roomIds: s.roomIds })); assert.deepEqual(after, original);
  const stats = await fixture(); assert.equal(stats.sends.length, 0); assert.equal(stats.inputs.length, 0); assert.deepEqual(pageErrors, []);
  check('All 10 original native identities, providers and memberships unchanged; models/sends/terminal writes zero');
  fs.writeFileSync(path.join(evidence, 'gui-checks.json'), JSON.stringify({ pass: checks.length, fail: 0, pids: { main: app.process().pid, backend: child.pid }, hiddenWindows: 1, models: 0, sends: 0, inputs: 0, checks, shots, pageErrors }, null, 2));
  console.log(`GUI ${checks.length}/0; ${shots.length} screenshots; models/sends/inputs 0`);
}
run().catch(error => { console.error(error.stack); console.error(errors); process.exitCode = 1; }).finally(async () => { try { await cleanup(); } finally { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true }); } }).catch(error => { console.error(error.stack); process.exitCode = 1; });
