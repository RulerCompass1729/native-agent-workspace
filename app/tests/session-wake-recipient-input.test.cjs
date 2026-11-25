'use strict';
// R238 (the person, 2026-11-25): a message on its way to a session is no longer withdrawn by ordinary input into that
// session; Esc, Ctrl-C and every other change withdraw it as before, and text left half typed there is neither lost nor
// sent with it. Synthetic workspaces; no model, no real backend.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs'), { PeerRunner } = require('../peer-handoffs.cjs');
const wake = require('../session-wake.cjs'), background = require('../background-operation.cjs'), mobileSession = require('../mobile-session.cjs');
const { uiError } = require('../ui-errors.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (count = 16) => { for (let i = 0; i < count; i++) await tick(); };
const KEY = 'backends/aaaaaaaaaaaaaaaaaaaa', MOVED = 'backends/bbbbbbbbbbbbbbbbbbbb', MIN = 60000, BODY = 'One bounded task.';
const AGENT = { id: 'other-session', name: 'Other agent', nativeId: 'other-native', provider: 'claude', callId: 'call-1', turnId: 'turn-1', operationId: 'operation-1' };

async function fixture(t, { provider = 'codex', publish = session => session } = {}) {
  const realNow = Date.now; let now = realNow(); Date.now = () => now; t.after(() => { Date.now = realNow; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-input-')); fs.chmodSync(root, 0o700);
  const dirs = [root, path.join(root, KEY)];
  fs.mkdirSync(dirs[1], { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dirs[1]), 0o700);
  const layout = entries => fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries }), { mode: 0o600 });
  layout(['.', KEY]);
  const f = { root, dirs, layout, writes: [], attempts: [], places: new Map(), host: null };
  // What native does with an attempt; a test replaces it. The default takes it.
  f.native = async ({ guard }) => { assert.equal(guard(), true); };
  f.host = { binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); r.record = s; s.nativeId = 'native-' + s.id;
    r.host = { rpc: { call: async () => ({ goal: null }) } };
    r.chatAvailable = r.addressedSendAvailable = true; r.terminal = { alive: true, input() {} };
    r.finishTurn = () => {}; r.interrupt = async () => ({ interrupted: true });
    r.start = async () => r.emit('state', 'idle'); r.stop = async () => ({ state: 'ended' });
    const take = way => async (text, tag, ...rest) => {
      const guard = rest.find(value => typeof value === 'function');
      f.attempts.push({ way, text, tag });
      if (text.endsWith(BODY)) await f.native({ way, text, tag, guard, r });
      f.writes.push({ id: s.id, way, text, tag }); r.emit('submitted', tag);
    };
    r.send = take('send'); r.queue = take('queue'); r.steer = (text, tag, turnId, guard) => take('steer')(text, tag, guard);
    return r;
  } };
  for (const dir of dirs) f.places.set(dir, new Workspace(f.host, dir));
  const connect = async dir => {
    const w = f.places.get(dir); assert.ok(w, 'a known backend');
    return { close() {}, async call(method, spec) {
      if (method === 'initial') { const state = w.snapshot(); return { ...state, sessions: state.sessions.map(publish), capabilities: ['agentWakeV1', 'agentWakePreflightV1'] }; }
      if (method === 'wakeCheck') { f.checking?.(); return wake.check(w, spec); }
      if (method === 'wakeTake') { if (w === f.source) await f.taking?.(); return wake.take(w, spec); }
      if (method === 'wakeReceive') return wake.receive(w, spec);
      throw Error('Unexpected method ' + method);
    } };
  };
  f.connect = connect;
  for (const [dir, w] of f.places) w.peerRunner = new PeerRunner(w, dir, connect);
  [f.source, f.target] = dirs.map(dir => f.places.get(dir));
  t.after(() => { for (const w of f.places.values()) w.close(); fs.rmSync(root, { recursive: true, force: true }); });
  f.a = await f.source.create('codex', root, 'source-owner', 'Sender'); f.b = await f.target.create(provider, root, 'target-owner', 'Receiver');
  f.ra = f.source.runtimes.get(f.a);
  Object.defineProperties(f, { s: { get: () => f.target.get(f.b) }, r: { get: () => f.target.runtimes.get(f.b) } });
  f.s.view = 'terminal'; if (provider === 'codex') f.r.turnId = null;
  f.begin = id => { f.ra.turnId = id; f.ra.emit('nativeTurnStart', { nativeId: f.source.get(f.a).nativeId, turnId: id }); f.ra.emit('state', 'working'); };
  f.register = async (id = 'one') => { f.begin(id); const result = await f.ra.addressedCall({ nativeId: f.source.get(f.a).nativeId, turnId: id, callId: 'call-' + id }, { recipient_id: f.b, message: BODY }); f.row = f.source.get(f.a).messages.findLast(m => m.wake); return result; };
  f.end = async () => { const turnId = f.ra.turnId; f.ra.turnId = null; f.ra.emit('state', 'idle'); f.ra.emit('nativeTurnEnd', { nativeId: f.source.get(f.a).nativeId, turnId, status: 'completed' }); await settle(); };
  f.look = async (ms = MIN) => { now += ms; wake.retryHeld(f.source); await settle(); };
  f.advance = ms => { now += ms; };
  f.busy = () => { f.r.turnId = 'recipient-turn'; f.r.emit('state', 'working'); };
  // The recipient's own work is over: what it was given has been answered.
  f.rest = () => {
    const tag = f.s.pendingTag; f.r.turnId = null; f.r.emit('state', 'idle');
    if (tag) f.r.emit('complete', { tag, text: 'An ordinary reply.', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false });
  };
  f.type = (data = 'x') => f.target.input(f.b, data, f.s.owner);
  f.delivered = () => f.writes.filter(x => x.id === f.b && x.text.endsWith(BODY)).length;
  f.outcome = () => [f.row.wake.status, f.delivered()];
  return f;
}
const phone = (t, f) => {
  const valid = mobileSession.valid; mobileSession.valid = () => true; t.after(() => { mobileSession.valid = valid; });
  // The two changes mobile-session.cjs delegate().human() makes.
  return { human() { wake.human(f.target, f.b); f.s.peerRevision = (f.s.peerRevision || 0) + 1; f.s.controlRevision++; }, reserve() {} };
};
const sentence = (text, source) => f => { f.r.emit('nativeInput', text, { id: 'native-input', ...(source ? { source } : {}) }); f.r.emit('nativeControlBoundary', 'control:input'); };
const NOTICE = '<task-notification><task-id>task-1</task-id><status>completed</status></task-notification>';
const ORDINARY = {
  'typing in the terminal': ['codex', f => f.type('x')],
  'a paste': ['claude', f => f.type('\x1b[200~several words\x1b[201~')],
  'a paste without its marks': ['codex', f => f.type('several words')],
  'arrows, deleting and an Option key': ['claude', f => { for (const data of ['\x1b[A', '\x1bOD', '\x1b[1;3C', '\x7f', '\x1bb', '\x1b\x7f', '\x1b[3~', '\r']) f.type(data); }],
  'a sentence submitted in the terminal': ['claude', sentence('Please also look at this.')],
  'a sentence sent from the conversation box': ['codex', f => { f.rest(); return f.target.send(f.b, 'Please also look at this.', 'target-owner'); }],
  'a sentence sent from the phone': ['claude', (f, t) => { f.rest(); return f.target.send(f.b, 'From the phone.', null, null, null, null, null, null, phone(t, f)); }],
  'a sentence queued while it works': ['claude', async f => { f.r.queueAvailable = true; f.busy(); await f.target.queue(f.b, 'And this.', 'target-owner'); }],
  'a sentence queued from the phone': ['claude', async (f, t) => { f.r.queueAvailable = true; f.busy(); await f.target.queue(f.b, 'From the phone.', null, null, phone(t, f)); }],
  'a steer while it works': ['codex', async f => { f.r.steerAvailable = true; f.busy(); await f.target.steer(f.b, 'And this.', 'target-owner', 'recipient-turn'); }],
  'a background notice': ['claude', sentence(NOTICE, 'system')],
  'a scheduled wake-up': ['claude', sentence('loop', 'schedule_wakeup')],
  'a cross-session message': ['claude', sentence('hello', 'naw-peer')],
};
// Registered and not yet sent; held for a recipient at work; after the recipient began taking it.
const MOMENTS = {
  'after it is registered': async (f, act) => { await f.register(); await act(); await f.end(); },
  'while it is held': async (f, act) => { f.busy(); await f.register(); await f.end(); assert.equal(f.row.wake.status, 'held'); await act(); f.rest(); await f.look(); },
  'while it is being taken': async (f, act) => { let done = false; f.taking = async () => { if (done) return; done = true; await act(); }; await f.register(); await f.end(); },
};
for (const [moment, run] of Object.entries(MOMENTS)) {
  for (const [name, [provider, act]] of Object.entries(ORDINARY)) test(`${name} ${moment} leaves the message: it goes once`, async t => {
    const f = await fixture(t, { provider });
    await run(f, () => act(f, t));
    // At work because of that input: it waits, then goes.
    if (f.row.wake.status === 'held') { f.rest(); await f.look(); }
    assert.deepEqual(f.outcome(), ['submitted', 1]);
    f.rest(); await f.look(); await f.look();
    assert.equal(f.delivered(), 1, 'never twice');
  });
}

