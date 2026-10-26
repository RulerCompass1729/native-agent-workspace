const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Chromium event-path regression. Synthetic native transport; not physical IME.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { fork, execFileSync } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-ime-profile-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, sequence = 0; const errors = [], passed = [], skipped = [];
let osReturnAttempt = false;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 200; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = m => { if (m.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(m); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 5000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function run() {
  console.log('Synthetic IME profile:', profile);
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service'); client = await connect(profile, 'ime-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check(); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.length === 1, 'Session'); const id = (await snapshot()).sessions[0].id;
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await createIn(page, 'chat');
  await until(async () => (await snapshot()).sessions.length === 2, 'Second session');
  const other = (await snapshot()).sessions.find(s => s.id !== id).id;
  await page.locator(`[data-session-id="${id}"]`).click(); await page.keyboard.type('FIRST-A');
  assert.equal(await page.locator('#message-input').inputValue(), 'FIRST-A', 'Sidebar selection must accept immediate input without an extra click');
  await page.locator(`[data-session-id="${other}"]`).click(); await page.keyboard.type('FIRST-B');
  assert.equal(await page.locator('#message-input').inputValue(), 'FIRST-B');
  await page.locator(`[data-session-id="${id}"]`).click();
  assert.equal(await page.locator('#message-input').inputValue(), 'FIRST-A');
  passed.push('Immediate typing after sidebar selection goes to the selected conversation, retaining each draft');
  await page.locator('#terminal-tab').click(); await until(async () => (await fixture()).pending.includes(id), 'Terminal'); await fixture('release', id);
  const input = page.locator(`[data-terminal-id="${id}"] .xterm-helper-textarea`);
  await until(() => input.evaluate(el => document.activeElement === el), 'Focused terminal');
  const cdp = await page.context().newCDPSession(page);
  await input.evaluate(el => { window.syntheticTrace = []; for (const name of ['compositionstart', 'compositionend', 'keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'blur', 'focus']) el.addEventListener(name, event => window.syntheticTrace.push({ type: event.type, key: event.key, isComposing: event.isComposing, data: event.data, value: el.value, active: document.activeElement === el }), true); });
  for (const isComposing of Array.from({ length: Number(process.env.NAW_IME_CYCLES || 2) }, (_, i) => i % 2 === 0)) {
    const before = (await fixture()).inputs.length;
    const traceBefore = await page.evaluate(() => window.syntheticTrace.length);
    await cdp.send('Input.imeSetComposition', { text: '候选中文', selectionStart: 4, selectionEnd: 4 });
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, isComposing, bubbles: true, cancelable: true });
    await delay(100);
    const ended = await page.evaluate(n => window.syntheticTrace.slice(n).filter(e => e.type === 'compositionend'), traceBefore);
    assert.ok(ended.length <= 1, 'At most one browser commit');
    // Chromium may itself commit the candidate on this Enter. That is valid
    // text input, never permission to send a CR/native task. Only compare to
    // the observed compositionend, not an assumed CDP event sequence.
    const committed = ended.length ? ended[0].data : '确认中文';
    assert.equal((await fixture()).inputs.slice(before).map(x => x.data).join(''), ended.length ? committed : '', 'No text before the browser commits; no terminal CR during confirmation');
    if (!ended.length) await cdp.send('Input.insertText', { text: committed });
    await until(async () => (await fixture()).inputs.slice(before).map(x => x.data).join('') === committed, 'One committed phrase');
    await input.dispatchEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13, bubbles: true, cancelable: true });
    await input.dispatchEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
    await delay(80); assert.equal((await fixture()).inputs.slice(before).map(x => x.data).join(''), committed, 'The confirmation keypress after compositionend cannot send CR');
    // A subsequent, separate Enter must still pass through, exactly once.
    await page.keyboard.press('Enter');
    await until(async () => (await fixture()).inputs.slice(before).map(x => x.data).join('') === committed + '\r', 'Separate Enter sends one CR');
  }
  // No wait-for-focus after these clicks: reproduce the person's actual sequence.
  await page.locator('#chat-tab').click(); await page.keyboard.type('-GUI-NOW');
  assert.equal(await page.locator('#message-input').inputValue(), 'FIRST-A-GUI-NOW');
  await page.locator('#terminal-tab').click(); await page.keyboard.type('A-NOW');
  await until(async () => (await fixture()).inputs.some(x => x.id === id && x.data === 'A'), 'Immediate native text');
  await page.locator(`[data-session-id="${other}"]`).click(); await page.locator('#terminal-tab').click();
  await until(async () => (await fixture()).pending.includes(other), 'Second terminal initial attachment'); await fixture('release', other);
  const otherInput = page.locator(`[data-terminal-id="${other}"] .xterm-helper-textarea`);
  await until(() => otherInput.evaluate(el => document.activeElement === el), 'Second terminal ready once');
  await fixture('terminal', other, { data: '', sequence: 1, keyboardFlags: 1 }); await delay(100);
  const enhancedBase = (await fixture()).inputs.length;
  for (const key of ['Shift+Enter', 'Control+/', 'Control+Shift+a', 'Control+Alt+v']) await otherInput.press(key);
  await until(async () => (await fixture()).inputs.slice(enhancedBase).map(x => x.data).join('') === '\x1b[13;2u\x1b[47;5u\x1b[97;6u\x1b\x16', 'Native enhanced keys preserve Option character input');
  const layoutBase = (await fixture()).inputs.length;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 1, key: '@', code: 'KeyL', windowsVirtualKeyCode: 76, text: '@', unmodifiedText: 'l' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: '@', code: 'KeyL', windowsVirtualKeyCode: 76 });
  await until(async () => (await fixture()).inputs.slice(layoutBase).map(x => x.data).join('') === '@', 'Layout Option+L types @ rather than Alt+L');
  const layoutShortcutBase = (await fixture()).inputs.length;
  await otherInput.dispatchEvent('keydown', { key: 'Q', code: 'KeyA', keyCode: 65, which: 65, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  await until(async () => (await fixture()).inputs.slice(layoutShortcutBase).map(x => x.data).join('') === '\x1b[113;6u', 'Modified letter follows logical keyboard layout');
  await page.locator('#chat-tab').click(); await page.locator('#terminal-tab').click();
  await until(() => otherInput.evaluate(el => document.activeElement === el), 'Original native input after layout check');
  const markedBase = (await fixture()).inputs.length;
  await cdp.send('Input.imeSetComposition', { text: '选择中文', selectionStart: 4, selectionEnd: 4 });
  await otherInput.dispatchEvent('keydown', { key: 'a', code: 'KeyA', keyCode: 65, which: 65, ctrlKey: true, shiftKey: true, isComposing: true, bubbles: true, cancelable: true });
  await delay(80);
  assert.ok((await fixture()).inputs.slice(markedBase).every(item => !/[\r\x1b]/.test(item.data)), 'Composing modifiers cannot bypass the IME barrier');
  await otherInput.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true, isComposing: true, bubbles: true, cancelable: true });
  await delay(80);
  assert.ok((await fixture()).inputs.slice(markedBase).every(item => !/[\r\x1b]/.test(item.data)), 'IME confirmation never emits a native submit or enhanced newline');
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  const accentBase = (await fixture()).inputs.length;
  await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: 'é' });
  await until(async () => (await fixture()).inputs.slice(accentBase).map(x => x.data).join('') === 'é', 'Composed accented input reaches the original terminal');
  await fixture('terminal', other, { data: '', sequence: 2, keyboardFlags: 0 }); await delay(100);
  const legacyBase = (await fixture()).inputs.length; await otherInput.press('Shift+Enter');
  await until(async () => (await fixture()).inputs.slice(legacyBase).map(x => x.data).join('') === '\r', 'Native program can restore legacy keyboard mode');
  passed.push('Codex native keyboard mode survives the view boundary, preserves modified shortcuts and IME confirmation, and returns to legacy mode');
  const base = (await fixture()).inputs.length;
  await page.locator(`[data-session-id="${id}"]`).click(); await page.keyboard.type('FAST-A');
  await page.locator(`[data-session-id="${other}"]`).click(); await page.keyboard.type('FAST-B');
  await until(async () => (await fixture()).inputs.slice(base).map(x => x.data).join('') === 'FAST-AFAST-B', 'Immediate typing after terminal selection');
  const chunks = (await fixture()).inputs.slice(base);
  assert.equal(chunks.filter(x => x.id === id).map(x => x.data).join(''), 'FAST-A');
  assert.equal(chunks.filter(x => x.id === other).map(x => x.data).join(''), 'FAST-B');
  // Claude pushes CSI-u flags 5 and reads 13;2u as a newline; a plain CR would submit the draft.
  await page.locator(`[data-session-id="${id}"]`).click();
  await until(() => input.evaluate(el => document.activeElement === el), 'Claude native input for Shift+Enter');
  await fixture('terminal', id, { data: '', sequence: 1, keyboardFlags: 5 }); await delay(100);
  const claudeBase = (await fixture()).inputs.length;
  await input.press('Shift+Enter');
  await until(async () => (await fixture()).inputs.slice(claudeBase).map(x => x.data).join('') === '\x1b[13;2u', 'Claude Shift+Enter is a native newline');
  await fixture('terminal', id, { data: '', sequence: 2, keyboardFlags: 0 }); await delay(100);
  const claudeLegacy = (await fixture()).inputs.length; await input.press('Shift+Enter');
  await until(async () => (await fixture()).inputs.slice(claudeLegacy).map(x => x.data).join('') === '\x1b\r', 'Claude legacy keyboard mode gets its own terminal-setup newline');
  passed.push('Claude native Shift+Enter inserts a newline under its CSI-u request and as ESC CR otherwise');
  await page.locator(`[data-session-id="${other}"]`).click();
  await until(() => otherInput.evaluate(el => document.activeElement === el), 'Codex native input after the Claude key check');
  const compositionBase = (await fixture()).inputs.length;
  await otherInput.evaluate(el => { window.syntheticTrace = []; for (const name of ['compositionstart', 'compositionend', 'beforeinput', 'input', 'blur', 'focus']) el.addEventListener(name, event => window.syntheticTrace.push({ type: event.type, data: event.data, value: el.value, active: document.activeElement === el }), true); });
  await cdp.send('Input.imeSetComposition', { text: '离开前', selectionStart: 3, selectionEnd: 3 });
  await page.locator(`[data-session-id="${id}"]`).click(); await page.keyboard.type('ONLY-A');
  await delay(100);
  const crossing = (await fixture()).inputs.slice(compositionBase);
  assert.equal(crossing.filter(x => x.id === other).map(x => x.data).join(''), '离开前', 'Blur commits pending marked text to its original session');
  assert.equal(crossing.filter(x => x.id === id).map(x => x.data).join(''), 'ONLY-A', 'New target never receives prior composition');
  const guiBase = (await fixture()).inputs.length;
  await cdp.send('Input.imeSetComposition', { text: '转到对话', selectionStart: 4, selectionEnd: 4 });
  await page.locator('#chat-tab').click(); await page.keyboard.type('-AFTER-IME');
  assert.equal(await page.locator('#message-input').inputValue(), 'FIRST-A-GUI-NOW-AFTER-IME', 'Immediate GUI draft after marked text');
  await until(async () => (await fixture()).inputs.slice(guiBase).map(x => x.data).join('') === '转到对话', 'Origin commit before GUI control change');
  await page.locator('#terminal-tab').click();
  await until(() => input.evaluate(el => document.activeElement === el), 'Ready after GUI control acknowledgement');
  const cancelBase = (await fixture()).inputs.length;
  await cdp.send('Input.imeSetComposition', { text: '不提交', selectionStart: 3, selectionEnd: 3 });
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await page.locator(`[data-session-id="${other}"]`).click(); await page.keyboard.type('AFTER-CANCEL');
  await delay(100);
  const cancelled = (await fixture()).inputs.slice(cancelBase);
  assert.equal(cancelled.filter(x => x.id === id).map(x => x.data).join(''), '', 'Cancel composition sends no candidate');
  assert.equal(cancelled.filter(x => x.id === other).map(x => x.data).join(''), 'AFTER-CANCEL');
  await page.locator(`[data-session-id="${id}"]`).click();
  for (let i = 0; i < 2; i++) {
    const repeatedBase = (await fixture()).inputs.length;
    await cdp.send('Input.imeSetComposition', { text: '重复文字', selectionStart: 4, selectionEnd: 4 });
    await page.locator(`[data-session-id="${other}"]`).click();
    await page.locator(`[data-session-id="${id}"]`).click();
    await until(async () => (await fixture()).inputs.slice(repeatedBase).filter(x => x.id === id).map(x => x.data).join('') === '重复文字', 'Refocus never deletes or repeats the prior composition');
  }
  passed.push('Marked-text GUI switching accepts an immediate draft; cancelled and repeated/refocused compositions do not send, duplicate or erase other input');
  // Slow/rejected origin acknowledgement cannot absorb keys for a new target.
  await fixture('hold-input', id);
  const heldBase = (await fixture()).inputs.length;
  await cdp.send('Input.imeSetComposition', { text: '未确认保留', selectionStart: 5, selectionEnd: 5 });
  await page.locator(`[data-session-id="${other}"]`).click(); await page.keyboard.type('WHILE-HELD');
  await until(async () => (await fixture()).waitingInputs.includes(id), 'Origin input held');
  assert.equal((await fixture()).inputs.slice(heldBase).filter(x => x.id === other).map(x => x.data).join(''), 'WHILE-HELD');
  await fixture('fail-input', id); await page.locator(`[data-session-id="${id}"]`).click();
  const recovery = page.locator(`[data-terminal-id="${id}"] .terminal-input-recovery`);
  await recovery.waitFor();
  assert.equal(await recovery.locator('textarea').inputValue(), '未确认保留');
  if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'input-unconfirmed.png') }); }
  const pasteBase = (await fixture()).inputs.length;
  await recovery.locator('textarea').evaluate(el => { const data = new DataTransfer(); data.setData('text/plain', 'DO-NOT-PASTE'); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
  await delay(50); assert.equal((await fixture()).inputs.length, pasteBase, 'Recovery copy surface never forwards paste to native input');
  assert.equal((await fixture()).inputs.slice(heldBase).filter(x => x.id === id).map(x => x.data).join(''), '', 'Failed origin never retries');
  await recovery.getByRole('button', { name: '关闭提示', exact: true }).click();
  // A late input failure must also leave a GUI draft intact and block its send
  // while the old native input is unconfirmed.
  await fixture('hold-input', id);
  await cdp.send('Input.imeSetComposition', { text: '模式切换', selectionStart: 4, selectionEnd: 4 });
  await page.locator('#chat-tab').click(); await page.keyboard.type('-HELD-GUI');
  assert.equal(await page.locator('#message-input').inputValue(), 'FIRST-A-GUI-NOW-AFTER-IME-HELD-GUI');
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  await until(async () => (await fixture()).waitingInputs.includes(id), 'Mode-switch input held');
  await fixture('fail-input', id);
  await until(() => page.locator('#compose-hint').textContent().then(t => t.includes('上一段原生输入未确认')), 'Failure is visible without changing input surface');
  await page.keyboard.type('-STILL-GUI');
  assert.equal(await page.locator('#message-input').inputValue(), 'FIRST-A-GUI-NOW-AFTER-IME-HELD-GUI-STILL-GUI');
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  await page.locator('#terminal-tab').click(); await recovery.waitFor();
  assert.equal(await recovery.locator('textarea').inputValue(), '模式切换');
  assert.equal((await snapshot()).sessions.find(x => x.id === id).view, 'terminal');
  assert.equal((await snapshot()).sessions.find(x => x.id === id).liveDraft, 'FIRST-A-GUI-NOW-AFTER-IME-HELD-GUI-STILL-GUI');
  await recovery.getByRole('button', { name: '关闭提示', exact: true }).click();
  // Permission changes are still checked in the actual Workspace.input call.
  await fixture('hold-input', id);
  const deniedBase = (await fixture()).inputs.length;
  await cdp.send('Input.imeSetComposition', { text: '权限变化', selectionStart: 4, selectionEnd: 4 });
  await page.locator(`[data-session-id="${other}"]`).click();
  await until(async () => (await fixture()).waitingInputs.includes(id), 'Permission-case input held');
  await fixture('set-owner', id, 'other-test-view'); await fixture('release-input', id);
  await page.locator(`[data-session-id="${id}"]`).click(); await recovery.waitFor();
  assert.equal(await recovery.locator('textarea').inputValue(), '权限变化');
  assert.equal((await fixture()).inputs.slice(deniedBase).length, 0);
  assert.equal((await snapshot()).sessions.find(x => x.id === id).owner, 'other-test-view');
  await recovery.getByRole('button', { name: '关闭提示', exact: true }).click();
  await page.locator('#take-control').click();
  await until(() => input.evaluate(el => document.activeElement === el), 'Explicit control returns');
  passed.push('Delayed/refused IME input preserves an explicit copy at its origin, never retries, keeps new typing/drafts separate and respects a newer owner');
  // Ready-terminal input during a deliberately slow control acknowledgement.
  for (const outcome of ['release-claim', 'fail-claim', 'release-taken', 'cancel']) {
    await page.locator('#chat-tab').click();
    await until(async () => (await snapshot()).sessions.find(x => x.id === id).view === 'chat', 'Chat ready before held claim');
    console.log('Held-input outcome:', outcome);
    const queueBase = (await fixture()).inputs.length;
    await fixture('hold-claim', id); await page.locator('#terminal-tab').click();
    await page.keyboard.type('BUFFERED'); await page.keyboard.press('Enter');
    await until(async () => (await fixture()).claims.includes(id), 'Control held with input');
    assert.equal((await fixture()).inputs.slice(queueBase).filter(x => x.id === id).length, 0, 'No write before authorization');
    if (outcome === 'cancel') {
      await cdp.send('Input.imeSetComposition', { text: '不要重放', selectionStart: 4, selectionEnd: 4 });
      await page.locator(`[data-session-id="${other}"]`).click(); await page.keyboard.type('OTHER-ONLY');
    }
    await fixture(outcome === 'cancel' ? 'release-claim' : outcome, id);
    if (outcome === 'release-claim') {
      await until(async () => (await fixture()).inputs.slice(queueBase).filter(x => x.id === id).map(x => x.data).join('') === 'BUFFERED\r', 'Authorized input flush once and in order');
    } else {
      await page.locator(`[data-session-id="${id}"]`).click();
      // Both surfaces are visible now. Deliberately focus the native input;
      // visibility no longer establishes which surface owns the keyboard.
      await page.locator('#terminal-tab').click();
      await recovery.waitFor();
      assert.equal((await fixture()).inputs.slice(queueBase).filter(x => x.id === id).length, 0, 'Cancelled/failed/new-owner input is never flushed');
      assert.ok((await recovery.locator('textarea').inputValue()).startsWith('BUFFERED\n'), 'Unsubmitted input copy remains available');
      if (outcome === 'cancel') {
        assert.ok((await recovery.locator('textarea').inputValue()).includes('不要重放'));
        assert.equal((await fixture()).inputs.slice(queueBase).filter(x => x.id === other).map(x => x.data).join(''), 'OTHER-ONLY');
      }
      await recovery.getByRole('button', { name: '关闭提示', exact: true }).click();
      if (outcome === 'release-taken') { await page.locator('#take-control').click(); await until(() => input.evaluate(el => document.activeElement === el), 'Takeover after rejected queue'); }
    }
  }
  passed.push('Held control changes retain text/Enter until authorization; cancelled, rejected and newer-owner queues never write or replay their text or composition');
  const backBase = (await fixture()).inputs.length;
  await fixture('hold-input-ack', id);
  await cdp.send('Input.imeSetComposition', { text: '回到终端', selectionStart: 4, selectionEnd: 4 });
  await page.locator('#chat-tab').click();
  await page.locator('#terminal-tab').click(); await page.keyboard.type('BACK-NOW');
  await until(async () => (await fixture()).inputs.slice(backBase).filter(x => x.id === id).map(x => x.data).join('') === '回到终端BACK-NOW', 'Return to still-authorized native view accepts immediate input while old ACK is held');
  await fixture('release-input', id);
  passed.push('Immediate return from GUI to an already-authorized terminal does not wait on the prior composition acknowledgement');
  await page.locator('#chat-tab').click();
  await until(async () => (await snapshot()).sessions.find(x => x.id === id).view === 'chat', 'Chat before connection replacement');
  await fixture('hold-claim', id); const replacedBase = (await fixture()).inputs.length;
  await page.locator('#terminal-tab').click(); await page.keyboard.type('OLD-CONNECTION');
  await until(async () => (await fixture()).claims.includes(id), 'Old connection claim held');
  await fixture('replace', id);
  await until(async () => (await fixture()).pending.includes(id), 'Replacement snapshot pending');
  await fixture('release', id); await fixture('release-claim', id);
  await recovery.waitFor();
  assert.equal(await recovery.locator('textarea').inputValue(), 'OLD-CONNECTION');
  assert.equal((await fixture()).inputs.slice(replacedBase).length, 0, 'Old queue never writes to replacement connection');
  await recovery.getByRole('button', { name: '关闭提示', exact: true }).click();
  passed.push('Replacing a connection cancels old queued input and carries its copy into the new terminal surface');
  // Click terminal output after another control owns focus.
  await page.locator('#terminal-display').click(); await page.locator('#close-terminal-display').click();
  await page.locator(`[data-terminal-id="${id}"] .xterm-screen`).click({ position: { x: 40, y: 30 } });
  await page.keyboard.type('MOUSE-A');
  await until(async () => (await fixture()).inputs.filter(x => x.id === id).map(x => x.data).join('').endsWith('MOUSE-A'), 'Mouse target');
  if (process.platform === 'darwin' && process.env.NAW_TEST_FOREGROUND_RETURN === '1') {
    const returnBase = (await fixture()).inputs.length;
    osReturnAttempt = true;
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "Finder" to activate']);
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setFocusable(true); w.show(); w.focus(); });
    await page.waitForFunction(() => document.hasFocus());
    try { await page.keyboard.type('RETURN-A'); }
    finally { await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setFocusable(false); w.hide(); }); }
    await until(async () => {
      const actual = (await fixture()).inputs.slice(returnBase).filter(x => x.id === id).map(x => x.data).join('');
      if (!'RETURN-A'.startsWith(actual)) throw Error('Unexpected input in the finite OS-return attempt; discard contaminated evidence, cause unverified');
      return actual === 'RETURN-A';
    }, 'Exact app return target');
    osReturnAttempt = false;
  }
  else if (process.platform === 'darwin') skipped.push('macOS foreground app return: enable NAW_TEST_FOREGROUND_RETURN=1 only when desktop activation is explicitly wanted');
  passed.push('Immediate GUI/native switching, native session switching, pending composition on blur and terminal mouse focus keep the correct target');
  if (process.platform === 'darwin' && process.env.NAW_TEST_FOREGROUND_RETURN === '1') passed.push('Explicit foreground app return keeps the exact input target');
  if (process.env.NAW_EVIDENCE_DIR) { await page.locator('#toast').waitFor({ state: 'hidden' }); fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, 'input-switch.png') }); }
  await cdp.detach(); assert.deepEqual(errors, []); assert.equal(app.windows().length, 1);
  passed.push('KeyCode 13 during active composition (with and without isComposing) never emits CR; committed text and a later Enter pass once');
  console.log(JSON.stringify({ passed, skipped, errors, modelTasks: 0, nativeProviderProcesses: 0, physicalIME: false, deterministicInput: 'CDP to hidden non-focusable Electron renderer; foreground return requires explicit opt-in' }, null, 2));
}
run().catch(async e => { console.error(e.stack); if (osReturnAttempt) console.log('Foreground attempt failed; raw input diagnostics discarded to avoid retaining unrelated typing.'); else if (page) { console.log('Synthetic trace:', JSON.stringify(await page.evaluate(() => window.syntheticTrace))); console.log('Input destination evidence:', JSON.stringify((await fixture()).inputs)); console.log('Focus:', await page.evaluate(() => ({ active: document.activeElement?.outerHTML, focused: document.hasFocus(), recovery: [...document.querySelectorAll('.terminal-input-recovery')].map(el => ({ hidden: el.hidden, visible: el.checkVisibility(), text: el.querySelector('textarea').value })), hint: document.getElementById('compose-hint').textContent, status: document.getElementById('session-status').textContent })));  } process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
}));
