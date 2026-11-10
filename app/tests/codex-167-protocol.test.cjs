// Actual adapter/workspace, synthetic 0.167 protocol; no provider or model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const fromApp = require('node:module').createRequire(path.join(__dirname, '../native-history.cjs'));
const { Codex } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const { verifiedCodexProtocol, codexVersionInfo } = require('../native-history.cjs');
const media = require('../space-images.cjs');
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-codex167-'))), calls = [];
  const host = { binaries: {}, codexBinary: '/synthetic/codex', codexTargets: new Map(), close() {}, rpc: {
    nativeVersion: '0.167.0', ws: { readyState: 1 }, async call(method, params) { calls.push({ method, params }); throw Error('Unexpected RPC: ' + method); },
  } };
  const w = new Workspace(host, dir), s = { id: 'synthetic', nativeId: randomUUID(), provider: 'codex', cwd: dir,
    owner: 'window', state: 'idle', messages: [], fleet: [], controlRevision: 0, memberRevision: 0 };
  const r = new Codex(s, host); w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, host, calls, w, s, r };
}
test('0.167 history discovery reads bounded metadata and cursors on the qualified running connection', async () => {
  // Only executable discovery is stubbed; run the actual ready/list/read code.
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../native-history.cjs'), 'utf8'), {
    module, require: name => name === './platform.cjs' ? { executable: () => '/synthetic/codex' } : fromApp(name),
  });
  const id = randomUUID(), calls = [], thread = { id, cwd: '/synthetic', name: 'Existing note', model: 'existing-model' };
  const host = { binaries: {}, codexBinary: '/synthetic/codex', async startCodex() {}, rpc: {
    nativeVersion: '0.167.0', ws: { readyState: 1 }, async call(method, params) {
      calls.push({ method, params });
      return method === 'thread/read' ? { thread } : { data: [thread], nextCursor: params.cursor ? null : 'next-page' };
    },
  } };
  const history = new module.exports.NativeHistory(host);
  assert.equal((await history.list({ search: ' note ' })).nextCursor, 'next-page');
  assert.equal((await history.list({ cursor: 'next-page' })).nextCursor, null);
  assert.equal((await history.read(id)).nativeId, id);
  assert.deepEqual(calls.map(c => c.method), ['thread/list', 'thread/list', 'thread/read']);
  assert.equal(calls[0].params.limit, 30); assert.equal(calls[0].params.useStateDbOnly, true);
  assert.equal(calls[0].params.searchTerm, 'note'); assert.equal(calls[1].params.cursor, 'next-page');
  assert.equal(calls[2].params.includeTurns, false);
  assert.equal(codexVersionInfo(host.rpc).nativeVersionStatus, 'verified');
});
test('0.167 workspace steer reaches only the exact active turn and never starts a replacement turn', async t => {
  const f = fixture(t);
  f.r.event({ method: 'turn/started', params: { threadId: f.s.nativeId, turn: { id: 'active-turn' } } });
  f.host.rpc.call = async (method, params) => { f.calls.push({ method, params }); return { turnId: 'active-turn' }; };
  assert.equal(f.w.snapshot().sessions[0].steerAvailable, true);
  await assert.rejects(f.w.steer(f.s.id, 'Wrong target', 'window', 'old-turn'));
  await assert.rejects(f.w.steer(f.s.id, 'Wrong owner', 'other-window', 'active-turn'));
  assert.equal(f.calls.length, 0);
  const tag = await f.w.steer(f.s.id, 'Refine this task', 'window', 'active-turn');
  assert.deepEqual(f.calls, [{ method: 'turn/steer', params: { threadId: f.s.nativeId, expectedTurnId: 'active-turn',
    input: [{ type: 'text', text: 'Refine this task', text_elements: [] }], clientUserMessageId: tag } }]);
  assert.equal(f.r.turnId, 'active-turn'); assert.equal(f.s.state, 'working');
});
test('0.167 item and turn pages preserve old content, boundaries and private scope', async t => {
  const f = fixture(t);
  f.host.rpc.call = async (method, params) => {
    f.calls.push({ method, params });
    if (method === 'thread/items/list') return params.cursor
      ? { data: [{ turnId: 'turn-b', item: { type: 'agentMessage', id: 'answer-b', text: 'Older page B' } }], nextCursor: null }
      : { data: [{ turnId: 'turn-a', item: { type: 'agentMessage', id: 'answer-a', text: 'Older page A' } }], nextCursor: 'items-page' };
    if (method === 'thread/turns/list') return params.cursor
      ? { data: [{ id: 'turn-b', status: 'interrupted', completedAt: 200, durationMs: 1000 }], nextCursor: null }
      : { data: [{ id: 'turn-a', status: 'completed', completedAt: 100, durationMs: 2000 }], nextCursor: 'turns-page' };
    throw Error('Unexpected mutation: ' + method);
  };
  f.w.join(f.s.id, true); f.w.setDraft(f.s.id, 'Keep private draft', 'window'); const room = JSON.stringify(f.w.room);
  assert.equal(await f.r.hydrateHistory(f.s.nativeId), true); await f.r.turnMetadataHydration;
  assert.deepEqual(f.s.messages.filter(m => m.role === 'assistant').map(m => m.text), ['Older page A', 'Older page B']);
  assert.deepEqual(f.s.messages.filter(m => m.kind === 'turn').map(m => [m.turnId, m.status]), [['turn-a', 'complete'], ['turn-b', 'interrupted']]);
  assert.deepEqual(f.calls.filter(c => c.method === 'thread/turns/list').map(c => [c.params.itemsView, c.params.cursor]), [['notLoaded', undefined], ['notLoaded', 'turns-page']]);
  assert.equal(JSON.stringify(f.w.room), room); assert.equal(f.w.drafts.get(f.s.id), 'Keep private draft'); assert.equal(f.w.versions.dispatches, 0);
});
test('0.167 first-terminal history check uses one paginated turn instead of full hydration', async t => {
  const f = fixture(t); let launches = 0;
  f.r.terminalEndpoint = async () => '/synthetic/terminal.sock';
  f.r.makeTerminal = () => { launches++; return { alive: true }; };
  f.host.rpc.call = async (method, params) => {
    f.calls.push({ method, params });
    if (method === 'thread/read') { assert.equal(params.includeTurns, false); return { thread: { id: f.s.nativeId } }; }
    assert.equal(method, 'thread/turns/list'); assert.equal(params.limit, 1); assert.equal(params.itemsView, 'full');
    return { data: [{ id: 'saved-turn' }], nextCursor: null };
  };
  await f.r.openTerminal(); assert.equal(launches, 1); assert.equal(f.r.hasHistory, true);
  assert.deepEqual(f.calls.map(c => c.method), ['thread/read', 'thread/turns/list']);
});
test('0.167 space image forwarding waits for the exact localImage echo, not the turn acknowledgement', async t => {
  const f = fixture(t), png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
  const decoder = { createFromBuffer: bytes => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => bytes }) };
  const refs = media.stageSpaceImages(f.dir, 'shared', [{ bytes: png, name: 'Synthetic.png' }], decoder);
  const packet = { version: randomUUID(), refs }; f.w.join(f.s.id, true);
  f.host.rpc.call = async (method, params) => { f.calls.push({ method, params }); return { turn: { id: 'image-turn' } }; };
  assert.equal(f.w.snapshot().sessions[0].spaceImagesAvailable, true);
  const tag = await f.w.forward(f.s.id, 'Original caption', 'window', null, 'shared', packet);
  assert.equal(f.calls.length, 1); const call = f.calls[0]; assert.equal(call.method, 'turn/start');
  assert.equal(call.params.clientUserMessageId, tag); assert.deepEqual(call.params.input.map(p => p.type), ['text', 'localImage']);
  const row = f.w.room.messages.find(m => m.id === tag); assert.equal(row.imageReceipt.status, 'awaiting-native');
  const event = clientId => ({ method: 'item/completed', params: { threadId: f.s.nativeId, turnId: 'image-turn', completedAtMs: Date.now(),
    item: { type: 'userMessage', id: 'image-item', clientId, content: call.params.input.map(p => p.type === 'localImage' ? { ...p, detail: null } : p) } } });
  f.r.event(event('another-input')); assert.equal(row.imageReceipt.status, 'awaiting-native');
  f.r.event(event(tag)); assert.equal(row.imageReceipt.status, 'accepted'); assert.equal(row.imageReceipt.nativeItemId, 'image-item');
  await assert.rejects(f.w.forward(f.s.id, 'Original caption', 'window', null, 'shared', packet)); assert.equal(f.calls.length, 1);
});
test('future, prerelease and still-unqualified 0.166 history/steer do not inherit 0.167 qualification', t => {
  const f = fixture(t);
  for (const version of ['0.166.0', '0.168.0', '0.167.0-beta', undefined]) {
    f.host.rpc.nativeVersion = version; assert.equal(verifiedCodexProtocol(f.host.rpc), false); assert.equal(f.r.steerAvailable, false);
    if (version !== '0.166.0') assert.equal(f.r.spaceImagesAvailable, false);
  }
  f.host.rpc.nativeVersion = '0.167.0'; f.host.rpc.ws.readyState = 3; assert.equal(f.r.spaceImagesAvailable, false);
});
