'use strict';
// r4: a workspace_message refused by the sender's own plugin (「没有本原生主会话的定向协作授权」) never reached NAW, so
// one meant for the butler was lost. The plugin now tells NAW the recipient only, and R119 records the event.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
const { Workspace } = require('../workspace.cjs'), { createSubmissionServer } = require('../claude-submit.cjs');
const { QueueDispatcher } = require('../queue-dispatch.cjs');
const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' };

async function plugin() {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8') + `
export function seed(binding, prompt) {
  stopped = false; observationGap = false; nativeBlocks = true; addressedTool = true; rootBinding = binding; activeTurn = prompt ? 'turn-1' : null; rootIdle = false;
  rootPrompt = prompt ? { id: prompt, binding, pending: false } : null;
}
//${randomUUID()}`;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const hooks = new Map();
  mod.register((event, match, handler) => { hooks.set(typeof match === 'object' && match?.tool ? `${event}:${match.tool}` : event, typeof match === 'function' ? match : handler); return { catch() {} }; });
  const posted = [];
  const $ = { session: { id: async () => 'native-sender' }, env: { get: async name => ({ NAW_SUBMIT_SOCKET: '/fixture/socket', NAW_HOOK_TOKEN: 'fixture-token' })[name] },
    http: { fetch: async (url, spec) => { posted.push([url.slice('http://localhost'.length), JSON.parse(spec.body)]); return { ok: true, status: 200, text: '{"status":"recorded"}' }; } } };
  const engine = Object.assign(async () => { throw Error('not reached'); }, { origin: { plugin: 'engine', tier: 'core' } });
  return { mod, posted, $, engine, call: hooks.get('tool.call:mcp__native_workspace__workspace_message') };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

test('the plugin tells NAW only the recipient of a message it refused, once per prompt and recipient; not a subagent\'s', async () => {
  const p = await plugin(), binding = { sessionId: 'native-sender', socketPath: '/fixture/socket', token: 'fixture-token', lease: 'lease-1', observationEpoch: 'epoch-1' };
  p.mod.seed(binding, 'prompt-1');
  const send = (extra = {}) => p.call(p.$, { tool_use_id: 'call-' + randomUUID(), recipient_id: 'butler', message: 'SYNTHETIC PRIVATE MESSAGE', ...extra }, p.engine);
  // A prompt that started no turn of its own (no promptTurns link): refused as before.
  assert.equal((await send()).deny, '没有本原生主会话的定向协作授权。');
  await flush();
  assert.deepEqual(p.posted, [['/addressed-refused', { recipientId: 'butler', sessionId: 'native-sender', lease: 'lease-1' }]]);
  await send(); await flush();
  assert.equal(p.posted.length, 1, 'once per prompt and recipient');
  await send({ recipient_id: 'member' }); await flush();
  assert.equal(p.posted.length, 2);
  await send({ agentId: 'sub-1', recipient_id: 'other' }); await flush();
  assert.equal(p.posted.length, 2, 'a subagent call is refused by design and not told');
  p.mod.seed(null, 'prompt-2');
  assert.equal((await send()).deny, '没有本原生主会话的定向协作授权。');
  await flush();
  assert.equal(p.posted.length, 2, 'without a bound root nothing can be told');
  assert.doesNotMatch(JSON.stringify(p.posted), /SYNTHETIC PRIVATE/u);
});

test('the report reaches the butler\'s record: submit route, backend entry, then one event with its code', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-unbound-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = { binaries: {}, close() {}, rpc: {} }, w = new Workspace(host, dir);
  t.after(() => w.close());
  const s = { id: 'sender', nativeId: 'native-sender', provider: 'claude', model: 'claude-test-model', view: 'chat', cwd: dir, owner: 'window',
    state: 'idle', createdAt: Date.now() - 10000, messages: [], fleet: [], roomId: null, roomIds: [], controlRevision: 0, memberRevision: 0 };
  const runtime = new EventEmitter(); runtime.host = host; runtime.chatAvailable = true;
  w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime);
  Object.assign(runtime, { record: s, submission: {}, rootLease: 'lease-1', validRootBinding: m => m.lease === 'lease-1' && m.sessionId === s.nativeId });
  const socketPath = path.join(dir, 's'), transport = createSubmissionServer(socketPath, new Map([['token-1', runtime]]));
  await transport.start();
  t.after(async () => { transport.server.closeAllConnections(); await new Promise(r => transport.server.close(r)); });
  const post = body => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/addressed-refused', headers: { 'X-Workspace-Token': 'token-1' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve([res.statusCode, text]));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  const ledger = new ButlerLedger(dir), ingress = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger });
  assert.deepEqual(await post({ sessionId: s.nativeId, lease: 'lease-1', recipientId: 'butler' }), [200, '{"status":"recorded"}']);
  assert.equal((await post({ sessionId: s.nativeId, lease: 'other', recipientId: 'butler' }))[0], 409, 'not the bound root');
  assert.equal((await post({ sessionId: s.nativeId, lease: 'lease-1', recipientId: 'x'.repeat(101) }))[0], 409);
  assert.equal((await post({ sessionId: s.nativeId, lease: 'lease-1' }))[0], 409);
  assert.deepEqual(await post({ sessionId: s.nativeId, lease: 'lease-1', recipientId: 'sender' }), [200, '{"status":"ignored"}'], 'not to itself');
  const state = () => w.snapshot().sessions.find(x => x.id === s.id);
  assert.deepEqual(state().wakeUndelivered.map(e => [e.recipientId, e.sourceIssue]), [['butler', 'root-turn-unbound']]);
  ingress.observeWakeUndelivered([state()], { steward: () => BUTLER });
  ingress.observeWakeUndelivered([state()], { steward: () => BUTLER });
  const events = ledger.snapshot().events.filter(e => e.eventId.startsWith('wake-undelivered:'));
  assert.deepEqual(events.map(e => [e.kind, e.payload.reason, e.payload.outcome]), [['blocked', 'wake-undelivered', 'not-sent:root-turn-unbound']]);
  const other = new ButlerLedger(path.join(dir, 'o'));
  fs.mkdirSync(path.join(dir, 'o'), { recursive: true });
  new ButlerIngress(path.join(dir, 'o'), { roomState: new RoomState(path.join(dir, 'o')), ledger: other })
    .observeWakeUndelivered([state()], { steward: () => ({ sessionId: 'member', nativeId: 'native-member' }) });
  assert.equal(other.snapshot().events.filter(e => e.eventId.startsWith('wake-undelivered:')).length, 0, 'to anyone else, no event');
});

test('the sessions the butler continued from: done rotations only, nearest first, a loop ends', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-continued-from-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const e = (time, event, oldId, newId) => ({ time, event, spaces: [], old: { id: oldId, nativeId: 'n-' + oldId }, new: newId ? { id: newId, nativeId: 'n-' + newId } : null });
  fs.writeFileSync(path.join(dir, 'rotation-log.jsonl'), [e(1, 'done', 'a', 'b'), e(2, 'kept', 'k', 'b'), e(3, 'requested', 'b', null), e(4, 'done', 'b', 'c'),
    e(5, 'done', 'x', 'y'), e(6, 'done', 'y', 'x')].map(x => JSON.stringify(x) + '\n').join(''));
  const d = new QueueDispatcher({ roomState: new RoomState(dir), dataDir: dir, connect: async () => null, tickMs: 3600000 });
  assert.deepEqual(d.continuedFrom('c'), ['b', 'a']);
  assert.deepEqual(d.continuedFrom('a'), []);
  assert.deepEqual(d.continuedFrom('x'), ['y']);
});
