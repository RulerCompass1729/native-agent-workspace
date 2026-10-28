const testScratch = require('./fixtures/test-scratch.cjs');
const { createIn } = require('./fixtures/create-view.cjs');
// Actual Electron and xterm wheel/scrollbar paths, synthetic VT/transport only.
// Inspect public xterm APIs in this owned window; no private-core product hook.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { fork } = testScratch.childProcess, { _electron } = testScratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connect } = require(path.join(code, 'app/service-client.cjs'));
const profile = testScratch.directory(path.join(os.tmpdir(), 'naw-terminal-scroll-'));
const child = fork(path.join(code, 'app/daemon.cjs'), [profile], { execArgv: ['--require', path.join(__dirname, 'fixtures/loading-terminal.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: profile }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const checks = [], observations = [], errors = [], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, page, client, sequence = 0;
const frames = new Map();
async function until(fn, label) { for (let i = 0; i < 120; i++) { if (await fn()) return; await delay(40); } throw Error(label); }
function fixture(method = 'stats', target, value) { const id = ++sequence; return new Promise((resolve, reject) => {
  const cb = result => { if (result.requestId === id) { clearTimeout(timer); child.off('message', cb); resolve(result); } };
  const timer = setTimeout(() => { child.off('message', cb); reject(Error('Fixture timeout')); }, 8000);
  child.on('message', cb); child.send({ id, method, target, value });
}); }
const snapshot = () => page.evaluate(() => workspace.initial());
const host = id => page.locator(`[data-terminal-id="${id}"]`);
const bytes = async id => (await fixture()).inputs.filter(row => row.id === id).map(row => row.data).join('');
const output = (id, data) => { const sequence = (frames.get(id) || 0) + 1; frames.set(id, sequence); return fixture('terminal', id, { sequence, data }); };
async function observe(id) { return page.evaluate(id => {
  const t = window.scrollTestTerms.get(id), b = t.buffer.active;
  return { buffer: b.type, baseY: b.baseY, viewportY: b.viewportY, rows: t.rows, cols: t.cols, mouse: t.modes.mouseTrackingMode, disableStdin: t.options.disableStdin, first: b.getLine(b.viewportY)?.translateToString() };
}, id); }
async function wheel(id, delta = -240) {
  const rect = await host(id).locator('.xterm-screen').boundingBox(); assert.ok(rect);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2); await page.mouse.wheel(0, delta); await delay(100);
}
async function capture(name) { if (process.env.NAW_EVIDENCE_DIR) { fs.mkdirSync(process.env.NAW_EVIDENCE_DIR, { recursive: true, mode: 0o700 }); await page.screenshot({ path: path.join(process.env.NAW_EVIDENCE_DIR, name + '.png') }); fs.writeFileSync(path.join(process.env.NAW_EVIDENCE_DIR, name + '.json'), JSON.stringify(observations, null, 2)); } }
async function create(provider) {
  await page.locator('#new-session').click(); await page.locator(`input[name="provider"][value="${provider}"]`).check(); await page.locator('#session-name').fill(provider + ' · 滚动'); await createIn(page, 'chat');
  const id = (await snapshot()).sessions.find(s => s.provider === provider).id;
  await until(async () => (await fixture()).pending.includes(id), 'Passive native pane snapshot'); await fixture('release', id);
  await host(id).locator('.terminal-surface').waitFor(); await page.locator('#message-input').fill(provider + ' 私人草稿'); return id;
}
async function run() {
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Service ready'); client = await connect(profile, 'scroll-observer');
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  // Record only the existing public Terminal API after open. Installed/source
  // code and xterm behavior remain identical; the application gets no hook.
  await app.context().addInitScript(() => {
    window.scrollTestTerms = new Map(); let constructor;
    Object.defineProperty(window, 'Terminal', { configurable: true, get: () => constructor, set: value => {
      constructor = value; const open = value.prototype.open;
      value.prototype.open = function (element, ...args) { window.scrollTestTerms.set(element.closest('[data-terminal-id]').dataset.terminalId, this); return open.call(this, element, ...args); };
    } });
  });
  page = await app.firstWindow(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#new-session').waitFor(); await page.reload(); await page.locator('#new-session').waitFor();
  for (const provider of ['claude', 'codex']) {
    const id = await create(provider);
    const original = (await snapshot()).sessions.find(s => s.id === id), identity = s => [s.id, s.nativeId, s.pid, s.owner, s.liveDraft];
    await output(id, '\x1bc' + Array.from({ length: 240 }, (_, i) => `HISTORY-${i}\r\n`).join(''));
    await until(async () => (await observe(id)).baseY > 100, 'Real xterm normal scrollback');
    const before = await observe(id), initialBytes = await bytes(id);
    await wheel(id);
    const local = await observe(id); observations.push({ provider, path: 'normal', before, after: local, bytes: await bytes(id) });
    assert.ok(local.viewportY < before.viewportY, 'Normal wheel exposes older local content');
    assert.equal(await bytes(id), initialBytes); assert.equal((await snapshot()).viewState.mode, 'chat', 'Local wheel does not change control view');
    // X10 reports clicks, not wheel input: its normal-buffer wheel is still a
    // local reading action and must not switch the native control view.
    await output(id, '\x1b[?9h'); await until(async () => (await observe(id)).mouse === 'x10', 'X10 click-only mode');
    const x10Before = await observe(id); await wheel(id);
    const x10After = await observe(id); observations.push({ provider, path: 'x10-local', before: x10Before, after: x10After });
    assert.ok(x10After.viewportY < x10Before.viewportY); assert.equal(await bytes(id), initialBytes);
    assert.equal((await snapshot()).viewState.mode, 'chat', 'Click-only mouse mode does not turn local wheel into native control');
    await output(id, '\x1b[?9l');
    // Exercise the actual scrollbar, not a programmatic scrollToLine stand-in.
    const slider = host(id).locator('.xterm-scrollable-element > .scrollbar.vertical > .slider'), track = host(id).locator('.xterm-scrollable-element > .scrollbar.vertical');
    const a = await slider.boundingBox(), b = await track.boundingBox(); assert.ok(a && b);
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2, b.y + 3, { steps: 8 }); await page.mouse.up();
    await until(async () => (await observe(id)).viewportY < local.viewportY, 'Scrollbar drag reaches older history');
    assert.equal(await bytes(id), initialBytes);
    checks.push(provider + ': normal/X10 local wheel and real scrollbar drag reveal earlier content without native input');
    await page.locator('#chat-tab').click();
    await page.evaluate(id => window.scrollTestTerms.get(id).scrollToBottom(), id);
    await output(id, '\x1b[?1000h\x1b[?1006h');
    await until(async () => (await observe(id)).mouse === 'vt200', 'Native mouse protocol enabled');
    const mouseBefore = await observe(id), previous = await bytes(id);
    if (provider === 'codex') await fixture('hold-claim', id);
    await wheel(id);
    const mouseAfter = await observe(id); observations.push({ provider, path: 'mouse', before: mouseBefore, after: mouseAfter, bytes: await bytes(id) });
    await capture(provider + '-mouse-wheel');
    assert.equal(mouseBefore.disableStdin, true, 'Mouse wheel starts from chat with an unfocused native pane');
    if (provider === 'codex') {
      await until(async () => (await fixture()).claims.includes(id), 'Wheel enters existing pending-control path');
      assert.equal(await bytes(id), previous, 'No input before native control acknowledgement');
      await fixture('release-claim', id);
    }
    await until(async () => (await bytes(id)).length > previous.length, 'Native wheel reaches its original session without a preparatory click');
    const delivered = (await bytes(id)).slice(previous.length); assert.match(delivered, /^\x1b\[<64;\d+;\d+M$/, 'One exact native SGR wheel-up event');
    await output(id, '\x1b[H\x1b[2JOlder native-program content');
    await until(() => host(id).locator('.xterm-rows').innerText().then(text => text.includes('Older native-program content')), 'Native program response remains raw');
    checks.push(provider + ': native mouse wheel prepares existing control, preserves the first event through acknowledgement and renders original program output');
    await page.locator('#chat-tab').click();
    await output(id, '\x1b[?1000l\x1b[?1006l\x1b[?1049h\x1b[HAlternate native program');
    await until(async () => (await observe(id)).buffer === 'alternate' && (await observe(id)).mouse === 'none', 'Alternate buffer without mouse tracking');
    const altBefore = await bytes(id); await wheel(id);
    await until(async () => (await bytes(id)).length > altBefore.length, 'Alternate wheel reaches native fallback');
    assert.match((await bytes(id)).slice(altBefore.length), /^\x1b(?:\[|O)A$/, 'Exact native fallback up sequence');
    observations.push({ provider, path: 'alternate', after: await observe(id), bytes: (await bytes(id)).slice(altBefore.length) });
    assert.deepEqual(identity((await snapshot()).sessions.find(s => s.id === id)), identity(original));
    await fixture('set-owner', id, 'other-test-window'); const unauthorized = await bytes(id); await wheel(id); assert.equal(await bytes(id), unauthorized);
    assert.equal((await snapshot()).sessions.find(s => s.id === id).owner, 'other-test-window', 'Wheel never takes another window control');
    checks.push(provider + ': alternate-buffer native fallback retains identity/draft and cannot send or take control after ownership changes');
    await capture(provider + '-complete');
  }
  const stats = await fixture(); assert.deepEqual(stats.sends, []); assert.deepEqual(stats.interruptions, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, observations, errors, modelTasks: 0, nativeProcesses: 0, physicalTrackpad: 'not tested', iTermComparison: 'not tested', profile, scriptSha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }, null, 2));
}
run().catch(async error => { console.error(error.stack); await capture('failed'); console.error(JSON.stringify({ observations, errors }, null, 2)); process.exitCode = 1; }).finally(testScratch.cleanup(async () => {
  try { if (app) await app.close(); if (client) { for (const s of (await client.call('initial')).sessions) await client.call('stop', s.id); await client.call('shutdown'); client.close(); } }
  finally { if (child.connected) child.disconnect(); if (child.exitCode === null) child.kill('SIGTERM'); }
}));
