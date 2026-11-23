const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { ButlerLedger } = require('../butler-ledger.cjs');
const { ButlerIngress } = require('../butler-ingress.cjs');
const { StewardWake, GAP_MS, wakeText } = require('../steward-wake.cjs');
const stewardRecords = require('../steward-record.cjs');
const rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs');
const { Workspace } = require('../workspace.cjs');
const { createSubmissionServer } = require('../claude-submit.cjs');
const { uiError } = require('../ui-errors.cjs');

// The person, 2026-11-23: 「如果我不理你的话感觉就卡在这里了」. A refused butler call ended its turn and nothing
// woke it. A refusal is now an event (reason code only), waking the butler at most 3 times in a row; a call that
// goes through resets that. Synthetic sessions, no provider process, model or daily app.
const NOW = 1_800_000_000_000;
const BUTLER = { sessionId: 'butler', nativeId: 'native-butler' };
const SENDER = { id: 'butler', nativeId: 'native-butler', provider: 'claude', name: 'Synthetic butler' };
const failure = n => ({ eventId: `butler-source:${n}`, sourceRef: `queue-outcome:space-1:${n}`, kind: 'failure',
  payload: { spaceId: 'space-1', itemId: `item-${n}`, reason: `Synthetic failure reason ${n}` } });
const refused = (n, extra = {}) => ({ state: 'not-executed', reason: 'another-operation-running', retry: false, method: 'spaceAction', ...extra });
const args = n => ({ action: 'invoke', method: 'spaceAction', arguments: ['shared', 'queueAdd', ['SYNTHETIC PRIVATE TEXT', null]], operation_id: `op-${n}` });
function directory(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function unit(t) {
  const dir = directory(t, 'naw-control-refused-'), clock = { now: NOW }, lines = [], sends = [];
  const ledger = new ButlerLedger(dir, { now: () => clock.now });
  const ingress = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger, now: () => clock.now });
  const wake = new StewardWake(dir, { ledger: () => ledger, selected: () => BUTLER, now: () => clock.now, record: line => lines.push(line) });
  const send = async (text, itemId) => { sends.push([text, itemId]); return `tag-${sends.length}`; };
  const session = { id: 'butler', nativeId: 'native-butler' };
  const env = { dir, clock, lines, sends, ledger, ingress, wake };
  env.refuse = n => ingress.controlResult?.(SENDER, args(n), refused(n), { steward: () => BUTLER });
  env.succeed = n => { if (ingress.controlResult?.(SENDER, args(n), { state: 'complete', id: `op-${n}` }, { steward: () => BUTLER }) === 'succeeded') wake.controlSucceeded?.(); };
  env.next = async () => { clock.now += GAP_MS; return wake.wake(session, 'claude-test-model', send); };
  return env;
}

// The dispatcher's pass (queue-dispatch.cjs wakeSteward), as steward-wake.test.cjs drives it.
class FakeClient extends EventEmitter {
  constructor(sessions) {
    super();
    this.state = { sessions, rooms: [{ id: 'shared', revision: 0, run: null, messages: [] }], wakePolicy: { enabled: true }, capabilities: [rules.CAPABILITY] };
    this.calls = [];
  }
  snapshot() { return structuredClone(this.state); }
  async refresh() { return this.snapshot(); }
  close() {}
  route(id) {
    if (!this.state.sessions.some(s => s.id === id)) throw Error('unknown session');
    return { client: this, state: { capabilities: [rules.CAPABILITY] } };
  }
  async call(method, ...rest) {
    this.calls.push([method, ...rest]);
    if (method === 'initial') return this.snapshot();
    if (method === 'dispatch') { this.state.sessions.find(s => s.id === rest[0]).state = 'working'; return `tag-${this.calls.length}`; }
    throw Error(`unexpected ${method}`);
  }
  dispatches() { return this.calls.filter(call => call[0] === 'dispatch'); }
}
function butler(extra = {}) {
  return { id: 'butler', name: 'Synthetic butler', provider: 'claude', nativeId: 'native-butler', model: 'claude-test-model', state: 'idle', roomIds: [], roomId: null,
    createdAt: NOW - 3600000, background: 0, scheduled: 0, backgroundStale: false, chatAvailable: true, liveDraft: '', serviceCapabilities: [rules.CAPABILITY], fleet: [], messages: [], ...extra };
}

