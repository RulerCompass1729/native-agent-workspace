// Real browser DOM, actual task-board (R250: it holds what waits for you) and question-form sources, synthetic
// state/answer transport. No model, daily app, listener or external request.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const section = (from, to) => renderer.slice(renderer.indexOf(from), renderer.indexOf(to, renderer.indexOf(from)));
let browser, passed = 0;
const check = (name, ok) => { assert.ok(ok, name); console.log('PASS', name); passed++; };
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.NAW_CHROMIUM_EXECUTABLE });
  const context = await browser.newContext();
  const errors = []; context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  await page.setContent('<div id="header"></div><div id="header-actions"></div><div id="room-layout"></div><button id="room-record"></button><div id="task-board"></div>');
  for (const file of ['approval-policy.js', 'task-stream.js', 'renderer/disclosure-list.js', 'renderer/activity-stream.js', 'renderer/task-board.js']) await page.addScriptTag({ content: fs.readFileSync(path.join(root, 'app', file), 'utf8') });
  await page.addScriptTag({ content: `
    const owner = 'human', disconnected = false;
    let state = { capabilities: ['nativeQuestionAnswer'], sessions: [
      { id: 'a', nativeId: 'native-a', name: 'A', provider: 'codex', owner, state: 'working', approvals: [
        { requestId: 'q1', receivedAt: 1, method: 'item/tool/requestUserInput', params: { isBlocking: false,
          questions: [{ id: 'q', header: 'Choice', question: 'Which way?', isOther: true, options: [{ label: 'First', description: '' }] }] } }
      ] }, { id: 'b', nativeId: 'native-b', name: 'B', state: 'approval' }
    ] };
    const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
    const uiText = key => key, uiNode = (tag, key) => node(tag, key), ui = { display: { attribute: (n, key, value) => n.setAttribute(key, value) } };
    const uiButton = (key, action) => { const b = node('button', key); b.type = 'button'; b.onclick = action; return b; };
    const answers = [], api = { answer: (id, requestId, value) => { answers.push({ id, requestId, value }); state.sessions[0].approvals = []; stream.render(); } };
    const appendNativeQuestions = () => {};
    ${section('function appendQuestionForm(', 'function nativeApprovalPreview(')}
    ${section('function renderWaitingQuestion(', 'function renderApproval(')}
    const board = nativeWorkspaceTaskBoard.bind({ host: document.getElementById('task-board'), document, text: key => key,
      onWaiting: (slot, item) => { if (item.kind === 'question') renderWaitingQuestion(slot.question, item); } });
    board.update({ rooms: [], sessions: [], connected: true, confirmations: [], confirmationsAvailable: true });
    const stream = nativeWorkspaceActivityStream.bind({ document, state: () => state, rooms: () => [], inRoom: () => false,
      text: key => key, language: () => 'zh', connected: () => true, attempt: f => f(), toggleChanged: () => {},
      question: renderWaitingQuestion, waitingChanged: items => board.setWaiting(items) });
    stream.render(); window.probe = { state, stream, answers };
  ` });
  // The question opens in place in its board row (R250 A).
  const row = page.locator('#task-board-panel .task-board-task:has(.task-board-entry[data-item-id="question:a:q1"])');
  const reopen = async () => { if (!await page.locator('#task-board-panel').isVisible()) await page.locator('.task-board-toggle').click(); await row.locator('.task-board-entry').click(); await row.locator('.question-form').waitFor(); };
  await reopen();
  const input = row.locator('input[type="text"]'), submit = row.locator('.question-form > button');
  const original = '  半句原文 / not sent  ';
  await input.fill(original);
  await input.evaluate(n => { window.originalInput = n; n.setSelectionRange(3, 7); });
  await page.evaluate(() => { probe.state.sessions[1].name = 'B renamed'; probe.stream.render(); });
  check('an unrelated approval refresh preserves the exact typed answer', await input.inputValue() === original);
  check('the same input stays connected and focused with its selection', await input.evaluate(n => n === originalInput && document.activeElement === n && n.selectionStart === 3 && n.selectionEnd === 7));
  await page.keyboard.press('Escape'); await page.locator('#task-board-panel').waitFor({ state: 'hidden' }); await reopen();
  check('closing and reopening the board preserves the draft', await input.inputValue() === original);
  await page.evaluate(() => {
    const other = structuredClone(probe.state.sessions[0]); other.id = 'c'; other.nativeId = 'native-c';
    other.approvals[0].requestId = 'q2'; other.approvals[0].receivedAt = 2;
    probe.state.sessions.push(other); probe.stream.render();
  });
  check('another question arriving leaves the original input connected', await input.evaluate(n => n === originalInput && n.value === '  半句原文 / not sent  '));
  await page.evaluate(() => { probe.state.sessions = probe.state.sessions.filter(s => s.id !== 'c'); probe.stream.render(); });
  check('removing another question preserves the draft', await input.inputValue() === original);
  await page.evaluate(() => { probe.state.sessions[0].owner = 'another-window'; probe.stream.render(); });
  check('owner change disables the answer without discarding it', await input.isDisabled() && await submit.isDisabled() && await input.inputValue() === original);
  await page.evaluate(() => { probe.state.sessions[0].owner = 'human'; probe.state.sessions[0].state = 'idle'; probe.stream.render(); });
  check('returning ownership and ending the turn preserves an answerable draft', await input.isEnabled() && await submit.isEnabled() && await input.inputValue() === original);
  await page.evaluate(() => { probe.state.sessions[0].nativeId = 'replacement-native'; probe.stream.render(); });
  check('native replacement cannot inherit the old question draft', await input.inputValue() === '' && await input.evaluate(n => n !== originalInput));
  await input.fill(original);
  await submit.click();
  const sent = await page.evaluate(() => probe.answers);
  check('one click sends the original question answer once', sent.length === 1 && sent[0].requestId === 'q1' && sent[0].value.q[0] === original.trim());
  check('answered question and cached draft disappear', await row.count() === 0);
  await page.evaluate(() => probe.stream.render());
  check('later refresh never resends the answer', await page.evaluate(() => probe.answers.length) === 1);
  check('no page errors', errors.length === 0);
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(scratch.cleanup(async () => {
  if (browser) await browser.close();
  console.log(`NONBLOCKING DRAFT PASS ${passed} FAIL ${process.exitCode ? 1 : 0} SKIP 0`);
}));
