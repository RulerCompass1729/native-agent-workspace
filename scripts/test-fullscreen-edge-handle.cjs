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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'fullscreen edge handle', task: 'collapsed side stays discoverable', token, pid: process.pid }));
const scratch = require('./fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(require('playwright'));
const { connect } = require('../app/service-client.cjs'), { createIn } = require('./fixtures/create-view.cjs');
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-edge-handle-'));
const dropped = ['NODE_OPTIONS', 'NODE_PATH', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION'];
const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith('NAW_') && !key.startsWith('ELECTRON_') && !dropped.includes(key));
const env = {
  ...Object.fromEntries(inherited),
  NAW_DATA_DIR: profile,
  NAW_WORKSPACE: path.join(profile, 'work'),
  NAW_TEST_APP_ROOT: root,
  NAW_TEST_PARENT_PID: String(process.pid),
  NAW_TEST_UI_LANGUAGE: 'zh',
  NAW_TEST_VISIBLE: '0',
  NAW_APP_VERSION: require('../package.json').version,
};
const child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
let app, page, client, seq = 0, errors = '';
const checks = [], shots = [];
child.stderr.on('data', data => { errors += data; });
const closed = new Promise(resolve => child.once('close', resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 240; i++) {
    if (await fn()) return;
    await delay(50);
  }
  throw Error(label);
}
function fixture(method = 'stats', target, value) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', read); reject(Error('Fixture timeout: ' + method)); }, 10000);
    const read = r => {
      if (r.requestId !== id) return;
      clearTimeout(timer); child.off('message', read); resolve(r);
    };
    child.on('message', read);
    child.send({ id, method, target, value });
  });
}
const check = label => { checks.push(label); console.log('PASS:', label); };
async function settle() {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await delay(120);
}
const cleanup = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { try { await client.call('shutdown'); } catch {} client.close(); client = null; }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([closed, delay(1500)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await closed;
});

const HANDLES = {
  terminal: { fullscreen: '#terminal-maximize', handle: '#edge-chat', name: '展开对话', text: '对话', restores: '#chat-tab' },
  chat: { fullscreen: '#close-native-terminal', handle: '#edge-terminal', name: '展开终端', text: '终端', restores: '#terminal-tab' },
};

function layout() {
  return page.evaluate(() => {
    const box = selector => {
      const element = document.querySelector(selector);
      if (!element || element.hidden || !element.getClientRects().length) return null;
      return element.getBoundingClientRect().toJSON();
    };
    return {
      chat: box('#edge-chat'),
      terminal: box('#edge-terminal'),
      conversation: box('#conversation-pane'),
      native: box('#native-pane'),
      xterm: box('#native-pane .xterm-screen'),
      messages: box('#messages'),
    };
  });
}
const overlaps = (a, b) => Boolean(a && b) && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function assertSplit(label) {
  const now = await layout();
  assert.ok(now.conversation && now.native, label + ': both panes shown side by side');
  assert.equal(now.chat, null, label + ': no conversation handle while side by side');
  assert.equal(now.terminal, null, label + ': no terminal handle while side by side');
}

async function fullscreen(side, width) {
  const spec = HANDLES[side];
  await page.locator(spec.fullscreen).click();
  await settle();
  const handle = page.getByRole('button', { name: spec.name, exact: true });
  await handle.waitFor({ state: 'visible' });
  assert.equal(await page.locator(spec.handle).getAttribute('title'), '恢复并排');
  assert.ok((await page.locator(spec.handle).textContent()).includes(spec.text), side + ': handle shows its short label');
  const now = await layout();
  const box = side === 'terminal' ? now.chat : now.terminal;
  if (side === 'terminal') {
    assert.equal(now.conversation, null, 'Terminal fullscreen hides the conversation');
    assert.equal(now.terminal, null, 'Terminal fullscreen has no terminal handle');
    assert.ok(!overlaps(box, now.xterm), 'Handle leaves the first terminal column clear');
    if (width > 900) assert.ok(box.x + box.width <= now.native.x + 0.5, 'Handle sits on the left edge');
    else assert.ok(box.y + box.height <= now.native.y + 0.5, 'Handle sits on the top edge');
  } else {
    assert.equal(now.native, null, 'Conversation fullscreen hides the terminal');
    assert.equal(now.chat, null, 'Conversation fullscreen has no conversation handle');
    assert.ok(!overlaps(box, now.messages), 'Handle leaves the conversation scrollbar clear');
    if (width > 900) assert.ok(box.x >= now.conversation.x + now.conversation.width - 0.5, 'Handle sits on the right edge');
    else assert.ok(box.y >= now.conversation.y + now.conversation.height - 0.5, 'Handle sits on the bottom edge');
  }
  return { handle, box };
}

