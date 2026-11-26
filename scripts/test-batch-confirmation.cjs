// Batch confirm (11-18): several archive cards of one agent show as one card; "Confirm all" and quick clicks one by one
// queue in main instead of failing. Real hidden Electron window, MCP broker and persisted state; synthetic native only.
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'batch confirmation window test', pid: process.pid }));
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), new Date().toISOString().slice(0, 7), 'batch-confirmation-' + token);
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
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-batch-confirmation-')));
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
  async function ask(method, target) {
    const args = { action: 'invoke', method, arguments: [target], operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: args });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: args,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId,
        'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    const record = JSON.parse(result.content[0].text); trace.push({ args, record, isError: result.isError }); save('trace', trace);
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: args });
    assert.equal(stored(record.id).state, 'confirmation-required'); await card(record).waitFor();
    return record;
  }
  const archive = target => ask('archiveSession', target);
  async function create(name, provider = 'codex') {
    const id = await client.call('create', { provider, cwd, name, view: 'chat' });
    await until(async () => (await client.call('initial')).sessions.find(s => s.id === id)?.state === 'idle', 'Synthetic session ready');
    return id;
  }
  async function language(lang) {
    await page.locator('#setup-button').click(); await page.locator('#ui-language').selectOption(lang);
    await until(async () => (await page.locator('#setup-title').textContent()) === (lang === 'zh' ? '设置' : 'Settings'), 'Language changes');
    await page.locator('#close-setup').click();
  }
  async function shot(name, { lang, scheme, width }) {
    await language(lang); await page.emulateMedia({ colorScheme: scheme });
    await page.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark');
    await win.evaluate((w, width) => w.setContentSize(width, 820), width); await wait(300);
    const batch = page.locator('#messages .background-batch');
    if (await batch.count()) await batch.first().evaluate(el => el.scrollIntoView({ block: 'center' }));
    await wait(150);
    const layout = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    await page.screenshot({ path: path.join(pictures, name + '.png') });
    shots.push({ name, lang, scheme, width, ...layout });
    save('shots', shots);
  }
  const shots = [];
  const toastText = () => page.locator('#toast-text').evaluate(el => el.isConnected && !el.closest('[hidden]') ? el.textContent : '').catch(() => '');
  await check('four-archive-cards-one-batch', async () => {
    const targets = [];
    for (const name of ['Synthetic note A', 'Synthetic note B', 'Synthetic note C', 'Synthetic note D']) targets.push(await create(name));
    const records = [];
    for (const target of targets) records.push(await archive(target));
    const batch = page.locator('#messages .background-batch');
    await until(async () => await batch.count() === 1 && await batch.locator('.background-batch-item').count() === 4, 'One merged card lists four targets');
    await language('zh');
    const all = batch.getByRole('button', { name: '全部确认（4）', exact: true });
    assert.equal(await all.count(), 1, 'Exactly one Confirm all button');
    assert.equal(await batch.getByRole('button', { name: '取消这 4 项', exact: true }).count(), 1, 'Cancel names its four items');
    assert.equal(await page.locator('#messages .background-controls button').count(), 3, 'No other card keeps buttons');
    const merged = page.locator('#messages .background-merged').filter({ hasText: '已并入「全部确认（4）」' });
    assert.equal(await merged.count(), 3, 'The other cards point to the batch');
    assert.equal(await page.locator('#messages .background-card:has(.background-merged)').count(), 0, 'and look like nothing to answer');
    // Parked at the bottom under a long answer, the input box's timer and any merged line lead to the batch's buttons.
    await fixture('event', source, { method: 'item/completed', params: { threadId: records[0].actor.nativeId, turnId: 'fixture-control-turn', item: { id: randomUUID(), type: 'agentMessage', text: 'Synthetic answer. '.repeat(160) } } });
    const inView = () => all.evaluate(el => { const r = el.getBoundingClientRect(), v = document.querySelector('#messages').getBoundingClientRect(); return r.top >= v.top && r.bottom <= v.bottom; });
    const park = async () => { await page.locator('#messages').evaluate(el => { el.scrollTop = el.scrollHeight; }); await until(async () => !await inView(), 'The batch is scrolled out of view'); };
    await park();
    assert.match(await page.locator('#session-timers .session-timer').textContent(), /^去确认 · 剩余 \d+:\d\d$/);
    await page.locator('#session-timers .session-timer').click();
    await until(inView, 'The timer leads to the batch');
    await until(async () => await page.locator('[data-search-target]').count() === 0, 'The mark clears');
    await merged.last().evaluate(el => el.scrollIntoView({ block: 'start' })); await wait(300);
    assert.equal(await inView(), false, 'Only the merged line is in view');
    assert.equal(new Set(await merged.locator('button').evaluateAll(list => list.map(b => b.getAttribute('aria-label')))).size, 3, 'Each merged line names its own card');
    await merged.last().getByRole('button', { name: /^去确认：/ }).click();
    assert.equal(await card(records[0]).getAttribute('data-search-target'), 'true');
    await until(inView, 'A merged line leads to the batch');
    // What waits for the person is on the task board (R250): the batch is one row there.
    const board = require('./fixtures/board-waiting.cjs')(page);
    await board.open();
    const rows = board.waiting();
    save('waiting-rows', { rows: await rows.count() });
    assert.equal(await rows.count(), 1, 'The board lists the batch once');
    assert.match(await rows.first().locator('.task-board-task-title').textContent(), /归档会话 · 4 项/, 'The board names the batch');
    await board.close();
    await shot('pending-zh-light', { lang: 'zh', scheme: 'light', width: 1240 });
    await shot('pending-en-dark', { lang: 'en', scheme: 'dark', width: 1240 });
    await shot('pending-zh-dark-narrow850', { lang: 'zh', scheme: 'dark', width: 850 });
    await shot('pending-en-light-narrow850', { lang: 'en', scheme: 'light', width: 850 });
    await language('zh'); await page.emulateMedia({ colorScheme: 'light' }); await win.evaluate(w => w.setContentSize(1240, 820));
    // The fourth target is archived by the person while the batch runs: only that item is void.
    await all.click();
    await page.evaluate(id => workspace.archiveSession(id), targets[3]);
    await page.screenshot({ path: path.join(pictures, 'running-zh-light.png') });
    await until(() => records.every(r => !['running', 'confirmation-required'].includes(stored(r.id).state)), 'Every batch item settles');
    const receipts = records.map(r => stored(r.id));
    save('batch-receipts', receipts.map(r => ({ state: r.state, disposition: r.disposition || null, reason: r.reason || null })));
    assert.deepEqual(receipts.slice(0, 3).map(r => r.state), ['complete', 'complete', 'complete']);
    assert.notEqual(receipts[3].state, 'complete');
    const after = (await state()).sessions;
    assert.ok(targets.every(id => after.find(s => s.id === id)?.archived === true), 'Three by the batch, the fourth by the person');
    await until(async () => (await batch.locator('.background-state').textContent()).startsWith('已执行 3 项'), 'Result line counts each receipt');
    await batch.first().evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(pictures, 'result-zh-light.png') });
    await shot('result-en-dark', { lang: 'en', scheme: 'dark', width: 1240 });
    assert.doesNotMatch(await toastText(), /no longer current|不再有效/);
  });
  await check('one-by-one-quick-clicks-queue', async () => {
    await language('zh'); await page.emulateMedia({ colorScheme: 'light' }); await win.evaluate(w => w.setContentSize(1240, 820));
    const targets = [await create('Synthetic note E'), await create('Synthetic note F')];
    const records = [await archive(targets[0]), await archive(targets[1])];
    // The finished batch above keeps its result card; this one is the batch still waiting.
    const batch = page.locator('#messages .background-batch').filter({ has: page.getByRole('button', { name: '全部确认（2）', exact: true }) });
    await until(async () => await batch.count() === 1, 'Two cards merge');
    await batch.getByRole('button', { name: '逐个看', exact: true }).click();
    await until(async () => await batch.count() === 0, 'Opened one by one');
    const confirm = record => card(record).locator('.background-controls').getByRole('button', { name: '确认', exact: true });
    assert.equal(await confirm(records[0]).count(), 1); assert.equal(await confirm(records[1]).count(), 1);
    await confirm(records[0]).click(); await confirm(records[1]).click();
    await page.screenshot({ path: path.join(pictures, 'quick-clicks-zh-light.png') });
    await until(() => records.every(r => stored(r.id).state === 'complete'), 'Both quick clicks run, one after the other');
    assert.doesNotMatch(await toastText(), /no longer current|不再有效/);
  });
  await check('stop-cards-merge-by-what-they-do-and-resume-cards-merge', async () => {
    await language('zh'); await page.emulateMedia({ colorScheme: 'light' }); await win.evaluate(w => w.setContentSize(1240, 820));
    const claude = [], codex = [];
    for (const name of ['A', 'B', 'C', 'D']) claude.push(await create('Synthetic Claude ' + name, 'claude'));
    for (const name of ['A', 'B']) codex.push(await create('Synthetic Codex ' + name));
    // Asked in turn, so neither kind sits next to its own.
    const asked = new Map();
    for (const id of [claude[0], codex[0], claude[1], claude[2], codex[1], claude[3]]) asked.set(id, await ask('stop', id));
    const ends = claude.map(id => asked.get(id)), disconnects = codex.map(id => asked.get(id));
    const batch = count => page.locator('#messages .background-batch').filter({ has: page.getByRole('button', { name: `全部确认（${count}）`, exact: true }) });
    await until(async () => await batch(4).count() === 1 && await batch(2).count() === 1, 'Ending and disconnecting are two merged cards');
    const read = async count => ({ title: await batch(count).locator('.background-sentence').textContent(), risks: await batch(count).locator('.background-risk').allTextContents(),
      rows: await batch(count).locator('.background-batch-target').allTextContents(), details: await batch(count).locator('.background-batch-details pre').allTextContents() });
    const end = await read(4), disconnect = await read(2); save('stop-batches', { end, disconnect });
    assert.equal(end.title, '结束会话 · 4 项'); assert.equal(disconnect.title, '断开 Codex 会话 · 2 项');
    assert.deepEqual([end.risks, disconnect.risks], [['会停下正在进行的工作'], ['会停下正在进行的工作']]);
    assert.ok(end.rows.every(row => /Synthetic Claude/.test(row)) && disconnect.rows.every(row => /Synthetic Codex/.test(row)));
    assert.ok(end.details.length === 4 && end.details.every(text => /^这会停止本应用托管的原生主进程/.test(text)));
    assert.ok(disconnect.details.length === 2 && disconnect.details.every(text => /^关闭本应用终端连接/.test(text)));
    await batch(4).evaluate(el => el.scrollIntoView({ block: 'center' })); await page.screenshot({ path: path.join(pictures, 'stop-pending-zh-light.png') });
    await batch(4).getByRole('button', { name: '全部确认（4）', exact: true }).click();
    await until(() => ends.every(r => stored(r.id).state === 'complete'), 'One click ends all four, each with its own receipt');
    save('stop-receipts', [...ends, ...disconnects].map(r => ({ id: r.id, state: stored(r.id).state, humanDecision: stored(r.id).humanDecision ?? null })));
    assert.ok(disconnects.every(r => stored(r.id).state === 'confirmation-required'), 'The Codex batch still waits');
    const states = async ids => { const all = (await state()).sessions; return ids.map(id => all.find(s => s.id === id)?.state); };
    assert.deepEqual(await states(claude), ['ended', 'ended', 'ended', 'ended']);
    await batch(2).getByRole('button', { name: '全部确认（2）', exact: true }).click();
    await until(() => disconnects.every(r => stored(r.id).state === 'complete'), 'The earlier stops did not void the other batch');
    save('stopped', { claude: await states(claude), codex: await states(codex) });
    const resumes = [];
    for (const id of claude) resumes.push(await ask('resume', id));
    await until(async () => await batch(4).count() === 1, 'Four resume cards are one');
    assert.equal(await batch(4).locator('.background-sentence').textContent(), '恢复运行 · 4 项');
    await batch(4).evaluate(el => el.scrollIntoView({ block: 'center' })); await page.screenshot({ path: path.join(pictures, 'resume-pending-zh-light.png') });
    await batch(4).getByRole('button', { name: '全部确认（4）', exact: true }).click();
    await until(() => resumes.every(r => stored(r.id).state === 'complete'), 'One click resumes all four');
    save('resumed', { claude: await states(claude), receipts: resumes.map(r => stored(r.id).state) });
    assert.doesNotMatch(await toastText(), /no longer current|不再有效/);
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
    const ok = !fatal && !cleanupError && failed === 0 && checks.length === 3;
    save('result', { passed, failed, ok, checks, fatal, cleanupError, errors, pictures, syntheticNative: true, installed: false });
    console.log(`RESULT passed=${passed} failed=${failed} fatal=${Boolean(fatal)} cleanup=${cleanupError ? 'failed' : 'complete'}`);
    if (!ok) process.exitCode = 1;
  }
})();
