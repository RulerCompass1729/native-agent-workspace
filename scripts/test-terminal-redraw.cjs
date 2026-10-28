const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Reproduce native-style redraw after shrinking an alternate-screen grid.
// Optional private input is decoded viewport text, not a captured native VT stream.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-terminal-redraw-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
let app, page, client, request = 0, sequence = 0; const observations = [], chunks = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const full = '› Show the numbered local fixture without changing files.';
const narrow = '› Show the numbered local fixture without changing …';
const captured = process.env.NAW_REDRAW_CAPTURE ? JSON.parse(fs.readFileSync(process.env.NAW_REDRAW_CAPTURE)).observations : null;
const frame = stage => captured ? captured.find(f => f.label === (stage === 'maximized' ? 'maximized' : 'split')).visibleText.split('\n') : [stage === 'maximized' ? full : narrow, '中文与English保持原样。abcdefghij原生列', 'Original mixed-language text'];
async function until(fn, label) { for (let i = 0; i < 140; i++) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++request; return new Promise((resolve, reject) => {
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000); child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function capture(name, detail) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, name + '.json'), JSON.stringify({ observations, chunks, detail }, null, 2)); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); } }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'redraw-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await app.context().addInitScript(() => { window.redrawTerms = new Map(); let constructor; Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => { constructor = value; const open = value.prototype.open; value.prototype.open = function (element, ...args) { window.redrawTerms.set(element.closest('[data-terminal-id]').dataset.terminalId, this); return open.call(this, element, ...args); }; } }); });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor(); await page.reload(); await page.locator('#new-session').waitFor();
  await page.locator('#new-session').click(); await page.locator('input[name="provider"][value="codex"]').check(); await page.locator('#session-name').fill('Native redraw'); await createIn(page, 'chat');
  const id = (await snapshot()).sessions[0].id; await until(async () => (await fixture()).pending.includes(id), 'Native snapshot'); await fixture('release', id); await page.locator('.terminal-surface').waitFor();
  const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(1250, 850)); await delay(200);
  const output = async data => { chunks.push({ sequence: ++sequence, data }); await fixture('terminal', id, { sequence, data }); };
  await output('\x1b[?1049h\x1b[?1003h\x1b[?1006h');
  await until(() => page.evaluate(id => window.redrawTerms.get(id).buffer.active.type === 'alternate', id), 'Actual alternate buffer');
  for (const stage of ['split', 'maximized', 'restored']) {
    if (stage !== 'split') await page.locator('#terminal-maximize').click();
    await until(() => page.evaluate(({ id, stage }) => window.redrawTerms.get(id).cols === (stage === 'maximized' ? 111 : 53), { id, stage }), 'Grid settled before original redraw');
    if (stage === 'restored') {
      await delay(100);
      const boundary = await page.evaluate(id => {
        const t = window.redrawTerms.get(id), row = t.element.querySelectorAll('.xterm-rows > div')[1], range = document.createRange(); range.selectNodeContents(row);
        const line = t.buffer.active.getLine(1);
        return { cols: t.cols, lastCellWidth: line.getCell(t.cols - 1).getWidth(), retained: line.translateToString(true), dom: row.textContent, glyphRight: range.getBoundingClientRect().right, screenRight: t.element.querySelector('.xterm-screen').getBoundingClientRect().right };
      }, id);
      await capture('wide-boundary', boundary); console.log(JSON.stringify({ boundary }));
      assert.equal(boundary.lastCellWidth, 2, 'The shrink leaves a retained wide cell straddling the last visible column');
      assert.ok(boundary.glyphRight <= boundary.screenRight + 1, 'A retained wide character cannot paint beyond the active grid');
      assert.ok(boundary.retained.endsWith('中') && !boundary.dom.includes('中'), 'Only the unrenderable partial glyph is omitted, with its backing cell intact');
      await page.locator('#terminal-maximize').click();
      await until(() => page.evaluate(id => window.redrawTerms.get(id).cols === 111 && window.redrawTerms.get(id).element.querySelectorAll('.xterm-rows > div')[1].textContent.includes('中'), id), 'Widening reveals the original complete glyph without new output');
      await page.locator('#terminal-maximize').click();
      await until(() => page.evaluate(id => window.redrawTerms.get(id).cols === 53, id), 'Restored after backing preservation check');
    }
    const text = frame(stage);
    // CUP + EL matches a bounded native redraw. A full-screen reset would erase
    // the retained off-grid cells and conceal the regression being measured.
    // Keep the cursor on the first row: toolbar wrapping can shrink the row
    // count, and a bottom cursor would scroll away the backing row under test.
    await output(text.map((line, row) => `\x1b[${row + 1};1H${line}\x1b[K`).join('') + '\x1b[1;1H');
    await until(() => page.evaluate(({ id, expected }) => window.redrawTerms.get(id).buffer.active.getLine(0).translateToString(false, 0, expected.length) === expected, { id, expected: text[0] }), 'Original frame reached public buffer');
    await delay(100);
    const detail = await page.evaluate(id => {
      const t = window.redrawTerms.get(id), surface = t.element.parentElement.getBoundingClientRect();
      const lines = [...t.element.querySelectorAll('.xterm-rows > div')].map((row, index) => {
        let maxRight = -Infinity; const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let text;
        while (text = walker.nextNode()) { if (!text.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(text); maxRight = Math.max(maxRight, r.getBoundingClientRect().right); }
        const line = t.buffer.active.getLine(t.buffer.active.viewportY + index);
        return { dom: row.textContent.replace(/\u00a0/g, ' ').trimEnd(), visible: line.translateToString(true, 0, t.cols), retained: line.translateToString(true), backingLength: line.length, maxRight };
      });
      return { buffer: t.buffer.active.type, cols: t.cols, rows: t.rows, paneRight: surface.right, screenRight: t.element.querySelector('.xterm-screen').getBoundingClientRect().right, maxGlyphRight: Math.max(...lines.map(l => l.maxRight)), lines };
    }, id);
    observations.push({ stage, ...detail }); await capture(stage, detail);
    console.log(JSON.stringify({ stage, cols: detail.cols, paneRight: detail.paneRight, screenRight: detail.screenRight, maxGlyphRight: detail.maxGlyphRight, first: detail.lines[0] }));
    assert.ok(detail.maxGlyphRight <= detail.paneRight + 1, 'Every original rendered glyph fits the visible right edge');
    for (const line of detail.lines) assert.equal(line.dom, line.visible.trimEnd(), 'Every DOM row preserves its active visible text, without old wider-screen tails');
    if (stage === 'maximized') {
      await output('\x1b[2;1H' + 'a'.repeat(52) + '中\x1b[K\x1b[1;1H');
      await until(() => page.evaluate(id => window.redrawTerms.get(id).buffer.active.getLine(1).getCell(52).getWidth() === 2, id), 'Wide boundary fixture reached the public buffer');
    }
    if (stage === 'restored') {
      assert.ok(detail.lines[0].backingLength > detail.cols && detail.lines[0].retained.endsWith('les.'), 'Off-grid backing text is retained, not truncated to conceal the defect');
      await page.evaluate(id => { window.redrawHover = 0; window.redrawTerms.get(id).registerLinkProvider({ provideLinks(y, callback) { callback(y === 1 ? [{ range: { start: { x: 1, y }, end: { x: 30, y } }, text: 'synthetic hover only', activate() {}, hover() { window.redrawHover++; } }] : []); } }); }, id);
      const rect = await page.locator('.xterm-screen').boundingBox(); await page.mouse.move(rect.x + 10, rect.y + 5);
      await until(() => page.evaluate(() => window.redrawHover > 0), 'Public link hover exercises the second DOM row factory caller');
      const hovered = await page.evaluate(id => { const t = window.redrawTerms.get(id), row = t.element.querySelector('.xterm-rows > div'); return { text: row.textContent.trimEnd(), visible: t.buffer.active.getLine(0).translateToString(false, 0, t.cols).trimEnd(), retained: t.buffer.active.getLine(0).translateToString(true) }; }, id);
      assert.equal(hovered.text, hovered.visible, 'Link hover redraw keeps the same visible-column bound'); assert.equal(hovered.retained, detail.lines[0].retained);
      await capture('link-hover', hovered);
    }

  }
  const stats = await fixture(); assert.deepEqual(stats.sends, []); assert.ok(stats.inputs.length <= 2 && stats.inputs.every(row => row.id === id && /^\x1b\[<35;\d+;\d+M$/.test(row.data)), 'Only the expected native any-mode hover report is allowed; no typed task'); assert.deepEqual(stats.interruptions, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: ['Original mixed-frame redraw survives split/maximize/restore without out-of-grid glyphs or buffer truncation'], errors, modelTasks: 0, nativeProviders: 0, expectedNativeMouseReports: stats.inputs.length, inputSource: captured ? 'private decoded native viewport rows; generated VT replay' : 'synthetic original native-style frame', scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }));
}
run().catch(async error => { console.error(error.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => { try { if (app) await app.close(); if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); } }));
