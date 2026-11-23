// Merged-card rows and the input box's timer (11-23): each merged row opens to its single card's text; the timer beside the
// input box counts down, jumps to its card by click or Enter, lists the rest under +N. Real hidden Electron window, MCP broker
// and persisted state; synthetic native only.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = fs.realpathSync(process.env.NAW_TEST_APP_ROOT || root);
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const { roomIds } = require(path.join(code, 'app/collaboration-spaces.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || [root, code].some(p => path.resolve(evidence) === p || path.resolve(evidence).startsWith(p + path.sep))) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
// Cloned lanes can explicitly share the same slot with the canonical checkout.
const slot = process.env.NAW_GUI_TEST_SLOT || path.join(path.dirname(common), '.local/gui-test-slot.lock');
assert.ok(path.isAbsolute(slot), 'GUI slot must be absolute');
fs.mkdirSync(path.dirname(slot), { recursive: true });
const token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'session timers window test', pid: process.pid }));
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), new Date().toISOString().slice(0, 7), 'session-timers-' + token);
const checks = [], trace = [], errors = [];
let profile, child, client, app, page, helper, source, sequence = 0;
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let n = 0; n < 200; n++) { if (await fn()) return; await wait(40); }
  throw Error(label);
}
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timeout')); }, 8000);
    const receive = r => {
      if ((method === 'backgroundProof' ? r.proofRequestId : r.requestId) !== id) return;
      clearTimeout(timer); child.off('message', receive); r.error ? reject(Error(r.error)) : resolve(r);
    };
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
function mcp() {
  helper = scratch.childProcess.spawn(process.execPath, [path.join(code, 'app/claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_CONTROL_DESCRIPTOR: path.join(profile, 'outbox-owner.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = ''; const pending = new Map();
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', part => {
    buffer += part; let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      pending.get(reply.id)?.(reply); pending.delete(reply.id);
    }
  });
  helper.stderr.on('data', part => errors.push(String(part)));
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('MCP response timeout')); }, 15000);
    pending.set(id, reply => { clearTimeout(timer); reply.error ? reject(Error(JSON.stringify(reply.error))) : resolve(reply.result); });
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function hidden(stage) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  const frontmostPid = Number(execFileSync('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier"], { encoding: 'utf8' }).trim());
  save(stage + '-windows', { windows, frontmostPid, ownPid: app.process().pid });
  assert.ok(windows.length > 0 && windows.every(w => !w.visible && !w.focused), 'Owned windows stay hidden and unfocused');
  assert.notEqual(frontmostPid, app.process().pid, 'Owned app does not take the foreground');
}
const stored = id => JSON.parse(fs.readFileSync(path.join(profile, 'background-operations.json'))).records.find(r => r.id === id);
const archiveState = () => JSON.parse(fs.readFileSync(path.join(profile, 'room-state.json')));
const state = () => page.evaluate(() => workspace.initial());
const card = record => page.locator(`#messages [data-message-id="background:${record.actor.nativeId}:${record.id}"]`);
async function check(name, test) {
  try { await test(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (e) { checks.push({ name, passed: false, error: e.stack }); console.error('FAIL ' + name + '\n' + e.stack); }
  await hidden(name);
  save('checks', checks);
}
async function run() {
  fs.mkdirSync(pictures, { recursive: true });
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-session-timers-')));
  const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/background-control.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  save('source', { code, revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code, encoding: 'utf8' }).trim(), profile, childPid: child.pid });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic service starts');
  client = await connectService(profile, 'human-view');
  source = await client.call('create', { provider: 'codex', cwd, name: 'Synthetic operator', view: 'chat' });
  await client.call('wakePolicy', null, false);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: source, mode: 'chat' }]), { mode: 0o600 });
  app = await _electron.launch({ args: [code], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor(); await hidden('startup');
  const rpc = mcp(); await rpc('initialize');
  assert.ok((await rpc('tools/list')).tools.some(t => t.name === 'workspace_control'));
  const win = await app.browserWindow(page);
  async function archive(target) {
    const args = { action: 'invoke', method: 'archiveSession', arguments: [target], operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: args });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: args,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId,
        'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    const record = JSON.parse(result.content[0].text); trace.push({ args, record, isError: result.isError }); save('trace', trace);
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: args });
    assert.equal(stored(record.id).state, 'confirmation-required'); await card(record).waitFor();
    return record;
  }
  async function create(name) {
    const id = await client.call('create', { provider: 'codex', cwd, name, view: 'chat' });
    await until(async () => (await client.call('initial')).sessions.find(s => s.id === id)?.state === 'idle', 'Synthetic session ready');
    return id;
  }
  async function language(lang) {
    await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(lang);
    await until(async () => (await page.locator('#setup-title').textContent()) === (lang === 'zh' ? '设置' : 'Settings'), 'Language changes');
    await page.locator('#close-setup').click();
  }
  async function shot(name, { scheme, width }) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark');
    await win.evaluate((w, width) => w.setContentSize(width, 820), width); await wait(300);
    const layout = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    await page.screenshot({ path: path.join(pictures, name + '.png') });
    shots.push({ name, scheme, width, ...layout }); save('shots', shots);
  }
  const shots = [];
  const chip = page.locator('#session-timers .session-timer');
  const marked = () => page.evaluate(() => [...document.querySelectorAll('#messages [data-search-target]')].map(el => ({ id: el.dataset.messageId, batch: Boolean(el.querySelector('.background-batch')), focused: document.activeElement === el })));
  // Native <details>: read the expanded state from the accessibility tree, not from an attribute.
  const cdp = await page.context().newCDPSession(page);
  async function expanded(selector) {
    const { root: doc } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.nodeId, selector });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    const own = nodes[0], prop = name => own.properties?.find(p => p.name === name)?.value?.value;
    return { role: own.role?.value, name: own.name?.value, expanded: prop('expanded'), focusable: prop('focusable') };
  }
  const open = id => page.locator(`#session-list .session-link[data-session-id="${id}"]`).click();
  await language('zh');
  const targets = [], records = [];
  for (const name of ['合成 甲', '合成 乙', '合成 丙']) targets.push(await create(name));
  for (const target of targets) records.push(await archive(target));
  const batch = page.locator('#messages .background-batch');
  const rowTexts = [];
  await check('merged-rows-open-to-the-single-card-text', async () => {
    await until(async () => await batch.count() === 1 && await batch.locator('.background-batch-details').count() === 3, 'One merged card with three expandable rows');
    const summary = n => `#messages .background-batch .background-batch-item:nth-child(${n}) summary.background-batch-summary`;
    const before = await expanded(summary(1)); save('row-ax-before', before);
    assert.equal(before.expanded, false); assert.equal(before.focusable, true); assert.match(before.name, /合成 甲/);
    await page.locator(summary(1)).focus(); await page.keyboard.press('Enter');
    const after = await expanded(summary(1)); save('row-ax-after', after);
    assert.equal(after.expanded, true, 'Enter opens the row');
    await page.locator(summary(1)).click(); assert.equal((await expanded(summary(1))).expanded, false, 'A click closes it again');
    for (const n of [1, 2, 3]) {
      await page.locator(summary(n)).click();
      rowTexts.push(await page.locator(`#messages .background-batch .background-batch-item:nth-child(${n}) .background-batch-details > pre`).textContent());
    }
    assert.ok(rowTexts.every(text => text.length > 20), 'Each row shows a full text');
    assert.equal(await batch.locator('.background-buttons button').count(), 3, 'Opening rows answers nothing: the batch keeps its buttons');
    assert.ok(records.every(r => stored(r.id).state === 'confirmation-required'), 'No card was answered by expanding');
    await batch.first().evaluate(el => el.scrollIntoView({ block: 'center' }));
    await shot('rows-open-light', { scheme: 'light', width: 1280 }); await shot('rows-open-dark', { scheme: 'dark', width: 1280 });
    await page.emulateMedia({ colorScheme: 'light' });
  });
  await check('timer-counts-down-and-jumps-by-click-and-enter', async () => {
    await until(async () => await chip.count() === 1 && await chip.isVisible(), 'The timer shows beside the input box');
    const read = () => chip.evaluate(el => ({ text: el.textContent, name: el.getAttribute('aria-label'), tag: el.tagName, kind: el.dataset.kind, live: Boolean(el.closest('[aria-live]')), probe: el.probe === 1 }));
    const first = await read(); save('timer-first', first);
    assert.equal(first.tag, 'BUTTON'); assert.equal(first.kind, 'countdown'); assert.equal(first.live, false, 'No live region around the timer');
    assert.match(first.text, /^等你确认 · 剩余 \d+:\d\d$/); assert.match(first.name, /^等你确认，剩余 (\d+ 分 )?\d+ 秒，跳到这条消息$/);
    assert.equal(await page.locator('#session-timers .session-timer-more').count(), 0, 'One merged card is one timer');
    await chip.evaluate(el => { el.probe = 1; });
    await until(async () => (await read()).text !== first.text, 'The 1 s clock changes the words');
    assert.equal((await read()).probe, true, 'The tick rewrites words only; the button is the same node');
    const box = await page.locator('#session-timers').boundingBox(), input = await page.locator('#composer').boundingBox();
    save('timer-box', { box, input });
    assert.ok(Math.abs(box.x + box.width - (input.x + input.width - 14)) <= 2, 'Right edge 14 px inside the input box');
    assert.ok(box.y < input.y && box.y + box.height > input.y, 'Straddles the input box top edge');
    await page.locator('#messages').evaluate(el => { el.scrollTop = 0; });
    await chip.click();
    let jumped = await marked(); save('jump-click', jumped);
    assert.equal(jumped.length, 1); assert.equal(jumped[0].batch, true, 'Lands on the merged card'); assert.equal(jumped[0].focused, true);
    await shot('timer-jumped-light', { scheme: 'light', width: 1280 });
    await until(async () => (await marked()).length === 0, 'The highlight fades after about 2 s');
    await chip.focus(); await page.keyboard.press('Enter');
    jumped = await marked(); save('jump-enter', jumped);
    assert.equal(jumped.length, 1); assert.equal(jumped[0].batch, true);
    await until(async () => (await marked()).length === 0, 'Highlight clears');
    await shot('timer-light', { scheme: 'light', width: 1280 }); await shot('timer-dark', { scheme: 'dark', width: 1280 });
    await shot('timer-dark-850', { scheme: 'dark', width: 850 }); await page.emulateMedia({ colorScheme: 'light' }); await win.evaluate(w => w.setContentSize(1280, 820));
  });
  await check('one-by-one-shows-plus-n-and-each-row-jumps', async () => {
    await batch.getByRole('button', { name: '逐个看', exact: true }).click();
    await until(async () => await batch.count() === 0, 'Opened one by one');
    const more = page.locator('#session-timers .session-timer-more');
    await until(async () => await more.count() === 1, '+2 appears');
    assert.equal(await more.textContent(), '+2'); assert.equal(await more.getAttribute('aria-label'), '还有 2 个计时');
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    // The cards were asked in order, so the first one ends first and leads.
    await chip.click();
    let jumped = await marked(); save('plus-lead', jumped);
    assert.equal(jumped[0]?.id, `background:${records[0].actor.nativeId}:${records[0].id}`, 'The soonest deadline leads');
    await more.click(); assert.equal(await more.getAttribute('aria-expanded'), 'true');
    const rows = page.locator('#session-timer-list .session-timer-row');
    assert.equal(await rows.count(), 2); assert.ok(await page.locator('#session-timer-list').isVisible());
    const names = await rows.evaluateAll(list => list.map(el => [el.textContent, el.getAttribute('aria-label')])); save('plus-rows', names);
    assert.ok(names.every(([text, name]) => /^等你确认 · 剩余 \d+:\d\d/.test(text) && /跳到这条消息$/.test(name)));
    await shot('timer-plus-open-light', { scheme: 'light', width: 1280 }); await shot('timer-plus-open-dark', { scheme: 'dark', width: 1280 });
    await page.emulateMedia({ colorScheme: 'light' });
    await rows.first().focus(); await page.keyboard.press('Escape');
    assert.equal(await more.getAttribute('aria-expanded'), 'false', 'Escape closes the list');
    assert.equal(await more.evaluate(el => document.activeElement === el), true, 'Focus returns to +2');
    await more.click(); await rows.nth(1).click();
    jumped = await marked(); save('plus-row-jump', jumped);
    assert.equal(jumped[0]?.id, `background:${records[2].actor.nativeId}:${records[2].id}`, 'A row jumps to its own card');
    assert.equal(await more.getAttribute('aria-expanded'), 'false', 'Jumping closes the list');
    // Every single card shows the same text its merged row did.
    const single = await Promise.all(records.map(r => card(r).locator('.background-details > pre').textContent()));
    save('single-vs-row', { same: single.map((text, i) => text === rowTexts[i]) });
    assert.deepEqual(single, rowTexts);
    // Both buttons redraw on a quiet click, with no other state change to trigger the list.
    await wait(1500);
    await page.locator('#messages').getByRole('button', { name: '合成一张', exact: true }).click();
    await until(async () => await batch.count() === 1, 'Collapsed back into one card');
    await wait(1500);
    await batch.getByRole('button', { name: '逐个看', exact: true }).click();
    await until(async () => await batch.count() === 0, 'Opened one by one again');
  });
  await check('only-this-conversation-and-gone-when-done', async () => {
    await open(targets[0]);
    await until(async () => !(await page.locator('#session-timers').isVisible()), 'Another conversation shows no timer');
    await open(source);
    await until(async () => await chip.isVisible(), 'Back in the asking conversation the timer returns');
    for (const r of records) await card(r).locator('.background-controls').getByRole('button', { name: '确认', exact: true }).click();
    await until(() => records.every(r => stored(r.id).state === 'complete'), 'All three run');
    await until(async () => !(await page.locator('#session-timers').isVisible()), 'The timer leaves when nothing is pending or running');
  });
  const stats = await fixture('stats'); save('fixture-stats', stats);
  assert.equal(stats.nativeProcesses, 0); assert.equal(stats.modelCalls, 0);
  assert.deepEqual(stats.sends, []); assert.deepEqual(stats.inputs, []);
  assert.deepEqual(errors, []);
  await hidden('final');
}
(async () => {
  let fatal, cleanupError;
  try { await run(); } catch (e) { fatal = e.stack; console.error(fatal); }
  finally {
    if (helper) helper.stdin.end();
    if (client) client.close();
    try {
      await scratch.release();
      const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json')));
      if (owner.token === token) fs.rmSync(slot, { recursive: true });
    } catch (e) { cleanupError = e.stack; console.error(cleanupError); }
    const passed = checks.filter(c => c.passed).length, failed = checks.length - passed;
    const ok = !fatal && !cleanupError && failed === 0 && checks.length === 4;
    save('result', { passed, failed, ok, checks, fatal, cleanupError, errors, pictures, syntheticNative: true, installed: false });
    console.log(`RESULT passed=${passed} failed=${failed} fatal=${Boolean(fatal)} cleanup=${cleanupError ? 'failed' : 'complete'}`);
    if (!ok) process.exitCode = 1;
  }
})();
