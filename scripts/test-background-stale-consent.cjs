// Real hidden Electron UI and service; synthetic native producer, zero models.
const scratch = require('./fixtures/test-scratch.cjs');
const { revealDefaultSpace } = require('./fixtures/default-space.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const { connectService } = require('../app/service-connection.cjs');
const root = path.resolve(__dirname, '..'), evidence = process.env.NAW_EVIDENCE_DIR;
if (!evidence || !path.isAbsolute(evidence) || path.resolve(evidence).startsWith(root + path.sep)) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, owner: 'Codex F', task: 'stale confirmation isolated acceptance', pid: process.pid, at: new Date().toISOString() }));
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), new Date().toISOString().slice(0, 7), 'background-' + token);
fs.mkdirSync(pictures, { recursive: true });
const checks = [], trace = [], errors = [];
let profile, child, client, app, page, helper, sequence = 0, source, recipient;
const desktop = () => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); var p=$.NSEvent.mouseLocation; JSON.stringify({frontmostPid:$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier,x:p.x,y:p.y})"], { encoding: 'utf8' }));
const save = (name, value) => fs.writeFileSync(path.join(evidence, name + '.json'), JSON.stringify(value, null, 2), { mode: 0o600 });
async function checkDesktopState(stage, minimumWindows = 1) {
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(w => ({ visible: w.isVisible(), focused: w.isFocused() })));
  assert.ok(windows.length >= minimumWindows, 'Owned application windows remain observable');
  assert.ok(windows.every(w => !w.visible && !w.focused), 'Owned application windows stay hidden and unfocused');
  // Hidden, unfocused windows do not rule out this application activating itself without one (a native dialog,
  // app.focus). Whatever the person does, the frontmost application is never this test's own app (review 0a2298c6).
  const sample = desktop(), ownPid = app.process().pid;
  assert.notEqual(sample.frontmostPid, ownPid, 'This application never makes itself the frontmost application');
  // The person can move the pointer or switch apps while this hidden test runs.
  // Global samples cannot attribute such changes to this application.
  save(stage, { ...sample, ownPid, windows, attribution: 'unattributed', physicalPointerIsolation: 'unverified' });
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let n = 0; n < 150; n++) { if (await fn()) return; await wait(40); } throw Error(label); }
function fixture(method, target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(Error('Fixture response timeout')); }, 8000);
    const receive = r => { if ((method === 'backgroundProof' ? r.proofRequestId : r.requestId) !== id) return; clearTimeout(timer); child.off('message', receive); r.error ? reject(Error(r.error)) : resolve(r); };
    child.on('message', receive); child.send({ id, method, target, value });
  });
}
function mcp() {
  helper = scratch.childProcess.spawn(process.execPath, [path.join(root, 'app/claude-message-tool.cjs'), '--codex'], {
    env: { ...process.env, NAW_CONTROL_DESCRIPTOR: path.join(profile, 'outbox-owner.json') }, stdio: ['pipe', 'pipe', 'pipe'] });
  let text = ''; const pending = new Map();
  helper.stdout.setEncoding('utf8'); helper.stdout.on('data', part => { text += part; let end; while ((end = text.indexOf('\n')) >= 0) { const r = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); pending.get(r.id)?.(r); pending.delete(r.id); } });
  helper.stderr.on('data', part => errors.push(String(part)));
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => reject(Error('MCP response timeout')), 15000);
    pending.set(id, r => { clearTimeout(timer); r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result); });
    helper.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const state = () => client.call('initial');
