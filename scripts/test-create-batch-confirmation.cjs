// Create batch confirm (11-20): several new-session cards of one agent, started with the same directory, backend,
// model settings and permissions, show as one card. Real hidden Electron window, MCP broker and durable receipts;
// the native host is the synthetic fixture, so no provider process or model call is involved.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = fs.realpathSync(process.env.NAW_TEST_APP_ROOT || root);
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || [root, code].some(p => path.resolve(evidence) === p || path.resolve(evidence).startsWith(p + path.sep))) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = process.env.NAW_GUI_TEST_SLOT || path.join(path.dirname(common), '.local/gui-test-slot.lock');
assert.ok(path.isAbsolute(slot), 'GUI slot must be absolute');
fs.mkdirSync(path.dirname(slot), { recursive: true });
const token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'create batch confirmation window test', pid: process.pid }));
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), new Date().toISOString().slice(0, 7), 'create-batch-' + token);
const checks = [], trace = [], errors = [], shots = [];
let profile, child, client, app, page, helper, source, sequence = 0;
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, rounds = 400) {
  for (let n = 0; n < rounds; n++) { if (await fn()) return; await wait(40); }
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
const state = () => page.evaluate(() => workspace.initial());
const card = record => page.locator(`#messages [data-message-id="background:${record.actor.nativeId}:${record.id}"]`);
async function check(name, test) {
  try { await test(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (e) { checks.push({ name, passed: false, error: e.stack }); console.error('FAIL ' + name + '\n' + e.stack); }
  await hidden(name);
  save('checks', checks);
}
const count = (text, part) => text.split(part).length - 1;
async function run() {
  fs.mkdirSync(pictures, { recursive: true });
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-create-batch-')));
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
  // The confirmation ledger, its expiry timer and the answer path live in the Electron main process, so the
  // synthetic clock has to replace BackgroundControl there before main.cjs loads it.
  const entry = path.join(profile, 'entry');
  fs.mkdirSync(entry);
  fs.writeFileSync(path.join(entry, 'package.json'), JSON.stringify({ name: 'owned-create-batch', version: require('../package.json').version, main: 'main.cjs' }));
  fs.writeFileSync(path.join(entry, 'main.cjs'), [
    "const path = require('node:path'), e = require('electron');",
    "if (process.env.NAW_CREATE_BATCH_FIXTURE !== '1') throw Error('Owned create-batch fixture only');",
    "const root = path.resolve(process.env.NAW_TEST_APP_ROOT);",
    "e.app.setAppPath(root); e.app.getVersion = () => require(path.join(root, 'package.json')).version;",
    "const control = require(path.join(root, 'app/background-control.cjs')), Original = control.BackgroundControl, instances = new Set();",
    "let offset = 0;",
    "control.BackgroundControl = class extends Original { constructor(options) { super({ ...options, now: () => Date.now() + offset }); instances.add(this); } };",
    "globalThis.createBatchClock = { advance: async ms => { offset += ms; const deadline = Date.now() + 3000;",
    "  const states = () => [...instances].map(i => ({ failed: i.failed, inflight: i.inflight?.size, pending: i.data?.records?.filter(r => r.state === 'confirmation-required').length, expired: i.data?.records?.filter(r => r.disposition === 'expired').length }));",
    "  for (;;) { for (const i of instances) { i.expirePending(); i.changed(); }",
    "    if (![...instances].some(i => i.inflight?.size) || Date.now() >= deadline) return { offset, instances: instances.size, states: states() };",
    "    await new Promise(resolve => setTimeout(resolve, 25)); } } };",
    "require(path.join(root, 'app/main.cjs'));"
  ].join('\n'));
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env, NAW_CREATE_BATCH_FIXTURE: '1', NAW_DATA_DIR: profile, NAW_TEST_APP_ROOT: code, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_VISIBLE: '0' }, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor(); await hidden('startup');
  const rpc = mcp(); await rpc('initialize');
  assert.ok((await rpc('tools/list')).tools.some(t => t.name === 'workspace_control'));
  const win = await app.browserWindow(page);
  async function createCard(options) {
    const args = { action: 'invoke', method: 'create', arguments: [options], operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: args });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: args,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId,
        'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    const record = JSON.parse(result.content[0].text); trace.push({ args, record, isError: result.isError }); save('trace', trace);
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: args });
    assert.equal(stored(record.id).state, 'confirmation-required'); await card(record).waitFor();
    return record;
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
    if (await batch.count()) await batch.last().evaluate(el => el.scrollIntoView({ block: 'center' }));
    await wait(150);
    const layout = await page.evaluate(() => ({ width: innerWidth, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    await page.screenshot({ path: path.join(pictures, name + '.png') });
    shots.push({ name, lang, scheme, width, ...layout });
    save('shots', shots);
  }
  const toastText = () => page.locator('#toast-text').evaluate(el => el.isConnected && !el.closest('[hidden]') ? el.textContent : '').catch(() => '');
  const sessionsNamed = async names => (await state()).sessions.filter(s => names.includes(s.name));
  const batchOf = size => page.locator('#messages .background-batch').filter({ has: page.getByRole('button', { name: `全部确认（${size}）`, exact: true }) });

  await check('five-same-configuration-cards-merge', async () => {
    const names = ['Synthetic batch A', 'Synthetic batch B', 'Synthetic batch C', 'Synthetic batch D', 'Synthetic batch E'];
    const records = [];
    for (const name of names) records.push(await createCard({ provider: 'codex', cwd, name, view: 'chat', settings: { model: 'synthetic-model', effort: 'high' } }));
    const batch = batchOf(5);
    await until(async () => await batch.count() === 1 && await batch.locator('.background-batch-item').count() === 5, 'Five cards share one batch');
    await language('zh');
    const config = await batch.locator('.background-batch-config').textContent();
    save('shared-config', { config });
    assert.equal(count(config, 'Codex'), 1, 'Backend appears once');
    assert.equal(count(config, '模型：synthetic-model'), 1, 'Model appears once');
    assert.equal(count(config, '思考强度：high'), 1, 'Effort appears once');
    assert.equal(count(config, '权限：原生默认'), 1, 'Permissions appear once');
    assert.equal(count(config, '目录 workspace'), 1, 'Directory appears once');
    const rows = batch.locator('.background-batch-item');
    const shown = (await rows.allTextContents()).map(text => text.trim());
    // Each row now carries its countdown and details after the name; the name still leads every row.
    assert.equal(shown.length, names.length, 'One row per card');
    for (const [index, name] of names.entries()) assert.ok(shown[index].startsWith(name), `Row ${index + 1} names its session: ${shown[index].slice(0, 60)}`);
    assert.ok(shown.every(text => !text.includes('模型：') && !text.includes('权限：')), 'Per-row text keeps only the name');
    assert.equal(await batch.getByRole('button', { name: '全部确认（5）', exact: true }).count(), 1);
    assert.equal(await page.locator('#messages .background-controls button').count(), 3, 'Only the one batch keeps buttons');
    await shot('pending-zh-light', { lang: 'zh', scheme: 'light', width: 1240 });
    await shot('pending-en-dark', { lang: 'en', scheme: 'dark', width: 1240 });
    await shot('pending-zh-dark-narrow850', { lang: 'zh', scheme: 'dark', width: 850 });
    await shot('pending-en-light-narrow850', { lang: 'en', scheme: 'light', width: 850 });
    await language('zh'); await page.emulateMedia({ colorScheme: 'light' }); await win.evaluate(w => w.setContentSize(1240, 820));
    await batch.getByRole('button', { name: '全部确认（5）', exact: true }).click();
    await until(() => records.every(r => stored(r.id).state === 'complete'), 'All five execute');
    const receipts = records.map(r => stored(r.id));
    save('batch-receipts', receipts.map(r => ({ id: r.id, state: r.state, humanDecision: r.humanDecision })));
    assert.ok(receipts.every(r => r.state === 'complete' && r.humanDecision === 1), 'Each card has its own receipt');
    const created = await sessionsNamed(names);
    assert.equal(created.length, 5, 'Exactly one session per card');
    for (const session of created) assert.deepEqual(session.requestedSettings, { model: 'synthetic-model', effort: 'high' });
    const resultBatch = page.locator('#messages .background-batch').filter({ hasText: names[0] });
    await until(async () => (await resultBatch.locator('.background-state').textContent()).startsWith('已执行 5 项'), 'Result line counts five receipts');
    await resultBatch.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(pictures, 'result-zh-light.png') });
    assert.doesNotMatch(await toastText(), /no longer current|不再有效/);
  });

  await check('mixed-permissions-and-settings-split', async () => {
    const cases = [
      { name: 'Split codex A', options: { provider: 'codex', cwd, name: 'Split codex A', view: 'chat', settings: { model: 'synthetic-model', effort: 'high' } } },
      { name: 'Split codex B', options: { provider: 'codex', cwd, name: 'Split codex B', view: 'chat', settings: { model: 'synthetic-model', effort: 'high' } } },
      { name: 'Split codex model C', options: { provider: 'codex', cwd, name: 'Split codex model C', view: 'chat', settings: { model: 'synthetic-model-2', effort: 'high' } } },
      { name: 'Split claude plan D', options: { provider: 'claude', cwd, name: 'Split claude plan D', view: 'chat', settings: { model: 'synthetic-claude', effort: 'high', permissionMode: 'plan' } } },
      { name: 'Split claude plan E', options: { provider: 'claude', cwd, name: 'Split claude plan E', view: 'chat', settings: { model: 'synthetic-claude', effort: 'high', permissionMode: 'plan' } } },
      { name: 'Split claude edits F', options: { provider: 'claude', cwd, name: 'Split claude edits F', view: 'chat', settings: { model: 'synthetic-claude', effort: 'high', permissionMode: 'acceptEdits' } } },
      { name: 'Split codex bypass G', options: { provider: 'codex', cwd, name: 'Split codex bypass G', view: 'chat', skipPermissions: true, settings: { model: 'synthetic-model', effort: 'high' } } },
      { name: 'Split dsh H', options: { provider: 'dsh', cwd, name: 'Split dsh H', view: 'terminal' } },
    ];
    const records = [];
    for (const item of cases) records.push(await createCard(item.options));
    await language('zh');
    const codex = batchOf(2).filter({ hasText: '模型：synthetic-model ·' });
    const plan = batchOf(2).filter({ hasText: '权限：只读计划' });
    await until(async () => await batchOf(2).count() === 2, 'Two same-configuration pairs merge on their own');
    assert.equal(await codex.count(), 1, 'Codex pair keeps its own batch');
    assert.equal(await plan.count(), 1, 'Plan pair keeps its own batch');
    assert.match(await plan.locator('.background-batch-config').textContent(), /模型：synthetic-claude · 思考强度：high · 权限：只读计划/);
    assert.equal(await plan.locator('.background-risks').count(), 0, 'Plan asks no risk warning');
    // Every other configuration is a single card with its own confirmation.
    for (const record of [records[2], records[5], records[6], records[7]])
      assert.equal(await card(record).locator('.background-controls').getByRole('button', { name: '确认', exact: true }).count(), 1, 'A single configuration keeps its own confirmation');
    for (const batch of [codex, plan])
      assert.equal(await batch.locator('.background-batch-item button').count(), 0, 'A merged row has no separate confirmation');
    const edits = card(records[5]);
    assert.match(await edits.locator('.background-risks').first().textContent(), /放宽权限：新会话改文件不再问你/);
    const bypass = card(records[6]);
    assert.match(await bypass.locator('.background-risks').first().textContent(), /放宽权限：此会话执行操作前不再逐项询问/);
    await codex.getByRole('button', { name: '全部确认（2）', exact: true }).click();
    await plan.getByRole('button', { name: '全部确认（2）', exact: true }).click();
    for (const record of [records[2], records[5], records[6], records[7]]) await card(record).locator('.background-controls').getByRole('button', { name: '确认', exact: true }).click();
    await until(() => records.every(r => stored(r.id).state === 'complete'), 'All eight configurations execute');
    const created = await sessionsNamed(cases.map(item => item.name));
    assert.equal(created.length, 8, 'Each configuration starts once');
    const forName = name => created.find(s => s.name === name);
    assert.equal(forName('Split claude plan D').requestedSettings.permissionMode, 'plan');
    assert.equal(forName('Split claude edits F').requestedSettings.permissionMode, 'acceptEdits');
    assert.equal(forName('Split codex bypass G').skipPermissions, true);
    assert.equal(forName('Split dsh H').provider, 'dsh');
    assert.doesNotMatch(await toastText(), /no longer current|不再有效/);
  });

  await check('partially-expired-cards-stay-out', async () => {
    const expiredNames = ['Expired create A', 'Expired create B'];
    const expired = [];
    for (const name of expiredNames) expired.push(await createCard({ provider: 'codex', cwd, name, view: 'chat', settings: { model: 'synthetic-model', effort: 'high' } }));
    await until(async () => await batchOf(2).count() === 1, 'The two cards wait together');
    save('expiry-clock', await app.evaluate(async (_electron, ms) => globalThis.createBatchClock.advance(ms), 11 * 60 * 1000));
    await until(() => expired.every(r => stored(r.id).state === 'not-executed' && stored(r.id).disposition === 'expired'), 'Both cards reach their deadline');
    const freshNames = ['Fresh create C', 'Fresh create D', 'Fresh create E'];
    const fresh = [];
    for (const name of freshNames) fresh.push(await createCard({ provider: 'codex', cwd, name, view: 'chat', settings: { model: 'synthetic-model', effort: 'high' } }));
    const batch = batchOf(3);
    await until(async () => await batchOf(3).count() === 1 && await batch.locator('.background-batch-item').count() === 3, 'Only the fresh cards form the batch');
    const shown = (await batch.locator('.background-batch-item').allTextContents()).map(text => text.trim());
    assert.equal(shown.length, freshNames.length, 'Only the fresh cards form rows');
    for (const [index, name] of freshNames.entries()) assert.ok(shown[index].startsWith(name), `Row ${index + 1} names ${name}: ${shown[index].slice(0, 60)}`);
    assert.ok(shown.every(text => !expiredNames.some(name => text.startsWith(name))), 'Expired names are not in the batch');
    save('partial-expiry', { expired: expired.map(r => ({ id: r.id, receipt: stored(r.id) })), batch: shown });
    await batch.getByRole('button', { name: '全部确认（3）', exact: true }).click();
    await until(() => fresh.every(r => stored(r.id).state === 'complete'), 'Only the fresh three execute');
    const created = await sessionsNamed([...expiredNames, ...freshNames]);
    assert.deepEqual(created.map(s => s.name).sort(), [...freshNames].sort(), 'No session comes from an expired card');
    assert.ok(expired.every(r => stored(r.id).state === 'not-executed' && stored(r.id).disposition === 'expired'), 'Expired receipts stay expired');
  });

  await check('duplicate-submit-runs-each-card-once', async () => {
    const names = ['Repeat create A', 'Repeat create B'];
    const records = [];
    for (const name of names) records.push(await createCard({ provider: 'codex', cwd, name, view: 'chat', settings: { model: 'synthetic-model', effort: 'high' } }));
    const batch = batchOf(2);
    await until(async () => await batch.count() === 1, 'Two cards wait together');
    await page.evaluate(() => {
      const button = [...document.querySelectorAll('#messages .background-batch button')].find(el => el.textContent === '全部确认（2）');
      button.click(); button.click();
    });
    await until(() => records.every(r => stored(r.id).state === 'complete'), 'Both cards finish');
    await wait(300);
    const created = await sessionsNamed(names);
    assert.equal(created.length, 2, 'A second click does not create again');
    assert.equal(new Set(created.map(s => s.id)).size, 2);
    assert.ok(records.every(r => stored(r.id).state === 'complete'), 'Each receipt stays complete');
    assert.doesNotMatch(await toastText(), /no longer current|不再有效|已经在等/);
    save('duplicate-submit', records.map(r => ({ id: r.id, receipt: stored(r.id), sessions: created.filter(s => s.name === r.command.arguments[0].name).length })));
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
