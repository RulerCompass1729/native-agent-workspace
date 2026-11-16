// Hidden integration check of product confirmation cards; synthetic transport, no DOM/CSS replacement.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { createSourceEntry } = require('./fixtures/synthetic-source-boot.cjs');
const { execFileSync } = require('node:child_process');
const output = process.env.NAW_EVIDENCE_DIR;
if (!output || !path.isAbsolute(output) || output.startsWith(root + path.sep)) throw Error('Private evidence directory required');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
const pictures = process.env.NAW_PICTURES_DIR;
if (!pictures || !path.isAbsolute(pictures) || pictures.startsWith(root + path.sep)) throw Error('An explicit private screenshot directory is required');
fs.mkdirSync(pictures, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
fs.mkdirSync(path.dirname(slot), { recursive: true });
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, pid: process.pid, task: 'formal confirmation card verification' }));
let child, client, app, page, helper, sequence = 0; const errors = [], checks = [];
const profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-consent-formal-')));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
const record = name => { checks.push(name); console.log('PASS', name); };
function checkForeground() {
  const pid = Number(execFileSync('osascript', ['-l', 'JavaScript', '-e',
    "ObjC.import('AppKit'); Number($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)"], { encoding: 'utf8' }).trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Foreground app is observable');
  assert.notEqual(pid, app.process().pid, 'The hidden test app never becomes the foreground app');
}
function fixture(method, target, value) {
  const id = ++sequence, field = method === 'backgroundProof' ? 'proofRequestId' : 'requestId';
  if (method === 'backgroundComplete') { child.send({ id, method, target, value }); return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout: ' + method)); }, 10000);
    const cb = r => { if (r[field] === id) { clearTimeout(timer); child.off('message', cb); r.error ? reject(Error(r.error)) : resolve(r); } };
    child.on('message', cb); child.send({ id, method, target, value });
  });
}
function mcp() {
  helper = scratch.childProcess.spawn(process.execPath, [path.join(code, 'app/claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_CONTROL_DESCRIPTOR: path.join(profile, 'outbox-owner.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const pending = new Map();
  helper.stdout.setEncoding('utf8'); helper.stdout.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) {
    const r = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending.get(r.id)?.(r); pending.delete(r.id);
  } }); helper.stderr.on('data', value => errors.push(String(value)));
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error('MCP timeout')), 20000);
    pending.set(id, r => { clearTimeout(timer); r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result); });
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function main() {
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    execArgv: ['--require', path.join(root, 'scripts/fixtures/background-control.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service starts');
  client = await connectService(profile, 'human-view');
  const source = await client.call('create', { provider: 'codex', cwd: profile, name: 'Codex 助手', view: 'chat' });
  const other = await client.call('create', { provider: 'claude', cwd: profile, name: 'Claude 研究', view: 'chat' });
  await client.call('join', source, true); await client.call('join', other, true);
  await client.call('draft', other, '保留这份未发送的草稿。');
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: other, mode: 'chat' }]), { mode: 0o600 });
  const entry = createSourceEntry({ profile, code, fixturePid: child.pid });
  app = await _electron.launch({ executablePath: require('electron'), args: [entry],
    env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: 'zh' }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor({ timeout: 45000 }); await revealDefaultSpace(page);
  // Observe and forward the real shared clock, including cancellation. Preserve
  // callback execution, arguments and timing without mutating product DOM/state.
  function observeClock() {
    const timeout = window.setTimeout, cancel = window.clearTimeout, active = new Set();
    const counts = { scheduled: 0, fired: 0 };
    window.setTimeout = function (callback, ms, ...args) {
      if (ms !== 1000 || typeof callback !== 'function' || !callback.toString().includes('.background-state[data-expires-at]')) return timeout.call(this, callback, ms, ...args);
      counts.scheduled++;
      const id = timeout.call(this, function (...values) { active.delete(id); counts.fired++; return callback.apply(this, values); }, ms, ...args);
      active.add(id); return id;
    };
    window.clearTimeout = function (id) { active.delete(id); return cancel.call(this, id); };
    window.consentClockSnapshot = () => ({ ...counts, active: active.size });
  }
  await page.addInitScript(observeClock); await page.evaluate(observeClock);
  const clockProbe = () => page.evaluate(() => ({ timers: window.consentClockSnapshot(),
    states: [...document.querySelectorAll('.background-state[data-expires-at]')].map(n => ({ text: n.textContent, expiresAt: n.dataset.expiresAt, void: Boolean(n.closest('.background-void')) })) }));
  async function idleClock(label) {
    // A detached-card timer may perform one final bounded check after removal.
    await delay(1200);
    const before = await clockProbe(); await delay(2400); const after = await clockProbe();
    console.log('IDLE CLOCK', JSON.stringify({ label, before, after }));
    assert.deepEqual(after.timers, before.timers, label + ': no clock scheduling or callbacks while idle');
    assert.equal(after.timers.active, 0, label + ': no retained timeout');
    assert.deepEqual(after.states, [], label + ': no stale countdown markers');
  }
  checkForeground();
  await page.evaluate(() => workspace.roomRename('项目协作'));
  const rpc = mcp(); await rpc('initialize');
  async function control(method, args) {
    const request = { action: 'invoke', method, arguments: args, operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: request });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: request, _meta: { threadId: proof.nativeId, sessionId: proof.sessionId,
      callId: proof.callId, 'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: request });
    const row = JSON.parse(result.content[0].text); assert.equal(row.state, 'confirmation-required', JSON.stringify(row)); return row;
  }
  const createArgs = [{ provider: 'claude', name: 'Claude 7 · NAW 开发', cwd: path.join(profile, 'claude-cards-20261115'), skipPermissions: true }];
  const old = await control('create', createArgs), current = await control('create', createArgs);
  const clear = await control('clearSharedHistory', []);
  const messageId = r => `background:${r.actor.nativeId}:${r.id}`;
  const pending = r => page.locator(`[data-waiting-id="${messageId(r)}"]`);
  await until(async () => (await page.evaluate(() => workspace.initial())).backgroundConfirmations.length === 2, 'Exactly two current confirmations');
  record('actual pending list excludes the superseded request');
  const win = await app.browserWindow(page), shots = [];
  async function language(lang) {
    await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(lang);
    await until(async () => (await page.locator('#setup-title').textContent()) === (lang === 'zh' ? '设置' : 'Settings'), 'Language changes');
    await page.locator('#close-setup').click();
  }
  async function panel(open) {
    const more = page.locator('#stream-waiting-more');
    if ((await more.getAttribute('aria-expanded') === 'true') !== open) await more.click();
  }
  async function shot(lang, variant, width, view) {
    await win.evaluate((w, width) => w.setContentSize(width, width === 850 ? 650 : 820), width);
    await delay(300);
    assert.equal(await page.locator("#consent-design-style").count(), 0, "No prototype DOM or CSS injection");
    assert.equal(await page.locator('.background-sentence').evaluateAll(nodes => nodes.some(n => n.textContent.includes('clearSharedHistory'))), false, 'Product summary uses the human action name');
    if (view === 'original-and-void') {
      const stale = page.locator(`#conversation-pane [data-message-id="${messageId(old)}"]`);
      await stale.evaluate(el => el.scrollIntoView({ block: 'start' })); await delay(100);
      const visible = await stale.locator('.background-note').evaluate(el => {
        const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;
      });
      assert.ok(visible, 'The superseded card reason is actually in the screenshot');
    }
    const file = `${variant}-${lang}-${width}-${view}.png`;
    await page.screenshot({ path: path.join(pictures, file) }); shots.push(file);
    checkForeground();
    const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll('.stream-waiting-list .background-buttons button')].map(b => ({ text: b.textContent, width: b.clientWidth, scroll: b.scrollWidth })) }));
    assert.ok(metrics.scroll <= metrics.width, 'No horizontal page overflow');
    for (const b of metrics.buttons) assert.ok(b.scroll <= b.width + 1, 'Button label fits: ' + b.text);
  }
  // First open, with no conversation card to have already started the shared clock.
  assert.equal(await page.locator('.background-state[data-expires-at]').count(), 0);
  await panel(true);
  const clocks = page.locator('#stream-waiting-list .background-state[data-expires-at]');
  assert.equal(await clocks.count(), 2);
  const mounted = await clocks.elementHandles();
  const clockSnapshot = () => clocks.evaluateAll(nodes => nodes.map(n => ({ text: n.textContent, expiresAt: n.dataset.expiresAt })));
  const initialClocks = await clockSnapshot(), startedAt = Date.now();
  await delay(1600);
  const nextClocks = await clockSnapshot();
  console.log('COUNTDOWN', JSON.stringify({ before: initialClocks, after: nextClocks, elapsedMs: Date.now() - startedAt }));
  for (const [index, initial] of initialClocks.entries()) {
    assert.ok(await mounted[index].evaluate(n => n.isConnected), 'The same card stays mounted without a state redraw');
    assert.equal(nextClocks[index].expiresAt, initial.expiresAt, 'Ticking preserves the stored deadline');
    assert.notEqual(nextClocks[index].text, initial.text, 'First-open waiting countdown changes within 1.6 seconds');
  }
  assert.equal((await clockProbe()).timers.active, 1, 'Both cards use one observed shared timer');
  record('both first-open waiting countdowns tick without a conversation card or deadline change');
  await panel(false);
  await idleClock('Closing the list with no conversation cards');
  for (const handle of mounted) { assert.equal(await handle.evaluate(n => n.isConnected), false); await handle.dispose(); }
  record('removing the last visible countdown stops the clock');
  for (const lang of ['zh', 'en']) for (const variant of ['implemented']) {
    await page.reload(); await page.locator('#new-session').waitFor(); await language(lang);
    await page.locator(`.session-link[data-session-id="${other}"]`).click();
    await page.locator('#chat-tab').click();
    await until(() => page.locator('#message-input').isVisible(), 'Other conversation visible');
    assert.ok(await page.locator('#stream-waiting').isVisible());
    for (const width of [1240, 850]) await shot(lang, variant, width, 'conversation');
    await page.locator('#terminal-tab').click();
    await until(() => page.locator('#native-pane').isVisible(), 'Native terminal visible');
    assert.ok(await page.locator('#stream-waiting').isVisible());
    for (const width of [1240, 850]) await shot(lang, variant, width, 'terminal');
    await page.locator('#room-nav').click(); await page.locator('#room-overview').click();
    assert.ok(await page.locator('#stream-waiting').isVisible());
    for (const width of [1240, 850]) await shot(lang, variant, width, 'overview');
    await panel(true);
    assert.equal(await page.locator('.stream-waiting-row').count(), 2);
    for (const width of [1240, 850]) await shot(lang, variant, width, 'cards');
    assert.equal(await pending(current).locator('.background-sentence').textContent(), lang === 'zh' ? '新建会话「Claude 7 · NAW 开发」 · Claude · 目录 claude-cards-20261115 · 跳过权限确认' : 'Create session “Claude 7 · NAW 开发” · Claude · Folder claude-cards-20261115 · Skip permission prompts');
    assert.equal(await page.locator('.stream-waiting-count').textContent(), lang === 'zh' ? '有 2 件等你确认' : '2 actions need your confirmation');
    assert.equal(await page.locator('.stream-waiting-title').textContent(), lang === 'zh' ? '清空「项目协作」的共享记录' : 'Clear shared records in “项目协作”');
    assert.equal(await pending(clear).locator('.background-sentence').textContent(), lang === 'zh' ? '清空空间「项目协作」的共享记录' : 'Clear shared records in “项目协作”');
    assert.equal(await pending(clear).locator('.background-risk-delete').count(), 1);
    assert.equal(await pending(clear).locator('.background-buttons .primary').textContent(), lang === 'zh' ? '确认' : 'Confirm');
    assert.equal(await pending(current).locator('.background-details').count(), 1);
    assert.equal(await pending(current).locator('.background-details').getAttribute('open'), null);
    await pending(current).locator('.stream-waiting-link').click();
    await until(() => page.locator(`[data-message-id="${messageId(current)}"][data-search-target]`).isVisible(), 'One click reaches the exact card');
    const stale = page.locator(`#conversation-pane [data-message-id="${messageId(old)}"]`);
    assert.equal(await stale.locator('.background-buttons').count(), 0);
    for (const width of [1240, 850]) await shot(lang, variant, width, 'original-and-void');
    record(`${lang}/${variant}: strip in conversation, native terminal and overview; direct navigation and disabled duplicate`);
  }
  await panel(true); await pending(current).locator('.background-buttons button:not(.primary)').click();
  await until(() => pending(current).count().then(n => n === 0), 'Cancel removes only that card');
  assert.ok(await pending(clear).isVisible());
  await pending(clear).locator('.background-buttons button:not(.primary)').click();
  await until(() => page.locator('#stream-waiting').isHidden(), 'Last cancellation clears the strip');
  const final = await client.call('initial');
  assert.equal(await page.evaluate(async () => (await workspace.initial()).backgroundConfirmations.length), 0, 'No pending human confirmations');
  await page.locator(`.session-link[data-session-id="${source}"]`).click(); await page.locator('#chat-tab').click();
  assert.ok(await page.locator('#conversation-pane .background-void').count(), 'Historical superseded cards are still rendered');
  await idleClock('Zero pending confirmations with old cards in the initiator conversation');
  record('zero pending confirmations leave historical cards without a running clock');
  assert.equal(final.sessions.length, 2);
  await page.locator(`.session-link[data-session-id="${other}"]`).click(); await page.locator('#chat-tab').click();
  assert.equal(await page.locator('#message-input').inputValue(), '保留这份未发送的草稿。');
  const again = await control('clearSharedHistory', []);
  await until(async () => (await page.evaluate(() => workspace.initial())).backgroundConfirmations.length === 1, 'A new confirmation arrives');
  await panel(true);
  const renewed = pending(again).locator('.background-state[data-expires-at]');
  const text = await renewed.textContent(), deadline = await renewed.getAttribute('data-expires-at');
  await delay(1600);
  assert.notEqual(await renewed.textContent(), text, 'The clock restarts for a new pending confirmation');
  assert.equal(await renewed.getAttribute('data-expires-at'), deadline, 'Restart does not change the deadline');
  const replacedNode = await renewed.elementHandle();
  await panel(false); await panel(true);
  assert.equal(await replacedNode.evaluate(n => n.isConnected), false, 'List repaint detaches the old countdown node');
  await replacedNode.dispose();
  assert.equal(await renewed.getAttribute('data-expires-at'), deadline, 'Repaint preserves the deadline');
  const repaintedText = await renewed.textContent(); await delay(1600);
  assert.notEqual(await renewed.textContent(), repaintedText, 'The replacement node keeps ticking');
  assert.equal((await clockProbe()).timers.active, 1, 'Repaint retains only one shared timer');
  await pending(again).locator('.background-buttons button:not(.primary)').click();
  await until(() => page.locator('#stream-waiting').isHidden(), 'The renewed confirmation is cancelled');
  await idleClock('Cancelling the renewed confirmation');
  record('new confirmations restart the clock; repaint replaces nodes without retaining timers');
  assert.equal(fs.existsSync(createArgs[0].cwd), false, 'No requested directory created');
  const stats = await fixture('stats'); assert.equal(stats.modelCalls, 0); assert.equal(stats.nativeProcesses, 0);
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  assert.ok(windows.length && windows.every(w => !w.visible && !w.focused));
  checkForeground();
  assert.deepEqual(errors, []); record('cancellation preserves sessions/draft; hidden windows; zero models and renderer errors');
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, pictures, shots, stats, windows, errors, productRenderer: true }, null, 2));
  fs.writeFileSync(path.join(pictures, 'index.html'), `<!doctype html><html lang="zh"><meta charset="utf-8"><title>正式确认卡 · 已批预览对照</title><style>
    body{max-width:1600px;margin:24px auto;padding:0 20px;font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;color:#26372e;background:#f8f8f5}
    h2{font-size:20px;margin-top:36px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0}img{width:100%;border:1px solid #d6dcd3}a{color:#325e44}
    @media(max-width:850px){.pair{grid-template-columns:1fr}}
    </style><h1>正式确认卡 · 已批预览对照</h1>
    <p>左：用户已批的 66c63823 预览。右：正式 renderer 的真实确认卡，没有临时样式或文字替换。均为合成数据、隐藏窗口。</p>
    <p>已保留精确操作身份、作废卡原因与禁用、风险说明、详情及原处理器；常设许可逻辑未改。混合等待事项分别计数（预览的待实现要求）。未新增集中入口或对外发送能力。</p>
    ${['zh','en'].map(lang => [850,1240].map(width => ['cards','original-and-void','conversation','terminal','overview'].map(view => `<h2>${lang} · ${width} · ${view}</h2><div class="pair"><figure><figcaption>已批预览</figcaption><a href="../consent-cards-20261115/proposal-${lang}-${width}-${view}.png"><img loading="lazy" src="../consent-cards-20261115/proposal-${lang}-${width}-${view}.png"></a></figure><figure><figcaption>正式实现</figcaption><a href="implemented-${lang}-${width}-${view}.png"><img loading="lazy" src="implemented-${lang}-${width}-${view}.png"></a></figure></div>`).join('')).join('')).join('')}
    <p>窄/宽、中/英各档；未验证真实 provider 或系统通知；未合并、安装、推送。</p></html>`);
  console.log(JSON.stringify({ passed: checks.length, failed: 0, skipped: 0, screenshots: shots.length, pictures, productRenderer: true }));
}
main().catch(async e => {
  console.error(e.stack); process.exitCode = 1;
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(pictures, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
}).finally(scratch.cleanup(async () => {
  if (helper) helper.stdin.end();
  if (app) await app.close().catch(() => {});
  if (client) { await client.call('shutdown').catch(() => {}); client.close(); }
  if (child?.connected) child.disconnect();
  if (child?.exitCode === null) child.kill('SIGTERM');
  const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
  if (owner.token === token) { fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); }
}));