const invoke = (method, args, id = randomUUID(), extra = {}) => ({ action: 'invoke', method, arguments: args, operation_id: id, ...extra });
async function run() {
  const before = desktop(); save('desktop-before', before);
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-background-'))); const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(root, 'app/daemon.cjs'), [profile], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/background-stale-consent.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: root, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require('../package.json').version }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  save('owned', { token, profile, childPid: child.pid });
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Fixture service starts'); client = await connectService(profile, 'human-view');
  source = await client.call('create', { provider: 'codex', cwd, name: 'Synthetic operator', view: 'chat' });
  recipient = await client.call('create', { provider: 'claude', cwd, name: 'Synthetic recipient', view: 'chat' });
  await client.call('join', source, true); await client.call('join', recipient, true);
  await client.call('draft', source, 'HUMAN ORIGINAL UNSENT DRAFT');
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: source, mode: 'chat' }]), { mode: 0o600 });
  app = await _electron.launch({ args: [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 30000 });
  save('owned', { token, profile, childPid: child.pid, appPid: app.process().pid });
  await app.evaluate(({ app }) => {
    const B = process.mainModule.require(app.getAppPath() + '/app/background-control.cjs').BackgroundControl, commit = B.prototype.commit;
    B.prototype.commit = function (...args) { globalThis.consentFixtureController = this; return commit.apply(this, args); };
  });
  page = await app.firstWindow(); page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor();
  await until(async () => await page.locator('#message-input').inputValue() === 'HUMAN ORIGINAL UNSENT DRAFT', 'Human draft restored');
  // Count what the main process sends to each window, including windows created later. A background
  // window loads no document, so anything sent to it stays in memory for as long as the app runs.
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    globalThis.sendsByWindow = new Map();
    const count = win => {
      const id = win.id;
      const original = win.webContents.send.bind(win.webContents);
      win.webContents.send = (...args) => {
        globalThis.sendsByWindow.set(id, (globalThis.sendsByWindow.get(id) || 0) + 1);
        return original(...args);
      };
    };
    BrowserWindow.getAllWindows().forEach(count);
    electronApp.on('browser-window-created', (_event, win) => count(win));
  });
  const rpc = mcp(); await rpc('initialize'); const catalog = await rpc('tools/list'); assert.ok(catalog.tools.some(t => t.name === 'workspace_control'));
  async function control(args, wrongBody = false) {
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: args });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: wrongBody ? { ...args, method: 'madeUp' } : args,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId, 'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    const value = JSON.parse(result.content[0].text); trace.push({ args, value, isError: result.isError }); save('trace', trace);
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: args }); return value;
  }
  async function decide(record, response) {
    assert.equal(record.state, 'confirmation-required', JSON.stringify(record));
    assert.equal(record.confirmation.kind, 'message');
    const card = page.locator(`[data-message-id="background:${record.actor.nativeId}:${record.id}"]`);
    await card.getByRole('button', { name: record.confirmation.options.buttons[response], exact: true }).click();
    await until(() => {
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'background-operations.json'))).records.find(r => r.id === record.id);
      return saved && !['running', 'confirmation-required'].includes(saved.state);
    }, 'Human decision settled for ' + record.id);
    return (await control({ action: 'receipt', operation_id: record.id })).receipt;
  }
  const commands = await control({ action: 'catalog' });
  assert.ok(commands.commands.some(c => c.method === 'backgroundWithdraw'));
  const stale = await control(invoke('input', [recipient, '\x1b']));
  await fixture('consentState', recipient, 'working');
  const invalid = await decide(stale, 1);
  assert.equal(invalid.disposition, 'invalidated'); assert.deepEqual((await fixture('stats')).inputs, []);
  checks.push('Actual MCP + GUI confirm of stale Esc: zero native bytes');
  await fixture('consentState', recipient, 'idle');
  const withdraw = await control(invoke('input', [recipient, '\x1b']));
  const withdrawn = await control(invoke('backgroundWithdraw', [withdraw.id]));
  assert.equal(withdrawn.state, 'complete');
  assert.equal((await control({ action: 'receipt', operation_id: withdraw.id })).receipt.disposition, 'withdrawn');
  checks.push('Authenticated catalog withdrawal of originator card');
  const claim = await control(invoke('claim', [recipient, 'terminal']));
  assert.equal((await decide(claim, 1)).state, 'complete');
  const valid = await control(invoke('input', [recipient, '\x1b']));
  assert.equal((await decide(valid, 1)).state, 'complete');
  assert.equal((await fixture('stats')).inputs.length, 1);
  const expire = await control(invoke('input', [recipient, '\x1b']));
  await app.evaluate(() => { const c = globalThis.consentFixtureController; c.now = () => Date.now() + 120001; c.expirePending(); });
  await until(async () => (await control({ action: 'receipt', operation_id: expire.id })).receipt.disposition === 'expired', 'Expired card settled');
  await app.evaluate(() => { const c = globalThis.consentFixtureController; c.now = Date.now; });
  const waiting = await control(invoke('input', [recipient, '\x1b']));
  if (await page.locator('#close-native-terminal').isVisible()) await page.locator('#close-native-terminal').click();
  checks.push('Valid card writes once; expiration does not add input');
  for (const language of ['zh', 'en']) {
    const locale = (await control(invoke('interfaceSettings', ['describe']))).value.find(s => s.ns === 'locale');
    assert.equal((await control(invoke('interfaceSettings', ['update', 'locale', { preference: language }, locale.revision]))).state, 'complete');
    for (const width of [1160, 680]) {
      await app.evaluate(({ BrowserWindow }, width) => { const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL()); w.setMinimumSize(480, 500); w.setContentSize(width, 900); }, width);
      const expiredCard = page.locator(`[data-message-id="background:${expire.actor.nativeId}:${expire.id}"]`);
      await until(async () => (await expiredCard.innerText()).includes(language === 'zh' ? '已过期' : 'Expired'), 'Localized expiry');
      await expiredCard.scrollIntoViewIfNeeded();
      assert.ok(await page.locator('.background-state[data-expires-at]').count(), 'Pending card has remaining time');
      assert.equal(await expiredCard.getByRole('button', { name: language === 'zh' ? '确认此操作' : 'Confirm this action', exact: true }).count(), 0);
      await page.screenshot({ path: path.join(pictures, `stale-consent-${language}-${width}.png`) });
      const waitingCard = page.locator(`[data-message-id="background:${waiting.actor.nativeId}:${waiting.id}"]`);
      await waitingCard.scrollIntoViewIfNeeded();
      assert.match(await waitingCard.locator('.background-state').innerText(), language === 'zh' ? /剩余 [0-9]+:[0-9]{2}/ : /[0-9]+:[0-9]{2} left/);
      await page.screenshot({ path: path.join(pictures, `pending-consent-${language}-${width}.png`) });
    }
  }
  assert.equal((await fixture('stats')).inputs.length, 1);
  await checkDesktopState('desktop-final');
  assert.deepEqual(errors, []);
  save('result', { passed: true, checks, modelCalls: 0, nativeProcesses: 0, installed: false, pictures });
}
(async () => { try { await run(); } catch (e) { save('result', { passed: false, checks, error: e.stack, errors, installed: false }); process.exitCode = 1; }
  finally {
    if (helper) helper.stdin.end();
    if (client) client.close();
    await scratch.release();
    const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); if (owner.token === token) fs.rmSync(slot, { recursive: true });
  }
})();
