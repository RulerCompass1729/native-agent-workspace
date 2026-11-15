// Hidden real window and authenticated confirmation cards; synthetic providers.
// Build first. NAW_TEST_APP_ROOT permits the same regression against older code.
const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'), { execFileSync } = require('node:child_process');
const { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = fs.realpathSync(process.env.NAW_TEST_APP_ROOT || root);
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const { roomIds } = require(path.join(code, 'app/collaboration-spaces.cjs'));
const evidence = process.env.NAW_EVIDENCE_DIR, language = process.env.NAW_TEST_UI_LANGUAGE || 'zh';
if (!evidence || !path.isAbsolute(evidence) || [root, code].some(p => path.resolve(evidence) === p || path.resolve(evidence).startsWith(p + path.sep))) throw Error('External private evidence directory required');
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
// Cloned lanes can explicitly share the same slot with the canonical checkout.
const slot = process.env.NAW_GUI_TEST_SLOT || path.join(path.dirname(common), '.local/gui-test-slot.lock');
assert.ok(path.isAbsolute(slot), 'GUI slot must be absolute');
fs.mkdirSync(path.dirname(slot), { recursive: true });
const token = randomUUID();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no launch.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ token, task: 'room archive window test', pid: process.pid }));
const pictures = path.join(process.env.NAW_PICTURES_DIR || path.join(os.homedir(), 'Pictures/naw-dogfood'), '2026-11/room-archive-20261115');
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
      if ((method === 'backgroundProof' ? r.proofRequestId : method === 'archiveFixture' ? r.archiveRequestId : r.requestId) !== id) return;
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
  await card(record).locator('.background-controls button').first().waitFor();
  assert.equal(await card(record).locator('.background-controls button').count(), 2);
}
async function decide(record, response = 1) {
  await pendingCard(record);
  assert.deepEqual(stored(record.id).confirmation, record.confirmation, 'The click answers this exact pending question');
  const label = response === 1 ? (language === 'zh' ? '确认此操作' : 'Confirm this action') : record.confirmation.options.buttons[response];
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
  profile = fs.realpathSync(scratch.directory(path.join(os.tmpdir(), 'naw-room-archive-')));
  const cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  child = scratch.childProcess.fork(path.join(code, 'app/daemon.cjs'), [profile], {
    cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/room-archive.cjs')],
    env: { ...process.env, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd, NAW_APP_VERSION: require(path.join(code, 'package.json')).version },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.pipe(fs.createWriteStream(path.join(evidence, 'daemon.log')));
  await until(() => fs.existsSync(path.join(profile, 'connection.json')), 'Synthetic daemon ready');
  client = await connectService(profile, 'human-view'); await client.call('wakePolicy', null, false);
  const rooms = new (require(path.join(code, 'app/room-state.cjs')).RoomState)(profile);
  rooms.update({ archivedSessions: [], sessionArchives: {} });
  const room = rooms.create(language === 'zh' ? '归档验证' : 'Archive sample');
  const repair = rooms.create(language === 'zh' ? '补归档验证' : 'Repair sample');
  async function create(name, space, state = 'idle', children = 0, provider = 'claude') {
    const id = await client.call('create', { provider, cwd, name, view: 'chat' });
    await until(async () => (await client.call('initial')).sessions.find(s => s.id === id)?.state === 'idle', 'Synthetic session ready');
    if (space) await client.call('spaceAction', space, 'join', [id, true]);
    if (state === 'ended') await client.call('stop', id);
    if (state !== 'idle') await fixture('archiveFixture', id, { state, children });
    return id;
  }
  source = await create(language === 'zh' ? '合成操作员' : 'Synthetic operator', null, 'idle', 0, 'codex');
  const ended = await create(language === 'zh' ? '已结束 · 历史子任务' : 'Ended with historical children', room, 'ended', 13);
  const idle = await create(language === 'zh' ? '空闲会话' : 'Idle conversation', room, 'idle', 0, 'codex');
  const busy = await create(language === 'zh' ? '正在工作' : 'Working conversation', room, 'working');
  const unknown = await create(language === 'zh' ? '当前状态未知' : 'Unconfirmed conversation', room, 'unknown');
  const former = [], proofs = {};
  for (let n = 0; n < 6; n++) {
    const id = await create((language === 'zh' ? '旧会话 ' : 'Former conversation ') + (n + 1), repair, 'ended', n === 5 ? 13 : 0);
    const s = (await client.call('initial')).sessions.find(s => s.id === id);
    await client.call('moveMembership', id, null, { operationId: randomUUID(), nativeId: s.nativeId,
      revision: s.placementRevision, connectionRevision: s.connectionRevision || 0 });
    const after = (await client.call('initial')).sessions.find(s => s.id === id);
    proofs[id] = { nativeId: after.nativeId, connectionRevision: after.connectionRevision || 0,
      revision: after.placementRevision, signature: JSON.stringify([roomIds(after).sort(), after.memberRevision || 0,
        Object.entries(after.roomMembershipRevisions || {}).sort(([a], [b]) => a.localeCompare(b))]) };
    former.push(id);
  }
  rooms.update({ archived: true, restoreMembers: former, restorePlacements: proofs }, undefined, repair);
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'human-view', active: true, selected: source, mode: 'chat' }]), { mode: 0o600 });
  const entry = require('./fixtures/synthetic-source-boot.cjs').createSourceEntry({ profile, code, fixturePid: child.pid });
  app = await _electron.launch({ executablePath: require('electron'), args: [entry], env: { ...process.env,
    NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid), NAW_TEST_UI_LANGUAGE: language, NAW_TEST_VISIBLE: '0' }, timeout: 60000 });
  page = await app.firstWindow(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  await page.locator('#message-input').waitFor(); await hidden('startup');
  await (await app.browserWindow(page)).evaluate(w => w.setContentSize(1240, 820));
  const rpc = mcp(); await rpc('initialize');
  async function archive(target) {
    const args = { action: 'invoke', method: 'spaceAction', arguments: [target, 'archive', []], operation_id: randomUUID() };
    const proof = await fixture('backgroundProof', source, { callId: randomUUID(), arguments: args });
    const result = await rpc('tools/call', { name: 'workspace_control', arguments: args,
      _meta: { threadId: proof.nativeId, sessionId: proof.sessionId, callId: proof.callId,
        'x-codex-turn-metadata': { thread_id: proof.nativeId, turn_id: proof.turnId } } });
    const record = JSON.parse(result.content[0].text);
    await fixture('backgroundComplete', source, { callId: proof.callId, arguments: args });
    const receipt = await decide(record); trace.push({ args, receipt }); save('receipts', trace);
    assert.equal(receipt.state, 'complete', JSON.stringify(receipt)); return receipt;
  }
  save('before', { state: await state(), archives: archiveState() });
  await archive(room);
  await check('ended history and idle members archive in persisted state', async () => {
    const current = await state(), persisted = archiveState(); save('after-first', { current, persisted });
    for (const id of [ended, idle]) {
      assert.equal(current.sessions.find(s => s.id === id).archived, true);
      assert.ok(persisted.archivedSessions.includes(id));
      assert.equal(await page.locator(`#session-list .session-link[data-session-id="${id}"]`).count(), 0);
    }
  });
  await check('busy and unconfirmed members keep their exact homes with a shared reason', async () => {
    const current = await state(), record = current.rooms.find(r => r.id === room);
    for (const [id, reason] of [[busy, 'working'], [unknown, 'unconfirmed']]) {
      assert.deepEqual(roomIds(current.sessions.find(s => s.id === id)), [room]);
      assert.equal(current.sessions.find(s => s.id === id).archived, false);
      assert.ok(record.events.some(e => e.sessionId === id && e.archiveReason === reason));
    }
  });
  await archive(repair);
  await check('repeat archive repairs all six detached former members', async () => {
    const current = await state(), persisted = archiveState(); save('after-repair', { current, persisted });
    for (const id of former) assert.ok(persisted.archivedSessions.includes(id));
  });
  await check('repeat archive is idempotent', async () => {
    const before = archiveState(); await archive(repair);
    assert.deepEqual(archiveState().archivedSessions, before.archivedSessions);
    assert.deepEqual(archiveState().sessionArchives, before.sessionArchives);
  });
  await page.evaluate(async ids => { for (const id of ids) await workspace.spaceAction(id, 'restore', []); }, [room, repair]);
  await check('restore returns the original conversations and memberships', async () => {
    const current = await state(); save('after-restore', { current, persisted: archiveState() });
    for (const [space, ids] of [[room, [ended, idle, busy, unknown]], [repair, former]]) for (const id of ids) {
      assert.deepEqual(roomIds(current.sessions.find(s => s.id === id)), [space]);
      assert.equal(current.sessions.find(s => s.id === id).archived, false);
    }
  });
  await page.locator(`.room-row[data-space-id="${room}"] .room-nav`).click();
  await page.locator('#room-record').click();
  // Show the changed bilingual copy, rather than leaving it below restore events.
  await page.locator('#activity-stream .stream-tools input').fill(language === 'zh' ? '留在原处' : 'stays in place');
  await page.screenshot({ path: path.join(pictures, `${path.basename(evidence)}-${language}-record.png`) });
  const stats = await fixture('stats'); save('fixture-stats', stats);
  assert.equal(stats.nativeProcesses, 0); assert.equal(stats.modelCalls, 0);
  assert.deepEqual(stats.sends, []); assert.deepEqual(stats.inputs, []); assert.deepEqual(errors, []);
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
      assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot);
    } catch (e) { cleanupError = e.stack; console.error(cleanupError); }
    const passed = checks.filter(c => c.passed).length, failed = checks.length - passed;
    const ok = !fatal && !cleanupError && failed === 0 && checks.length === 5;
    save('result', { passed, failed, ok, checks, fatal, cleanupError, errors, pictures, syntheticNative: true, installed: false });
    console.log(`RESULT passed=${passed} failed=${failed} fatal=${Boolean(fatal)} cleanup=${cleanupError ? 'failed' : 'complete'}`);
    if (!ok) process.exitCode = 1;
  }
})();
