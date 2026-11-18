// One hidden source window and a synthetic provider. No model or real native runtime.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
assert.ok(evidence && path.isAbsolute(evidence), 'An outside-repository screenshot directory is required');
const gitEnv = { ...process.env }; delete gitEnv.GIT_ASKPASS;
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, env: gitEnv, encoding: 'utf8' }).trim();
for (const repository of [root, path.dirname(common)]) assert.ok(!path.resolve(evidence).startsWith(repository + path.sep), 'Private evidence stays outside the repository');
const slot = path.resolve(process.env.NAW_GUI_TEST_SLOT || path.resolve(common, '../.local/gui-test-slot.lock')), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('OCCUPIED: no GUI or service started'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex D', task: 'nonmodal settings', token, pid: process.pid }));
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs'), { createIn } = require('./fixtures/create-view.cjs'), locale = require('../app/ui-locale.js');
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-settings-panel-'));
const home = path.join(profile, 'home'), temporary = path.join(profile, 'tmp');
for (const dir of [home, temporary]) fs.mkdirSync(dir);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !['NODE_OPTIONS', 'NODE_PATH', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'].includes(key))), HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary, NAW_DATA_DIR: profile, NAW_WORKSPACE: path.join(profile, 'work'), NAW_TEST_APP_ROOT: root, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh', NAW_TEST_VISIBLE: '0', NAW_APP_VERSION: require('../package.json').version };
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
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
async function accessible(cdp, selector) {
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  assert.ok(nodeId, 'Exact AX target: ' + selector);
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
  assert.equal(nodes[0].ignored, false, 'AX exposed: ' + selector); return nodes[0];
}
async function run() {
  fs.mkdirSync(path.join(evidence, 'images'), { recursive: true });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service');
  client = await connect(profile, 'settings-gui-person'); scratch.ownService(profile);
  const sourceEntry = require('./fixtures/synthetic-source-boot.cjs').createSourceEntry({ profile, code: root, fixturePid: child.pid });
  app = await _electron.launch({ executablePath: require('electron'), args: [sourceEntry], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.locator('#new-session').waitFor();
  if (await page.locator('#setup-dialog').isVisible()) await page.locator('#close-setup').click();
  await require('./fixtures/default-space.cjs').revealDefaultSpace(page);
  assert.ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focused: win.isFocused() })))).every(win => !win.visible && !win.focused));
  check('Isolated source window stays hidden and unfocused');
  await page.locator('#new-session').click(); await page.locator('input[name=provider][value=codex]').check();
  await page.locator('#session-name').fill('Settings synthetic'); await createIn(page, 'chat');
  const id = (await client.call('initial')).sessions[0].id;
  await fixture('bindSends', id);
  await page.locator('#close-native-terminal').click();
  const cdp = await page.context().newCDPSession(page), measurements = [];
  let count = 0;
  for (const lang of ['zh', 'en']) for (const width of [1240, 850]) for (const theme of ['light', 'dark']) {
    const tag = `${lang}-${width}-${theme}`, height = width === 850 ? 600 : 820;
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows().forEach(win => win.setContentSize(...size)), [width, height]);
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(lang);
    await page.getByRole('dialog', { name: locale.format(lang, 'common.settings'), exact: true }).waitFor();
    await settle();
    assert.equal(await page.locator('#setup-dialog').evaluate(el => el.matches(':modal')), false);
    const dialogAX = await accessible(cdp, '#setup-dialog');
    assert.equal(dialogAX.name.value, locale.format(lang, 'common.settings'));
    assert.equal(await page.locator('#close-setup').getAttribute('aria-label'), `${locale.format(lang, 'common.close')} · ${locale.format(lang, 'common.settings')}`);
    assert.equal(await page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')), theme === 'dark');
    await accessible(cdp, '#message-input');
    // Focusing the reply while the terminal owns keyboard input must restore chat.
    await menu('terminal'); await page.locator('#message-input').click();
    await until(async () => await page.locator('#chat-tab').getAttribute('aria-pressed') === 'true', 'Settings must not block inputFocusAllowed');
    const text = `Synthetic settings reply ${tag} 你好`;
    await page.locator('#message-input').fill(text); await page.locator('#message-input').press('Enter'); count++;
    await until(async () => (await fixture('stats', id)).stats.sends === count, 'Exactly one synthetic send');
    assert.equal((await fixture('stats', id)).lastSend.text, text);
    await fixture('complete', id, { text: 'Synthetic acknowledgement' });
    await until(async () => !(await page.locator('#message-input').isDisabled()), 'Reply ready');
    // A real backend question stays reachable with settings open, including its answer action.
    await fixture('approval', id, { requestId: count, method: 'item/tool/requestUserInput', params: {
      threadId: 'synthetic-thread', turnId: 'synthetic-turn', itemId: `settings-${count}`, isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'detail', header: 'Synthetic / 合成', question: 'Synthetic question / 合成问题', isOther: true, isSecret: false, options: [] }],
    } });
    const form = page.locator('#approval .question-form'); await form.waitFor(); await form.getByRole('textbox').fill('Synthetic answer / 合成回答');
    await accessible(cdp, '#approval .question-form input');
    const metrics = await page.evaluate(() => {
      const rect = id => document.getElementById(id).getBoundingClientRect().toJSON();
      return { width: innerWidth, height: innerHeight, reply: rect('message-input'), panel: rect('setup-dialog'), approval: rect('approval') };
    });
    assert.ok(metrics.reply.width >= 200 && metrics.reply.x >= 0 && metrics.reply.bottom <= height && metrics.reply.right <= metrics.panel.left, JSON.stringify(metrics));
    assert.ok(metrics.approval.width > 0 && metrics.approval.right <= metrics.panel.left);
    await page.screenshot({ path: path.join(evidence, 'images', tag + '.png'), scale: 'css' }); shots.push(tag);
    await form.getByRole('button', { name: locale.format(lang, 'approval.submit'), exact: true }).click();
    await until(async () => (await fixture('stats', id)).approvalReplies.length === count, 'Question answered once');
    assert.deepEqual((await fixture('stats', id)).approvalReplies.at(-1), { requestId: count, result: { answers: { detail: { answers: ['Synthetic answer / 合成回答'] } } } });
    assert.equal(await page.locator('#setup-dialog').isVisible(), true);
    await page.locator('#close-setup').click();
    await until(async () => await page.evaluate(() => document.activeElement.id === 'message-input'), 'Close restores reply focus');
    assert.equal(await page.locator('main.settings-panel-open').count(), 0);
    measurements.push({ tag, ...metrics }); check(`${tag}: send once, question answer once, AX exposed, reply fits, close returns focus`);
  }
  // A pre-existing true modal is still a boundary; settings opened from Create stays above it.
  await page.locator('#setup-button').click();
  await page.locator('#new-session').click(); await page.locator('#session-name').fill('Keep creation draft');
  await page.locator('#create-setup').click(); assert.equal(await page.locator('#setup-dialog').evaluate(el => el.matches(':modal')), true);
  const { root: dom } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.nodeId, selector: '#message-input' });
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  const ax = await cdp.send('Accessibility.getPartialAXTree', { backendNodeId: node.backendNodeId, fetchRelatives: false });
  assert.equal(ax.nodes[0].ignored, true, 'Actual modal retains its AX/focus boundary');
  await page.locator('#close-setup').click(); assert.equal(await page.locator('#session-name').inputValue(), 'Keep creation draft');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'create-setup');
  await page.keyboard.press('Escape'); check('Create modal keeps its draft, nested return focus and original modal/AX boundary');
  await page.locator('#setup-button').click(); await page.locator('#message-input').focus();
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#setup-dialog').isVisible(), true);
  await page.locator('#close-setup').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'close-setup');
  await page.locator('#ui-language').focus();
  await page.locator('#ui-language').dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  assert.equal(await page.locator('#setup-dialog').isVisible(), true);
  await page.keyboard.press('Escape'); await page.locator('#setup-dialog').waitFor({ state: 'hidden' });
  await until(async () => await page.evaluate(() => document.activeElement.id === 'message-input'), 'Escape restores reply focus');
  check('Close is keyboard reachable; only panel-local non-composition Escape closes settings');
  assert.deepEqual(pageErrors, []); assert.equal((await client.call('initial')).sessions.length, 1);
  const stats = (await fixture('stats', id)).stats; assert.equal(stats.sends, 8); assert.equal(stats.inputs, 0);
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ checks, measurements, stats, screenshots: shots, pageErrors }, null, 2));
  console.log(`GUI ${checks.length}/0; screenshots=${shots.length}; synthetic sends=${stats.sends}; question answers=8; models=0; native bytes=${stats.inputs}`);
}
run().catch(async error => { console.error(error.stack); console.error(errors); if (page) { await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); console.error(await page.evaluate(() => ({ focus: document.activeElement?.id, dialogs: [...document.querySelectorAll('dialog[open]')].map(e => e.id) })).catch(() => null)); } process.exitCode = 1; }).finally(async () => { try { await cleanup(); } finally { if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true }); } }).catch(error => { console.error(error.stack); process.exitCode = 1; });