test('one refused butler call with no member working wakes the butler once, within a minute, with only a position', async t => {
  const env = unit(t), client = new FakeClient([butler()]);
  const record = new stewardRecords.StewardRecord(env.dir, { steward: () => BUTLER, now: () => env.clock.now });
  env.wake.record = line => record.append(line);
  const dispatcher = new rules.QueueDispatcher({ roomState: new RoomState(env.dir), dataDir: env.dir, connect: async () => client, now: () => env.clock.now,
    settleMs: 8000, tickMs: 3600000, steward: () => ({ ...BUTLER, duty: '' }), stewardWake: env.wake, transcriptRoot: path.join(env.dir, 'none') });
  t.after(() => dispatcher.close());
  await dispatcher.start();
  env.wake.set(true);
  const before = env.ledger.latest(), refusedAt = env.clock.now;
  env.refuse(1);
  for (let i = 0; i < 8 && !client.dispatches().length; i++) { await dispatcher.schedule(); env.clock.now += 8000; }
  const sent = client.dispatches();
  assert.equal(sent.length, 1, 'the refusal wakes the idle butler');
  assert.ok(env.clock.now - refusedAt <= 60000, 'within about a minute');
  assert.equal(sent[0][2], wakeText(before));
  const events = env.ledger.eventsAfter(before).events;
  assert.deepEqual(events.map(e => [e.kind, e.payload]), [['blocked', { memberId: 'butler', reason: 'control-refused', outcome: 'another-operation-running' }]]);
  assert.doesNotMatch(JSON.stringify(events) + sent[0][2], /SYNTHETIC PRIVATE|queueAdd/u, 'no call arguments are kept or sent');
  for (let i = 0; i < 4; i++) { await dispatcher.schedule(); env.clock.now += 8000; }
  assert.equal(client.dispatches().length, 1, 'one wake for one refusal');
});

test('four refusals in a row: three wakes, then the blocked banner with its reason; other news still wakes', async t => {
  const env = unit(t); env.wake.set(true);
  for (const n of [1, 2, 3]) { env.refuse(n); assert.equal((await env.next())?.state, 'sent', `refusal ${n} wakes`); }
  env.refuse(4);
  assert.equal(await env.next(), null, 'the fourth refusal does not wake');
  assert.equal(env.sends.length, 3);
  const blocked = env.wake.view().blocked;
  assert.equal(blocked?.reason, 'control-refused-limit', 'shown at once, not after ten minutes');
  assert.deepEqual(env.lines.filter(l => l.kind === 'wakeBlocked').map(l => l.reason), ['control-refused-limit']);
  assert.equal(await env.next(), null); assert.equal(env.sends.length, 3, 'stays held while only refusals wait');
  env.ledger.ingest(failure(1));
  assert.equal((await env.next())?.state, 'sent', 'a recorded failure is news and still wakes it');
  env.refuse(5);
  assert.equal(await env.next(), null, 'refusals after it are still held');
  assert.equal(env.sends.length, 4);
});

test('a butler call that goes through resets the count and clears the banner', async t => {
  const env = unit(t); env.wake.set(true);
  for (const n of [1, 2, 3, 4]) { env.refuse(n); await env.next(); }
  assert.equal(env.sends.length, 3); assert.equal(env.wake.view().blocked?.reason, 'control-refused-limit');
  env.succeed(9);
  assert.equal(env.wake.view().blocked, undefined, 'the banner goes with the success');
  assert.equal((await env.next())?.state, 'sent', 'the refusal still waiting wakes it again');
  for (const n of [5, 6]) { env.refuse(n); assert.equal((await env.next())?.state, 'sent'); }
  env.refuse(7); assert.equal(await env.next(), null, 'three again after the reset');
  assert.equal(env.sends.length, 6);
});

