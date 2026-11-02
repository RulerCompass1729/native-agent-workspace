// Real Electron + real Claude CLI (fullscreen, any-event mouse tracking). Drag and Option-drag through a
// known text row in the terminal views a person uses: chat split, terminal tab, a view rebuilt from the
// service snapshot after a reload, and a second window that cannot send input. No model request: the CLI
// only starts. A fake pbcopy on PATH stores Claude's copies in scratch and a stubbed Electron clipboard
// records NAW's copies; the real clipboard is never touched. Takes the canonical GUI slot; exits 75 if busy.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
const { _electron } = testScratch.playwright(require('playwright'));
const { connectService } = require('../app/service-client.cjs');
const { executable } = require('../app/platform.cjs');
const evidence = process.env.NAW_EVIDENCE_DIR; assert.ok(evidence, 'NAW_EVIDENCE_DIR required');
const slot = path.resolve(testScratch.childProcess.execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), '..', '.local/gui-test-slot.lock');
try { fs.mkdirSync(slot); } catch { console.error('Canonical GUI slot occupied; nothing launched'); process.exit(75); }
const slotToken = require('node:crypto').randomUUID(); fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'test-native-terminal-select', token: slotToken, pid: process.pid }));
process.once('exit', () => { try { assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'), 'utf8')).token, slotToken); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); } catch (e) { console.error('GUI slot retained:', e.message); process.exitCode = 1; } });
fs.mkdirSync(evidence, { recursive: true });
const base = testScratch.directory(path.join(os.tmpdir(), 'naw-terminal-select-'));
const profile = path.join(base, 'profile'), cwd = path.join(base, 'work'), config = path.join(base, 'claude'), fakeBin = path.join(base, 'fakebin'), copiesDir = path.join(base, 'pbcopy');
for (const dir of [profile, cwd, config, fakeBin, copiesDir]) fs.mkdirSync(dir, { mode: 0o700 });
const binary = fs.realpathSync(executable('claude'));
const nativeVersion = testScratch.childProcess.execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
assert.match(nativeVersion, /^2\.1\.316\b/, 'Qualified on Claude Code 2.1.316 only; verify the fullscreen mouse contract before extending');
// NAW_TEST_LEGACY_SNAPSHOT=1: run with a backend whose snapshot lacks the SGR encoding (an older
// running backend); the rebuilt view must then select locally instead of dropping the drag.
const legacySnapshot = process.env.NAW_TEST_LEGACY_SNAPSHOT === '1';
const TEXT = 'Auto mode';
// Moving the pointer (with or without Option) over an any-event program sends no-button motion reports only.
const hoverOnly = sent => sent.every(d => /^\x1b\[<(\d+);\d+;\d+M$/.test(d) && (Number(/^\x1b\[<(\d+);/.exec(d)[1]) & 35) === 35);
const errors = [], results = {}; let total = 0, application, page, client;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, ms = 40000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(75); } throw Error(label); }
const snapshot = () => client.call('initial');
const server = http.createServer((req, res) => { total++; res.writeHead(500); res.end(); });
const nativeCopies = () => fs.readdirSync(copiesDir).sort().map(f => fs.readFileSync(path.join(copiesDir, f), 'utf8'));
async function cleanup() {
  if (application) await application.close().catch(() => {});
  if (client) { try { for (const s of (await snapshot()).sessions) await client.call('stop', s.id); await client.call('shutdown'); } catch {} finally { client.close(); } }
  server.closeAllConnections(); await new Promise(r => server.close(r));
}
// The terminal of `id` in `view`: its row holding TEXT, the cell geometry and the selection/data hooks.
const term = (view, id, fn, arg) => view.evaluate(([id, source, arg]) => (0, eval)(source)(window.selectTerms.get(id), arg), [id, String(fn), arg]);
async function textBox(view, id) {
  const where = await term(view, id, t => { const b = t.buffer.active; for (let y = 0; y < t.rows; y++) { const line = b.getLine(b.viewportY + y)?.translateToString(true) || ''; const x = line.indexOf('Auto mode'); if (x >= 0) return { x, y }; } return null; });
  assert.ok(where, 'The welcome screen shows the known text row');
  const screen = await view.locator(`[data-terminal-id="${id}"] .xterm-screen`).boundingBox(), cols = await term(view, id, t => t.cols), rows = await term(view, id, t => t.rows);
  const cw = screen.width / cols, ch = screen.height / rows;
  return { y: screen.y + (where.y + 0.5) * ch, x0: screen.x + (where.x + 0.3) * cw, x1: screen.x + (where.x + TEXT.length - 0.3) * cw, blankY: screen.y + (rows - 0.5) * ch, blankX: screen.x + (cols - 2) * cw };
}
async function drag(view, id, option = false) {
  const b = await textBox(view, id);
  if (option) await view.keyboard.down('Alt');
  await view.mouse.move(b.x0, b.y); await view.mouse.down(); for (let i = 1; i <= 8; i++) await view.mouse.move(b.x0 + (b.x1 - b.x0) * i / 8, b.y); await view.mouse.up();
  if (option) await view.keyboard.up('Alt');
}
async function measure(label, view, id, action) {
  await term(view, id, t => { t.clearSelection(); window.selectData = []; });
  const before = { native: nativeCopies().length, app: (await application.evaluate(() => globalThis.selectCopies.length)), control: (await snapshot()).sessions[0].controlRevision || 0 };
  await action(); await sleep(1200);
  const after = (await snapshot()).sessions[0];
  results[label] = { local: await term(view, id, t => t.getSelection()), nativeCopies: nativeCopies().slice(before.native), appCopiesBefore: before.app,
    sent: await view.evaluate(() => window.selectData.slice()), controlRevisionDelta: (after.controlRevision || 0) - before.control,
    encoding: await term(view, id, t => t._core.coreMouseService.activeEncoding) };
  await view.screenshot({ path: path.join(evidence, label + '.png') });
}
async function cmdC(view, label) {
  const before = await application.evaluate(() => globalThis.selectCopies.length);
  await view.keyboard.press('Meta+C'); await sleep(400);
  results[label].appCopies = (await application.evaluate(() => globalThis.selectCopies.slice())).slice(before);
}
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(fakeBin, 'pbcopy'), `#!/bin/bash\ncat > ${JSON.stringify(copiesDir)}/$(date +%s%N)-$$.txt\n`, { mode: 0o700 });
  const shim = path.join(base, 'claude-local');
  fs.writeFileSync(shim, '#!/usr/bin/python3\nimport os,sys\nos.environ.pop("ANTHROPIC_AUTH_TOKEN",None)\nos.environ.pop("CLAUDE_CODE_OAUTH_TOKEN",None)\nos.environ["PATH"]=' + JSON.stringify(fakeBin) + '+":"+os.environ.get("PATH","")\nos.environ.update(' +
    `ANTHROPIC_BASE_URL=${JSON.stringify(`http://127.0.0.1:${server.address().port}`)},ANTHROPIC_API_KEY="local-fixture",CLAUDE_CONFIG_DIR=${JSON.stringify(config)},CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1",DISABLE_AUTOUPDATER="1")\n` +
    `os.execv(${JSON.stringify(binary)},["claude"]+sys.argv[1:]+["--model","haiku"])\n`, { mode: 0o700 });
  const real = fs.realpathSync(cwd);
  fs.writeFileSync(path.join(config, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: ['local-fixture'], rejected: [] },
    projects: { [real]: { hasTrustDialogAccepted: true }, [real + '-sessions']: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  fs.writeFileSync(path.join(profile, 'runtime-locations.json'), JSON.stringify({ claude: shim }), { mode: 0o600 });
  application = await _electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await application.context().addInitScript(() => {
    window.selectTerms = new Map(); window.selectData = []; let constructor;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => {
      constructor = value; const open = value.prototype.open;
      value.prototype.open = function (element, ...args) { window.selectTerms.set(element.closest('[data-terminal-id]').dataset.terminalId, this); this.onData(d => window.selectData.push(d)); return open.call(this, element, ...args); };
    } });
  });
  await application.evaluate(({ clipboard }) => { globalThis.selectCopies = []; for (const k of Object.keys(clipboard)) if (typeof clipboard[k] === 'function') clipboard[k] = (...a) => { if (k.startsWith('write')) globalThis.selectCopies.push(String(a[0])); return k.startsWith('read') ? '' : undefined; }; });
  page = await application.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); await page.reload(); await page.locator('#new-session').waitFor();
  client = await connectService(profile, 'terminal-select');
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="claude"]').check();
  await page.locator('#session-name').fill('Select check'); await createIn(page, 'terminal');
  await until(async () => (await snapshot()).sessions.find(s => s.nativeId && s.chatAvailable && s.state === 'idle'), 'Ready', 70000);
  const id = (await snapshot()).sessions[0].id;
  await until(async () => (await page.locator('#terminal-area').innerText()).includes(TEXT), 'Fullscreen welcome painted', 20000); await sleep(1000);
  // (b) Terminal tab: the view sends input; Claude selects and copies the dragged text itself.
  await measure('b-terminal-drag', page, id, () => drag(page, id));
  // (c) Hover only: not a human operation.
  await measure('c-terminal-hover', page, id, async () => { const b = await textBox(page, id); for (let i = 0; i < 12; i++) await page.mouse.move(b.x0 + i * 6, b.blankY); });
  // (f) Option-drag in the terminal tab keeps a local selection and sends nothing.
  await measure('f-terminal-option-drag', page, id, () => drag(page, id, true)); await cmdC(page, 'f-terminal-option-drag');
  // Option-click on blank cells must not type arrow keys into the program.
  await measure('h-option-click-blank', page, id, async () => { const b = await textBox(page, id); await page.keyboard.down('Alt'); await page.mouse.click(b.blankX, b.blankY); await page.keyboard.up('Alt'); });
  // (a) Chat split: the press switches to the terminal view and the drag reaches Claude.
  await page.locator('#chat-tab').click(); await sleep(800);
  await measure('a-chat-split-drag', page, id, () => drag(page, id));
  // (g) Reload: the terminal view is rebuilt from the service snapshot and must report SGR like a live one.
  await page.reload(); await page.locator('#new-session').waitFor(); await page.locator(`[data-session-id="${id}"]`).first().click();
  if (!((await page.locator('#terminal-tab').getAttribute('class')) || '').includes('active')) await page.locator('#terminal-tab').click();
  await until(() => page.evaluate(id => Boolean(window.selectTerms.get(id)), id), 'Rebuilt terminal view', 20000);
  await until(async () => (await page.locator('#terminal-area').innerText()).includes(TEXT), 'Rebuilt view shows the welcome', 20000); await sleep(800);
  results.rebuiltEncodingBeforeInput = await term(page, id, t => t._core.coreMouseService.activeEncoding);
  await measure('g-rebuilt-view-drag', page, id, () => drag(page, id));
  if (legacySnapshot) await cmdC(page, 'g-rebuilt-view-drag');
  // (e) A second window viewing the same session cannot send input: a plain drag selects locally.
  const opened = application.waitForEvent('window'); await page.evaluate(id => window.workspace.newWindow(id), id); const second = await opened;
  second.on('pageerror', e => errors.push('second: ' + e.message)); await second.locator('#terminal-area').waitFor({ timeout: 20000 });
  if (!((await second.locator('#terminal-tab').getAttribute('class')) || '').includes('active')) await second.locator('#terminal-tab').click();
  await until(() => second.evaluate(id => Boolean(window.selectTerms.get(id)), id), 'Second window terminal', 20000);
  await until(async () => (await second.locator('#terminal-area').innerText()).includes(TEXT), 'Second window shows the welcome', 20000); await sleep(800);
  await measure('e-second-window-drag', second, id, () => drag(second, id)); await cmdC(second, 'e-second-window-drag');
  const out = { nativeVersion, localResponses: total, paidModelCalls: 0, results, errors };
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(out, null, 2)); console.log(JSON.stringify(out));
  const r = results;
  for (const k of ['b-terminal-drag', 'a-chat-split-drag', ...(legacySnapshot ? [] : ['g-rebuilt-view-drag'])]) { assert.deepEqual(r[k].nativeCopies, [TEXT], k + ': Claude copies exactly the dragged text'); assert.equal(r[k].local, '', k + ': no local selection'); }
  if (legacySnapshot) {
    assert.equal(r.rebuiltEncodingBeforeInput, 'DEFAULT', 'An older backend snapshot rebuilds a legacy-encoded view');
    assert.equal(r['g-rebuilt-view-drag'].local, TEXT, 'That view selects the dragged text locally'); assert.deepEqual(r['g-rebuilt-view-drag'].appCopies, [TEXT], 'Cmd+C copies it');
    assert.deepEqual(r['g-rebuilt-view-drag'].nativeCopies, []); assert.equal(r['g-rebuilt-view-drag'].controlRevisionDelta, 0);
  } else assert.equal(r.rebuiltEncodingBeforeInput, 'SGR', 'A view rebuilt from the snapshot reports SGR mouse events');
  assert.equal(r['c-terminal-hover'].controlRevisionDelta, 0, 'Hovering is not a human operation');
  assert.ok(r['c-terminal-hover'].sent.length > 0 && r['c-terminal-hover'].sent.every(d => /^\x1b\[<\d+;\d+;\d+M$/.test(d)), 'Hover reports reach the program as SGR motion');
  for (const k of ['f-terminal-option-drag', 'e-second-window-drag']) {
    assert.equal(r[k].local, TEXT, k + ': exactly the dragged text is selected locally'); assert.ok(hoverOnly(r[k].sent), k + ': only pointer motion reaches the program, no press, drag or keys'); assert.equal(r[k].controlRevisionDelta, 0);
    assert.deepEqual(r[k].nativeCopies, []); assert.deepEqual(r[k].appCopies, [TEXT], k + ': Cmd+C copies exactly that text');
  }
  assert.ok(hoverOnly(r['h-option-click-blank'].sent), 'Option-click types no arrow keys into the program'); assert.equal(r['h-option-click-blank'].controlRevisionDelta, 0);
  assert.equal(total, 0, 'No model request'); assert.deepEqual(errors, []);
})().catch(async error => { console.error(error.stack); console.error(JSON.stringify({ partial: results, errors })); process.exitCode = 1; try { await page.screenshot({ path: path.join(evidence, 'failure.png') }); } catch {} })
  .finally(testScratch.cleanup(cleanup));
