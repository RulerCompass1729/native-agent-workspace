// Synthetic transport using the typed error fields observed in a native rollout.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Codex } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { RoomState } = require('../room-state.cjs');
const { ButlerIngress } = require('../butler-ingress.cjs');
const { sessionReady, CAPABILITY } = require('../queue-dispatch.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-quota-'));
  fs.chmodSync(dir, 0o700);
  const calls = [], host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: {
    call: async (method, params) => { calls.push({ method, params }); return { turn: { id: 'retry-turn' } }; }
  } };
  const w = new Workspace(host, dir), s = { id: 'member-a', nativeId: 'native-a', provider: 'codex', model: 'model-a',
    cwd: dir, view: 'chat', owner: 'window', state: 'idle', controlRevision: 0, memberRevision: 0,
    messages: [], serviceCapabilities: [CAPABILITY], background: 0, scheduled: 0, fleet: [] };
  const r = new Codex(s, host); w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  const room = new RoomState(dir), ingress = new ButlerIngress(dir, { roomState: room });
  const observe = () => ingress.observeRecoveryFailures(w.snapshot().sessions);
  w.on('change', observe);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const notify = (method, params, rpc = host.rpc) => r.event({ method, params: { threadId: s.nativeId, ...params } }, rpc);
  const start = id => notify('turn/started', { turn: { id } });
  const end = (id, error, status = 'failed') => notify('turn/completed', { turn: { id, status, ...(error ? { error } : {}) } });
  return { dir, w, s, r, host, calls, room, ingress, observe, notify, start, end,
    snapshot: () => w.snapshot().sessions.find(row => row.id === s.id), events: () => ingress.ledger.eventsAfter(null).events };
}
const rawError = () => ({ codex_error_info: 'usage_limit_exceeded', message: "You've hit your usage limit. Try again later." });
const ready = s => sessionReady(s, { enabled: true });
for (const [field, code] of [['codex_error_info', 'usage_limit_exceeded'], ['codexErrorInfo', 'usageLimitExceeded']])
test(`verified ${field} quota persists before idle, stops only this member, and reaches the ledger once`, t => {
  const f = fixture(t); f.start('quota-turn');
  const error = { [field]: code, message: 'NATIVE QUOTA BODY', private: 'DO NOT COPY', resetsAt: 1_900_000_000 };
  f.notify('error', { turnId: 'quota-turn', error, willRetry: true });
  assert.equal(f.snapshot().nativeQuota?.kind, 'usage_limit_exceeded');
  assert.equal(f.snapshot().nativeQuota.turnId, 'quota-turn');
  assert.equal(f.snapshot().nativeQuota.model, 'model-a');
  assert.equal(f.snapshot().nativeQuota.resetsAt, 1_900_000_000);
  assert.equal(f.r.nativeRetry, null, 'Quota must not enter transient retry mode');
  f.end('quota-turn', error); f.observe();
  const row = f.snapshot(); assert.equal(row.state, 'idle');
  assert.deepEqual(ready(row), { ready: false, reason: 'usage-limit-exceeded' });
  assert.equal(ready({ ...row, id: 'member-b', nativeId: 'native-b', nativeQuota: undefined }).ready, true);
  assert.equal(f.w.capacityRecoveries.size, 0); assert.equal(f.calls.length, 0);
  assert.equal(f.events().length, 1); assert.equal(f.events()[0].kind, 'blocked');
  assert.deepEqual(f.events()[0].payload, { memberId: 'member-a', reason: 'codex-usage-limit-exceeded' });
  assert.ok(!JSON.stringify(row.nativeQuota).includes('DO NOT COPY'));
  assert.ok(!JSON.stringify(f.events()).includes('NATIVE QUOTA BODY'));
  const ledgerBytes = fs.readFileSync(f.ingress.ledger.file);
  new ButlerIngress(f.dir, { roomState: f.room }).observeRecoveryFailures([row, row]);
  assert.deepEqual(fs.readFileSync(f.ingress.ledger.file), ledgerBytes);
  f.w.persist();
  const saved = new Workspace(f.host, f.dir);
  try { assert.deepEqual(saved.snapshot().sessions[0].nativeQuota, row.nativeQuota); }
  finally { saved.close(); }
});
test('completion alone classifies the recorded snake_case error without parsing its prose reset time', t => {
  const f = fixture(t); f.start('quota-turn'); f.end('quota-turn', rawError());
  assert.equal(f.snapshot().nativeQuota?.turnId, 'quota-turn');
  assert.equal(f.snapshot().nativeQuota.resetsAt, undefined); assert.equal(f.events().length, 1);
});
for (const boundary of ['wrong-thread', 'old-turn', 'no-turn', 'foreign-rpc', 'replaced-rpc', 'lifecycle', 'stopped', 'disconnected', 'context-pending'])
test('quota classification refuses unverified ' + boundary, t => {
  const f = fixture(t); f.start('quota-turn');
  const params = { turnId: 'quota-turn', error: rawError() }; let rpc = f.host.rpc;
  if (boundary === 'wrong-thread') params.threadId = 'native-other';
  if (boundary === 'old-turn') params.turnId = 'unseen';
  if (boundary === 'no-turn') delete params.turnId;
  if (boundary === 'foreign-rpc') rpc = {};
  if (boundary === 'replaced-rpc') { f.host.rpc = {}; rpc = f.host.rpc; }
  if (boundary === 'lifecycle') f.r.lifecycleRevision++;
  if (boundary === 'stopped') f.r.stopped = true;
  if (boundary === 'disconnected') f.r.transportDisconnected = true;
  if (boundary === 'context-pending') f.s.nativeContextPending = {};
  f.notify('error', params, rpc);
  assert.equal(f.snapshot().nativeQuota ?? null, null); assert.equal(f.events().length, 0);
});
for (const error of [{ message: "You've hit your usage limit" }, { codexErrorInfo: 'other', message: 'usage_limit_exceeded' },
  { codexErrorInfo: 'requestForbidden' }, { codexErrorInfo: 'connectionFailed' },
  { codexErrorInfo: 'other', codex_error_info: 'usage_limit_exceeded' }])