async function run() {
  fs.mkdirSync(path.join(evidence, 'images'), { recursive: true });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service');
  client = await connect(profile, 'edge-handle-person');
  scratch.ownService(profile);
  const sourceEntry = require('./fixtures/synthetic-source-boot.cjs').createSourceEntry({ profile, code: root, fixturePid: child.pid });
  app = await _electron.launch({ executablePath: require('electron'), args: [sourceEntry], env, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  await page.locator('#new-session').waitFor();
  if (await page.locator('#setup-dialog').isVisible()) await page.keyboard.press('Escape');
  await require('./fixtures/default-space.cjs').revealDefaultSpace(page);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(win => ({ visible: win.isVisible(), focused: win.isFocused() })));
  assert.ok(windows.every(win => !win.visible && !win.focused)); check('Source window stays hidden and unfocused');
  await page.locator('#new-session').click(); await page.locator('input[name=provider][value=codex]').check();
  await page.locator('#session-name').fill('Edge handle demo'); await createIn(page, 'chat');
  await until(async () => (await client.call('initial')).sessions.length === 1, 'One synthetic session');
  const id = (await client.call('initial')).sessions[0].id;
  await fixture('history', id, [{ id: 'edge-reply', type: 'agentMessage', turnId: 'edge', text: '合成示例：终端全屏时，左边缘露出对话把手；对话全屏时，右边缘露出终端把手。' }]);
  await until(async () => (await fixture()).pending.includes(id), 'Terminal snapshot requested');
  await fixture('release', id); await page.locator('.xterm').waitFor();
  await page.locator('#message-input').fill('Unsent private draft');
  await assertSplit('Start');

  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, theme) => { nativeTheme.themeSource = theme; }, theme);
    await page.emulateMedia({ colorScheme: theme });
    for (const width of [1280, 900]) {
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().forEach(win => win.setContentSize(width, 800)), width);
      await settle();
      await assertSplit(`${theme}-${width}`);
      for (const side of ['terminal', 'chat']) {
        const spec = HANDLES[side];
        const { handle, box } = await fullscreen(side, width);
        const key = `${theme}-${width}-${side}-fullscreen`;
        await page.screenshot({ path: path.join(evidence, 'images', key + '.png'), scale: 'css' });
        shots.push({ key, handle: box });
        await handle.click(); await settle();
        await assertSplit(key + ' click');
        assert.equal(await page.locator(spec.restores).getAttribute('aria-pressed'), 'true', key + ': click lands where the existing control lands');
        check(`${key}: handle named 「${spec.name}」, clear of content, one click restores side by side`);
      }
    }
  }

  await fullscreen('terminal', 900);
  await page.locator('#terminal-tab').focus();
  await page.keyboard.press('Shift+Tab');
  for (let i = 0; i < 20 && await page.evaluate(() => document.activeElement.id) !== 'edge-chat'; i++) await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'edge-chat', 'Conversation handle is keyboard reachable');
  assert.notEqual(await page.locator('#edge-chat').evaluate(element => getComputedStyle(element).outlineStyle), 'none', 'Keyboard focus is visible');
  await page.keyboard.press('Enter'); await settle(); await assertSplit('Keyboard conversation handle');
  await fullscreen('chat', 900);
  await page.locator('#chat-tab').focus();
  for (let i = 0; i < 40 && await page.evaluate(() => document.activeElement.id) !== 'edge-terminal'; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'edge-terminal', 'Terminal handle is keyboard reachable');
  assert.notEqual(await page.locator('#edge-terminal').evaluate(element => getComputedStyle(element).outlineStyle), 'none', 'Keyboard focus is visible');
  await page.keyboard.press('Space'); await settle(); await assertSplit('Keyboard terminal handle');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent private draft');
  check('Both handles are keyboard reachable with a visible focus ring; the draft survives');

  const stats = await fixture();
  assert.equal(stats.sends.length, 0); assert.equal(stats.inputs.length, 0); assert.deepEqual(pageErrors, []);
  const summary = { pass: checks.length, fail: 0, screenshots: shots.length, hiddenWindows: 1, syntheticSessions: 1, sends: 0, inputs: 0, models: 0, pageErrors, checks, shots };
  fs.writeFileSync(path.join(evidence, 'gui-checks.json'), JSON.stringify(summary, null, 2));
  console.log(`GUI ${checks.length}/0; ${shots.length} screenshots; models/sends/inputs 0`);
}
run()
  .catch(error => { console.error(error.stack); console.error(errors); process.exitCode = 1; })
  .finally(async () => {
    try { await cleanup(); } finally {
      if (JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token === token) fs.rmSync(slot, { recursive: true });
    }
  })
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
