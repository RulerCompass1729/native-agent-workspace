const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// T-61: punctuation-heavy Chinese rows lost their last glyph at the native terminal's right edge.
// Fill each row exactly to the grid with a synthetic native frame and check that the last glyph, the
// xterm screen and the grid all end inside the visible client area, at the 13px default and at 14px, for a Codex and a
// Claude session (the renderer path is the same for both; the native side is the synthetic fixture).
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-terminal-right-edge-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version } });
let app, page, client, request = 0, sequence = 0; const observations = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Every mark here is a full-width character (two cells), as in the reported rows.
const wide = '中，文。标：点（）「」测、试';
async function until(fn, label) { for (let i = 0; i < 140; i++) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++request; return new Promise((resolve, reject) => {
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000); child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
async function capture(name, detail) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, name + '.json'), JSON.stringify(detail ?? { observations, errors }, null, 2)); } }
function rows(cols) {
  const cjk = Array.from({ length: Math.floor(cols / 2) }, (_, i) => wide[i % wide.length]).join('');
  return [(cols % 2 ? 'x' : '') + cjk, 'a'.repeat(cols - 1) + 'Z'];
}
async function stableCols(id) {
  let last = -1; for (let i = 0; i < 60; i++) { const cols = await page.evaluate(id => window.edgeTerms.get(id).cols, id); if (cols === last && cols > 0) return cols; last = cols; await delay(150); }
  throw Error('Grid did not settle');
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'right-edge-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await app.context().addInitScript(() => { window.edgeTerms = new Map(); let constructor; Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => { constructor = value; const open = value.prototype.open; value.prototype.open = function (element, ...args) { window.edgeTerms.set(element.closest('[data-terminal-id]').dataset.terminalId, this); return open.call(this, element, ...args); }; } }); });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor();
  const win = await app.browserWindow(page), seen = new Set();
  for (const provider of ['codex', 'claude']) for (const fontSize of [13, 14]) {
    await page.evaluate(fontSize => workspace.viewState({ selected: '', mode: 'chat', terminalDisplay: { fontSize, palette: 'dark' } }), fontSize); await page.reload(); await page.locator('#new-session').waitFor();
    await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#session-name').fill(`Right edge ${provider} ${fontSize}`); await createIn(page, 'chat');
    const id = (await snapshot()).sessions.map(s => s.id).find(s => !seen.has(s)); seen.add(id);
    await until(async () => (await fixture()).pending.includes(id), 'Native snapshot'); await fixture('release', id); await page.locator(`[data-terminal-id="${id}"] .terminal-surface`).waitFor();
    await fixture('terminal', id, { sequence: ++sequence, data: '\x1b[?1049h' });
    await until(() => page.evaluate(id => window.edgeTerms.get(id)?.buffer.active.type === 'alternate', id), 'Actual alternate buffer');
    for (const [width, height] of [[1250, 850], [1000, 800], [820, 760]]) for (const maximized of [false, true]) {
      await win.evaluate((w, size) => w.setSize(size[0], size[1]), [width, height]);
      if (maximized) await page.locator('#terminal-maximize').click();
      const cols = await stableCols(id), [first, second] = rows(cols);
      await fixture('terminal', id, { sequence: ++sequence, data: `\x1b[2J\x1b[1;1H${first}\x1b[2;1H${second}\x1b[3;1H` });
      await until(() => page.evaluate(({ id, first }) => window.edgeTerms.get(id).buffer.active.getLine(0).translateToString(true) === first, { id, first }), 'Frame reached the public buffer');
      await delay(150);
      const detail = await page.evaluate(id => {
        const t = window.edgeTerms.get(id), surface = t.element.parentElement, screen = t.element.querySelector('.xterm-screen').getBoundingClientRect(), cell = screen.width / t.cols;
        // The visible right edge is the nearest clipping ancestor's client area, which excludes any scrollbar.
        let clipRight = Infinity, clipper = '';
        for (let node = t.element; node && node !== document.documentElement; node = node.parentElement) {
          const style = getComputedStyle(node); if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
          const right = node.getBoundingClientRect().left + node.clientLeft + node.clientWidth; if (right < clipRight) { clipRight = right; clipper = node.className || node.id; }
        }
        const lines = [0, 1].map(index => {
          const row = t.element.querySelectorAll('.xterm-rows > div')[index], line = t.buffer.active.getLine(t.buffer.active.viewportY + index), left = row.getBoundingClientRect().left;
          let lastRight = -Infinity, drift = 0, col = 0; const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
          for (let node; (node = walker.nextNode());) for (let k = 0; k < node.data.length; k++) {
            while (col < t.cols && line.getCell(col)?.getWidth() === 0) col++;
            if (node.data[k].trim()) { const r = document.createRange(); r.setStart(node, k); r.setEnd(node, k + 1); const box = r.getBoundingClientRect(); lastRight = Math.max(lastRight, box.right); drift = Math.max(drift, Math.abs(box.left - left - col * cell)); }
            col += line.getCell(col)?.getWidth() || 1;
          }
          return { dom: row.textContent.replace(/ /g, ' ').trimEnd(), buffer: line.translateToString(true), lastRight, drift };
        });
        return { cols: t.cols, rows: t.rows, fontSize: t.options.fontSize, cell, screenRight: screen.right, clipRight, clipper, surfaceClass: surface.className,
          scrollbarGutter: surface.offsetWidth - surface.clientWidth - surface.clientLeft * 2, overflowY: surface.scrollHeight > surface.clientHeight + 1, overflowX: surface.scrollWidth > surface.clientWidth + 1, lines };
      }, id);
      const stage = { provider, fontSize, width, height, maximized, ...detail }; observations.push(stage); await capture(`${provider}-f${fontSize}-${width}${maximized ? '-max' : ''}`, stage);
      const label = `${provider} ${fontSize}px ${width}x${height}${maximized ? ' maximized' : ''} (${detail.cols} cols)`;
      // The pixels on screen in the terminal area, so a person can see the right edge at the widest and the narrowest window, split and maximized.
      if (process.env.NAW_SCREENSHOTS_DIR && width !== 1000) { fs.mkdirSync(process.env.NAW_SCREENSHOTS_DIR, { recursive: true, mode: 0o700 }); await page.screenshot({ path: path.join(process.env.NAW_SCREENSHOTS_DIR, `${provider}-f${fontSize}-${width}${maximized ? '-max' : ''}.png`), clip: await page.locator('#terminal-area').boundingBox() }); }
      console.log(JSON.stringify({ label, clipRight: detail.clipRight, screenRight: detail.screenRight, lastRight: detail.lines.map(l => l.lastRight), drift: detail.lines.map(l => l.drift), gutter: detail.scrollbarGutter, overflowY: detail.overflowY }));
      assert.equal(detail.fontSize, fontSize, `${label}: the chosen terminal font size is applied`);
      for (const [index, line] of detail.lines.entries()) {
        assert.equal(line.dom, line.buffer.trimEnd(), `${label}: row ${index + 1} renders its whole buffer text`);
        assert.ok(line.lastRight <= detail.clipRight + 0.5, `${label}: the last glyph of row ${index + 1} ends inside the visible edge (${line.lastRight} > ${detail.clipRight})`);
      }
      // The c48e28a mechanism: each full-width mark must not push the rest of its row right. Latin rows keep a
      // sub-pixel drift that grows with the column count; it is recorded, and covered by the edge check above.
      assert.ok(detail.lines[0].drift <= 1, `${label}: every glyph of the punctuation row starts at its own column (drift ${detail.lines[0].drift}px)`);
      assert.ok(detail.screenRight <= detail.clipRight + 0.5, `${label}: the terminal grid is not wider than the visible area`);
      assert.ok(!detail.overflowY && !detail.overflowX, `${label}: the terminal surface never needs its own scrollbar, which would take columns`);
      if (maximized) await page.locator('#terminal-maximize').click();
    }
  }
  assert.deepEqual([...new Set(observations.map(o => o.provider))], ['codex', 'claude'], 'Both providers were measured');
  const stats = await fixture(); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.inputs, [], 'The synthetic native session receives no input');
  await capture('observations');
  const latinDrift = Math.max(...observations.map(o => o.lines[1].drift)), margin = Math.min(...observations.map(o => o.clipRight - Math.max(...o.lines.map(l => l.lastRight))));
  console.log(JSON.stringify({ checks: ['Punctuation-heavy Chinese and Latin rows that fill the grid end inside the visible edge for Codex and Claude sessions at 13px and 14px, split and maximized, at three window sizes'], stages: observations.length, latinDrift, smallestEdgeMargin: margin, errors, modelTasks: 0, nativeProviders: 0, scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }));
  assert.deepEqual(errors, []);
}
run().catch(async error => { console.error(error.stack); if (page) await capture('failed'); process.exitCode = 1; }).finally(testScratch.cleanup(async () => { try { if (app) await app.close(); if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); } }));