test('only the designated butler counts; a repeated answer or another session records nothing', t => {
  const env = unit(t), before = env.ledger.latest();
  const result = (sender, value, steward = () => BUTLER) => env.ingress.controlResult(sender, args(1), value, { steward });
  assert.equal(result({ ...SENDER, id: 'member' }, refused(1)), null);
  assert.equal(result({ ...SENDER, nativeId: 'other-native' }, refused(1)), null);
  assert.equal(result(SENDER, refused(1, { duplicate: true })), null);
  assert.equal(result(SENDER, refused(1), () => null), null, 'no butler designated');
  assert.equal(result(SENDER, refused(1), () => { throw Error('unreadable'); }), null);
  assert.equal(result(SENDER, { state: 'unconfirmed', error: 'x' }), null, 'unconfirmed is neither');
  assert.equal(result(SENDER, { state: 'awaiting-native' }), 'succeeded');
  assert.equal(env.ledger.latest(), before);
  assert.equal(result(SENDER, refused(1, { reason: 'Not A Code!' })), 'refused');
  assert.equal(env.ledger.eventsAfter(before).events[0].payload.outcome, 'refused', 'an unexpected reason is kept as a code only');
});

test('a plugin refusal reaches the ledger: submit route, backend count, session state, then one event per refusal', async t => {
  const dir = directory(t, 'naw-control-refused-plugin-');
  const host = { binaries: {}, close() {}, rpc: {} }, w = new Workspace(host, dir);
  t.after(() => w.close());
  const s = { id: 'butler', nativeId: 'native-butler', provider: 'claude', model: 'claude-test-model', view: 'chat', cwd: dir, owner: 'window',
    state: 'idle', createdAt: NOW - 10000, messages: [], fleet: [], roomId: null, roomIds: [], controlRevision: 0, memberRevision: 0 };
  const runtime = new EventEmitter(); runtime.host = host; runtime.chatAvailable = true;
  w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime);
  Object.assign(runtime, { record: s, submission: {}, rootLease: 'lease-1', validRootBinding: m => m.lease === 'lease-1' && m.sessionId === s.nativeId });
  const socketPath = path.join(dir, 's'), transport = createSubmissionServer(socketPath, new Map([['token-1', runtime]]));
  await transport.start();
  t.after(async () => { transport.server.closeAllConnections(); await new Promise(r => transport.server.close(r)); });
  const post = body => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/control-refused', headers: { 'X-Workspace-Token': 'token-1' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => resolve([res.statusCode, text]));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.deepEqual(await post({ sessionId: s.nativeId, lease: 'lease-1', reason: 'root-call-unconfirmed' }), [200, '{"status":"recorded"}']);
  assert.equal((await post({ sessionId: s.nativeId, lease: 'other', reason: 'root-changed' }))[0], 409, 'not the bound root');
  assert.equal((await post({ sessionId: s.nativeId, lease: 'lease-1', reason: 'anything else' }))[0], 409, 'only the two codes');
  const state = () => w.snapshot().sessions.find(x => x.id === s.id);
  assert.equal(state().controlRefusal.count, 1); assert.equal(state().controlRefusal.reason, 'root-call-unconfirmed');
  const ledger = new ButlerLedger(dir), ingress = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger });
  const before = ledger.latest();
  ingress.observeControlRefusals([state()], { steward: () => BUTLER });
  ingress.observeControlRefusals([state()], { steward: () => BUTLER });
  ingress.observeControlRefusals([{ ...state(), id: 'member' }], { steward: () => BUTLER });
  assert.equal(ledger.eventsAfter(before).events.length, 1, 'the same refusal once; another session not at all');
  await post({ sessionId: s.nativeId, lease: 'lease-1', reason: 'root-changed' });
  ingress.observeControlRefusals([state()], { steward: () => BUTLER });
  assert.deepEqual(ledger.eventsAfter(before).events.map(e => e.payload.outcome), ['root-call-unconfirmed', 'root-changed']);
  const restarted = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger });
  restarted.observeControlRefusals([state()], { steward: () => BUTLER });
  assert.equal(ledger.eventsAfter(before).events.length, 2, 'a restarted GUI does not record it again');
});

