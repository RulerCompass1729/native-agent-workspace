const testScratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-compact-ui-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/native-progress.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let application, page, client, sequence = 0; const errors = [], checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); m.error ? reject(Error(m.error)) : resolve(m); } };
    const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 20000);
    child.on('message', cb); child.send({ id, method, target, value });
  });
}
const snapshot = () => page.evaluate(() => workspace.initial());
// The native terminal beside the chat is the only live screen (the readonly progress panel was removed).
const nativePane = id => page.locator(`[data-terminal-id="${id}"]`);
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(provider + ' · 实时过程'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.state === 'idle'), 'Created');
  const id = (await snapshot()).sessions.find(s => s.provider === provider).id;
  await until(() => nativePane(id).locator('.xterm').count(), 'Native screen'); return id;
}
async function screen(id) {
  return page.evaluate(id => {
    const t = [...window.progressTestTerminals].reverse().find(t => t.element?.isConnected && t.element.closest('[data-terminal-id]')?.dataset.terminalId === id);
    if (!t) return null;
    const b = t.buffer.active;
    return { cols: t.cols, rows: t.rows, type: b.type, cursor: [b.cursorX, b.cursorY], lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString()) };
  }, id);
}
async function aligned(id) {
  // The canonical screen follows native resizes too, so compare with its latest state.
  await until(async () => JSON.stringify(await screen(id)) === JSON.stringify((await fixture('stats', id)).screen), 'Canonical screen alignment');
}
async function capture(name) {
  if (!process.env.NAW_EVIDENCE_DIR || !page || page.isClosed()) return;
  fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') });
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Daemon'); client = await connect(profile, 'observer-test');
  application = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await application.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  // Test-only inspection of the actual xterm instances; no production debug API.
  await page.evaluate(() => {
    window.progressTestTerminals = []; window.progressTestLatencies = [];
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (...args) { window.progressTestTerminals.push(this); return open.apply(this, args); };
    new MutationObserver(records => { for (const r of records) if (r.attributeName === 'data-paint-latency') window.progressTestLatencies.push(Number(r.target.dataset.paintLatency)); }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-paint-latency'] });
  });

  const metrics = [];
  async function measure(label, room = false) {
    await delay(150);
    const m = await page.evaluate(({ label, room }) => {
      const list = document.querySelector(room ? '#room-messages' : '#messages');
      const input = document.querySelector(room ? '#shared-input' : '#message-input');
      const send = document.querySelector(room ? '#forward-button' : '#send-button');
      const progress = document.querySelector('#native-pane');
      const css = getComputedStyle(list), a = input.getBoundingClientRect(), b = send.getBoundingClientRect();
      return { label, contentHeight: list.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom), contentWidth: list.clientWidth,
        progressHeight: progress?.clientHeight || 0, inputBottom: a.bottom, sendBottom: b.bottom, height: innerHeight,
        inputVisible: a.top >= 0 && a.bottom <= innerHeight, sendVisible: b.top >= 0 && b.bottom <= innerHeight };
    }, { label, room });
    metrics.push(m); await capture(label);
    assert.ok(m.contentHeight >= 96, label + ': four lines of readable body: ' + JSON.stringify(m));
    assert.ok(m.inputVisible && m.sendVisible, label + ': input and send stay in the window: ' + JSON.stringify(m));
    return m;
  }
  const size = (width, height) => application.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setSize(...s), [width, height]);
  await size(850, 600);
  const a = await create('claude');
  await fixture('history', a, [{ id: 'answer', type: 'agentMessage', text: '这是需要完整阅读的回答。\n'.repeat(30) }]);
  await fixture('output', a, { data: '原生实时输出\r\n'.repeat(35) }); await aligned(a);
  const draft = '保留中文草稿，不发送。\n'.repeat(12);
  await page.locator('#message-input').fill(draft);
  const before = await measure('solo-compact');
  // Hiding the terminal gives the chat the room; bringing it back keeps the canonical screen.
  await page.locator('#close-native-terminal').click();
  const collapsed = await measure('solo-collapsed');
  // In the compact side-by-side layout the terminal takes width, not height.
  assert.ok(collapsed.contentWidth > before.contentWidth && collapsed.contentHeight >= before.contentHeight, JSON.stringify({ before, collapsed }));
  await page.locator('#terminal-tab').focus(); await page.keyboard.press('Enter'); await page.locator('#chat-tab').click();
  await measure('solo-expanded'); await aligned(a);
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  checks.push('Minimum window preserves four readable lines, input and send; hiding and restoring the terminal by pointer and keyboard keeps canonical output and unsent draft');

  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  const b = await create('codex');
  await fixture('output', b, { data: '另一个原生会话的过程\r\n'.repeat(35) });
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await page.locator('#shared-input').fill('共同讨论的草稿，不发送');
  await measure('room-compact', true); await aligned(a); await aligned(b);
  for (let n = 0; n < 3; n++) {
    const box = await page.locator('#shared-input').boundingBox();
    await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4);
    await page.mouse.down(); await page.mouse.move(box.x + box.width - 4, box.y + box.height + 56, { steps: 12 }); await page.mouse.up();
  }
  assert.ok((await page.locator('#shared-input').boundingBox()).height >= await page.evaluate(() => Math.min(190, innerHeight * .22 - 2)), 'Actual resize reaches the responsive input height limit');
  await measure('room-tall-draft', true);
  await page.locator('#room-tabs').getByRole('button', { name: 'claude · 实时过程', exact: true }).click();
  await page.locator('#terminal-area .xterm:visible').waitFor();
  assert.ok((await page.locator('#terminal-area').boundingBox()).height >= 200);
  await capture('member-terminal-compact');
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#chat-tab').click();
  await measure('solo-from-room');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  await page.locator('#room-nav').click();
  await page.locator('#room-record').click();
  assert.equal(await page.locator('#shared-input').inputValue(), '共同讨论的草稿，不发送');
  await size(1200, 900); await measure('room-wide', true);
  checks.push('Shared timeline and member conversation remain readable with both canonical live panes; switching retains separate drafts');

  await size(850, 600); await page.locator(`[data-session-id="${b}"]`).click(); await page.locator('#chat-tab').click();
  await fixture('approval', b, { requestId: 17, method: 'item/commandExecution/requestApproval', params: { command: 'echo synthetic\n'.repeat(30), cwd: '/synthetic', reason: '不执行命令，仅核对紧凑窗口' } });
  await page.locator('#approval').waitFor();
  await measure('permission-compact');
  const decision = page.locator('#approval').getByRole('button', { name: '允许这一次', exact: true });
  await decision.focus();
  assert.ok(await page.locator('#approval').evaluate(el => el.scrollTop > 0));
  await decision.click({ trial: true });
  await capture('permission-actions-reachable');
  assert.equal((await fixture()).stats.sends, 0);
  checks.push('Long confirmation scope does not consume the conversation or move the input beyond the window; no decision or task sent');

  await fixture('stop');
  await until(async () => (await snapshot()).sessions.every(s => s.state === 'ended'), 'Ended');
  await until(async () => /最后收到/.test(await panel(b).locator(':scope > summary').textContent()), 'Last frame visible after state broadcast');
  await aligned(b); await capture('ended-retained-frame');
  await page.locator(`[data-session-id="${a}"]`).click(); await page.locator('#chat-tab').click();
  await until(async () => (await panel(a).locator('.progress-notice').textContent()).includes('当前没有保留'), 'Fresh ended panel has no frame');
  assert.equal(await panel(a).locator('.progress-viewport').isHidden(), true);
  assert.equal(await panel(a).locator('.progress-controls').isHidden(), true);
  assert.equal(await panel(a).locator('.progress-trace').isHidden(), true);
  await measure('ended-no-frame');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.match(await page.locator('#messages').textContent(), /这是需要完整阅读的回答/);
  checks.push('Disconnect keeps a received last frame; selecting an ended session without a held frame shows an honest compact empty state and saved history');
  // Seed real persisted recovery copies; the UI must handle their geometry
  // independently of the separate ownership-conflict acceptance test.
  await page.evaluate(async id => {
    for (let i = 1; i <= 3; i++) await workspace.retainDraftRecovery(id, `合成待恢复副本 ${i}\n` + '保留副本正文。\n'.repeat(12));
  }, a);
  await page.reload(); await page.locator('#new-session').waitFor();
  await page.locator('#draft-recovery > summary').click();
  await page.getByRole('textbox', { name: '草稿副本 3', exact: true }).focus();
  await capture('recovery-copy-reachable');
  await page.locator('#message-input').focus();
  await page.locator('#send-button').click({ trial: true });
  await measure('recovery-input-reachable');
  assert.equal(await page.locator('#message-input').inputValue(), draft);
  assert.equal(await page.locator('.draft-recovery-text').count(), 3);
  checks.push('Expanded persisted recovery copies and original draft remain keyboard/mouse reachable without pushing controls outside the compact window');
  const stats = (await fixture()).stats;
  assert.equal(stats.opens, 1); assert.equal(stats.inputs, 0); assert.equal(stats.sends, 0);
  assert.deepEqual(errors, []);
  const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.deepEqual(windows, [{ visible: false, focusable: false }]);
  console.log(JSON.stringify({ checks, metrics, stats, windows, errors }, null, 2));
}
run().catch(async error => { console.error(error.stack); await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (application) await application.close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
  await until(() => child.exitCode !== null, 'Owned fixture daemon exits');
}));