test('unknown/plain-text/other-provider error stays outside quota: ' + JSON.stringify(error), t => {
  const f = fixture(t); f.start('ordinary-turn'); f.end('ordinary-turn', error);
  assert.equal(f.snapshot().nativeQuota ?? null, null); assert.equal(f.events().length, 0);
});
test('normal assistant text is not an error even if it quotes the native quota enum', t => {
  const f = fixture(t); f.start('ordinary-turn');
  f.notify('item/completed', { turnId: 'ordinary-turn', item: { id: 'answer', type: 'agentMessage', text: 'usage_limit_exceeded' } });
  f.end('ordinary-turn', null, 'completed'); assert.equal(f.snapshot().nativeQuota ?? null, null); assert.equal(f.events().length, 0);
});
test('a live successful human retry clears the episode, while stale history and a mere turn start do not', t => {
  const f = fixture(t); f.start('quota-turn'); f.end('quota-turn', rawError()); const original = structuredClone(f.s.nativeQuota);
  f.end('history-turn', null, 'completed'); assert.deepEqual(f.s.nativeQuota, original);
  f.start('human-retry'); assert.deepEqual(f.s.nativeQuota, original);
  f.end('human-retry', null, 'completed'); assert.equal(f.snapshot().nativeQuota ?? null, null);
  assert.equal(ready(f.snapshot()).ready, true); assert.equal(f.events().length, 1);
  f.start('second-episode'); f.end('second-episode', rawError()); assert.equal(f.events().length, 2);
});
test('native replacement does not inherit quota; model changes and reconnect do not erase an unresolved session quota', t => {
  const f = fixture(t); f.start('quota-turn'); f.end('quota-turn', rawError()); const row = f.snapshot();
  assert.equal(ready({ ...row, model: 'model-b' }).ready, false);
  assert.equal(ready({ ...row, nativeId: 'native-b' }).ready, true);
  assert.equal(ready({ ...row, provider: 'claude' }).ready, true);
  const bytes = fs.readFileSync(f.ingress.ledger.file);
  f.ingress.observeRecoveryFailures([{ ...row, model: 'model-b' }, { ...row, nativeId: 'native-b' }]);
  assert.deepEqual(fs.readFileSync(f.ingress.ledger.file), bytes);
  f.r.emit('state', 'idle'); assert.equal(ready(f.snapshot()).ready, false);
});
test('automatic dispatch rechecks quota at the backend even if its caller retained an older ready snapshot', async t => {
  const f = fixture(t); f.start('quota-turn'); f.end('quota-turn', rawError());
  await assert.rejects(f.w.send(f.s.id, 'Synthetic queued task', 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: 'item-a' }));
  assert.equal(f.calls.length, 0); assert.equal(f.s.messages.filter(m => m.role === 'user').length, 0);
});
test('a still-blocked manual retry cannot arm the overload timer, and another quota retains the original episode', t => {
  const f = fixture(t); f.host.rpc.nativeVersion = '0.164.0';
  f.start('quota-turn'); f.end('quota-turn', rawError());
  f.start('another-quota'); f.end('another-quota', rawError());
  assert.equal(f.s.nativeQuota.turnId, 'quota-turn'); assert.equal(f.events().length, 1);
  f.start('manual-overload'); f.end('manual-overload', { codexErrorInfo: 'serverOverloaded' });
  assert.equal(f.w.capacityRecoveries.size, 0, 'An unresolved quota cannot be converted to a timed transient retry');
});
test('a success from a different model, or a contradictory duplicate completion, cannot clear quota', t => {
  const f = fixture(t); f.start('quota-turn');
  f.notify('error', { turnId: 'quota-turn', error: rawError() });
  f.end('quota-turn', null, 'completed');
  assert.equal(f.s.nativeQuota?.turnId, 'quota-turn', 'The failing turn is not its own recovery proof');
  f.s.model = 'model-b'; f.start('other-model'); f.s.model = 'model-a';
  f.end('other-model', null, 'completed'); assert.equal(f.s.nativeQuota?.turnId, 'quota-turn');
});
test('snake_case structured reset is retained, malformed/conflicting resets and prose never become timers', t => {
  for (const [extra, expected] of [[{ resets_at: 1_900_000_000 }, 1_900_000_000],
    [{ resets_at: 'tomorrow' }, undefined], [{ resetsAt: -1 }, undefined],
    [{ resetsAt: 1_900_000_000, resets_at: 1_900_000_001 }, undefined]]) {
    const f = fixture(t); f.start('quota-turn'); f.end('quota-turn', { ...rawError(), ...extra });
    assert.equal(f.s.nativeQuota?.resetsAt, expected); assert.equal(f.w.capacityRecoveries.size, 0);
  }
});
test('a typed quota without any observed native turn or thread binding is ignored', t => {
  const f = fixture(t);
  f.end('unobserved', rawError());
  f.r.event({ method: 'turn/started', params: { turn: { id: 'unbound' } } });
  f.notify('error', { turnId: 'unbound', error: rawError() });
  assert.equal(f.s.nativeQuota ?? null, null); assert.equal(f.events().length, 0);
});
test('ordinary native retry metadata retains its existing behavior', t => {
  const f = fixture(t); f.start('ordinary-turn');
  f.notify('error', { turnId: 'ordinary-turn', error: { codexErrorInfo: 'other', message: 'Synthetic transient error' }, willRetry: true });
  assert.equal(f.r.nativeRetry, 'ordinary-turn'); assert.equal(f.s.nativeQuota ?? null, null);
});
for (const beforeAck of [false, true]) test('the accepted turn ACK is identity proof even without a turn-start notification: completion before ACK=' + beforeAck, async t => {
  const f = fixture(t); let acknowledge;
  f.host.rpc.call = () => new Promise(resolve => { acknowledge = resolve; });
  const sending = f.r.send('Synthetic human retry', 'human-tag', () => true);
  if (beforeAck) f.end('ack-turn', rawError());
  acknowledge({ turn: { id: 'ack-turn' } }); await sending;
  if (!beforeAck) f.end('ack-turn', rawError());
  assert.equal(f.s.nativeQuota?.turnId, 'ack-turn'); assert.equal(f.events().length, 1);
  assert.equal(ready(f.snapshot()).ready, false);
});

test('manual success after a model change resolves only this native session; repeated quota does not create another event', t => {
  const f = fixture(t); f.start('quota-turn'); f.end('quota-turn', rawError());
  f.s.model = 'model-b'; f.start('manual-b-quota'); f.end('manual-b-quota', rawError());
  assert.equal(f.s.nativeQuota.turnId, 'quota-turn'); assert.equal(f.events().length, 1);
  f.start('manual-b-success'); f.end('manual-b-success', null, 'completed');
  assert.equal(f.s.nativeQuota ?? null, null); assert.equal(ready(f.snapshot()).ready, true);
});
