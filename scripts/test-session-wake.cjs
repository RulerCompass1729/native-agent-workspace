const scratch = require('./fixtures/test-scratch.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto'), { once } = require('node:events');
const { fork } = scratch.childProcess, { _electron } = scratch.playwright(require('playwright'));
const root = path.resolve(__dirname, '..'), code = process.env.NAW_TEST_APP_ROOT || root;
const { connectService } = require(path.join(code, 'app/service-connection.cjs'));
const common = require('node:child_process').execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim();
const slot = path.join(path.dirname(common), '.local/gui-test-slot.lock'), token = randomUUID();
const sourceFiles = ['app/adapters.cjs','app/session-wake.cjs','app/addressed-handoffs.cjs','app/claude-message-tool.cjs','app/claude-submit.cjs','app/workspace.cjs','app/peer-handoffs.cjs','app/daemon.cjs','app/workspace-client.cjs','app/main.cjs','app/preload.cjs','app/renderer/renderer.js','app/dsh/client.js'];
const hashes = () => Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(code, file))).digest('hex')]));
const sourceBefore = hashes();
try { fs.mkdirSync(slot); } catch (e) { if (e.code !== 'EEXIST') throw e; console.error('GUI slot occupied; no GUI launched.'); process.exit(75); }
fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'Codex2', task: 'T100 source wake workflow', token, pid: process.pid, at: new Date().toISOString() }));
const profile = scratch.directory(path.join(os.tmpdir(), 'naw-session-wake-')), cwd = path.join(profile, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
const backendKey = 'backends/aaaaaaaaaaaaaaaaaaaa', backendDir = path.join(profile, backendKey);
fs.mkdirSync(backendDir, { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(backendDir), 0o700);
fs.writeFileSync(path.join(profile, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', backendKey] }), { mode: 0o600 });
const evidence = process.env.NAW_EVIDENCE_DIR; if (evidence) fs.mkdirSync(evidence, { recursive: true });
const spawnService = dataDir => fork(path.join(code, 'app/daemon.cjs'), [dataDir], { cwd, execArgv: ['--require', path.join(__dirname, 'fixtures/session-wake.cjs')], env: { ...process.env, NAW_APP_VERSION: require(path.join(code, 'package.json')).version, NAW_TEST_APP_ROOT: code, NAW_WORKSPACE: cwd }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const child = spawnService(profile), targetChild = spawnService(backendDir);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], errors = [];
let app, page, peer, sourceClient, targetClient, a, b, sequence = 0;
async function until(fn, message) { for (let i = 0; i < 180; i++) { if (await fn()) return; await delay(50); } throw Error(message); }
function request(child, method = 'stats', target, value) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', reply); reject(Error('Owned fixture request timed out')); }, 15000);
    const reply = row => { if (row.requestId !== id) return; clearTimeout(timer); child.off('message', reply); resolve(row); };
    child.on('message', reply);
    child.send(method === 'wakeIntent' ? { id: 'ignored-' + id, wakeRequestId: id, method, target, value } : { id, method, target, value, text: value });
  });
}
function fixture(method = 'stats', target, value) {
  if (method === 'stats') return Promise.all([request(child), request(targetChild)]).then(rows => ({ sends: rows.flatMap(r => r.sends), inputs: rows.flatMap(r => r.inputs), modelCalls: rows.reduce((n, r) => n + r.modelCalls, 0), nativeProcesses: rows.reduce((n, r) => n + r.nativeProcesses, 0) }));
  return request(target === b ? targetChild : child, method, target, value);
}
const snapshot = async () => { const [left, right] = await Promise.all([sourceClient.call('initial'), targetClient.call('initial')]); return { ...left, sessions: [...left.sessions, ...right.sessions] }; };
const stateFor = async id => (await snapshot()).sessions.find(s => s.id === id);
async function launch() {
  app = await _electron.launch({ executablePath: process.env.NAW_APP_EXECUTABLE || require('electron'), args: process.env.NAW_APP_EXECUTABLE ? [] : [root], env: { ...process.env, NAW_DATA_DIR: profile, NAW_TEST_PARENT_PID: String(process.pid) }, timeout: 70000 });
  await until(() => app.windows().length === 2, 'Two owned restored views');
  for (const p of app.windows()) { p.setDefaultTimeout(12000); p.on('pageerror', e => errors.push(e.message)); await p.locator('#new-session').waitFor(); const s = await p.evaluate(() => workspace.initial()); if (s.viewState.owner === 'wake-source-owner') page = p; else peer = p; }
  assert.ok(page && peer);
  await page.locator('#message-input').waitFor(); await peer.locator('#message-input').waitFor();
  await until(async () => (await stateFor(a)).chatAvailable && (await stateFor(b)).chatAvailable, 'Both original adapter readers ready');
}
async function send(p, text) { await p.locator('#message-input').fill(text); await p.locator('#send-button').click(); }
async function globalMenu(label) { await page.locator('#room-more').click(); await page.getByRole('menuitem', { name: label, exact: true }).click(); }
async function sessionMenu(label) { await peer.locator(`[data-session-menu="${b}"]`).click(); await peer.getByRole('menuitem', { name: label, exact: true }).click(); }
async function capture(name) { if (evidence) { await page.screenshot({ path: path.join(evidence, name + '-source.png') }); await peer.screenshot({ path: path.join(evidence, name + '-receiver.png') }); } }
async function run() {
  await until(() => [profile, backendDir].every(dir => fs.existsSync(path.join(dir, 'connection.json'))), 'Both owned services bootstrapped');
  sourceClient = await connectService(profile, 'wake-source-owner'); targetClient = await connectService(backendDir, 'wake-target-owner');
  a = await sourceClient.call('create', { provider: 'codex', cwd, name: 'Sender', view: 'chat' }); b = await targetClient.call('create', { provider: 'codex', cwd, name: 'Receiver', view: 'chat' });
  fs.writeFileSync(path.join(profile, 'views.json'), JSON.stringify([{ owner: 'wake-source-owner', active: true, selected: a, mode: 'chat' }, { owner: 'wake-target-owner', active: true, selected: b, mode: 'chat' }]), { mode: 0o600 });
  await launch(); const before = await snapshot(), original = before.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner }));
  await send(page, 'Prepare a bounded handoff.');
  const body = 'Inspect the retained result and finish one task.';
  const staged = await fixture('wakeIntent', a, { recipientId: b, body, callId: 'gui-native-call-one' }); assert.equal(staged.wakeResult?.status, 'staged', staged.wakeError);
  assert.equal((await fixture()).sends.length, 1);
  const intent = (await stateFor(a)).messages.find(m => m.wake)?.wake; assert.ok(intent);
  const exact = `[Workspace message from ${intent.senderName} · ${intent.senderId} at ${new Date(intent.time).toISOString()}]\n${body}`;
  await peer.locator('#message-input').fill(exact); await until(async () => (await stateFor(b)).liveDraft === exact, 'Exact matching unsent draft saved');
  await fixture('release', a, 'Sender has finished its original turn.');
  await until(async () => (await fixture()).sends.length === 2, 'One receiver native dispatch after source completion');
  const arrived = await stateFor(b); assert.equal(arrived.liveDraft, exact); assert.equal(arrived.owner, original.find(s => s.id === b).owner);
  assert.ok(arrived.messages.some(m => m.origin === 'agent-wake' && m.status === 'submitted' && m.text === exact && m.name === '来自 Sender'));
  assert.equal(await peer.locator('#message-input').inputValue(), exact); await capture('received');
  checks.push('Original source stages then finishes; one explicit peer message crosses two real owned daemons and arrives with native identity, source/time, owner and an exactly matching draft preserved');
  await fixture('release', b, 'Receiver completed the bounded task.'); await until(async () => (await stateFor(b)).state === 'idle', 'Receiver complete');
  await send(page, 'Prepare another bounded handoff.');
  const pending = await fixture('wakeIntent', a, { recipientId: b, body: 'This must be cancelled by the human.', callId: 'gui-native-call-two' }); assert.equal(pending.wakeResult?.status, 'staged', pending.wakeError);
  await send(peer, 'Human input takes priority.'); await peer.locator('#message-input').fill('Newer unsent human draft');
  await until(async () => (await stateFor(b)).liveDraft === 'Newer unsent human draft', 'New human draft saved');
  await fixture('release', a, 'The old source turn finishes later.');
  const calls = await fixture(); assert.equal(calls.sends.length, 4); assert.ok(!calls.sends.some(s => s.text.includes('This must be cancelled')));
  assert.equal((await stateFor(b)).liveDraft, 'Newer unsent human draft');
  assert.ok((await stateFor(a)).messages.find(m => m.wake?.callId === 'gui-native-call-two').text.includes('This must be cancelled by the human.'));
  await capture('human-priority');
  checks.push('Actual user send in the other original view revokes the pending wake globally; late source completion preserves the newer draft and never dispatches');
  await fixture('release', b, 'Human task completed.');
  await globalMenu('关闭所有 agent 自动消息'); await until(async () => (await snapshot()).wakePolicy.enabled === false, 'Global off');
  await send(page, 'A task while automatic messages are off.');
  const off = await fixture('wakeIntent', a, { recipientId: b, body: 'Must not send while off.', callId: 'gui-native-call-off' }); assert.ok(off.wakeError); assert.equal((await fixture()).sends.length, 5);
  await fixture('release', a, 'Normal task completes while automatic messaging is disabled.');
  await globalMenu('允许 agent 自动消息'); await until(async () => (await snapshot()).wakePolicy.enabled === true, 'Global on');
  await sessionMenu('禁止其他 agent 叫醒'); await until(async () => (await stateFor(b)).wakeDisabled === true, 'Per-session off');
  await capture('switches'); checks.push('Existing workspace/session menus persist global and per-session controls; global off rejects a tool call while ordinary human input still works');
  const failedMarker = path.join(profile, 'agent-wake-boundary'); fs.unlinkSync(failedMarker); fs.mkdirSync(failedMarker);
  await send(peer, 'Human control survives a failed automatic guard.');
  await until(async () => (await fixture()).sends.length === 6, 'Human input survives guard storage failure');
  const finalDraft = 'Draft after a failed automatic guard'; await peer.locator('#message-input').fill(finalDraft);
  await until(async () => (await stateFor(b)).liveDraft === finalDraft, 'Human draft still persists after guard failure');
  await until(() => peer.locator('#alert').isVisible(), 'Guard failure is visible in existing alert');
  assert.match(await peer.locator('#alert').innerText(), /自动消息守卫/);
  assert.equal((await snapshot()).wakePolicy.enabled, false); await fixture('release', b, 'Human task completed despite guard failure.');
  await capture('guard-fault'); checks.push('A non-file automatic guard disables automatic messages and shows the existing alert while real human input and newer drafts still work');
  const finalBefore = await snapshot(); await app.close(); app = null; await launch();
  const restored = await snapshot(); assert.deepEqual(restored.sessions.map(s => ({ id: s.id, nativeId: s.nativeId, owner: s.owner })), original);
  assert.equal((await stateFor(b)).liveDraft, finalDraft); assert.equal((await stateFor(b)).wakeDisabled, true);
  assert.equal((await fixture()).sends.length, 6); assert.deepEqual(errors, []); await capture('reopened');
  checks.push('Ordinary owned GUI reopen retains both original identities, owners, final drafts and per-session off without replay');
  assert.deepEqual(hashes(), sourceBefore);
  const result = { sourceBefore, sourceAfter: hashes(), checks, errors, modelCalls: 0, realProviderProcesses: 0, sends: (await fixture()).sends, original, finalBefore, profile };
  if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ checks, modelCalls: 0, realProviderProcesses: 0, syntheticSends: result.sends.length }, null, 2));
}
const cleanup = scratch.cleanup(async () => { try { if (app) await app.close(); sourceClient?.close(); targetClient?.close(); } finally { for (const service of [child, targetChild]) { if (service.connected) service.disconnect(); if (service.exitCode === null) { service.kill('SIGTERM'); await once(service, 'exit'); } } } });
run().catch(async error => { console.error(error.stack); if (page && !page.isClosed()) await capture('failure'); if (evidence) fs.writeFileSync(path.join(evidence, 'failure.txt'), error.stack); process.exitCode = 1; }).finally(async () => {
  try { await cleanup(); const owner = JSON.parse(fs.readFileSync(path.join(slot, 'owner.json'))); assert.equal(owner.token, token); fs.unlinkSync(path.join(slot, 'owner.json')); fs.rmdirSync(slot); if (evidence) fs.writeFileSync(path.join(evidence, 'released.json'), JSON.stringify({ token, releasedAt: new Date().toISOString(), ownedProfilesAndProcessesGone: true, profile }, null, 2)); console.log('Owned fixture cleaned; canonical GUI token released.'); }
  catch (e) { console.error('Cleanup unconfirmed; own lock retained:', e.stack); process.exitCode = 1; }
});
