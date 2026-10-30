// Real Electron/xterm/IPC, existing synthetic terminal; no provider or model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), { randomUUID, createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process'), { once } = require('node:events');
const scratch = require('./fixtures/test-scratch.cjs');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const evidence = process.env.NAW_EVIDENCE_DIR;
if (evidence) {
  let parent = path.resolve(evidence); while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const target = path.join(fs.realpathSync(parent), path.relative(parent, path.resolve(evidence)));
  for (const folder of [root, code]) { const base = fs.realpathSync(folder); if (target === base || target.startsWith(base + path.sep)) throw Error('Evidence must be outside the repository'); }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (error) { if (error.code !== 'EEXIST') throw error; console.error('GUI slot occupied; no profile or GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T59 readonly oversized terminal', token, pid: process.pid, at: new Date().toISOString() }));
const hashes = () => Object.fromEntries(['app/renderer/renderer.js', 'app/renderer/styles.css', 'app/dsh/client.js', 'scripts/fixtures/loading-terminal.cjs'].map(f => [f, createHash('sha256').update(fs.readFileSync(path.join(code, f))).digest('hex')]));
const sourceBefore = hashes(), profile = scratch.directory(path.join(os.tmpdir(), 'naw-readonly-terminal-'));
const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd);
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_WORKSPACE: cwd, NAW_TEST_APP_ROOT: code }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, id, sequence = 0;
const checks = [], observations = [], errors = [];
async function until(fn, label) { for (let i = 0; i < 150; i++) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method = 'stats', target, value) { const requestId = ++sequence; return new Promise((resolve, reject) => {
  const timer = setTimeout(() => { child.off('message', receive); reject(Error('Owned fixture timeout')); }, 5000);
  const receive = result => { if (result.requestId !== requestId) return; clearTimeout(timer); child.off('message', receive); resolve(result); };
  child.on('message', receive); child.send({ id: requestId, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const surface = () => page.locator(`[data-terminal-id="${id}"] .terminal-surface`);
const stable = s => [s.id, s.nativeId, s.pid, s.owner, s.liveDraft, s.controlRevision, s.memberRevision];
async function geometry() { return surface().evaluate(el => {
  const r = el.getBoundingClientRect(), rows = el.querySelectorAll('.xterm-rows > div');
  const rect = row => { const r = row?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, text: row.textContent } : null; };
  return { top: r.top, bottom: r.bottom, right: r.right, width: r.width, height: r.height, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop, first: rect(rows[0]), last: rect(rows[rows.length - 1]) };
}); }
async function capture(name) { if (evidence && page && !page.isClosed()) { await page.screenshot({ path: path.join(evidence, name + '.png') }); fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify({ geometry: await geometry(), snapshot: await snapshot(), observations }, null, 2)); } }
async function wheel(delta) { const box = await surface().boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.wheel(0, delta); await delay(120); }
async function dragScrollbar(bottom) {
  const g = await geometry(), thumb = g.clientHeight * g.clientHeight / g.scrollHeight;
  const thumbTop = g.top + g.scrollTop / (g.scrollHeight - g.clientHeight) * (g.clientHeight - thumb);
  await page.mouse.move(g.right - 3, thumbTop + thumb / 2); await page.mouse.down();
  await page.mouse.move(g.right - 3, bottom ? g.bottom - 3 : g.top + 3, { steps: 10 }); await page.mouse.up(); await delay(120);
}
function check(label) { checks.push(label); console.log('PASS:', label); }
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Owned daemon ready'); client = await connectService(profile, 'readonly-grid-setup');
  app = await _electron.launch({ executablePath: require('electron'), args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_WORKSPACE: cwd, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await app.context().addInitScript(() => {
    window.readonlyGridTerms = new Map(); let constructor;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => {
      constructor = value; const open = value.prototype.open;
      value.prototype.open = function (element, ...args) { window.readonlyGridTerms.set(element.closest('[data-terminal-id]').dataset.terminalId, this); return open.call(this, element, ...args); };
    } });
  });
  page = await app.firstWindow(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message)); await page.locator('#new-session').waitFor(); await page.reload(); await page.locator('#new-session').waitFor();
  await app.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json');
    const { ServiceClient } = load('./app/service-client.cjs'), call = ServiceClient.prototype.call;
    globalThis.readonlyGridCalls = []; ServiceClient.prototype.call = function (method, ...args) { globalThis.readonlyGridCalls.push(method); return call.call(this, method, ...args); };
  });
  id = await client.call('create', { provider: 'codex', cwd, name: 'Original readonly grid', view: 'chat' });
  await page.locator(`[data-session-id="${id}"]`).click(); await page.locator('#chat-tab').click();
  await until(async () => (await fixture()).pending.includes(id), 'One passive native snapshot'); await fixture('release', id);
  await surface().waitFor(); if (await page.locator('#take-control').isVisible()) await page.locator('#take-control').click();
  await until(() => page.locator('#message-input').evaluate(el => !el.readOnly), 'Owned setup control'); await page.locator('#message-input').fill('Original unsent draft');
  await until(async () => (await snapshot()).sessions.find(s => s.id === id).liveDraft === 'Original unsent draft', 'Original draft saved'); await delay(200);
  const grid = await page.evaluate(id => { const t = window.readonlyGridTerms.get(id); return { cols: t.cols, rows: t.rows }; }, id);
  const rowsText = Array.from({ length: grid.rows }, (_, i) => `\x1b[${i + 1};1HROW-${String(i).padStart(3, '0')}${i === grid.rows - 1 ? ' LAST ORIGINAL ROW' : ''}`).join('');
  const frame = '\x1bc' + rowsText + '\x1b[?1000h\x1b[?1006h';
  await fixture('terminal', id, { sequence: 1, data: frame });
  await until(() => surface().locator('.xterm-rows').innerText().then(s => s.includes('LAST ORIGINAL ROW')), 'Exact original VT grid');
  await fixture('set-owner', id, 'original-other-window'); await until(() => page.locator('#message-input').evaluate(el => el.readOnly), 'Observer has no native control');
  const before = stable((await snapshot()).sessions.find(s => s.id === id)), beforeCalls = await app.evaluate(() => globalThis.readonlyGridCalls.length);
  const win = await app.browserWindow(page); await win.evaluate(w => w.setSize(850, 600)); await delay(250);
  const top = await geometry(); observations.push({ step: 'readonly-shrunk', grid, geometry: top });
  assert.ok(top.scrollHeight > top.clientHeight + 40, 'Real original grid exceeds the readonly viewport');
  assert.ok(top.last.bottom > top.bottom + 20, 'The original last row initially lies below the visible pane'); await capture('01-original-overflow');
  await dragScrollbar(true); const barBottom = await geometry(); observations.push({ step: 'bar-bottom', geometry: barBottom });
  assert.ok(barBottom.scrollTop > top.scrollTop, 'Real outer scrollbar drag moves the original frame');
  assert.ok(barBottom.last.bottom <= barBottom.bottom + 1, 'Scrollbar reaches complete last original row'); await capture('02-scrollbar-last-row');
  check('Readonly outer scrollbar reaches the complete last original row without resizing the original grid');
  await wheel(-1200); const wheelTop = await geometry(); observations.push({ step: 'wheel-top', geometry: wheelTop });
  assert.ok(wheelTop.scrollTop < barBottom.scrollTop, 'Readonly content wheel must return toward the first original row');
  assert.ok(wheelTop.first.top >= wheelTop.top - 1, 'Wheel returns to the original first row');
  await wheel(1200); const wheelBottom = await geometry(); observations.push({ step: 'wheel-bottom', geometry: wheelBottom });
  assert.ok(wheelBottom.last.bottom <= wheelBottom.bottom + 1, 'Wheel reaches complete last row over mouse-mode terminal content'); await capture('03-wheel-last-row');
  await dragScrollbar(false); const returned = await geometry(); assert.ok(returned.first.top >= returned.top - 1, 'Scrollbar returns to original top');
  check('Content wheel and outer scrollbar read both ends of the unchanged mouse-mode frame');
  await fixture('terminal', id, { sequence: 2, data: '\x1b[?1000l\x1b[?1006l\x1b[?1049h\x1b[H\x1b[2J' + rowsText });
  await until(() => page.evaluate(id => window.readonlyGridTerms.get(id).buffer.active.type === 'alternate', id), 'Original alternate frame');
  await wheel(1200); const alternateBottom = await geometry();
  assert.ok(alternateBottom.last.bottom <= alternateBottom.bottom + 1, 'Readonly alternate screen reaches complete last row locally');
  await wheel(-1200); const alternateTop = await geometry();
  assert.ok(alternateTop.first.top >= alternateTop.top - 1, 'Readonly alternate screen returns locally to first row');
  observations.push({ step: 'alternate', bottom: alternateBottom, top: alternateTop }); await capture('04-alternate-reading');
  check('Readonly alternate-screen wheel reads the oversized frame without native fallback input');
  await fixture('terminal', id, { sequence: 3, data: '\x1b[?1049l\x1bc' + Array.from({ length: 240 }, (_, i) => `HISTORY-${i}\r\n`).join('') });
  await until(() => page.evaluate(id => window.readonlyGridTerms.get(id).buffer.active.baseY > 100, id), 'Real normal-buffer scrollback');
  const historyBefore = await page.evaluate(id => window.readonlyGridTerms.get(id).buffer.active.viewportY, id), outerBefore = (await geometry()).scrollTop;
  await wheel(-240);
  const historyAfter = await page.evaluate(id => window.readonlyGridTerms.get(id).buffer.active.viewportY, id);
  assert.ok(historyAfter < historyBefore, 'Ordinary readonly history keeps xterm scrollback behavior');
  assert.equal((await geometry()).scrollTop, outerBefore, 'Native-free normal history is not diverted into outer overflow');
  observations.push({ step: 'normal-history', historyBefore, historyAfter, outerBefore, geometry: await geometry() }); await capture('05-normal-history');
  check('Ordinary normal-buffer history still scrolls within xterm despite the same readonly oversized viewport');
  assert.deepEqual(stable((await snapshot()).sessions.find(s => s.id === id)), before);
  assert.deepEqual(await page.evaluate(id => { const t = window.readonlyGridTerms.get(id); return { cols: t.cols, rows: t.rows }; }, id), grid);
  const calls = (await app.evaluate(() => globalThis.readonlyGridCalls)).slice(beforeCalls);
  assert.deepEqual(calls.filter(c => ['resize', 'input', 'claim', 'send', 'queue', 'steer', 'approve', 'answer', 'run', 'resume', 'pause'].includes(c)), []);
  const stats = await fixture(); assert.deepEqual(stats.inputs, []); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.interruptions, []); assert.deepEqual(errors, []); assert.deepEqual(hashes(), sourceBefore);
  check('Reading retains native ID, original owner, draft, grid and control revisions with zero intervention or native input');
  const result = { checks, observations, errors, modelTasks: 0, realProviderProcesses: 0, nativeInputs: stats.inputs.length, syntheticOwner: before, observerCalls: calls, grid, sourceBefore, sourceAfter: hashes(), profile, scriptSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), physicalTrackpad: 'NOT RUN', iTermComparison: 'NOT RUN' };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
const cleanup = scratch.cleanup(async () => { try { if (app) await app.close(); client?.close(); } finally { if (child.connected) child.disconnect(); if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } } });
run().catch(async error => { console.error(error.stack); process.exitCode = 1; if (page && !page.isClosed()) await capture('failure'); if (evidence) fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); }).finally(async () => {
  try { await cleanup(); assert.equal(JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))).token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ profile, token, cleanupConfirmed: true, releasedAt: new Date().toISOString() }, null, 2)); console.log('Owned profile cleaned; exact GUI token released.'); }
  catch (error) { console.error('Cleanup unconfirmed; own token retained:', error.stack); process.exitCode = 1; }
});
