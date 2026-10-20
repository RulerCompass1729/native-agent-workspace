const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { LegacyInput, installPlugin } = require('../legacy-input.cjs');
const { processIdentity } = require('../platform.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-input-')), directory = path.join(root, 'socket'), cwd = path.join(root, 'work');
  fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(root, 'connection.json'), JSON.stringify({ pid: process.pid, endpoint: path.join(directory, 'desktop.sock') }), { mode: 0o600 });
  const record = { id: 'session', nativeId: crypto.randomUUID(), pid: process.pid, processIdentity: processIdentity(process.pid), provider: 'claude', terminalAvailable: true, cwd };
  const entry = { key: '.', state: { runtimeVersion: '0.1.0-alpha.2', servicePid: process.pid } };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, cwd, record, entry };
}

test('compat installer refuses nested directory links without writing outside the plugin', t => {
  const { root, cwd } = fixture(t), plugin = path.join(cwd, '.claude/skills/native-workspace-compat');
  fs.mkdirSync(plugin, { recursive: true }); const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(plugin, 'hooks'));
  assert.throws(() => installPlugin(cwd), /路径不安全/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('failed initialization never publishes a prepared target; fixing the store permits retry', async t => {
  const f = fixture(t), bridge = new LegacyInput(f.root); t.after(() => bridge.close());
  fs.writeFileSync(path.join(f.root, 'legacy-links.json'), 'invalid');
  await assert.rejects(bridge.prepare(f.entry, f.record)); assert.equal(bridge.prepared(f.record), false);
  fs.writeFileSync(path.join(f.root, 'legacy-links.json'), '[]');
  await bridge.prepare(f.entry, f.record); assert.equal(bridge.prepared(f.record), true);
  const descriptor = JSON.parse(fs.readFileSync(path.join(f.directory, `gui-${f.record.nativeId}.json`)));
  assert.equal(descriptor.sessionId, f.record.nativeId); assert.equal(fs.statSync(path.join(f.directory, `gui-${f.record.nativeId}.json`)).mode & 0o777, 0o600);
  assert.equal(bridge.connected(f.record), false); assert.equal(bridge.connected({ ...f.record, pid: process.pid + 1 }), false);
  const code = fs.readFileSync(path.join(f.cwd, '.claude/skills/native-workspace-compat/hooks/register.js'), 'utf8');
  assert.ok(code.includes('const legacyOnly = true;')); assert.equal(bridge.records.length, 0);
});

test('closing while listen is pending cannot publish a late descriptor or listener', async t => {
  const f = fixture(t), bridge = new LegacyInput(f.root);
  const pending = bridge.prepare(f.entry, f.record); bridge.close();
  await assert.rejects(pending, /窗口连接已关闭/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(bridge.targets.size, 0); assert.equal(bridge.servers.size, 0);
  assert.equal(fs.existsSync(path.join(f.directory, `gui-${f.record.nativeId}.json`)), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'gui-submit.sock')), false);
});

// Faithful alpha.2 draft semantics: the service does NOT check owner on setDraft.
function oldWindows(t) {
  const { EventEmitter } = require('node:events');
  const { WorkspaceClient } = require('../workspace-client.cjs');
  const scope = Symbol(), session = { id: 'legacy', provider: 'claude', pid: process.pid, nativeId: 'native', owner: 'A', controlRevision: 0, memberRevision: 0, liveDraft: '', state: 'idle' };
  const calls = [], windows = [];
  const open = owner => {
    const transport = new EventEmitter();
    const snapshot = () => ({ runtimeVersion: '0.1.0-alpha.2', owner, capabilities: [], sessions: [{ ...session }], room: { messages: [], revision: 0 }, diagnostics: { dispatches: 0, shellModelCalls: 0 } });
    transport.call = async (method, id, value) => {
      if (method === 'initial') return snapshot();
      calls.push([owner, method, value]);
      if (method === 'draft') session.liveDraft = value;
      if (method === 'claim' && session.owner !== owner) { session.owner = owner; session.controlRevision++; }
    };
    transport.close = () => transport.emit('closed');
    const entry = { key: '.', state: snapshot(), client: transport };
    const client = new WorkspaceClient([entry], '.', scope); windows.push(client);
    return { client, transport };
  };
  t.after(() => windows.forEach(w => w.close()));
  return { a: open('A'), b: open('B'), session, calls };
}

test('old unguarded draft service cannot receive a former portal owner write after takeover', async t => {
  const f = oldWindows(t);
  await f.b.client.call('claim', 'legacy', 'chat'); await f.b.client.call('draft', 'legacy', 'B new private draft');
  await assert.rejects(f.a.client.call('draft', 'legacy', 'A stale private draft'), /控制权或草稿已变化/);
  assert.equal(f.session.liveDraft, 'B new private draft');
  assert.equal(f.calls.some(([owner, method]) => owner === 'A' && method === 'draft'), false);
});

test('legacy draft refresh/write and another window takeover are ordered together', async t => {
  const f = oldWindows(t), call = f.a.transport.call; let release;
  f.a.transport.call = async (...args) => {
    const result = await call(...args);
    if (args[0] === 'initial') await new Promise(resolve => { release = resolve; });
    return result;
  };
  const oldDraft = f.a.client.call('draft', 'legacy', 'A queued');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const takeover = f.b.client.call('claim', 'legacy', 'chat').then(() => f.b.client.call('draft', 'legacy', 'B latest'));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.session.owner, 'A');
  release(); await oldDraft; await takeover;
  assert.equal(f.session.owner, 'B'); assert.equal(f.session.liveDraft, 'B latest');
});

test('accepted legacy send never clears another owner or a newer same-text draft', async t => {
  for (const takeover of [false, true]) {
    const f = oldWindows(t); await f.a.client.call('draft', 'legacy', 'task'); let accepted;
    f.a.client.control.legacyInput = { connected: () => true, prepared: () => false, records: [], close() {}, send: async () => new Promise(resolve => { accepted = () => resolve('native-accepted'); }) };
    const sending = f.a.client.call('send', 'legacy', 'task');
    while (!accepted) await new Promise(resolve => setImmediate(resolve));
    if (takeover) await f.b.client.call('claim', 'legacy', 'chat');
    await (takeover ? f.b : f.a).client.call('draft', 'legacy', 'task');
    accepted(); assert.equal(await sending, 'native-accepted'); assert.equal(f.session.liveDraft, 'task');
  }
});

test('viewing an owned legacy session does not pause peer collaboration; stale view never reclaims', async t => {
  const f = oldWindows(t); let pauses = 0;
  f.a.client.pauseExcept = async () => { pauses++; };
  f.b.client.pauseExcept = async () => { pauses++; };
  await f.a.client.call('claim', 'legacy', 'terminal'); await f.a.client.call('terminal', 'legacy');
  assert.equal(pauses, 0);
  await f.b.client.call('claim', 'legacy', 'chat'); assert.equal(pauses, 1);
  await assert.rejects(f.a.client.call('claim', 'legacy', 'chat'), /其他窗口接管/);
  assert.equal(f.session.owner, 'B'); assert.equal(pauses, 1);
});
