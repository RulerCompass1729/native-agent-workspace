const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Real hidden Electron/DSH UI and service; synthetic history/output, no models.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { fork, execFileSync } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const historyCount = process.env.NAW_READING_LONG === '1' ? 2480 : 240;
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-reading-profile-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const delay = ms => new Promise(r => setTimeout(r, ms));
let app, page, client, sequence = 0;
const observations = [], errors = [], resources = [];
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 10000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor();
  // Capture app Copy payloads without touching the person's active clipboard.
  await app.evaluate(({ clipboard }) => { globalThis.copiedText = []; clipboard.writeText = text => globalThis.copiedText.push(text); });
}
async function create(name) {
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check();
  await page.locator('#session-name').fill(name); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.some(s => s.name === name && s.state === 'idle'), 'Created');
  return (await snapshot()).sessions.find(s => s.name === name).id;
}
const historical = () => page.locator('#messages [data-message-id="history-40"]');
async function markReading() {
  await historical().locator('.message-body p').first().scrollIntoViewIfNeeded();
  const box = await historical().locator('.message-body p').first().boundingBox(); assert.ok(box);
  await page.mouse.click(box.x + 25, box.y + 9, { clickCount: 3 });
  return page.evaluate(() => ({ selection: window.getSelection().toString(), scroll: document.getElementById('messages').scrollTop }));
}
async function resource(label) {
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(m => ({ type: m.type, cpu: m.cpu, memory: m.memory })));
  const daemon = execFileSync('ps', ['-p', String(child.pid), '-o', 'rss=,time='], { encoding: 'utf8' }).trim();
  resources.push({ label, time: Date.now(), electron: metrics, syntheticDaemonRssKiBAndCpuTime: daemon });
}
async function run() {
  console.log('Synthetic reading profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service'); client = await connect(profile, 'reading-observer'); await launch();
  const id = await create('持续阅读'), other = await create('另一个会话');
  await page.locator(`[data-session-id="${id}"]`).click(); await resource('empty');
  const history = Array.from({ length: historyCount }, (_, i) => ({ id: `history-${i}`, type: 'agentMessage', turnId: `history-turn-${i}`, text: `Reading record ${i}. 保留这段历史，不应被新的输出打断。\n\n**已完成的内容**\n\n${'这是一段用于连续阅读测试的合成正文。 '.repeat(12)}\n\n\`\`\`js\nconst record = ${i};\n\`\`\`` }));
  const began = Date.now(); await fixture('history', id, history);
  await page.locator(`#messages [data-message-id="history-${historyCount - 1}"] .message-body p`).first().waitFor();
  await until(() => page.locator('#messages .message-body p').count().then(n => n >= historyCount * 2), 'Markdown history mounted');
  const markdownBody = page.locator(`#messages [data-message-id="history-${historyCount - 1}"] .message-body`);
  assert.equal(await markdownBody.evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
  const codeWhitespace = await markdownBody.locator('pre').first().evaluate(el => getComputedStyle(el).whiteSpace);
  assert.ok(['pre', 'pre-wrap', 'break-spaces'].includes(codeWhitespace), 'Code retains its own whitespace semantics');
  assert.match(await markdownBody.locator('pre').first().innerText(), new RegExp(`const record = ${historyCount - 1};`));
  observations.push({check:'Markdown paragraphs avoid duplicate whitespace; code formatting stays intact',pass:true});
  await resource('history-loaded');
  const initialLoadMs = Date.now() - began;
  await until(() => page.locator('#messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 3), 'Initial history follows latest output');
  // "Jump to latest" appears only after leaving the newest output and returns there.
  const jump = page.locator('#messages').getByRole('button', { name: '↓ 跳到最新', exact: true });
  assert.equal(await jump.isVisible(), false);
  await page.locator('#messages').evaluate(el => { el.scrollTop = 0; });
  await jump.waitFor({ state: 'visible' });
  if (process.env.NAW_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'jump-latest.png') });
  await jump.click();
  await until(() => page.locator('#messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 3), 'Jump returns to the latest output');
  await jump.waitFor({ state: 'hidden' });
  observations.push({ check: 'jump to latest appears after scrolling up and returns to the newest output', pass: true });
  let typedDraft;
  if (historyCount > 240) {
    const input = page.locator('#message-input');
    const text = 'Typing in a long running developer conversation.';
    const beganTyping = Date.now();
    await input.pressSequentially(text, { delay: 10 });
    const elapsedMs = Date.now() - beganTyping;
    assert.equal(await input.inputValue(), text);
    assert.ok(elapsedMs < 3500, `Long-history input took ${elapsedMs} ms`);
    await input.press('ArrowLeft'); await input.press('ArrowLeft'); await input.press('ArrowLeft');
    await delay(350); await input.pressSequentially('X');
    typedDraft = text.slice(0, -3) + 'X' + text.slice(-3);
    assert.equal(await input.inputValue(), typedDraft, 'Middle insertion keeps the GUI caret');
    await until(async () => (await client.call('initial')).sessions.find(s => s.id === id).liveDraft === typedDraft, 'Immediate draft persistence');
    observations.push({ check: 'Long-history typing and middle insertion preserve exact saved text', pass: true, historyCount, elapsedMs });
    console.log(JSON.stringify(observations.at(-1)));
  }
  const before = await markReading(); assert.ok(before.selection.includes('Reading record 40.'), 'Pointer selects actual paragraph');
  await page.evaluate(() => { window.readingMutations = 0; window.readingObserver = new MutationObserver(changes => { for (const c of changes) window.readingMutations += c.removedNodes.length; }); window.readingObserver.observe(document.getElementById('messages'), { childList: true }); });
  const started = Date.now();
  for (let i = 0; i < 24; i++) { await fixture('delta', id, { id: 'live-reply', text: `Live update ${i}.\n` }); await delay(40); }
  await page.locator('#messages [data-message-id="live-reply"]').getByText('Live update 23.', { exact: false }).waitFor();
  const lineGeometry = await page.locator('#messages [data-message-id="live-reply"] .message-body').evaluate(el => {
    const positions = {};
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let node;
    while ((node = walker.nextNode())) for (const text of ['Live update 0.', 'Live update 1.']) {
      const at = node.textContent.indexOf(text); if (at < 0) continue;
      const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + text.length);
      positions[text] = range.getBoundingClientRect().top;
    }
    return { positions, text: el.textContent, html: el.innerHTML };
  });
  assert.ok(lineGeometry.positions['Live update 1.'] - lineGeometry.positions['Live update 0.'] > 10,
    'Native newline stays a visible line break in the unified reader: ' + JSON.stringify(lineGeometry));
  observations.push({check:'Native single newlines remain visible during streaming',pass:true});
  const after = await page.evaluate(() => ({ selection: window.getSelection().toString(), scroll: document.getElementById('messages').scrollTop, removed: window.readingMutations }));
  observations.push({ check: 'reading selection survives another message streaming', pass: after.selection === before.selection, before: before.selection, after: after.selection });
  observations.push({ check: 'reading position remains stable during streaming', pass: Math.abs(after.scroll - before.scroll) < 3, before: before.scroll, after: after.scroll });
  const copy = historical().locator('.message-actions').getByRole('button', { name: '复制', exact: true }); await copy.focus();
  await fixture('delta', id, { id: 'live-reply', text: 'More while copying.\n' }); await delay(120);
  observations.push({ check: 'historical action retains keyboard focus during streaming', pass: await copy.evaluate(el => document.activeElement === el) });
  await copy.click(); assert.equal(await app.evaluate(() => globalThis.copiedText.at(-1)), history[40].text, 'Copy uses exact historical text');
  const liveCopy = page.locator('#messages [data-message-id="live-reply"] .message-actions').getByRole('button', { name: '复制', exact: true });
  await page.locator('#messages [data-message-id="live-reply"]').hover(); await liveCopy.click();
  assert.equal(await app.evaluate(() => globalThis.copiedText.at(-1)), (await snapshot()).sessions.find(s => s.id === id).messages.find(m => m.id === 'live-reply').text, 'Reused action copies latest streaming payload');
  await resource('stream-complete');
  const outputElapsedMs = Date.now() - started;
  const readPosition = (await markReading()).scroll;
  await page.locator('#terminal-tab').click();
  await until(async () => (await fixture('stats')).pending.includes(id), 'Terminal attachment'); await fixture('release', id);
  await page.locator('#chat-tab').click(); await delay(150);
  observations.push({ check: 'returning from native view restores reading position', pass: Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - readPosition) < 3, expected: readPosition, actual: await page.locator('#messages').evaluate(el => el.scrollTop), saved: (await snapshot()).viewState.readingPositions });
  await page.locator(`[data-session-id="${other}"]`).click(); await page.locator(`[data-session-id="${id}"]`).click(); await delay(200);
  observations.push({ check: 'returning from another conversation restores reading position', pass: Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - readPosition) < 3, expected: readPosition, actual: await page.locator('#messages').evaluate(el => el.scrollTop), saved: (await snapshot()).viewState.readingPositions });
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'reading.png') }); }
  await app.close(); app = null; await launch(); await delay(300);
  observations.push({ check: 'reopening restores the selected conversation and reading position', pass: (await snapshot()).viewState.selected === id && Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - readPosition) < 3 });
  if (typedDraft) assert.equal(await page.locator('#message-input').inputValue(), typedDraft, 'Draft survives view/session switching and app reopening');
  await page.locator('#message-input').click(); await page.locator('#messages').hover(); await page.mouse.wheel(0, await page.locator('#messages').evaluate(el => el.scrollHeight));
  await until(() => page.locator('#messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 3), 'Pointer scroll to latest');
  await fixture('delta', id, { id: 'follow-reply', text: 'Follow newest output.\n\n'.repeat(24) }); await delay(150);
  observations.push({ check: 'new output follows when already at the bottom', pass: await page.locator('#messages').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 3) });
  await page.locator('#messages').hover(); await page.mouse.wheel(0, -await page.locator('#messages').evaluate(el => el.scrollHeight));
  await until(() => page.locator('#messages').evaluate(el => el.scrollTop === 0), 'Pointer scroll to oldest');
  await fixture('delta', id, { id: 'follow-reply', text: 'More below the oldest record.\n\n' }); await delay(150);
  observations.push({ check: 'new output never pulls the reader away from the oldest record', pass: await page.locator('#messages').evaluate(el => el.scrollTop === 0) });
  // Start a large layout update and immediately change sessions. Late commits
  // belong to their source view, not the newly selected conversation.
  await fixture('delta', id, { id: 'follow-reply', text: '**Late layout**\n\n'.repeat(120) });
  await page.locator(`[data-session-id="${other}"]`).click(); await delay(150);
  observations.push({ check: 'late output does not populate, scroll or take focus in another conversation', pass: await page.locator('#messages').evaluate(el => el.scrollTop === 0 && el.querySelectorAll('article').length === 0 && document.activeElement === document.getElementById('message-input')) });
  for (let i = 0; i < 6; i++) { await page.locator(`[data-session-id="${id}"]`).click(); await page.locator(`#messages [data-message-id="history-${historyCount - 1}"] .message-body p`).first().waitFor(); await page.locator(`[data-session-id="${other}"]`).click(); }
  await resource('after-six-conversation-roundtrips');
  await page.locator(`[data-session-id="${id}"]`).click(); await historical().locator('.message-body p').first().waitFor(); await markReading();
  // Hold only the main-process disk coalescer. Scroll still travels through real
  // pointer events, IPC and memory; normal quit must flush it before the timer.
  await app.evaluate(() => { const original = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...args) => original(fn, ms === 150 ? 60000 : ms, ...args); });
  await page.locator('#messages').hover(); await page.mouse.wheel(0, 137);
  let closingPosition;
  await until(async () => { closingPosition = await page.locator('#messages').evaluate(el => el.scrollTop); return Math.abs(closingPosition - readPosition) > 10 && (await snapshot()).viewState.readingPositions[id]?.top === closingPosition; }, 'Scroll reached main while disk save is held');
  await app.close(); app = null; await launch(); await delay(200);
  observations.push({ check: 'quit flushes the latest scroll before a pending disk-save timer', pass: Math.abs(await page.locator('#messages').evaluate(el => el.scrollTop) - closingPosition) < 3 });
  const persisted = (await snapshot()).viewState;
  const rejected = await page.evaluate(async () => {
    const old = (await workspace.initial()).viewState;
    try { await workspace.viewState({ ...old, readingPositions: { invalid: { top: -1, offset: 0, follow: true, anchor: '' } } }); return false; }
    catch { return JSON.stringify((await workspace.initial()).viewState) === JSON.stringify(old); }
  });
  observations.push({ check: 'invalid reading metadata is rejected without changing saved view state', pass: rejected });
  assert.ok(JSON.stringify(persisted.readingPositions).length < 1000, 'Only bounded geometry, no transcript or selected text');
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })));
  assert.equal(windows.length, 1); assert.ok(windows.every(w => !w.visible && !w.focusable));
  const final = await snapshot(); assert.equal(final.diagnostics.dispatches, 0);
  console.log(JSON.stringify({ observations, errors, historyMessages: history.length, initialLoadMs, outputElapsedMs, removedHistoricalNodes: after.removed, resources, windows, modelTasks: 0, nativeProviderProcesses: 0, clipboard: 'app Copy payload intercepted; system clipboard unchanged' }, null, 2));
  assert.deepEqual(errors, []); assert.ok(observations.every(o => o.pass), 'Reading continuity checks');
}
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) console.log(JSON.stringify(await page.evaluate(() => ({ errors: document.getElementById('toast')?.textContent, selected: document.querySelector('[data-session-id].active')?.dataset.sessionId, hidden: document.getElementById('messages')?.hidden, body: document.querySelector('#messages .message-body')?.outerHTML.slice(0, 1500), messages: document.querySelectorAll('#messages article').length })))); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try { if (app) await app.close(); if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } }
  finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
}));
