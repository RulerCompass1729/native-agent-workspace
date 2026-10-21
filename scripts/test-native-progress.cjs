const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork } = require('node:child_process');
const { _electron } = require('playwright');
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-progress-ui-'));
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
const panel = id => page.locator(`[data-progress-id="${id}"]`);
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check();
  await page.locator('#initial-view').selectOption('chat'); await page.locator('#session-name').fill(provider + ' · 实时过程'); await page.locator('#confirm-create').click();
  await until(async () => (await snapshot()).sessions.some(s => s.provider === provider && s.state === 'idle'), 'Created');
  const id = (await snapshot()).sessions.find(s => s.provider === provider).id;
  await until(() => panel(id).locator('.xterm').count(), 'Readonly screen'); return id;
}
async function screen(id) {
  return page.evaluate(id => {
    const t = [...window.progressTestTerminals].reverse().find(t => t.element?.closest('[data-progress-id]')?.dataset.progressId === id);
    if (!t) return null;
    const b = t.buffer.active;
    return { cols: t.cols, rows: t.rows, type: b.type, cursor: [b.cursorX, b.cursorY], lines: Array.from({ length: b.length }, (_, i) => b.getLine(i).translateToString()) };
  }, id);
}
async function aligned(id) {
  const expected = (await fixture('stats', id)).screen;
  await until(async () => JSON.stringify(await screen(id)) === JSON.stringify(expected), 'Canonical screen alignment');
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
  const a = await create('claude');
  await fixture('rawUnavailable', a, true);
  await panel(a).getByRole('button', { name: '重新连接画面', exact: true }).click();
  await until(async () => await panel(a).locator('.progress-trace').evaluate(el => el.open), 'GUI-first progress visible before a TUI exists');
  await fixture('progress', a, { id: 'before-tui', title: 'Command', status: 'running', delta: 'Visible without launching TUI' });
  await panel(a).locator('[data-item-id="before-tui"]').waitFor();
  await panel(a).locator('.progress-trace > summary').click();
  await fixture('rawUnavailable', a, false);
  // Re-enter the session to reconnect its readonly observer without a hidden
  // terminal-opening action (the current no-raw panel hides raw controls).
  await page.locator('#room-nav').click(); await page.locator(`[data-session-id="${a}"]`).click();
  await until(() => panel(a).locator('.xterm').count(), 'Existing raw terminal observed again');
  const before = await snapshot();
  await page.locator('#message-input').fill('PRIVATE-UNSENT-中文');
  await fixture('output', a, { data: '准备：你好🌳\r\nTEMPORARY' }); await aligned(a);
  const temporary = (await fixture('stats', a)).index;
  await fixture('output', a, { data: '\r\x1b[2KDONE\r\n\x1b[?1049h\x1b[31m请确认\x1b[0m' }); await aligned(a);
  await fixture('output', a, { data: '\x1b[?1049l继续\r\n', cols: 66, rows: 18 }); await aligned(a);
  assert.equal(await page.locator('#message-input').evaluate(el => document.activeElement === el), true);
  assert.equal(await page.locator('#message-input').inputValue(), 'PRIVATE-UNSENT-中文');
  await panel(a).getByRole('slider').fill(String(temporary));
  await until(async () => (await screen(a)).lines.some(line => line.includes('TEMPORARY')), 'Temporary overwritten frame retained');
  await fixture('output', a, { data: 'NEW PRIVATE OUTPUT\r\n' }); await delay(150);
  assert.ok((await screen(a)).lines.some(line => line.includes('TEMPORARY')));
  await panel(a).getByRole('button', { name: '重新连接画面', exact: true }).click(); await delay(150);
  assert.ok((await screen(a)).lines.some(line => line.includes('TEMPORARY')), 'Re-sync respects rewind');
  await panel(a).getByRole('button', { name: '回到实时', exact: true }).click(); await aligned(a);
  await fixture('hold', a); await panel(a).getByRole('button', { name: '重新连接画面', exact: true }).click();
  await until(async () => (await fixture()).waiting.includes(a), 'Observe held');
  await panel(a).getByRole('slider').fill(String(temporary));
  await fixture('release', a); await delay(200);
  assert.ok((await screen(a)).lines.some(line => line.includes('TEMPORARY')), 'Late snapshot respects newer rewind intent');
  await panel(a).getByRole('button', { name: '回到实时', exact: true }).click(); await aligned(a);
  await fixture('gap', a); await aligned(a); assert.ok(!(await screen(a)).lines.join('').includes('must-not-paint'));
  checks.push('Unicode/alternate screen/resize equals canonical; overwritten frame replay; paused rewind survives output/re-sync; gaps never paint invented data');
  await fixture('progress', a, { id: 'stable', title: 'Read', status: 'completed', text: 'SELECT-ME-PRIVATE' });
  await panel(a).locator('.progress-trace > summary').click(); await panel(a).locator('[data-item-id="stable"] > summary').click();
  await panel(a).locator('[data-item-id="stable"] pre').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await fixture('progress', a, { id: 'other', title: 'Command', status: 'running', delta: 'halfway' }); await delay(100);
  assert.equal(await page.evaluate(() => getSelection().toString()), 'SELECT-ME-PRIVATE');
  await panel(a).getByRole('slider').fill(String(temporary));
  await until(async () => (await screen(a)).lines.some(line => line.includes('TEMPORARY')), 'Rewind before navigation');
  const b = await create('codex');
  await fixture('fleet', b, { event: 'subAgentActivity', kind: 'started', nativeId: 'synthetic-child', name: '/root/check', model: 'synthetic-small' });
  await until(async () => (await page.locator('#session-status').innerText()).includes('1 个子任务进行中'), 'Root-ready status retains child activity');
  assert.equal(await panel(b).locator('[data-child-id="synthetic-child"]').innerText(), '/root/check\n任务进行中');
  await fixture('fleet', b, { event: 'TaskCompleted', id: 'synthetic-child', name: 'task-complete' });
  assert.ok((await page.locator('#session-status').innerText()).includes('1 个子任务进行中'), 'Task event is not child completion');
  await page.locator(`[data-session-id="${a}"]`).click();
  await until(async () => (await screen(a))?.lines.some(line => line.includes('TEMPORARY')), 'Rewind survives session switch');
  await panel(a).getByRole('button', { name: '回到实时', exact: true }).click(); await aligned(a);
  await page.locator(`[data-session-id="${b}"]`).click();
  await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator(`[data-session-id="${a}"]`).click(); await page.getByRole('button', { name: '加入协作', exact: true }).click();
  await page.locator('#room-nav').click(); await page.locator('#room-record').click();
  await until(async () => await page.locator('#room-progress .xterm').count() === 2, 'Both observers visible');
  const nativeRowId = require('node:crypto').randomUUID();
  await fixture('nativeObservation', a, { id: nativeRowId, kind: 'response', text: 'PRIVATE_INTERMEDIATE <script>literal text</script>', truncated: true, gap: true });
  await fixture('nativeObservation', a, { id: nativeRowId + ':0', kind: 'tool-output', title: 'Read', text: 'PRIVATE_TOOL_OUTPUT', nonText: true });
  const trace = panel(a).locator('.progress-trace');
  if (await trace.getAttribute('open') === null) await trace.locator(':scope > summary').click();
  const nativeRow = panel(a).locator(`[data-item-id="claude-row-${nativeRowId}"]`);
  await nativeRow.locator(':scope > summary').click();
  assert.equal(await nativeRow.locator('script').count(), 0);
  assert.ok((await nativeRow.locator('pre').innerText()).includes('仅显示最近输出'));
  assert.ok((await nativeRow.locator('pre').innerText()).includes('PRIVATE_INTERMEDIATE <script>literal text</script>'));
  const toolRow = panel(a).locator(`[data-item-id="claude-row-${nativeRowId}:0"]`);
  await toolRow.locator(':scope > summary').click();
  assert.ok((await toolRow.locator('pre').innerText()).includes('PRIVATE_TOOL_OUTPUT\n含非文本结果'));
  assert.equal(await panel(a).getByText('部分原生消息未能同步', { exact: false }).count(), 1);
  assert.equal(await panel(b).locator(`[data-item-id="claude-row-${nativeRowId}"]`).count(), 0);
  assert.ok(!(await snapshot()).room.messages.some(m => String(m.text).includes('PRIVATE_INTERMEDIATE')));
  await capture('native-message-details');
  checks.push('Native saved message/tool text is readable only in its private member trace, safely literal, with explicit truncation/media/gap notices');
  assert.ok((await panel(b).locator(':scope > summary').innerText()).includes('1 个子任务进行中'));
  assert.equal(await panel(b).locator('[data-child-id="synthetic-child"]').innerText(), '/root/check\n任务进行中');
  await fixture('connection', b, 'disconnected'); await fixture('connection', b, 'idle');
  await until(async () => (await panel(b).locator('[data-child-id="synthetic-child"]').innerText()).includes('状态待核对'), 'Reconnect cannot turn historical child state into live evidence');
  await fixture('fleet', b, { event: 'subAgentActivity', kind: 'completed', nativeId: 'synthetic-child', name: '/root/check' });
  await until(async () => (await panel(b).locator('[data-child-id="synthetic-child"]').innerText()).includes('本轮已结束'), 'Only native child completion updates its row');
  assert.ok((await panel(b).locator(':scope > summary').innerText()).includes('主会话就绪'));
  assert.ok(!(await snapshot()).room.messages.some(m => String(m.text).includes('/root/check')), 'Private team observations are never shared messages');
  checks.push('Solo and room retain observed native child state; unrelated task completion cannot finish a child; reconnect marks stale until a new native lifecycle event; no shared payload or model query');
  await until(async () => await panel(b).locator('.progress-viewport').evaluate(el => el.scrollHeight <= el.clientHeight || el.scrollTop + el.clientHeight >= el.scrollHeight - 4), 'New live view starts at current output');
  await panel(b).locator('.progress-viewport').evaluate(el => { el.scrollTop = 0; }); await delay(80);
  await fixture('output', b, { data: 'Keep reading above\r\n' }); await aligned(b);
  assert.equal(await panel(b).locator('.progress-viewport').evaluate(el => el.scrollTop), 0, 'Output does not pull a manual reader down');
  await panel(b).getByRole('button', { name: '回到实时', exact: true }).click();
  await until(async () => await panel(b).locator('.progress-viewport').evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 4), 'Return live restores bottom follow');
  await page.locator('#shared-input').fill('ROOM-DRAFT-NOT-SENT');
  await page.locator('#shared-input').evaluate(el => { window.preReconnectComposer = el; el.dispatchEvent(new CompositionEvent('compositionstart', { data: '中', bubbles: true })); });
  const replacementState = await snapshot();
  await application.evaluate(({ BrowserWindow }, state) => BrowserWindow.getAllWindows()[0].webContents.send('workspace:reconnected', state), replacementState);
  await delay(120);
  assert.equal(await page.locator('#shared-input').evaluate(el => el === window.preReconnectComposer && el === document.activeElement), true, 'Targeted reconnect retains composer DOM and focus');
  assert.equal(await page.locator('#shared-input').inputValue(), 'ROOM-DRAFT-NOT-SENT');
  await page.locator('#shared-input').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { data: '中', bubbles: true })));
  const roomBefore = await snapshot();
  const resourceSample = () => application.evaluate(({ app }) => app.getAppMetrics().map(({ type, cpu, memory }) => ({ type, cpuPercent: cpu.percentCPUUsage, workingSetKiB: memory.workingSetSize })));
  const resourcesBefore = await resourceSample();
  const burst = Array.from({ length: 100 }, (_, i) => ({ data: `step ${i} 中文\r\n`, delay: 8 }));
  await Promise.all([fixture('burst', a, burst), fixture('burst', b, burst)]); await aligned(a); await aligned(b);
  assert.equal(await page.locator('#shared-input').inputValue(), 'ROOM-DRAFT-NOT-SENT');
  assert.equal(await page.locator('#shared-input').evaluate(el => document.activeElement === el), true);
  const roomAfter = await snapshot();
  assert.deepEqual(roomAfter.room.messages, roomBefore.room.messages);
  assert.deepEqual(roomAfter.sessions.map(s => [s.id, s.nativeId, s.owner, s.controlRevision]), roomBefore.sessions.map(s => [s.id, s.nativeId, s.owner, s.controlRevision]));
  assert.deepEqual((await fixture()).stats, { opens: 0, inputs: 0, resizes: 0, sends: 0 });
  const latencies = await page.evaluate(() => progressTestLatencies.sort((a,b) => a-b));
  assert.ok(latencies.length >= 20); const p95 = latencies[Math.floor(latencies.length * .95)]; assert.ok(p95 <= 200, `paint p95 ${p95} ms`);
  checks.push('Two private live observers preserve room records/drafts/focus/control/native IDs; no input/open/resize/model dispatch; output selection survives unrelated progress');
  await capture('two-private-live-streams');
  await fixture('burst', a, Array.from({ length: 1250 }, (_, i) => ({ data: `bounded ${i}\r\n` })));
  await aligned(a); await panel(a).locator('.progress-notice').getByText('仅保留最近', { exact: false }).waitFor();
  assert.ok((await panel(a).getByRole('slider').getAttribute('min')) !== '0');
  for (let i = 0; i < 90; i++) await fixture('progress', a, { id: 'large-' + i, title: 'tool', text: '字'.repeat(12000) });
  await until(async () => await panel(a).locator('.progress-trace > div > details').count() < 40, 'Evicted structured items removed');
  assert.ok(!fs.readFileSync(path.join(profile, 'workspace.json'), 'utf8').includes('SELECT-ME-PRIVATE'));
  checks.push('Retention overrun explicitly checkpoints; structured eviction mirrored; raw/tool observations not persisted');
  // Exercise the legacy frame contract in the actual renderer/xterm. This is
  // synthetic transport, not a claim of physical mouse/IME input or old-daemon proof.
  await fixture('legacyFrames', b);
  await panel(b).getByRole('button', { name: '重新连接画面', exact: true }).click();
  await fixture('output', b, { data: '\x1bcSELECT-LEGACY\r\n' }); await aligned(b);
  const selection = () => page.evaluate(id => [...progressTestTerminals].reverse().find(t => t.element?.isConnected && t.element.closest('[data-progress-id]')?.dataset.progressId === id).getSelection(), b);
  await page.evaluate(id => [...progressTestTerminals].reverse().find(t => t.element?.isConnected && t.element.closest('[data-progress-id]')?.dataset.progressId === id).select(0, 0, 13), b);
  assert.equal(await selection(), 'SELECT-LEGACY');
  await fixture('output', b, { data: 'NEW FULL FRAME\r\n', cols: 72, rows: 20 }); await delay(120);
  assert.equal(await selection(), 'SELECT-LEGACY');
  assert.ok(!(await screen(b)).lines.join('').includes('NEW FULL FRAME'));
  await panel(b).getByRole('button', { name: '重新连接画面', exact: true }).click(); await delay(120);
  assert.equal(await selection(), 'SELECT-LEGACY');
  await panel(b).getByRole('button', { name: '回到实时', exact: true }).click(); await aligned(b);
  checks.push('Legacy full-frame output/resize/reconnect preserve the selected frame; explicit live action returns to canonical screen');
  await fixture('hold', a); await panel(a).getByRole('button', { name: '重新连接画面', exact: true }).click();
  await until(async () => (await fixture()).waiting.includes(a), 'Old observation held');
  await fixture('connection', a, 'disconnected');
  await panel(a).locator('.progress-notice').getByText('连接已断开', { exact: false }).waitFor();
  assert.equal(await panel(a).getByRole('button', { name: '重新连接画面', exact: true }).isDisabled(), true);
  await panel(a).getByRole('button', { name: '最后画面', exact: true }).click();
  await panel(a).locator('.progress-controls > span').getByText('最后画面', { exact: true }).waitFor();
  await fixture('connection', a, 'idle');
  await fixture('output', a, { data: '\x1bcNEW CONNECTION CONTENT\r\n' });
  await fixture('release', a); await aligned(a);
  await until(() => panel(a).locator('.progress-notice').innerText().then(text => !text.includes('停止同步')), 'New connection observed');
  assert.equal(await panel(a).getByRole('button', { name: '重新连接画面', exact: true }).isDisabled(), false);
  checks.push('Session disconnect labels its frozen observation; old snapshot cannot overwrite a later connection; same panel refreshes after reconnect');
  await fixture('hold', a); await panel(a).getByRole('button', { name: '重新连接画面', exact: true }).click();
  await until(async () => (await fixture()).waiting.includes(a), 'Observe held before disconnect');
  await fixture('progress', a, { id: 'queued-disconnected', title: 'Must not show after disconnect', status: 'running' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('workspace:disconnected', 'Synthetic disconnect'));
  await fixture('release', a); await delay(150);
  await panel(a).locator('.progress-notice').getByText('连接已断开', { exact: false }).waitFor();
  assert.equal(await panel(a).locator('[data-item-id="queued-disconnected"]').count(), 0);
  await fixture('progress', b, { id: 'peer-disconnected', title: 'Peer still connected', status: 'running' }); await delay(80);
  assert.equal(await panel(b).locator('[data-item-id="peer-disconnected"]').count(), 0);
  checks.push('Late observation snapshots cannot overwrite newer rewind or conceal disconnection');
  assert.deepEqual(errors, []); assert.equal(application.windows().length, 1);
  console.log(JSON.stringify({ checks, p95Ms: p95, samples: latencies.length, resourcesBefore, resourcesAfter: await resourceSample(), stats: (await fixture()).stats, errors, modelTasks: 0, visibleOSInput: false }, null, 2));
}
run().catch(async error => { console.error(error.stack); await capture('failed'); process.exitCode = 1; }).finally(async () => {
  if (application) await application.close();
  if (client) { await fixture('stop'); await client.call('shutdown'); client.close(); }
  if (child.connected) child.disconnect();
});
