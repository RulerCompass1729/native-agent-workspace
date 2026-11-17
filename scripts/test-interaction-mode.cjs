// One hidden source window and a synthetic provider. No model or real native runtime.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'An outside-repository screenshot directory is required');
const gitEnv = { ...process.env }; delete gitEnv.GIT_ASKPASS;
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();
for (const repository of [root, path.dirname(common)]) assert.ok(!path.resolve(evidence).startsWith(repository + path.sep), 'Private evidence stays outside the repository');
const slot = path.resolve(common, '../.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no GUI or service started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex B', task: 'pane-local interaction modes', token, pid: process.pid }));
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs'), { createIn } = require('./fixtures/create-view.cjs'), locale = require('../app/ui-locale.js');
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-interaction-mode-'));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'].includes(key))), NAW_DATA_DIR: profile, NAW_WORKSPACE: path.join(profile, 'work'), NAW_TEST_APP_ROOT: root, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh', NAW_TEST_VISIBLE: '0', NAW_APP_VERSION: require('../package.json').version };
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
let app, page, client, seq = 0, errors = ''; const checks = [], shots = [];
child.stderr.on('data', data => { errors += data; }); const closed = new Promise(resolve => child.once('close', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 240; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++seq; return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.off('message', read); reject(Error('Fixture timeout: ' + method)); }, 10000); const read = r => { if (r.requestId === id) { clearTimeout(timer); child.off('message', read); resolve(r); } }; child.on('message', read); child.send({ id, method, target, value }); }); }
const check = label => { checks.push(label); console.log('PASS:', label); };
async function settle() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await delay(120); }
async function menu(mode) { await app.evaluate(({ Menu, BrowserWindow }, mode) => { const item = Menu.getApplicationMenu().getMenuItemById(mode === 'chat' ? 'naw-menu-chat' : 'naw-menu-terminal'); if (!item || !item.enabled) throw Error('Missing enabled mode menu'); item.click({}, BrowserWindow.getAllWindows().find(win => !win.isDestroyed())); }, mode); await settle(); }
const cleanup = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { try { await client.call('shutdown'); } catch {} client.close(); client = null; }
  if (child.exitCode === null && child.signalCode === null) { await Promise.race([closed, delay(1500)]); if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
  await closed;
});
async function run() {
  fs.mkdirSync(path.join(evidence, 'images'), { recursive: true });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service'); client = await connect(profile, 'mode-gui-person'); scratch.ownService(profile);
  const sourceEntry = require('./fixtures/synthetic-source-boot.cjs').createSourceEntry({ profile, code: root, fixturePid: child.pid });
  app = await _electron.launch({ executablePath: require('electron'), args: [sourceEntry], env, timeout: 60000 }); page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.locator('#new-session').waitFor(); if (await page.locator('#setup-dialog').isVisible()) await page.keyboard.press('Escape');
  await require('./fixtures/default-space.cjs').revealDefaultSpace(page);
  assert.ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focused: win.isFocused() })))).every(win => !win.visible && !win.focused)); check('Source window stays hidden and unfocused');
  await menu('terminal'); assert.equal((await client.call('initial')).sessions.length, 0); check('Menu on welcome does not create or claim a session');
  await page.locator('#new-session').click(); await page.locator('input[name=provider][value=codex]').check(); await page.locator('#session-name').fill('Export demo'); await createIn(page, 'chat');
  await until(async () => (await client.call('initial')).sessions.length === 1, 'One synthetic session'); const id = (await client.call('initial')).sessions[0].id;
  await fixture('history', id, [{ id: 'demo-reply', type: 'agentMessage', turnId: 'demo', text: '我会依次检查这三项：\n\n1. 文件是否完整 / Complete files\n2. 内容是否一致 / Matching content\n3. 导出结果是否可读 / Readable output\n\n这里只显示合成示例，没有执行任何外部操作。' }]);
  await until(async () => (await fixture()).pending.includes(id), 'Terminal snapshot requested'); await fixture('release', id); await page.locator('.xterm').waitFor();
  await page.locator('#message-input').fill('Unsent private draft');
  await page.locator('#chat-tab').click(); await settle(); await page.locator('#chat-tab').focus(); await page.keyboard.press('Tab');
  assert.equal(await page.locator('#chat-tab').getAttribute('aria-pressed'), 'true');
  for (let i = 0; i < 20 && await page.evaluate(() => document.activeElement.id) !== 'terminal-tab'; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'terminal-tab', 'terminal control is keyboard reachable');
  await page.keyboard.press('Space'); await until(async () => await page.locator('#terminal-tab').getAttribute('aria-pressed') === 'true', 'Space activates terminal');
  await page.locator('#chat-tab').focus(); await page.keyboard.press('Enter'); await until(async () => await page.locator('#chat-tab').getAttribute('aria-pressed') === 'true', 'Enter activates chat'); check('Native Tab only navigates; pane controls are reachable and Space/Enter activate them');
  await menu('terminal'); await until(async () => await page.locator('#terminal-tab').getAttribute('aria-pressed') === 'true', 'Native View menu to terminal');
  const terminal = page.locator('#terminal-area .xterm-helper-textarea'); await terminal.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('ArrowLeft');
  await until(async () => (await fixture()).inputs.length === 2, 'Terminal receives its own Tab and arrow');
  assert.deepEqual((await fixture()).inputs.map(input => input.data), ['\t', '\x1b[D']); check('Terminal Tab and arrow still reach the synthetic native runtime');
  await menu('chat'); await until(async () => await page.locator('#chat-tab').getAttribute('aria-pressed') === 'true', 'Native View menu to chat'); check('Real native menu / preload / renderer route both modes');
  await page.locator('#setup-button').click(); await menu('terminal'); assert.equal(await page.locator('#chat-tab').getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('#setup-dialog').isVisible(), true); await page.keyboard.press('Escape'); check('Mode menu does not switch through an open modal');
  await page.locator('#terminal-maximize').click(); await page.locator('#return-to-chat').waitFor({ state: 'visible' });
  await page.locator('#terminal-tab').focus(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'return-to-chat');
  await page.keyboard.press('Enter'); await page.locator('#conversation-pane').waitFor({ state: 'visible' });
  await page.locator('#close-native-terminal').click(); await page.locator('#native-pane').waitFor({ state: 'hidden' });
  await page.locator('#chat-tab').focus(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.id), 'open-native-terminal');
  assert.equal(await page.locator('#open-native-terminal').getAttribute('aria-expanded'), 'false');
  await page.screenshot({ path: path.join(evidence, 'images', 'chat-only-zh.png'), scale: 'css' });
  await page.keyboard.press('Space'); await page.locator('#native-pane').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private draft');
  await page.locator('#terminal-maximize').click(); await menu('chat'); await page.locator('#conversation-pane').waitFor({ state: 'visible' });
  await page.locator('#close-native-terminal').click(); await menu('terminal'); await page.locator('#native-pane').waitFor({ state: 'visible' });
  check('Close, keyboard open, return from maximized terminal and both native-menu fallbacks preserve the draft');
  for (const lang of ['zh', 'en']) {
    if (lang === 'en') { await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(lang); await page.waitForFunction(value => document.querySelector('#new-session').getAttribute('aria-label') === value, locale.format(lang, 'sidebar.newSession')); await page.keyboard.press('Escape'); }
    const labels = await app.evaluate(({ Menu }) => ['naw-menu-chat', 'naw-menu-terminal'].map(id => Menu.getApplicationMenu().getMenuItemById(id).label)); assert.deepEqual(labels, [locale.format(lang, 'view.chat'), locale.format(lang, 'view.native')]);
    for (const theme of ['light', 'dark']) {
      await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme); await page.emulateMedia({ colorScheme: theme });
      for (const width of [1280, 850]) {
        await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().forEach(win => win.setContentSize(width, 820)), width);
        for (const mode of ['chat', 'terminal']) {
          await page.locator(mode === 'chat' ? '#chat-tab' : '#terminal-tab').click(); await settle();
          const metrics = await page.evaluate(() => {
            const rect = element => element.getBoundingClientRect().toJSON();
            return { width: innerWidth, dark: document.body.hasAttribute('data-ds-dark-theme'), bandCount: document.querySelectorAll('#reading-mode-band').length,
              panes: ['conversation-pane', 'native-pane'].map(id => rect(document.getElementById(id))),
              heads: ['conversation-pane-toolbar', 'native-pane-tabs'].map(id => rect(document.getElementById(id))),
              terminalBackground: getComputedStyle(document.querySelector('#native-pane .native-pane-toolbar')).backgroundColor,
              terminalFont: getComputedStyle(document.querySelector('#native-pane .native-pane-toolbar')).fontFamily,
              controls: ['chat-tab', 'terminal-tab', 'session-files', 'chat-maximize', 'terminal-more', 'terminal-maximize', 'close-native-terminal'].map(id => { const e = document.getElementById(id); return { id, ...rect(e), clip: e.scrollWidth > e.clientWidth + 1, pressed: e.getAttribute('aria-pressed'), label: e.textContent }; }) };
          });
          assert.equal(metrics.bandCount, 0); assert.equal(metrics.dark, theme === 'dark');
          assert.equal(metrics.terminalBackground, 'rgb(25, 33, 44)'); assert.match(metrics.terminalFont, /monospace/);
          const selected = metrics.controls.filter(control => control.pressed === 'true'); assert.equal(selected.length, 1); assert.equal(selected[0].id, mode === 'chat' ? 'chat-tab' : 'terminal-tab');
          for (const control of metrics.controls.filter(control => control.width)) assert.ok(control.x >= 0 && control.x + control.width <= width + 1 && !control.clip, 'Unclipped control: ' + control.id);
          if (width === 1280) assert.ok(metrics.panes[0].x < metrics.panes[1].x); else assert.ok(metrics.panes[0].y < metrics.panes[1].y);
          const key = `${lang}-${theme}-${width}-${mode}`; await page.screenshot({ path: path.join(evidence, 'images', `${key}.png`), scale: 'css' }); shots.push({ key, ...metrics }); check(key + ': no mode row, distinct panes, correct selection and tools fit');
        }
      }
    }
  }
  await page.locator('#terminal-maximize').click();
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(evidence, 'images', 'return-from-maximized-en.png'), scale: 'css' });
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await page.locator('#close-native-terminal').click();
  await page.getByRole('button', { name: 'Open terminal', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(evidence, 'images', 'chat-only-en.png'), scale: 'css' });
  await page.getByRole('button', { name: 'Open terminal', exact: true }).click();
  await page.locator('#native-pane').waitFor({ state: 'visible' }); check('English open/return accessible names operate the same real paths');
  await client.call('join', id, true); await page.locator('#room-nav').waitFor({ state: 'visible' }); await page.locator('#room-nav').click(); await settle();
  assert.equal(await page.locator('#reading-mode-band').count(), 0); await menu('terminal'); assert.equal(await page.locator('#conversation-pane-toolbar').isVisible(), false); check('Space overview has no mode row or hidden mode action');
  await page.locator(`.collaboration-member-status[data-member-id="${id}"] .collaboration-member-name`).click(); await page.locator('#chat-tab').waitFor({ state: 'visible' }); await menu('chat');
  assert.equal(await page.locator('#chat-tab').getAttribute('aria-pressed'), 'true'); await page.locator('#open-native-terminal').waitFor({ state: 'visible' });
  await page.locator('#open-native-terminal').click(); await page.locator('#native-pane').waitFor({ state: 'visible' });
  await page.locator('#native-pane-title').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#native-pane-title').textContent()).includes('Export demo'));
  await page.screenshot({ path: path.join(evidence, 'images', 'focused-member-en.png'), scale: 'css' });
  await page.locator('#chat-tab').click(); await page.locator('#native-pane').waitFor({ state: 'hidden' }); check('Focused space member can open its terminal and return to conversation without a mode row');
  const stats = await fixture(); assert.equal(stats.sends.length, 0); assert.equal(stats.inputs.length, 2); assert.deepEqual(pageErrors, []);
  fs.writeFileSync(path.join(evidence, 'gui-checks.json'), JSON.stringify({ pass: checks.length, fail: 0, screenshots: shots.length, pids: { main: app.process().pid, backend: child.pid }, hiddenWindows: 1, syntheticSessions: 1, syntheticTerminalKeys: stats.inputs.map(input => input.data), sends: 0, models: 0, pageErrors, checks, shots }, null, 2));
  console.log(`GUI ${checks.length}/0; ${shots.length} screenshots; models/sends 0; synthetic terminal keys 2`);
}
run().catch(error => { console.error(error.stack); console.error(errors); process.exitCode = 1; }).finally(async () => { try { await cleanup(); } finally { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true }); } }).catch(error => { console.error(error.stack); process.exitCode = 1; });
