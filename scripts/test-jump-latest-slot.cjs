// Hidden source Electron + synthetic native host. Never uses a daily profile/provider.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const code = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '..'), req = createRequire(path.join(code, 'package.json'));
const scratch = req('./scripts/fixtures/test-scratch.cjs'), { _electron } = scratch.playwright(req('playwright'));
const { createSourceEntry } = req('./scripts/fixtures/synthetic-source-boot.cjs'), { connect } = req('./app/service-client.cjs');
const { revealDefaultSpace } = req('./scripts/fixtures/default-space.cjs');
const pictures = process.env.NAW_SCREENSHOTS_DIR, checks = [], failures = [], errors = [], observations = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, name) => { (value ? checks : failures).push(name); console.log(value ? 'PASS' : 'FAIL', name); };
let profile, child, app, client, sequence = 0;
const benign = new Set(['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'TZ', 'NAW_TEST_UI_LANGUAGE']);
const env = more => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => benign.has(key))), HOME: path.join(profile, 'home'), ...more });
async function until(fn, name, ms = 12000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await delay(40); } throw Error(name); }
const settled = async page => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await delay(100); };
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const receive = result => { if (result.requestId !== id) return; clearTimeout(timer); child.off('message', receive); result.error ? reject(Error(result.error)) : resolve(result); };
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Synthetic fixture timeout')); }, 8000);
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
function geometry(el) {
  const rect = node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
  const viewport = rect(el), surface = el.closest('.reading-surface'), button = (surface || el).querySelector('.jump-latest');
  const slot = surface?.querySelector('.reading-slot'), b = rect(button), lines = [];
  for (const p of el.querySelectorAll('.message-body p')) { const range = document.createRange(); range.selectNodeContents(p); for (const r of range.getClientRects()) {
    const clipped = { left: Math.max(r.left, viewport.left), right: Math.min(r.right, viewport.right), top: Math.max(r.top, viewport.top), bottom: Math.min(r.bottom, viewport.bottom) };
    if (clipped.left < clipped.right && clipped.top < clipped.bottom) lines.push(clipped);
  } }
  const overlap = r => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
  const anchor = [...el.children].find(row => row.dataset.messageId && row.getBoundingClientRect().bottom > viewport.top);
  return { viewport, button: b, slot: slot ? rect(slot) : null, hidden: button.parentElement.hidden, overlap: lines.filter(overlap).length, visibleLines: lines.length,
    buttonInViewport: overlap(viewport), top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight, anchor: anchor?.dataset.messageId, offset: anchor ? rect(anchor).top - viewport.top : null };
}
const clean = scratch.cleanup(async () => {
  if (app) { await app.close(); app = null; }
  if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); client = null; }
  if (child) { if (child.connected) child.disconnect(); await until(() => child.exitCode !== null || child.signalCode !== null, 'Owned synthetic host exit', 15000); }
});
(async () => { try {
  if (pictures) { const target = path.resolve(pictures); assert.ok(!target.startsWith(fs.realpathSync(code) + path.sep)); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); }
  profile = scratch.directory(path.join(os.tmpdir(), 'naw-jump-latest-slot-')); fs.mkdirSync(path.join(profile, 'home'), { mode: 0o700 });
  const work = path.join(profile, 'work'); fs.mkdirSync(work);
  const hook = path.join(profile, 'synthetic.cjs'); fs.writeFileSync(hook, `require(${JSON.stringify(path.join(code, 'scripts/fixtures/collaboration-overview.cjs'))});\n`);
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd: work, execArgv: ['--require', hook], env: env({ NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: work, NAW_APP_VERSION: req('./package.json').version }), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic daemon boot'); client = await connect(profile, 'jump-slot-test');
  const ids = [];
  const text = 'Synthetic reading geometry. This paragraph has enough text to fill the visible reading area, so a floating button cannot hide in an empty gap. Keep the same reading position while the prompt appears or disappears. ' .repeat(18);
  for (const [name, provider] of [['Reader A', 'codex'], ['Reader B', 'claude'], ['Reader C', 'codex'], ['Reader D', 'claude']]) {
    const id = await client.call('create', { name, provider, cwd: work, view: 'chat' }); await client.call('join', id, true); ids.push(id);
    for (let n = 0; n < 18; n++) await fixture('nativeBlock', id, { id: 'synthetic-' + ids.length + '-' + n, kind: 'response', turnId: 'turn-' + n, status: 'complete', text });
  }
  const identity = state => state.sessions.map(s => [s.id, s.nativeId, s.roomId]).sort(); const original = identity(await client.call('initial'));
  const entry = createSourceEntry({ profile, code, fixturePid: child.pid }), file = path.join(entry, 'entry.cjs');
  fs.writeFileSync(file, `const e=require('electron');e.Notification.isSupported=()=>false;require(${JSON.stringify(path.join(code, 'app/preflight.cjs'))}).preflight=()=>({claude:true,codex:true,python:true,paths:{},configured:{}});for(const k of ['show','showInactive','focus'])e.BrowserWindow.prototype[k]=function(){};for(const k of ['showOpenDialog','showSaveDialog','showMessageBox','showOpenDialogSync','showSaveDialogSync','showMessageBoxSync'])e.dialog[k]=()=>{throw Error('OS dialog forbidden')};e.shell.openExternal=e.shell.openPath=async()=>{throw Error('External open forbidden')};\n` + fs.readFileSync(file, 'utf8'));
  app = await _electron.launch({ executablePath: req('electron'), args: [entry], env: env({ NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }), timeout: 60000 });
  const grid = await app.firstWindow(); grid.setDefaultTimeout(12000); grid.on('pageerror', e => errors.push(e.message));
  await grid.locator('#room-nav').waitFor(); await revealDefaultSpace(grid); await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1600, 960));
  await grid.locator('#room-nav').click(); await grid.locator('.collaboration-member-reader').last().waitFor(); await settled(grid);
  check(await grid.locator('.collaboration-member-reader').count() === 4, 'Four synthetic member readers render');
  const waiting = app.waitForEvent('window'); await grid.evaluate(id => workspace.newWindow(id), ids[0]); const solo = await waiting;
  solo.setDefaultTimeout(12000); solo.on('pageerror', e => errors.push(e.message)); await solo.locator('#messages').waitFor();
  const soloWindow = await app.browserWindow(solo); await soloWindow.evaluate(win => win.setContentSize(1280, 960)); await soloWindow.dispose(); await settled(solo);
  check(await grid.evaluate(() => innerWidth) === 1600, 'Grid window keeps its exact 1600px content width');
  check(await solo.evaluate(() => innerWidth) === 1280, 'Solo window has its exact 1280px content width');
  for (const theme of ['light', 'dark']) for (const [layout, page, selector] of [['grid', grid, '.collaboration-messages'], ['solo', solo, '#messages']]) {
    const label = (process.env.NAW_TEST_UI_LANGUAGE || 'zh') + '-' + theme + '-' + layout;
    await page.emulateMedia({ colorScheme: theme }); await settled(page);
    const readers = page.locator(selector);
    for (let i = 0; i < await readers.count(); i++) {
      const reader = readers.nth(i); await reader.evaluate(el => { el.scrollTop = 180; }); await settled(page);
      const before = await reader.evaluate(geometry); observations.push({ label, column: i, before });
      check(before.visibleLines > 2 && !before.hidden, label + ' reader ' + i + ' has visible text and a prompt');
      check(before.overlap === 0 && !before.buttonInViewport, label + ' reader ' + i + ' jump button never intersects visible text or viewport (' + before.overlap + ' lines)');
      check(before.slot?.height === 32, label + ' reader ' + i + ' reserves exactly 32px');
      const stable = await reader.evaluate(async el => {
        const bar = (el.closest('.reading-surface') || el).querySelector('.jump-bar');
        const capture = () => ({ top: el.scrollTop, height: el.clientHeight }); const a = capture(); bar.hidden = true;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const b = capture(); bar.hidden = false;
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return [a, b, capture()];
      });
      check(stable.every(x => x.top === stable[0].top && x.height === stable[0].height), label + ' reader ' + i + ' prompt visibility preserves read position and height');
      const surface = reader.locator('xpath=..'); const latest = before.slot ? surface.locator('.jump-latest') : reader.locator('.jump-latest');
      if (i === 0) { await latest.focus(); await latest.press(theme === 'light' ? 'Enter' : 'Space'); } else await latest.click(); await settled(page);
      const after = await reader.evaluate(geometry); observations.at(-1).after = after;
      check(after.hidden && Math.abs(after.gap) <= 1, label + ' reader ' + i + ' original Latest action reaches tail and hides the prompt');
      check(after.slot?.height === 32 && after.viewport.height === before.viewport.height, label + ' reader ' + i + ' tail retains the slot without a viewport jump');
      const positions = await page.evaluate(async () => (await workspace.initial()).viewState.readingPositions);
      const key = layout === 'solo' ? ids[0] : 'collaboration:shared:' + ids[i];
      check(positions[key]?.follow === true, label + ' reader ' + i + ' original follow=true metadata is saved');
    }
    if (pictures) await page.screenshot({ path: path.join(pictures, label + '-tail.png') });
    await readers.evaluateAll(xs => xs.forEach(el => { el.scrollTop = 180; })); await settled(page);
    if (pictures) await page.screenshot({ path: path.join(pictures, label + '-reading.png') });
  }
  check((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focusable: w.isFocusable() })))).every(w => !w.visible && !w.focusable), 'Every owned window stays hidden and unfocusable');
  check(JSON.stringify(identity(await client.call('initial'))) === JSON.stringify(original), 'Views preserve all session/native identities');
  const stats = await fixture('stats', ids[0]); check(stats.stats.inputs === 0 && stats.stats.sends === 0, 'No native input or model send'); check(errors.length === 0, 'No renderer page errors: ' + JSON.stringify(errors));
  if (pictures) fs.writeFileSync(path.join(pictures, 'results.json'), JSON.stringify({ pass: checks.length, failures, errors, observations, stats }, null, 2));
  console.log(`RESULT ${checks.length} pass / ${failures.length} fail / 0 skip / ${errors.length} page errors`); assert.equal(failures.length, 0, failures.join('\n'));
} finally { await clean(); await scratch.release(); console.log('CLEANUP owned app, daemon and profile released'); } })().catch(e => { console.error(e); process.exitCode = 1; });