test('the plugin reports its own root refusal with a reason code only, and not a subagent call', async t => {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8') + `
export function seed(binding, prompt) {
  stopped = false; observationGap = false; nativeBlocks = true; rootBinding = binding; activeTurn = 'turn-1'; rootIdle = false;
  rootPrompt = prompt ? { id: 'prompt-1', binding, pending: false } : null;
  if (prompt) promptTurns.set('prompt-1', { binding, turnId: 'turn-1', promptId: 'prompt-1', ambiguous: false });
}
//${randomUUID()}`;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const hooks = new Map();
  mod.register((event, match, handler) => { hooks.set(typeof match === 'object' && match?.tool ? `${event}:${match.tool}` : event, typeof match === 'function' ? match : handler); return { catch() {} }; });
  const binding = { sessionId: 'native-butler', socketPath: '/fixture/socket', token: 'fixture-token', lease: 'lease-1', observationEpoch: 'epoch-1' };
  const posted = [];
  const $ = { session: { id: async () => 'native-butler' }, env: { get: async name => ({ NAW_SUBMIT_SOCKET: '/fixture/socket', NAW_HOOK_TOKEN: 'fixture-token' })[name] },
    http: { fetch: async (url, spec) => { posted.push([url.slice('http://localhost'.length), JSON.parse(spec.body)]); return { ok: true, status: 200, text: '{"status":"recorded"}' }; } } };
  const call = hooks.get('tool.call:mcp__native_workspace__workspace_control');
  const flush = () => new Promise(resolve => setTimeout(resolve, 10));
  const engine = (result = { text: '{"approved":false}' }) => Object.assign(async () => result, { origin: { plugin: 'engine', tier: 'core' } });
  mod.seed(binding, false);
  assert.match((await call($, { tool_use_id: 'call-1', action: 'snapshot', view_id: 'SYNTHETIC PRIVATE VIEW' }, engine())).deny, /actual native root call/u);
  await flush();
  assert.deepEqual(posted, [['/control-refused', { reason: 'root-call-unconfirmed', sessionId: 'native-butler', lease: 'lease-1' }]]);
  await call($, { tool_use_id: 'call-2', action: 'snapshot', agentId: 'sub-1' }, engine()); await flush();
  assert.equal(posted.length, 1, 'a subagent call is refused by design and not counted');
  mod.seed(binding, true);
  assert.match((await call($, { tool_use_id: 'call-3', action: 'snapshot', view_id: 'v' }, engine())).deny, /changed; no operation was taken/u);
  await flush();
  assert.deepEqual(posted[1], ['/control-refused', { reason: 'root-changed', sessionId: 'native-butler', lease: 'lease-1' }]);
  assert.doesNotMatch(JSON.stringify(posted), /SYNTHETIC PRIVATE/u);
});