const run = act => background.run(AGENT, act);
const WITHDRAWS = {
  'Esc': ['codex', f => f.type('\x1b')],
  'Ctrl-C': ['codex', f => f.type('\x03')],
  'the stop button': ['codex', f => f.target.interrupt(f.b, 'target-owner')],
  'a takeover': ['codex', f => f.target.claim(f.b, 'another-window')],
  'a reconnect of the running turn': ['codex', async f => { f.r.turnId = 'recipient-turn'; f.s.state = 'disconnected'; f.r.reconnect = async () => { f.r.emit('state', 'idle'); }; await f.target.resume(f.b, 'target-owner'); }],
  'another native session': ['codex', f => { f.s.nativeId = 'native-someone-else'; }],
  'a membership change': ['codex', f => { f.target.join(f.b, true); }],
  'a permission wait': ['codex', f => { f.r.emit('state', 'approval'); f.r.emit('state', 'idle'); }],
  'an observation gap': ['claude', f => { f.r.emit('nativeBlock', { id: 'gap-1', kind: 'gap', nativeId: f.s.nativeId, status: 'complete' }); }],
  'another control boundary': ['claude', f => { f.r.emit('nativeControlBoundary', 'control:permission'); }],
  'automatic messages switched off': ['codex', f => { wake.setPolicy(f.target, null, false); }],
  'automatic messages switched off for the recipient': ['codex', f => { wake.setPolicy(f.target, f.b, false); }],
  'all handoffs paused': ['codex', f => f.target.pauseAll('stop')],
  'another agent typing through background control': ['codex', f => run(() => f.type('x'))],
  'another agent sending through background control': ['codex', f => { f.rest(); return run(() => f.target.send(f.b, 'From another agent.', 'target-owner')); }],
  'another agent queueing through background control': ['claude', f => { f.r.queueAvailable = true; f.busy(); return run(() => f.target.queue(f.b, 'From another agent.', 'target-owner')); }],
  'another agent steering through background control': ['codex', f => { f.r.steerAvailable = true; f.busy(); return run(() => f.target.steer(f.b, 'From another agent.', 'target-owner', 'recipient-turn')); }],
  'a machine input that displaced a send': ['claude', f => { f.r.emit('nativeInput', NOTICE, { id: 'native-input', source: 'system', superseded: true }); }],
  'typing, then Esc': ['claude', f => { f.type('abc'); f.type('\x1b'); }],
  'Esc, then typing': ['claude', f => { f.type('\x1b'); f.type('abc'); }],
};
for (const chunk of ['abc\x1b', '\x1babc', '\x1b\x1b', 'abc\x03', '\x03abc', '\x1b[200~abc\x1b[201~\x1b', '\x1b[A\x1b', '\x1b[27u', '\x1b[27;1u', '\x1b[99;5u', '\x1b[27;5;99~']) {
  WITHDRAWS[`Esc or Ctrl-C in one piece with other keys (${JSON.stringify(chunk)})`] = ['claude', f => f.type(chunk)];
}
for (const [moment, go] of Object.entries(MOMENTS)) {
  for (const [name, [provider, act]] of Object.entries(WITHDRAWS)) test(`${name} ${moment} still withdraws the message, with ordinary typing around it`, async t => {
    const f = await fixture(t, { provider });
    await go(f, async () => { f.type('x'); await act(f); try { f.type('y'); } catch { /* Another window controls it now. */ } });
    for (let i = 0; i < 3; i++) { if (!['ended', 'recoverable'].includes(f.s.state)) f.rest(); await f.look(); }
    assert.equal(f.delivered(), 0);
    // The sender's own refusal of a take is answered as an outcome it cannot tell.
    assert.ok(['not-sent', 'cancelled', ...(moment === 'while it is being taken' ? ['unconfirmed'] : [])].includes(f.row.wake.status), f.row.wake.status);
  });
}

