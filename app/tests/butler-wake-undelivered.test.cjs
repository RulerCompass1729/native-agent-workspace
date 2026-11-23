// R119 (the person, 2026-11-23: 「不能错过项目经理的内容」): an automatic message to the designated butler that did not go
// out becomes one butler event with only the sender, the outcome with its code, and the time, so the ordinary
// stewardWake path wakes the butler. Limits, cooldown and refusals stay as they are; nothing is sent again.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { PeerRunner } = require('../peer-handoffs.cjs');
const { RoomState } = require('../room-state.cjs'), { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs');
const { StewardWake } = require('../steward-wake.cjs');
const wake = require('../session-wake.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

// Two backends as in session-wake.test.cjs: the sender in one, the recipient in the other, and main's intake in a
// third directory. The recipient is the designated butler unless `designate` is false; then main names someone else.
async function fixture(t, { designate = true, receiveFails = false } = {}) {
  const realNow = Date.now; let now = realNow(); Date.now = () => now; t.after(() => { Date.now = realNow; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-undelivered-'));
  const key = 'backends/aaaaaaaaaaaaaaaaaaaa', dirs = [root, path.join(root, key)];
  fs.mkdirSync(dirs[1], { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dirs[1]), 0o700);
  fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', key] }), { mode: 0o600 });
  const workspaces = [], runtimes = [], writes = [];
  for (let i = 0; i < 2; i++) {
    const w = new Workspace({ binaries: {}, close() {}, create(s) {
      const r = new EventEmitter(); r.record = s; s.nativeId = 'native-' + s.id;
      r.host = { rpc: { call: async () => ({ goal: null }) } };
      r.chatAvailable = r.addressedSendAvailable = true;
      r.start = async () => r.emit('state', 'idle');
      r.send = async (text, tag, guard) => { assert.equal(guard(), true); writes.push({ i, text, tag }); r.emit('submitted', tag); };
      runtimes.push(r); return r;
    } }, dirs[i]); workspaces.push(w);
  }
  const connect = async dir => {
    const w = workspaces[dirs.indexOf(dir)];
    return { close() {}, async call(method, spec) {
      if (method === 'initial') return { ...w.snapshot(), capabilities: ['agentWakeV1', 'agentWakePreflightV1'] };
      if (method === 'wakeCheck') return wake.check(w, spec);
      if (method === 'wakeTake') return wake.take(w, spec);
      if (method === 'wakeReceive') { if (receiveFails) throw Error('Synthetic connection lost'); return wake.receive(w, spec); }
      throw Error('Unexpected method ' + method);
    } };
  };
  workspaces.forEach((w, i) => { w.peerRunner = new PeerRunner(w, dirs[i], connect); });
  t.after(() => { workspaces.forEach(w => w.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const a = await workspaces[0].create('codex', root, 'source-owner', 'Sender');
  const b = await workspaces[1].create('codex', root, 'target-owner', 'Butler');
  const [source, target] = workspaces, [ra, rb] = runtimes;
  target.get(b).roomIds = []; target.get(b).roomId = null;
  if (designate) fs.writeFileSync(path.join(root, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: b, nativeId: target.get(b).nativeId } }), { mode: 0o600 });
  const start = id => { ra.turnId = id; ra.emit('nativeTurnStart', { nativeId: source.get(a).nativeId, turnId: id }); ra.emit('state', 'working'); };
  // A refusal may be thrown at once or come as a rejected promise; either is `{ error }` here.
  const call = async (text, callId) => {
    try { return await ra.addressedCall({ nativeId: source.get(a).nativeId, turnId: ra.turnId, callId }, { recipient_id: b, message: text }); }
    catch (error) { return { error }; }
  };
  const finish = async (status = 'completed') => { const turnId = ra.turnId; ra.turnId = null; ra.emit('state', 'idle'); ra.emit('nativeTurnEnd', { nativeId: source.get(a).nativeId, turnId, status }); await settle(); };
  const turn = async (id, text) => { start(id); const result = await call(text, 'call-' + id); await finish(); return result; };
  const reply = () => { const tag = writes.at(-1).tag; rb.emit('state', 'idle'); rb.emit('complete', { tag, text: 'An ordinary reply.', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); };
  const mainDir = path.join(root, 'main'); fs.mkdirSync(mainDir, { mode: 0o700 });
  const steward = () => designate ? { sessionId: b, nativeId: target.get(b).nativeId } : { sessionId: 'someone-else', nativeId: 'native-someone-else' };
  const f = { root, source, target, a, b, ra, rb, writes, start, call, finish, turn, reply, steward, mainDir };
  f.open = (dir = mainDir) => { const ledger = new ButlerLedger(dir, { now: () => Date.now() }); return { ledger, ingress: new ButlerIngress(dir, { roomState: new RoomState(dir), ledger, now: () => Date.now() }) }; };
  f.main = f.open();
  f.observe = (main = f.main) => main.ingress.observeWakeUndelivered?.(source.snapshot().sessions, { steward });
  f.events = (main = f.main) => main.ledger.snapshot().events.filter(e => e.eventId.startsWith('wake-undelivered:'));
  f.rows = () => source.get(a).messages.filter(m => m.wake);
  f.advance = ms => { now += ms; }; f.at = value => { now = value; }; f.now = () => now;
  return f;
}
const payload = (f, outcome, at) => ({ memberId: f.a, reason: 'wake-undelivered', outcome, title: new Date(at).toISOString() });

test('the fourth message in a row to the butler is refused for the limit: one event, without the message; the limit is unchanged', async t => {
  const f = await fixture(t);
  for (const [i, id] of ['one', 'two', 'three'].entries()) { if (i) f.advance(60001); f.ra.emit('state', 'idle'); await f.turn(id, `Task ${id}.`); f.reply(); }
  assert.equal(f.writes.length, 3);
  f.observe();
  assert.deepEqual(f.events(), [], 'delivered messages are no event: delivery wakes the butler already');
  f.advance(60001); await f.turn('four', 'Secret task four.');
  const row = f.rows().at(-1);
  assert.equal(row.wake.status, 'not-sent'); assert.match(row.text, /连续 3 次/);
  f.observe();
  assert.deepEqual(f.events().map(e => [e.kind, e.sourceRef, e.payload]), [['blocked', `wake-undelivered:${f.a}`, payload(f, 'not-sent:consecutive-limit', row.wake.time)]]);
  assert.ok(!JSON.stringify(f.main.ledger.snapshot()).includes('Secret task four'), 'never the message');
  assert.deepEqual([wake.MAX_STREAK, wake.COOLDOWN], [3, 60000]);
  wake.retryHeld(f.source); await settle();
  assert.equal(f.writes.length, 3, 'nothing is sent again'); assert.equal(f.source.wakeHoldTimer, null);
});

test('a message refused before it was registered (the turn lost its authority, or already sent one) is an event with its code', async t => {
  const f = await fixture(t);
  f.ra.emit('state', 'idle');
  // The sender's runtime changed during its turn: the sentence the sender reads covers several causes; the code names it.
  f.start('runtime'); f.ra.transportDisconnected = true;
  const runtime = await f.call('Secret one.', 'call-runtime');
  assert.match(runtime.error?.message || '', /真人操作|撤销|授权/);
  f.ra.transportDisconnected = false; await f.finish();
  // The person acted on the sender during its turn.
  f.advance(1000); f.start('person'); f.source.get(f.a).controlRevision = (f.source.get(f.a).controlRevision || 0) + 1;
  const person = await f.call('Secret two.', 'call-person');
  assert.ok(person.error, 'refused');
  await f.finish();
  // An ordinary sender's second message in one turn.
  f.advance(1000); f.start('twice');
  await f.call('First of the turn.', 'call-twice-1');
  const second = await f.call('Secret three.', 'call-twice-2');
  assert.ok(second.error, 'one message a turn, as before');
  assert.equal(f.rows().length, 1, 'only the first has a row');
  f.observe();
  const outcomes = f.events().map(e => e.payload.outcome);
  assert.deepEqual(outcomes, ['not-sent:source-runtime-changed', 'not-sent:turn-revoked-by-human', 'not-sent:turn-already-requested']);
  for (const e of f.events()) assert.deepEqual(Object.keys(e.payload).sort(), ['memberId', 'outcome', 'reason', 'title']);
  assert.ok(!/Secret (one|two|three)/.test(JSON.stringify(f.main.ledger.snapshot())), 'never the message');
  await f.finish();
  assert.equal(f.writes.length, 1, 'the first of the turn is still delivered');
});

test('withdrawn at the turn\'s end, or its one attempt failed: one event each', async t => {
  const f = await fixture(t);
  f.ra.emit('state', 'idle');
  f.start('failed-turn'); await f.call('Withdrawn.', 'call-failed-turn'); await f.finish('failed');
  assert.equal(f.rows().at(-1).wake.status, 'cancelled');
  const g = await fixture(t, { receiveFails: true });
  g.ra.emit('state', 'idle'); await g.turn('lost', 'Lost on the way.');
  assert.equal(g.rows().at(-1).wake.status, 'unconfirmed');
  f.observe(); g.observe();
  assert.deepEqual(f.events().map(e => e.payload.outcome), ['cancelled:turn-not-completed']);
  assert.deepEqual(g.events().map(e => e.payload.outcome), ['unconfirmed:delivery-failed']);
});

test('a message to anyone but the butler that did not go out is no event', async t => {
  const f = await fixture(t, { designate: false });
  f.ra.emit('state', 'idle'); await f.turn('first', 'First.'); f.reply(); f.advance(10000);
  await f.turn('second', 'Second.');
  assert.equal(f.rows().at(-1).wake.status, 'not-sent', 'refused for the 60-second limit, as before');
  f.start('twice'); await f.call('One.', 'call-a'); assert.ok((await f.call('Two.', 'call-b')).error);
  f.observe();
  assert.deepEqual(f.events(), []);
});

test('the same failure seen again, or after main restarts, is one event; failures before the intake started are not announced', async t => {
  const f = await fixture(t), started = f.now();
  f.ra.emit('state', 'idle');
  f.start('failed-turn'); await f.call('Withdrawn.', 'call-failed-turn'); await f.finish('failed');
  f.start('runtime'); f.ra.transportDisconnected = true; await f.call('Refused.', 'call-runtime'); f.ra.transportDisconnected = false; await f.finish();
  f.observe(); f.observe();
  assert.equal(f.events().length, 2);
  // Main restarts: a new intake over the same record, here opened as early as the failures, still records none again.
  const now = f.now(); f.at(started); const reopened = f.open(); f.at(now);
  f.observe(reopened);
  assert.equal(f.events(reopened).length, 2);
  // A fresh intake (another record) that started after them: the history is not announced.
  const fresh = path.join(f.root, 'main-fresh'); fs.mkdirSync(fresh, { mode: 0o700 });
  f.advance(1000); const later = f.open(fresh);
  f.observe(later);
  assert.deepEqual(f.events(later), []);
});

test('the event wakes the butler through the ordinary stewardWake path', async t => {
  const f = await fixture(t);
  const identity = f.steward();
  const stewardWake = new StewardWake(f.mainDir, { ledger: () => f.main.ledger, selected: () => identity, now: () => Date.now(), record: () => {} });
  stewardWake.set(true);
  assert.equal(stewardWake.due(), false);
  f.ra.emit('state', 'idle');
  f.start('failed-turn'); await f.call('Withdrawn.', 'call-failed-turn'); await f.finish('failed');
  f.observe();
  assert.equal(stewardWake.due(), true);
});

test('a row withdrawn by the person carries no code of its own: its notice names it, never "undefined"', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-undelivered-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 1000;
  const ledger = new ButlerLedger(dir, { now: () => now }), ingress = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger, now: () => now });
  now = 2000;
  const wakeRow = (id, status, uiMessage, extra = {}) => ({ id, origin: 'agent-wake-intent', uiMessage,
    wake: { id: 'w-' + id, senderId: 'sender', recipientId: 'butler', body: 'Secret.', time: 1500, status, ...extra } });
  const sessions = [{ id: 'sender', messages: [
    wakeRow('r1', 'cancelled', { version: 1, key: 'notice.wake.humanBoundary', params: {} }),
    wakeRow('r2', 'unconfirmed', { version: 1, key: 'notice.wake.restored', params: {} }),
    wakeRow('r3', 'consumed', null),
  ], wakeUndelivered: [{ id: 'u1', at: 1600, recipientId: 'butler', key: null }] }];
  ingress.observeWakeUndelivered(sessions, { steward: () => ({ sessionId: 'butler' }) });
  assert.deepEqual(ledger.snapshot().events.filter(e => e.eventId.startsWith('wake-undelivered:')).map(e => e.payload.outcome),
    ['cancelled:human-boundary', 'not-sent:unknown']);
  assert.ok(!JSON.stringify(ledger.snapshot()).includes('Secret.'));
});

test('main hands every backend state to the intake: the real state listener records the event', async t => {
  const f = await fixture(t);
  f.ra.emit('state', 'idle');
  f.start('failed-turn'); await f.call('Withdrawn.', 'call-failed-turn'); await f.finish('failed');
  const client = new EventEmitter(), context = { background: true, client, win: { isDestroyed: () => false } };
  const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  const bind = source.slice(source.indexOf('function bindClient(context)'), source.indexOf('function displayState('));
  vm.runInNewContext(bind + '\nbindClient(context);', { context, butlerIngress: f.main.ingress, stewardRole: { current: f.steward },
    sessionLabels: { labels: new Map() }, roomState: new RoomState(f.mainDir), broadcastRoom: async () => {} });
  client.emit('state', f.source.snapshot());
  assert.deepEqual(f.events().map(e => e.payload.outcome), ['cancelled:turn-not-completed']);
});

// Review F1: backends outlive main. A message staged before main restarted that fails after it is still announced,
// at the time it failed.
test('staged before main restarts, failed after: one event at the failure time', async t => {
  const statuses = rows => rows.map(row => row.wake.status);
  for (const [name, fail] of [
    ['its one attempt failed', async f => f.finish()],
    ['withdrawn by the person', async f => { wake.revoke(f.source); await f.finish(); }],
    ['withdrawn at an observation boundary', async f => { wake.cancelParticipant(f.source, f.a, 'synthetic boundary'); await f.finish(); }],
  ]) {
    const f = await fixture(t, { receiveFails: true });
    f.ra.emit('state', 'idle'); f.start('staged'); await f.call('Staged before the restart.', 'call-staged');
    assert.equal(f.rows().at(-1).wake.status, 'staged', name);
    f.advance(5000); const restarted = f.open(path.join(f.root, 'main-restarted-' + name.length)); f.advance(1000);
    const failedAt = f.now(); await fail(f);
    assert.notEqual(f.rows().at(-1).wake.status, 'staged', `${name}: ${statuses(f.rows())}`);
    f.observe(restarted);
    assert.deepEqual(f.events(restarted).map(e => e.payload.title), [new Date(failedAt).toISOString()], name);
  }
});

// r4 (the brief's three not-sent reasons, 11-23): 「收件方已不是登记时的那个会话」 is an event too, and one to the session
// the butler continued from is the current butler's.
test('the butler changed after the message was staged: one event with that code, nothing sent', async t => {
  const f = await fixture(t);
  f.ra.emit('state', 'idle'); f.start('changed'); await f.call('Secret staged.', 'call-changed');
  assert.equal(f.rows().at(-1).wake.status, 'staged');
  f.target.get(f.b).controlRevision = (f.target.get(f.b).controlRevision || 0) + 1;
  await f.finish();
  assert.equal(f.writes.length, 0);
  f.observe();
  assert.deepEqual(f.events().map(e => e.payload.outcome), ['not-sent:recipient-identity-changed']);
  assert.ok(!JSON.stringify(f.main.ledger.snapshot()).includes('Secret staged'));
});

test('a message to the session the butler continued from is recorded for the current butler; without that link, none', async t => {
  const f = await fixture(t, { designate: false });
  f.ra.emit('state', 'idle'); f.start('person'); f.source.get(f.a).controlRevision = (f.source.get(f.a).controlRevision || 0) + 1;
  assert.ok((await f.call('Secret to the old session.', 'call-old')).error);
  await f.finish();
  const next = () => ({ sessionId: 'butler-next', nativeId: 'native-butler-next' }), sessions = f.source.snapshot().sessions;
  f.main.ingress.observeWakeUndelivered(sessions, { steward: next });
  assert.deepEqual(f.events(), [], 'another session, as before');
  f.main.ingress.observeWakeUndelivered(sessions, { steward: next, formerly: () => { throw Error('unreadable'); } });
  assert.deepEqual(f.events(), [], 'an unreadable rotation log is the current session alone');
  f.main.ingress.observeWakeUndelivered(sessions, { steward: next, formerly: id => id === 'butler-next' ? [f.b] : [] });
  assert.deepEqual(f.events().map(e => e.payload.outcome), ['not-sent:turn-revoked-by-human']);
  assert.ok(!JSON.stringify(f.main.ledger.snapshot()).includes('Secret to the old'));
});
