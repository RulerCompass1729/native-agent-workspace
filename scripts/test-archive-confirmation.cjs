// Real hidden Electron window, MCP broker and persisted state; synthetic native
// transport only. Run this same script against another checkout with NAW_TEST_APP_ROOT.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = fs.realpathSync(process.env.NAW_TEST_APP_ROOT || root);
const language = process.env.NAW_TEST_UI_LANGUAGE || 'zh';
assert.ok(['zh', 'en'].includes(language), 'Archive confirmation locale is explicit');
const catalog = require(path.join(code, 'app/ui-messages.js'))[language];
const decisionLabels = record => record.confirmation.options.buttons.map((label, response) => response === 1
  ? catalog['background.card.confirm'] ?? catalog['background.confirm'] : catalog['common.cancel'] ?? label);
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
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'archive confirmation window test', pid: process.pid }));
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), new Date().toISOString().slice(0, 7), 'archive-confirmation-' + token);
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
async function pendingCard(record) {
  assert.equal(record.state, 'confirmation-required', JSON.stringify(record));
  assert.equal(record.confirmation.kind, 'message');
  await card(record).waitFor();
  assert.equal(await card(record).count(), 1, 'The operation identifies exactly one card');
  const expected = decisionLabels(record);
  assert.equal(expected.length, 2, 'The original question still has two decisions');
  await until(async () => {
    if ((await card(record).locator('.background-controls button').allTextContents()).includes(expected[1])) return true;
    const review = card(record).locator('.background-controls').getByRole('button', { name: catalog['background.batch.review'], exact: true });
    assert.ok(await review.count() <= 1, 'Review belongs only to this original card');
    if (await review.count()) {
      assert.ok(await review.isVisible() && await review.isEnabled(), 'The exact review control is available');
      // Expanding rebuilds this control synchronously; no approval is sent here.
      await review.dispatchEvent('click');
    }
    return false;
  }, 'Original card decisions are visible');
  const shown = await card(record).locator('.background-controls button').allTextContents();
  assert.deepEqual(shown.slice(0, 2), expected, 'Both original decision buttons remain, in order');
  assert.deepEqual(shown.slice(2), shown.length === 2 ? [] : [catalog['background.batch.collapse']], 'Only the known collapse control may accompany them');
}
async function decide(record, response = 1) {
  await pendingCard(record);
  assert.deepEqual(stored(record.id).confirmation, record.confirmation, 'The click answers this exact pending question');
  const label = decisionLabels(record)[response];
  const button = card(record).locator('.background-controls').getByRole('button', { name: label, exact: true });
  assert.equal(await button.count(), 1, 'Only this archive card\'s exact confirmation button is clicked');
  await button.click();
  await until(() => {
    const row = stored(record.id);
    return row && row.state !== 'running' && (row.state !== 'confirmation-required' ||
      row.humanDecisionAt && JSON.stringify(row.confirmation) !== JSON.stringify(record.confirmation));
  }, 'Confirmation settles or requires a fresh answer: ' + record.id);
  return stored(record.id);
}
async function check(name, test) {
  try { await test(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (e) { checks.push({ name, passed: false, error: e.stack }); console.error('FAIL ' + name + '\n' + e.stack); }
  await hidden(name);
  save('checks', checks);
}
async function run() {
  fs.mkdirSync(pictures, { recursive: true });
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-archive-confirmation-')));
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
  async function archive(target) {
    const args = { action: 'invoke', method: 'archiveSession', arguments: [target], operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: args });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: args,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId,
        'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    const record = JSON.parse(result.content[0].text); trace.push({ args, record, isError: result.isError }); save('trace', trace);
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: args });
    await pendingCard(record); return record;
  }
  async function create(name) {
    const id = await client.call('create', { provider: 'codex', cwd, name, view: 'chat' });
    await until(async () => (await client.call('initial')).sessions.find(s => s.id === id)?.state === 'idle', 'Synthetic session ready');
    const row = (await state()).sessions.find(s => s.id === id);
    assert.deepEqual(roomIds(row), [], 'This case uses independent sessions outside any space');
    assert.equal(Boolean(row.archived), false);
    return id;
  }
  for (const order of [[0, 1], [1, 0]]) await check('independent-order-' + order.join('-'), async () => {
    const targets = [await create('Synthetic archive first'), await create('Synthetic archive second')];
    const third = await create('Synthetic unrelated disconnect');
    const records = [await archive(targets[0]), await archive(targets[1])];
    assert.ok(records.every(r => stored(r.id).state === 'confirmation-required'), 'Both archive cards are pending together');
    await page.screenshot({ path: path.join(pictures, 'pending-' + order.join('-') + '.png') });
    const before = (await state()).sessions.find(s => s.id === third);
    // The same daemon stop endpoint used by the human stop handler; no native modal dialog.
    await client.call('stop', third);
    const stopped = (await state()).sessions.find(s => s.id === third);
    assert.equal(stopped.state, 'ended');
    assert.notEqual(stopped.connectionRevision, before.connectionRevision, 'The unrelated session really disconnected');
    assert.ok(records.every(r => stored(r.id).state === 'confirmation-required'), 'Disconnect leaves both buttons available');
    const receipts = [];
    for (const index of order) receipts.push(await decide(records[index]));
    const after = (await state()).sessions.filter(s => [...targets, third].includes(s.id));
    const persisted = archiveState();
    save('independent-' + order.join('-'), { targets, third, order, before, stopped, receipts, after, persisted });
    // Assert both receipts and the actual archive store; a resolved click alone proves nothing.
    assert.deepEqual(receipts.map(r => r.state), ['complete', 'complete']);
    assert.ok(targets.every(id => after.find(s => s.id === id)?.archived === true));
    assert.ok(targets.every(id => persisted.archivedSessions.includes(id)));
    assert.equal(after.find(s => s.id === third).archived, false);
    assert.equal(after.find(s => s.id === third).state, 'ended');
  });
  for (const change of ['rename', 'archive']) await check('target-changed-' + change, async () => {
    const target = await create('Synthetic changed target'), record = await archive(target);
    if (change === 'rename') await page.evaluate(id => workspace.rename(id, 'Synthetic renamed target'), target);
    else await page.evaluate(id => workspace.archiveSession(id), target);
    const before = archiveState(), beforeRow = (await state()).sessions.find(s => s.id === target);
    if (change === 'rename') assert.equal(beforeRow.name, 'Synthetic renamed target');
    else assert.equal(beforeRow.archived, true);
    const receipt = await decide(record), after = archiveState();
    const row = (await state()).sessions.find(s => s.id === target);
    save('target-changed-' + change, { target, before, beforeRow, receipt, after, row });
    if (change === 'rename') {
      assert.equal(receipt.state, 'confirmation-required', 'The old answer cannot authorize the renamed target');
      assert.notDeepEqual(receipt.confirmation, record.confirmation, 'The replacement question names the changed target');
      const reference = JSON.parse(receipt.confirmation.options.detail).references.find(r => r.id === target);
      assert.equal(reference.name, 'Synthetic renamed target');
    } else assert.equal(receipt.state, 'unconfirmed', 'A card for an already archived target must be refused');
    // Audit events record the refusal; archive membership and restore plans must not change.
    assert.deepEqual(after.archivedSessions, before.archivedSessions, 'The stale answer changes no archived session IDs');
    assert.deepEqual(after.sessionArchives, before.sessionArchives, 'The stale answer changes no archive restore plans');
    assert.equal(row.archived, change === 'archive');
    if (change === 'rename') assert.equal(row.name, 'Synthetic renamed target');
    if (change === 'rename') assert.equal((await decide(receipt, 0)).state, 'cancelled', 'Dismiss the new question without approving it');
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