test('a recipient whose backend was reopened after an Esc does not get it, also if every number comes out the same', async t => {
  for (const coincide of [false, true]) {
    const f = await fixture(t);
    f.type('x'); f.busy(); await f.register(); await f.end(); assert.equal(f.row.wake.status, 'held');
    f.type('y'); f.type('\x1b');
    f.target.persist(); f.target.close();
    const reopened = new Workspace(f.host, f.dirs[1]); f.places.set(f.dirs[1], reopened); reopened.peerRunner = new PeerRunner(reopened, f.dirs[1], f.connect);
    f.target = reopened; f.s.state = 'recoverable'; await f.target.resume(f.b, 'target-owner'); f.s.view = 'terminal';
    if (coincide) Object.assign(f.s, Object.fromEntries(['nativeId', 'owner', 'memberRevision', 'controlRevision', 'connectionRevision', 'peerRevision'].map(key => [key, f.row.wake.targetProof[key]])));
    assert.equal(f.s.state, 'idle'); await f.look(); await f.look();
    assert.deepEqual(f.outcome(), ['not-sent', 0], String(coincide));
  }
});

test('a recipient moved to another backend gets it after typing there, and not after an Esc there', async t => {
  for (const key of ['x', '\x1b']) {
    const f = await fixture(t);
    const root = f.root, windows = require('../quiet-windows.cjs');
    const at = Date.now(), open = { id: '11111111-1111-4111-8111-111111111111', key: KEY, openedAt: at, deadline: at + 10 * MIN };
    assert.equal(typeof windows.openWindow, 'function');
    f.type('before'); await f.register();
    f.row.wake.quietWindow = { id: open.id, deadline: open.deadline };
    Object.assign(f.row.wake, { status: 'held', heldAt: at, retryAt: at + MIN });
    f.ra.turnId = null; f.ra.emit('state', 'idle');
    const moved = path.join(root, MOVED); f.target.persist(); fs.renameSync(f.dirs[1], moved); f.target.dataDir = moved;
    f.places.delete(f.dirs[1]); f.places.set(moved, f.target); f.target.peerRunner = new PeerRunner(f.target, moved, f.connect); f.layout(['.', MOVED]);
    let typed = false; f.taking = async () => { if (!typed) { typed = true; f.type(key); } };
    await f.look(); if (f.row.wake.status === 'held') await f.look();
    assert.equal(f.row.wake.targetKey, MOVED);
    assert.deepEqual(f.outcome(), key === 'x' ? ['submitted', 1] : ['not-sent', 0]);
  }
});

