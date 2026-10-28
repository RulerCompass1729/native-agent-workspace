const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual Electron/xterm pointer selection; synthetic transport only. The owned
// main copy writer is intercepted: no system clipboard format/content changes.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-terminal-selection-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const checks = [], observations = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const context = 'COPY-THIS-CONTEXT 你好';
let app, page, client, sequence = 0; const frames = new Map();
async function until(fn, label) { for (let i = 0; i < 140; i++) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const host = id => page.locator(`[data-terminal-id="${id}"]`);
const output = (id, data) => { const sequence = (frames.get(id) || 0) + 1; frames.set(id, sequence); return fixture('terminal', id, { sequence, data }); };
const selected = id => page.evaluate(id => window.selectionTerms.get(id).getSelection(), id);
const copyCount = () => app.evaluate(() => globalThis.selectionCopies.length);
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function drag(id, force) {
  await page.evaluate(id => window.selectionTerms.get(id).clearSelection(), id);
  const rect = await host(id).locator('.xterm-screen').boundingBox(), cols = await page.evaluate(id => window.selectionTerms.get(id).cols, id);
  const rows = await page.evaluate(id => window.selectionTerms.get(id).rows, id), y = rect.y + rect.height / rows / 2;
  if (force) await page.keyboard.down('Alt');
  try {
    await page.mouse.move(rect.x + 1, y); await delay(40);
    const before = (await fixture()).inputs.length;
    await page.mouse.down(); await page.mouse.move(rect.x + rect.width / cols * 22 + 1, y, { steps: 12 }); await page.mouse.up();
    await delay(100); return { before, after: (await fixture()).inputs.length, text: await selected(id) };
  } finally { if (force) await page.keyboard.up('Alt'); }
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'selection-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await app.context().addInitScript(() => {
    window.selectionTerms = new Map(); let constructor;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => {
      constructor = value; const open = value.prototype.open;
      value.prototype.open = function (element, ...args) { window.selectionTerms.set(element.closest('[data-terminal-id]').dataset.terminalId, this); return open.call(this, element, ...args); };
    } });
  });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor(); await page.reload(); await page.locator('#new-session').waitFor();
  await app.evaluate(({ clipboard }) => { globalThis.selectionOriginalWriter = clipboard.writeText.bind(clipboard); globalThis.selectionCopies = []; globalThis.failSelectionCopy = false; clipboard.writeText = text => { if (globalThis.failSelectionCopy) throw Error('Synthetic copy refused'); globalThis.selectionCopies.push(text); }; });
  for (const provider of ['codex', 'claude']) {
    await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#session-name').fill(provider + ' · 选字复制'); await createIn(page, 'chat');
    const id = (await snapshot()).sessions.find(s => s.provider === provider).id;
    await until(async () => (await fixture()).pending.includes(id), 'Native snapshot'); await fixture('release', id); await host(id).locator('.terminal-surface').waitFor();
    await page.locator('#message-input').fill(provider + ' private draft'); await until(async () => (await snapshot()).sessions.find(s => s.id === id).liveDraft === provider + ' private draft', 'Draft saved');
    const stable = s => [s.id, s.nativeId, s.owner, s.liveDraft], original = stable((await snapshot()).sessions.find(s => s.id === id));
    await output(id, '\x1bc' + context + '\r\nSecond original line');
    await until(async () => (await host(id).locator('.xterm-rows').innerText()).includes(context), 'Original mixed-language native text');
    const normal = await drag(id, false); assert.equal(normal.text, context); assert.equal(normal.after, normal.before);
    for (const [protocol, mode] of [[1000, 'vt200'], [1002, 'drag'], [1003, 'any']]) {
      await output(id, `\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?${protocol}h\x1b[?1006h`);
      await until(() => page.evaluate(({ id, mode }) => window.selectionTerms.get(id).modes.mouseTrackingMode === mode, { id, mode }), 'Actual native mouse mode ' + mode);
      const native = await drag(id, false); assert.equal(native.text, ''); assert.ok(native.after > native.before, 'Ordinary mouse gestures remain native program input');
      const forced = await drag(id, true); assert.equal(forced.text, context); assert.equal(forced.after, forced.before, 'Option selection does not send a native button gesture');
      const beforeCopy = await copyCount(); await page.locator('#terminal-copy').click(); await until(async () => await copyCount() === beforeCopy + 1, 'Toolbar copy reaches existing native IPC');
      assert.equal(await app.evaluate(() => globalThis.selectionCopies.at(-1)), context);
      // Untrusted key dispatch exercises the actual shortcut handler without a
      // browser/menu default copy that could overwrite the person's clipboard.
      await page.evaluate(id => window.selectionTerms.get(id).textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', metaKey: true, bubbles: true, cancelable: true })), id);
      await until(async () => await copyCount() === beforeCopy + 2, 'Synthetic Cmd+C reaches actual xterm shortcut/native IPC');
      assert.equal(await app.evaluate(() => globalThis.selectionCopies.at(-1)), context);
      observations.push({ provider, mode, ordinaryNativeMouseInputs: native.after - native.before, forcedNativeMouseInputs: forced.after - forced.before, selected: forced.text, copiedExactly: true });
      assert.deepEqual(stable((await snapshot()).sessions.find(s => s.id === id)), original);
    }
    await app.evaluate(() => { globalThis.failSelectionCopy = true; }); await page.locator('#terminal-copy').click();
    await until(async () => (await page.locator('#toast-text').innerText()).includes('Synthetic copy refused'), 'Copy error is visible');
    assert.equal(await selected(id), context); await app.evaluate(() => { globalThis.failSelectionCopy = false; });
    const beforeRetry = await copyCount(); await page.locator('#terminal-copy').click(); await until(async () => await copyCount() === beforeRetry + 1, 'Explicit copy retry');
    const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(850, 600)); await capture(provider + '-selected-small');
    checks.push(provider + ': normal drag selects; native mouse protocols keep ordinary gestures and Option selects exact mixed text; toolbar/synthetic shortcut copy, failure retry and identity/draft retained');
  }
  // The user must discover the modifier without first failing Copy.
  const hint = page.locator('#terminal-selection-hint'); await hint.waitFor(); assert.equal(await hint.isVisible(), true); assert.match(await hint.innerText(), /Option/);
  const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(1250, 850));
  await until(() => page.evaluate(() => innerWidth === 1250 && document.querySelector('#session-layout').getBoundingClientRect().width > 900), 'Large window settled before narrowing the pane');
  const divider = await page.locator('#session-layout > .split-divider').boundingBox(), split = await page.locator('#session-layout').boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 10); await page.mouse.down(); await page.mouse.move(split.x + split.width * 0.8, divider.y + 10, { steps: 8 }); await page.mouse.up(); await delay(200);
  assert.equal(await page.locator('#session-layout > .split-divider').getAttribute('aria-valuenow'), '80', 'Narrow-pane drag actually applied');
  const narrow = await page.locator('.native-pane-toolbar').evaluate(bar => {
    const bounds = bar.getBoundingClientRect();
    return [...bar.querySelectorAll('#terminal-selection-hint, #terminal-controls button')].map(el => {
      const r = el.getBoundingClientRect(); return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, paneLeft: bounds.left, paneRight: bounds.right, paneTop: bounds.top, paneBottom: bounds.bottom };
    });
  });
  for (const r of narrow) {
    assert.ok(r.paneRight - r.paneLeft <= split.width * 0.21, 'Actual native pane is at the minimum split width');
    assert.ok(r.left >= r.paneLeft && r.right <= r.paneRight && r.top >= r.paneTop && r.bottom <= r.paneBottom, 'Hint and copy controls remain inside the narrow native pane: ' + r.id);
  }
  assert.equal(await page.locator('#terminal-copy').getAttribute('aria-describedby'), 'terminal-selection-hint'); await capture('narrow-visible-selection-hint');
  const stats = await fixture(); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.interruptions, []); assert.deepEqual(errors, []);
  if (process.env.NAW_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, 'native-inputs.json'), JSON.stringify(stats, null, 2));
  assert.ok(stats.inputs.every(row => /^\x1b\[<(?:0|32|35|43);\d+;\d+[Mm]$/.test(row.data)), 'Native inputs contain only expected pointer button, drag and hover reports');
  // xterm encodes an Option-modified any-mode hover as 35 + Alt(8).
  const hoverReports = stats.inputs.filter(row => /^\x1b\[<(?:35|43);/.test(row.data)).length;
  assert.equal(stats.inputs.length, observations.reduce((n, o) => n + o.ordinaryNativeMouseInputs, 0) + hoverReports, 'Every native input is accounted for by the measured drags or any-mode hover');
  console.log(JSON.stringify({ checks, observations, narrow, errors, modelTasks: 0, nativeProviderProcesses: 0, nativeMouseReports: stats.inputs.length, hoverReports, nativeInputs: stats.inputs, nativeTasks: 0, systemClipboard: 'all formats/content untouched; existing native copy writer intercepted', keyboardShortcut: 'untrusted DOM key event only; native menu/physical Cmd+C not tested', physicalMouse: 'not tested', iTermComparison: 'not tested', scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }, null, 2));
}
run().catch(async error => { console.error(error.stack); console.error(JSON.stringify({ partialChecks: checks, observations, errors })); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try { if (app) { await app.evaluate(({ clipboard }) => { if (globalThis.selectionOriginalWriter) clipboard.writeText = globalThis.selectionOriginalWriter; }); await app.close(); } if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } }
  finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
}));
