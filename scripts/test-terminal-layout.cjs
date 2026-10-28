const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual Electron layout and IPC; no providers, inference or global clipboard.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const { fork } = testScratch.childProcess;
const { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-terminal-layout-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: profile, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const delay = ms => new Promise(r => setTimeout(r, ms));
let app, page, client, sequence = 0;
const errors = [], observations = [];
async function until(fn, label) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(50); } throw Error(label); }
function fixture(method, target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 10000);
  const cb = r => { if (r.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(r); } }; child.on('message', cb); child.send({ id, method, target, value });
}); }
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service'); client = await connect(profile, 'layout-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  // Observe public xterm only in this owned test; shipped code gets no hook.
  await app.context().addInitScript(() => {
    window.layoutTerms = new Map(); let constructor;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => {
      constructor = value; const open = value.prototype.open;
      value.prototype.open = function (element, ...args) { window.layoutTerms.set(element.closest('[data-terminal-id]').dataset.terminalId, this); return open.call(this, element, ...args); };
    } });
  });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  await page.reload(); await page.locator('#new-session').waitFor();
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#session-name').fill('Layout task'); await createIn(page, 'chat');
  const snap = () => page.evaluate(() => workspace.initial());
  await until(async () => (await snap()).sessions[0]?.state === 'idle', 'Created'); const id = (await snap()).sessions[0].id;
  await fixture('nativeBlock', id, { id: 'reply', role: 'assistant', kind: 'text', text: 'Original native output', status: 'complete' });
  await until(async () => (await fixture('stats')).pending.includes(id), 'Snapshot pending'); await fixture('release', id);
  await page.locator('.terminal-surface').waitFor({ state: 'visible' });
  await app.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { ServiceClient } = load('./app/service-client.cjs'), call = ServiceClient.prototype.call;
    globalThis.layoutResizes = []; ServiceClient.prototype.call = function (method, ...args) { if (method === 'resize') globalThis.layoutResizes.push(args); return call.call(this, method, ...args); };
  });
  await page.locator('#message-input').fill('Unsent task draft');
  await fixture('set-owner', id, 'migration-connection'); await until(() => page.locator('#message-input').evaluate(el => el.readOnly), 'Observer is readonly');
  await page.locator('#take-control').click(); await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Takeover editable');
  assert.equal(await page.locator('#message-input').inputValue(), 'Unsent task draft');
  await delay(250);
  await page.evaluate(() => {
    window.layoutChurn = { removed: 0, mutations: 0 }; const surface = document.querySelector('.terminal-surface');
    new MutationObserver(records => { for (const r of records) { window.layoutChurn.mutations++; window.layoutChurn.removed += r.removedNodes.length; } }).observe(surface, { childList: true, attributes: true });
  });
  const before = await app.evaluate(() => globalThis.layoutResizes.length);
  for (let i = 0; i < 20; i++) { await fixture('state', id); await delay(40); }
  await delay(200); const after = await app.evaluate(() => globalThis.layoutResizes.length);
  const geometry = await page.evaluate(() => {
    const area = document.querySelector('#terminal-area').getBoundingClientRect(), screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { area: { width: area.width, height: area.height }, screen: { width: screen.width, height: screen.height }, churn: window.layoutChurn };
  });
  observations.push({ check: 'Stable native pane during twenty state updates', resizeCalls: after - before, geometry }); console.log(JSON.stringify(observations)); await capture('stable-layout');
  assert.ok(geometry.screen.width <= geometry.area.width, 'Native columns fit the pane');
  assert.ok(geometry.screen.height <= geometry.area.height, 'Native rows fit the pane');
  assert.equal(geometry.churn.removed, 0, 'State updates retain the terminal surface');
  assert.equal(after - before, 0, 'Unchanged geometry must not issue resize requests');
  const rows = page.locator(`[data-terminal-id="${id}"] .xterm-rows`);
  let nativeSequence = 0;
  const output = data => fixture('terminal', id, { data, sequence: ++nativeSequence, cols: 53, rows: 30 });
  await output('\x1b[1;1H\x1b[JOriginal stable native frame');
  await until(async () => (await rows.textContent()).includes('Original stable native frame'), 'Initial native frame');
  await output('\x1b[1;1H\x1b[J');
  await until(async () => !(await rows.textContent()).trim(), 'Native clear appears unchanged');
  await output('Native content after intentional clear');
  await until(async () => (await rows.textContent()).includes('Native content after intentional clear'), 'Later native content remains visible');
  observations.push({ check: 'Native output and intentional clear pass through unchanged' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 650));
  await delay(250);
  const changed = await app.evaluate(() => globalThis.layoutResizes.length); assert.ok(changed > after, 'Window resizing sends new native dimensions');
  await fixture('state', id); await delay(200); assert.equal(await app.evaluate(() => globalThis.layoutResizes.length), changed, 'The new size settles without another resize loop');
  await page.locator('#terminal-maximize').click(); await delay(250);
  const maximized = await app.evaluate(() => globalThis.layoutResizes.length); assert.ok(maximized > changed, 'Maximizing the terminal resizes the original display');
  await page.locator('#terminal-maximize').click(); await delay(250);
  await fixture('set-owner', id, 'other-window'); await until(() => page.locator('#message-input').evaluate(el => el.readOnly), 'Owner change keeps input gated');
  const beforeObserver = await app.evaluate(() => globalThis.layoutResizes.length);
  await page.evaluate(() => window.workspace.stageImages('not-a-session', 'not-a-native-thread', [Uint8Array.of(1)]).then(() => { throw Error('Unexpected import'); }, e => { window.rejectedImage = e.message; }));
  assert.ok(await page.evaluate(() => window.rejectedImage));
  await fixture('state', id); await delay(200); assert.equal(await app.evaluate(() => globalThis.layoutResizes.length), beforeObserver, 'Readonly views never resize the native process');
  await page.locator('#take-control').click(); await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Retake original display'); await delay(250);
  assert.ok(await app.evaluate(() => globalThis.layoutResizes.length) > beforeObserver, 'Taking control reapplies the current visible geometry');
  await capture('resized-and-retaken');
  // Draw real VT last-column cells, then measure their actual DOM ranges against
  // the visible xterm pane, not the larger outer area (which includes padding).
  async function edge(label, target = id) {
    await delay(180);
    const cols = await page.evaluate(id => window.layoutTerms.get(id).cols, target);
    const overflow = label.endsWith('observer-narrow') || label.endsWith('minimum-pane-large-font');
    const originalOwner = (await snap()).sessions.find(s => s.id === target).owner;
    const data = '\x1b[H\x1b[2J' + 'A'.repeat(cols - 1) + 'Z' + `\x1b[2;${cols - 1}H界` + (overflow ? '\x1b[?1000h\x1b[?1006h' : '');
    await fixture('terminal', target, { data, sequence: ++nativeSequence });
    await until(async () => await page.evaluate(({ id, cols }) => {
      const t = window.layoutTerms.get(id), rows = t.element.querySelectorAll('.xterm-rows > div');
      return t.buffer.active.getLine(t.buffer.active.viewportY)?.getCell(cols - 1)?.getChars() === 'Z' && rows[0]?.textContent === 'A'.repeat(cols - 1) + 'Z' && rows[1]?.textContent.includes('界');
    }, { id: target, cols }), label + ' exact current edge frame rendered');
    const resizeCount = await app.evaluate(() => globalThis.layoutResizes.length);
    const surface = page.locator(`[data-terminal-id="${target}"] .terminal-surface`);
    if (overflow) {
      await until(() => page.evaluate(id => window.layoutTerms.get(id).modes.mouseTrackingMode === 'vt200', target), 'Actual SGR mouse tracking enabled before gesture');
      await surface.hover(); await page.mouse.wheel(240, 0);
      await until(() => surface.evaluate(el => el.scrollLeft > 0), 'Oversized mouse-mode frame scrolls horizontally without taking control');
      assert.equal((await snap()).sessions.find(s => s.id === target).owner, originalOwner);
      assert.equal(await app.evaluate(() => globalThis.layoutResizes.length), resizeCount, 'Reading overflow does not resize the controlling native session');
    }
    const geometry = await page.evaluate(id => {
      const t = window.layoutTerms.get(id), surface = t.element.parentElement.getBoundingClientRect(), screen = t.element.querySelector('.xterm-screen').getBoundingClientRect();
      const cells = [...t.element.querySelectorAll('.xterm-rows > div')].slice(0, 2).map(row => {
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let text, rect;
        while (text = walker.nextNode()) { const index = Math.max(text.textContent.lastIndexOf('Z'), text.textContent.lastIndexOf('界')); if (index < 0) continue; const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1); rect = range.getBoundingClientRect(); }
        return rect ? { left: rect.left, right: rect.right, width: rect.width } : null;
      });
      return { cols: t.cols, rows: t.rows, fontSize: t.options.fontSize, paneLeft: surface.left, paneRight: surface.right, surfaceWidth: surface.width, screenWidth: screen.width, scrollLeft: t.element.parentElement.scrollLeft, mouseTrackingMode: t.modes.mouseTrackingMode, cells };
    }, target);
    const requested = await app.evaluate((_electron, id) => globalThis.layoutResizes.findLast(row => row[0] === id)?.slice(-2), target);
    observations.push({ check: label, geometry, nativeResizeRequested: requested });
    console.log(JSON.stringify(observations.at(-1))); await capture('edge-' + label.replace(/[^a-z0-9]+/gi, '-'));
    assert.ok(geometry.cells.every(cell => cell && cell.right <= geometry.paneRight + 1), label + ': complete ASCII and double-width final cells fit visible pane');
    assert.ok(overflow ? geometry.scrollLeft > 0 : geometry.screenWidth <= geometry.surfaceWidth + 1, label + ': original columns fit or remain scrollable in a readonly view');
    assert.deepEqual(requested, [geometry.cols, geometry.rows], label + ': native resize matches visible grid');
    assert.ok(geometry.cols >= 20 && geometry.cols <= 400 && geometry.rows >= 5 && geometry.rows <= 200, label + ': visible grid respects the actual native PTY size bounds');
    if (overflow) await fixture('terminal', target, { data: '\x1b[?1000l\x1b[?1006l', sequence: ++nativeSequence });
  }
  const win = await app.browserWindow(page);
  const setFont = async size => { await page.locator('#terminal-display').click(); await page.locator('#terminal-font-size').fill(String(size)); await page.locator('#terminal-font-size').press('Tab'); await page.locator('#close-terminal-display').click(); };
  async function edges(target, provider) {
    const stable = s => [s.id, s.nativeId, s.pid, s.owner, s.liveDraft], original = stable((await snap()).sessions.find(s => s.id === target));
    const check = label => edge(provider + '-' + label, target), divider = page.locator('#session-layout > .split-divider');
    await win.evaluate(w => w.setSize(1250, 850)); await setFont(14); await divider.focus(); await divider.press('Home'); await check('default-font');
    await fixture('set-owner', target, 'other-window'); await until(() => page.locator('#message-input').evaluate(el => el.readOnly), 'Readonly original grid');
    await win.evaluate(w => w.setSize(850, 600)); await check('observer-narrow');
    await page.locator('#take-control').click(); await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Retake after local reading');
    await win.evaluate(w => w.setSize(1250, 850));
    await setFont(24); await check('large-font'); await setFont(10); await check('small-font');
    await page.locator('#terminal-maximize').click(); await check('maximized'); await page.locator('#terminal-maximize').click(); await check('restored');
    for (const key of ['ArrowRight', 'ArrowLeft', 'Home']) { await divider.focus(); await divider.press(key); await check('divider-' + key); }
    const split = await page.locator('#session-layout').boundingBox(), drag = await divider.boundingBox();
    await page.mouse.move(drag.x + drag.width / 2, drag.y + 10); await page.mouse.down(); await page.mouse.move(split.x + split.width * 0.7, drag.y + 10, { steps: 8 }); await page.mouse.up(); await check('drag-release');
    await setFont(24); const narrow = await divider.boundingBox();
    await page.mouse.move(narrow.x + narrow.width / 2, narrow.y + 10); await page.mouse.down(); await page.mouse.move(split.x + split.width * 0.8, narrow.y + 10, { steps: 8 }); await page.mouse.up(); await check('minimum-pane-large-font');
    await win.evaluate(w => w.setSize(850, 600)); await check('small-window');
    assert.deepEqual(stable((await snap()).sessions.find(s => s.id === target)), original, 'Geometry and readonly reading retain identity, PID, owner and draft');
  }
  await edges(id, 'codex');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check(); await page.locator('#session-name').fill('Claude edge task'); await createIn(page, 'chat');
  const claude = (await snap()).sessions.find(s => s.provider === 'claude').id;
  await until(async () => (await fixture('stats')).pending.includes(claude), 'Claude native snapshot'); await fixture('release', claude); await page.locator(`[data-terminal-id="${claude}"] .terminal-surface`).waitFor();
  await page.locator('#message-input').fill('Claude unsent draft'); await until(async () => (await snap()).sessions.find(s => s.id === claude).liveDraft === 'Claude unsent draft', 'Claude draft saved');
  await edges(claude, 'claude');
  const stats = await fixture('stats'); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.inputs, []); assert.deepEqual(stats.interruptions, []);
  assert.equal((await snap()).diagnostics.dispatches, 0); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ observations, resized: changed > after, maximized: maximized > changed, observerDoesNotResize: true, retakeResizes: true, modelTasks: 0, nativeProviderProcesses: 0, nativeDispatches: 0, scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }));
}
run().catch(async e => { console.error(e.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  if (app) await app.close(); if (client) { const s = await client.call('initial'); for (const x of s.sessions) await client.call('stop', x.id); await client.call('shutdown'); client.close(); } if (child.connected) child.disconnect();
}));