test('with an older backend on either side, the old rule stays: any input withdraws, no input does not', async t => {
  const raw = require('../peer-handoffs.cjs').identity;
  const bare = ({ wakeInput, ...session }) => session;
  for (const side of ['an older recipient', 'an older sender', 'counts that cannot be read', 'an epoch that cannot be read']) for (const typed of [true, false]) {
    const unread = side === 'counts that cannot be read' ? { control: -1 } : { epoch: 'x' };
    const f = await fixture(t, { publish: side === 'an older recipient' ? bare : side === 'an older sender' ? s => s : s => ({ ...s, wakeInput: { ...s.wakeInput, ...unread } }) });
    f.type('before'); await f.register();
    if (side === 'an older sender') f.row.wake.targetProof = raw(f.s);
    assert.deepEqual(f.row.wake.targetProof, raw(f.s), side);
    if (typed) f.type('x');
    await f.end();
    assert.deepEqual(f.outcome(), typed ? ['not-sent', 0] : ['submitted', 1], `${side}, ${typed}`);
  }
});

test('input between the look at the recipient and the check that follows leaves the message too; an Esc there refuses it', async t => {
  for (const key of ['x', '\x1b']) {
    const f = await fixture(t); f.checking = () => f.type(key);
    assert.equal((await f.register()).status, key === 'x' ? 'staged' : 'not-sent'); await f.end();
    assert.deepEqual(f.outcome(), key === 'x' ? ['submitted', 1] : ['not-sent', 0]);
  }
});