// releaseRotation (queue-dispatch.cjs): a backend before alpha.284 destroys a six-argument call's connection
// (daemon 5-argument guard, fixed dfa418e5); a lost answer is asked again and confirmed, never left unconfirmed.
function releaseFixture(t, { runtimeVersion = '0.1.0-alpha.287', fail = [] } = {}) {
  const dir = directory(t, 'naw-release-retry-');
  const host = { binaries: {}, close() {}, rpc: {} }, w = new Workspace(host, dir);
  const s = { id: 'butler', nativeId: 'native-butler', provider: 'codex', model: 'm', view: 'chat', cwd: dir, owner: 'window', state: 'idle', createdAt: NOW - 10000,
    messages: [{ id: 'tag-1', role: 'user', origin: 'naw-dispatch', text: 'Synthetic', status: 'submitted' }], fleet: [], roomId: null, roomIds: [], controlRevision: 0, memberRevision: 0,
    rotationEpisode: { nativeId: 'native-butler', epoch: 'e1', tag: 'tag-1', state: 'invalid' } };
  const runtime = new EventEmitter(); runtime.host = host; runtime.chatAvailable = true;
  w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime);
  const calls = [], client = {
    route: () => ({ client, state: { runtimeVersion, capabilities: [rules.CAPABILITY], sessions: w.snapshot().sessions } }),
    call: async (method, ...rest) => {
      calls.push(method);
      const next = fail.shift();
      if (next === 'closed-after') { w.releaseRotation(...rest); throw uiError('error.serviceClosed'); }
      if (next) throw uiError(next);
      return w.releaseRotation(...rest);
    } };
  const dispatcher = new rules.QueueDispatcher({ dataDir: dir, roomState: new RoomState(dir), clients: () => client, now: () => NOW, settleMs: 0, tickMs: 3600000 });
  dispatcher.client = client; dispatcher.closed = false; dispatcher.releaseRetryMs = 0;
  t.after(() => { dispatcher.close(); w.close(); });
  const release = () => dispatcher.releaseRotation('butler', 'native-butler', 'e1', 'tag-1', { kind: 'steward', id: 'butler' }, 'discard-handoff');
  return { w, s, calls, release };
}

test('release on a backend before alpha.284 is refused before anything is sent', async t => {
  const f = releaseFixture(t, { runtimeVersion: '0.1.0-alpha.270' });
  await assert.rejects(f.release(), e => e.uiMessage?.key === 'error.queue.releaseBackendUpdate' && e.notSent === true);
  assert.deepEqual(f.calls, [], 'the call that would close the connection is never made');
  assert.equal(f.s.rotationEpisode.state, 'invalid');
});

test('release whose answer is lost to a closed connection is confirmed, not left unconfirmed', async t => {
  const f = releaseFixture(t, { fail: ['closed-after'] });
  assert.deepEqual(await f.release(), { epoch: 'e1', tag: 'tag-1', state: 'released' });
  assert.deepEqual(f.calls, ['releaseRotation'], 'the saved release is read back, not sent again');
});

test('release lost before it reached the backend is asked again, bounded, and the backend saves it once', async t => {
  const f = releaseFixture(t, { fail: ['error.serviceClosed', 'error.confirmationTimeout'] });
  assert.equal((await f.release()).state, 'released');
  assert.equal(f.calls.length, 3);
  const g = releaseFixture(t, { fail: ['error.serviceClosed', 'error.serviceClosed', 'error.serviceClosed', 'error.serviceClosed'] });
  await assert.rejects(g.release(), e => e.uiMessage?.key === 'error.serviceClosed');
  assert.equal(g.calls.length, 3, 'two retries at most'); assert.equal(g.s.rotationEpisode.state, 'invalid');
  const h = releaseFixture(t, { fail: ['error.workspace.handoffExpired'] });
  await assert.rejects(h.release()); assert.equal(h.calls.length, 1, 'a refusal is not retried');
});

test('a release already saved is confirmed by the backend again without a second change', async t => {
  const f = releaseFixture(t);
  const first = f.w.releaseRotation('butler', 'native-butler', 'e1', 'tag-1', { kind: 'steward', id: 'butler' }, 'discard-handoff');
  const saved = structuredClone(f.s);
  assert.deepEqual(f.w.releaseRotation('butler', 'native-butler', 'e1', 'tag-1', { kind: 'steward', id: 'butler' }, 'discard-handoff'), first);
  assert.deepEqual(f.s, saved, 'nothing changes the second time');
  assert.throws(() => f.w.releaseRotation('butler', 'native-butler', 'e2', 'tag-1', { kind: 'steward', id: 'butler' }, 'discard-handoff'), 'another epoch is still refused');
  assert.deepEqual(await f.release(), first); assert.deepEqual(f.calls, [], 'the dispatcher reads it from the state');
});