test('a recipient that was another native session when it began taking it does not get it', async t => {
  const f = await fixture(t); await f.register(); const own = f.s.nativeId;
  f.s.nativeId = 'native-someone-else'; f.taking = () => { f.s.nativeId = own; };
  await f.end(); assert.deepEqual(f.outcome(), ['not-sent', 0]);
});

test('what is published counts the recipient\'s ordinary input only, and is never saved', async t => {
  const f = await fixture(t), seen = () => { const { control, peer } = f.target.snapshot().sessions.find(s => s.id === f.b).wakeInput; return [control, peer]; };
  const first = f.target.snapshot().sessions.find(s => s.id === f.b).wakeInput;
  assert.match(first.epoch, /^[0-9a-f-]{36}$/); assert.deepEqual(seen(), [0, 0]);
  f.type('x'); sentence('words')(f); assert.deepEqual(seen(), [2, 1]);
  f.type('\x1b'); await background.run(AGENT, () => f.type('z')); wake.reconnected(f.target, f.s); assert.deepEqual(seen(), [2, 1]);
  assert.equal(f.target.snapshot().sessions.find(s => s.id === f.b).wakeInput.epoch, first.epoch);
  f.target.persist(); assert.doesNotMatch(fs.readFileSync(path.join(f.dirs[1], 'workspace.json'), 'utf8'), /wakeInput/);
  assert.notEqual(f.target.snapshot().sessions.find(s => s.id === f.b).wakeInput.epoch, f.source.snapshot().sessions.find(s => s.id === f.a).wakeInput.epoch);
});

test('the sender\'s own rule is unchanged: a counted reconnect leaves its message, Esc withdraws it', async t => {
  for (const [act, delivered] of [[f => { f.source.get(f.a).view = 'terminal'; f.source.input(f.a, 'x', 'source-owner'); }, 1], [f => { f.source.get(f.a).view = 'terminal'; f.source.input(f.a, '\x1b', 'source-owner'); }, 0]]) {
    const f = await fixture(t); await f.register(); act(f); await f.end(); assert.equal(f.delivered(), delivered);
  }
});

const draft = () => Object.assign(uiError('error.submission.nativeDraft'), { notSent: true });
const budget = f => JSON.stringify(f.s.wakeBudget ?? null);
for (const way of ['send', 'queue']) test(`text left in Claude's own prompt keeps the message held, as typed; it goes once the prompt is clear (${way})`, async t => {
  const f = await fixture(t, { provider: 'claude' });
  let text = 'half a sent'; f.type(text);
  f.native = async ({ guard }) => { assert.equal(guard(), true); if (text) throw draft(); };
  if (way === 'queue') { f.r.queueAvailable = true; f.busy(); }
  const before = budget(f);
  await f.register(); await f.end();
  assert.deepEqual(f.outcome(), ['held', 0]); assert.equal(f.attempts.length, 1); assert.equal(f.attempts[0].way, way);
  assert.equal(budget(f), before, 'one that did not go counts toward no limit');
  assert.deepEqual(f.s.messages.filter(m => m.origin === 'agent-wake'), [], 'no row of one that did not reach it');
  f.rest();
  for (let i = 0; i < 8; i++) await f.look();
  assert.equal(f.attempts.length, 1, 'not asked again while nothing was typed there'); assert.equal(f.row.wake.status, 'held');
  f.type('e'); text += 'e'; await f.look();
  assert.deepEqual([...f.outcome(), f.attempts.length, text], ['held', 0, 2, 'half a sente']);
  text = ''; f.type('\r'); sentence('half a sente')(f); await f.look();
  assert.deepEqual(f.outcome(), ['submitted', 1]); assert.equal(f.s.wakeBudget.senders[f.source.get(f.a).nativeId].streak, 1);
});
test('a prompt cleared without NAW seeing a key is asked again after ten minutes', async t => {
  const f = await fixture(t, { provider: 'claude' }); let text = 'half';
  f.native = async () => { if (text) throw draft(); };
  await f.register(); await f.end(); text = '';
  for (let i = 0; i < 9; i++) await f.look();
  assert.equal(f.attempts.length, 1); await f.look(); await f.look();
  assert.deepEqual(f.outcome(), ['submitted', 1]);
});
test('a draft that stays for two hours ends as any held message: not sent, said so', async t => {
  const f = await fixture(t, { provider: 'claude' }); f.native = async () => { throw draft(); };
  await f.register(); await f.end(); assert.equal(f.row.wake.status, 'held');
  for (let i = 0; i < 121; i++) await f.look();
  assert.deepEqual(f.outcome(), ['not-sent', 0]); assert.match(f.row.text, /等了 2 小时/);
});
test('an Esc while it waits for a draft withdraws it', async t => {
  const f = await fixture(t, { provider: 'claude' }); let text = 'half'; f.native = async () => { if (text) throw draft(); };
  await f.register(); await f.end(); assert.equal(f.row.wake.status, 'held');
  f.type('\x1b'); text = ''; await f.look();
  assert.deepEqual(f.outcome(), ['not-sent', 0]);
});
test('the person\'s input while Claude holds it for a tool boundary keeps it: it waits, then goes once', async t => {
  const f = await fixture(t, { provider: 'claude' }); let held = true;
  f.r.queueAvailable = true; f.busy();
  f.native = async () => { if (!held) return; f.r.emit('nativeInput', 'Meanwhile this.', { id: 'native-input' }); throw Object.assign(uiError('error.submission.nativeRejected'), { notSent: true, inputChanged: true }); };
  await f.register(); await f.end(); assert.deepEqual(f.outcome(), ['held', 0]);
  held = false; f.rest(); await f.look();
  assert.deepEqual(f.outcome(), ['submitted', 1]);
});
test('a sentence that gets to native first, just before it would: it waits, then goes once; an Esc there ends it', async t => {
  for (const key of [null, '\x1b']) {
    const f = await fixture(t, { provider: 'claude' }); let first = true;
    f.native = async ({ guard }) => {
      if (!first) return assert.equal(guard(), true);
      first = false; sentence('The person was first.')(f); f.busy(); if (key) f.type(key);
      assert.equal(guard(), false); throw Object.assign(uiError('error.submissionRevokedByHuman'), { notSent: true });
    };
    await f.register(); await f.end();
    assert.equal(f.row.wake.status, key ? 'unconfirmed' : 'held');
    f.rest(); await f.look(); await f.look();
    if (key) assert.equal(f.delivered(), 0); else assert.deepEqual(f.outcome(), ['submitted', 1]);
  }
});
test('typing just before native takes it, with nothing left in the prompt, does not stop it', async t => {
  for (const way of ['send', 'queue', 'steer']) {
    const f = await fixture(t, { provider: way === 'steer' ? 'codex' : 'claude' });
    if (way !== 'send') { Object.assign(f.r, { queueAvailable: true, steerAvailable: true }); f.busy(); }
    f.native = async ({ guard }) => { f.type('x'); assert.equal(guard(), true); };
    await f.register(); await f.end(); assert.deepEqual(f.outcome(), ['submitted', 1], way);
  }
});
test('every other refusal before native took it is as before: never held', async t => {
  for (const error of [Object.assign(uiError('error.submission.nativeRejected'), { notSent: true }), Object.assign(uiError('error.safeSubmissionNotReady'), { notSent: true }), uiError('error.submission.nativeDraft')]) {
    const f = await fixture(t, { provider: 'claude' }); f.native = async () => { throw error; };
    await f.register(); await f.end(); await f.look(); await f.look();
    assert.deepEqual([f.row.wake.status, f.delivered(), f.attempts.length], ['unconfirmed', 0, 1], error.message);
  }
});
test('the person\'s own sentence still on its way in keeps the message; another agent\'s automatic message there refuses it as before', async t => {
  for (const origin of ['human', 'human-mobile', 'agent-wake', 'naw-dispatch']) {
    const f = await fixture(t, { provider: 'claude' });
    f.r.queueAvailable = true; await f.register(); f.busy();
    f.s.messages.push({ id: 'pending-row', role: 'user', text: 'words', origin, status: 'awaiting-native', time: Date.now() }); f.r.pendingQueue = 'pending-row';
    await f.end();
    const person = origin.startsWith('human');
    assert.deepEqual(f.outcome(), [person ? 'held' : 'not-sent', 0], origin);
    f.r.pendingQueue = null; f.rest(); await f.look();
    assert.deepEqual(f.outcome(), person ? ['submitted', 1] : ['not-sent', 0], origin);
  }
});
test('a half-written draft in the conversation box is the same after the message, sent, queued or steered', async t => {
  for (const way of ['send', 'queue', 'steer']) {
    const f = await fixture(t, { provider: way === 'steer' ? 'codex' : 'claude' }), text = '半句话还没写完  \n';
    await f.register(); f.target.setDraft(f.b, text, 'target-owner');
    if (way !== 'send') { Object.assign(f.r, { queueAvailable: true, steerAvailable: true }); f.busy(); }
    await f.end();
    assert.deepEqual([...f.outcome(), f.target.drafts.get(f.b)], ['submitted', 1, text], way);
    assert.ok(!f.writes[0].text.includes('半句话'), way);
  }
});
test('the limits are the same: eight in a row, the minute between two, and typing that clears the run', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) { if (i) f.advance(MIN + 1); await f.register('t' + i); await f.end(); f.rest(); }
  assert.equal(f.delivered(), 8); f.advance(MIN + 1);
  assert.equal((await f.register('nine')).status, 'not-sent'); await f.end();
  f.type('x'); assert.equal((await f.register('ten')).status, 'staged'); await f.end(); f.rest(); assert.equal(f.delivered(), 9);
  assert.equal((await f.register('eleven')).status, 'not-sent', 'within the minute'); await f.end(); assert.equal(f.delivered(), 9);
});
