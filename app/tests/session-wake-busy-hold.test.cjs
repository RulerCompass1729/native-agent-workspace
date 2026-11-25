'use strict';
// R187/R188 (the person, 11-24 「按你推荐的来」 on: an ordinary input into the sender does not withdraw a held message):
// an automatic message whose recipient is at work is held by its sender's backend and goes once the recipient is idle.
// Synthetic workspaces; no model, no real backend.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs'), { PeerRunner } = require('../peer-handoffs.cjs');
const wake = require('../session-wake.cjs'), locale = require('../ui-locale.js'), backgroundOperation = require('../background-operation.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (count = 16) => { for (let i = 0; i < count; i++) await tick(); };
const KEY = 'backends/aaaaaaaaaaaaaaaaaaaa', MIN = 60000;
const ACTOR = { id: 'other-session', name: 'Other agent', nativeId: 'other-native', provider: 'claude', callId: 'call-1', turnId: 'turn-1', operationId: 'operation-1' };
const BUSY_TEXT = '收件方还没空下来；这条先存着，空下来后再试一次。';

function host(writes) {
  return { binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); r.record = s; s.nativeId = 'native-' + s.id;
    r.host = { rpc: { call: async () => ({ goal: null }) } };
    r.chatAvailable = r.addressedSendAvailable = true; r.midturn = [];
    r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag, guard) => { assert.equal(guard(), true); writes.push({ id: s.id, text, tag, at: Date.now() }); r.emit('submitted', tag); };
    r.queue = r.steer = async (...args) => { r.midturn.push(args); };
    return r;
  } };
}
// A sender on the root backend, a recipient on KEY. `old`: the recipient's backend is one that never asks to hold.
async function fixture(t, { provider = 'codex', old = false, steward = null } = {}) {
  const realNow = Date.now; let now = realNow(); Date.now = () => now; t.after(() => { Date.now = realNow; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-busy-')); fs.chmodSync(root, 0o700);
  const dirs = [root, path.join(root, KEY)];
  fs.mkdirSync(dirs[1], { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dirs[1]), 0o700);
  fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', KEY] }), { mode: 0o600 });
  const writes = [], places = new Map(), calls = { wakeReceive: 0 };
  const workspaces = dirs.map(dir => { const w = new Workspace(host(writes), dir); places.set(dir, w); return w; });
  const bare = result => { if (!old) return result; const { hold, retryAt, ...rest } = result; return rest; };
  const connect = async dir => {
    const w = places.get(dir); assert.ok(w, 'a known backend');
    return { close() {}, async call(method, spec) {
      if (method === 'initial') return { ...w.snapshot(), capabilities: ['agentWakeV1', 'agentWakePreflightV1'] };
      if (method === 'wakeCheck') return bare(await wake.check(w, spec));
      if (method === 'wakeTake') return wake.take(w, spec);
      if (method === 'wakeReceive') { calls.wakeReceive++; return bare(await wake.receive(w, spec)); }
      throw Error('Unexpected method ' + method);
    } };
  };
  workspaces.forEach((w, i) => { w.peerRunner = new PeerRunner(w, dirs[i], connect); });
  t.after(() => { workspaces.forEach(w => w.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const [source, target] = workspaces;
  const a = await source.create('codex', root, 'source-owner', 'Sender');
  const b = await target.create(provider, root, 'target-owner', 'Receiver');
  const ra = source.runtimes.get(a), rb = target.runtimes.get(b);
  if (steward) {
    const s = steward === 'sender' ? source.get(a) : target.get(b);
    s.roomIds = []; s.roomId = null;
    fs.writeFileSync(path.join(root, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: s.id, nativeId: s.nativeId } }), { mode: 0o600 });
  }
  const begin = (id, w = source, sender = a) => {
    const r = w.runtimes.get(sender);
    r.turnId = id; r.emit('nativeTurnStart', { nativeId: w.get(sender).nativeId, turnId: id }); r.emit('state', 'working');
  };
  const end = async (w = source, sender = a, status = 'completed') => {
    const r = w.runtimes.get(sender), turnId = r.turnId;
    r.turnId = null; r.emit('state', 'idle'); r.emit('nativeTurnEnd', { nativeId: w.get(sender).nativeId, turnId, status }); await settle();
  };
  const call = (text, callId, to = b, w = source, sender = a) => w.runtimes.get(sender).addressedCall({ nativeId: w.get(sender).nativeId, turnId: w.runtimes.get(sender).turnId, callId }, { recipient_id: to, message: text });
  const turn = async (id, text, to = b, w = source, sender = a) => {
    begin(id, w, sender); const result = await call(text, 'call-' + id, to, w, sender); await end(w, sender); return result;
  };
  const reply = () => { const tag = writes.at(-1).tag; rb.emit('state', 'idle'); rb.emit('complete', { tag, text: 'An ordinary reply.', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); };
  const rows = (w = source, sender = a) => w.get(sender).messages.filter(m => m.wake && m.origin === 'agent-wake-intent');
  const retry = async () => { wake.retryHeld(source); await settle(); };
  const look = async (ms = MIN) => { now += ms; await retry(); };
  const to = id => writes.filter(x => x.id === id);
  return { root, dirs, places, source, target, a, b, ra, rb, writes, calls, begin, end, call, turn, reply, rows, retry, look, to, advance: ms => { now += ms; }, now: () => now };
}
const busy = f => f.rb.emit('state', 'working');
const idle = f => f.rb.emit('state', 'idle');
// A message held because its recipient is at work.
async function held(t, options) {
  const f = await fixture(t, options); busy(f);
  f.result = await f.turn('one', 'While it works.');
  f.row = f.rows().at(-1);
  assert.equal(f.row.wake.status, 'held');
  return f;
}

test('a message to a recipient at work is held, waits while it works, and goes once, when it is idle', async t => {
  const f = await fixture(t); busy(f);
  f.begin('one');
  const result = await f.call('While it works.', 'call-one');
  assert.deepEqual([result.status, result.readiness], ['staged', 'held']);
  assert.equal(result.message, '已保存，尚未投递。收件方正在干活，NAW 先存着，每分钟看一次，它空下来后送一次（不插进它正在跑的回合；最多等 2 小时，没送成会在你下一次用这个工具时告诉你）；你不要等待或重试。真人可随时撤销。');
  await f.end();
  const row = f.rows().at(-1);
  assert.equal(row.wake.status, 'held'); assert.equal(f.writes.length, 0);
  assert.equal(row.text, `${BUSY_TEXT}\nWhile it works.`);
  assert.equal(locale.displayText('en', row.text, row.uiMessage), 'The recipient is not free yet; this one is held and tried again when it is.\nWhile it works.');
  assert.equal(row.wake.retryAt, f.now() + MIN); assert.equal(f.source.wakeHoldAt, row.wake.retryAt, 'the one timer is set');
  await f.look(); assert.deepEqual([row.wake.status, f.writes.length], ['held', 0], 'still at work: still held');
  idle(f); await f.look();
  assert.deepEqual([row.wake.status, f.writes.length], ['submitted', 1]);
  assert.equal(f.writes[0].text.split('\n')[1], 'While it works.');
  assert.equal(f.target.get(f.b).wakeBudget.senders[f.source.get(f.a).nativeId].streak, 1, 'counted as any other');
  assert.equal(f.source.wakeHoldTimer, null, 'no timer once nothing is held');
  f.reply(); await f.look();
  assert.equal(f.writes.length, 1, 'never twice');
});

test('one staged while the recipient was free, whose turn ends when it is at work, is held too; NAW says so', async t => {
  const f = await fixture(t);
  f.begin('one'); const result = await f.call('Free when called.', 'call-one');
  assert.match(result.message, /当前原生回合正常结束后尝试投递；那时收件方若正在干活、接不了，NAW 先存着，空下来后再送一次（收件方的后台是旧版本时不存，只试一次）；/);
  busy(f); await f.end();
  const row = f.rows().at(-1);
  assert.equal(row.wake.status, 'held');
  idle(f); await f.look();
  assert.deepEqual([row.wake.status, f.writes.length], ['submitted', 1]);
});

// 3b, 3c: what the person decided does not withdraw it.
const THIRD = 'Third';
const ordinary = {
  'nothing enters the sender': async () => {},
  'the sender runs another turn of its own': async f => { f.begin('own'); await f.end(); },
  'an automatic message of NAW reaches the sender': async f => {
    const c = await f.target.create('codex', f.root, 'target-owner', THIRD);
    await f.turn('third', 'Hello sender.', f.a, f.target, c);
    assert.equal(f.rows(f.target, c).at(-1).wake.status, 'submitted'); idle({ rb: f.ra });
  },
  'a NAW queue item reaches the sender': async f => {
    await f.source.send(f.a, 'A queue item.', null, null, null, null, null, null, null, null, { itemId: 'item-1', roomId: 'shared' });
    f.ra.emit('state', 'idle');
  },
  'the person types into the sender\'s native session': async f => { f.ra.emit('nativeInput', 'Typed by the person.', { id: 'native-1' }); },
  'the person writes to the sender in its conversation': async f => { await f.source.send(f.a, 'Written by the person.', 'source-owner'); f.ra.emit('state', 'idle'); },
  'the person types in the sender\'s terminal': async f => { f.source.get(f.a).view = 'terminal'; f.ra.terminal = { alive: true, input() {} }; f.source.input(f.a, 'x', 'source-owner'); },
  'the person steers the sender\'s next turn': async f => {
    f.ra.steerAvailable = true; f.ra.finishTurn = () => {}; f.ra.steer = async () => {};
    f.begin('own'); await f.source.steer(f.a, 'Also this.', 'source-owner', f.ra.turnId); await f.end();
  },
  'another agent\'s message enters the sender (control:input)': async f => { f.ra.emit('nativeControlBoundary', 'control:input'); },
};
for (const [name, act] of Object.entries(ordinary)) test(`held for a recipient at work, it still goes once after: ${name}`, async t => {
  const f = await held(t);
  await f.look(); assert.equal(f.row.wake.status, 'held');
  await act(f); await settle();
  await f.look(); assert.equal(f.row.wake.status, 'held', 'the recipient still works');
  idle(f); await f.look();
  assert.deepEqual([f.row.wake.status, f.row.wake.cancellation?.code, f.to(f.b).length], ['submitted', undefined, 1]);
  f.reply(); await f.look(); assert.equal(f.to(f.b).length, 1);
});

// What the person decided still withdraws it, and what nobody decided.
const ownTurn = f => { f.begin('own'); };
const withdrawn = {
  'Esc in the sender\'s terminal': f => { f.source.get(f.a).view = 'terminal'; f.ra.terminal = { alive: true, input() {} }; f.source.input(f.a, '\x1b', 'source-owner'); },
  'Ctrl-C in the sender\'s terminal': f => { f.source.get(f.a).view = 'terminal'; f.ra.terminal = { alive: true, input() {} }; f.source.input(f.a, '\x03', 'source-owner'); },
  'interrupting the sender': async f => { ownTurn(f); f.ra.interrupt = async () => ({ interrupted: true }); await f.source.interrupt(f.a, 'source-owner'); await f.end(f.source, f.a, 'interrupted'); },
  'another window taking the sender over': f => { f.source.claim(f.a, 'another-window'); },
  'the switch off, also when turned on again': f => { wake.setPolicy(f.source, null, false); wake.setPolicy(f.source, null, true); },
  'the sender\'s own switch off': f => { wake.setPolicy(f.source, f.a, false); },
  'the recipient\'s own switch off': f => { wake.setPolicy(f.target, f.b, false); },
  'pausing all handoffs here': f => { f.source.pauseAll('你暂停了后续交接'); },
  'pausing all handoffs on the recipient\'s backend': f => { f.target.pauseAll('你暂停了后续交接'); },
  'the person typing into the recipient': f => { f.rb.emit('nativeInput', 'The person types into the recipient', { id: 'recipient-native' }); },
  'another window taking the recipient over': f => { f.target.claim(f.b, 'another-window'); },
  'another native session in the recipient\'s place': f => { f.target.get(f.b).nativeId = 'native-someone-else'; },
  'the recipient\'s backend restarting': f => { const s = f.target.get(f.b); s.connectionRevision = (s.connectionRevision || 0) + 1; },
  'a permission request in the sender': f => { f.ra.emit('state', 'approval'); f.ra.emit('state', 'idle'); },
  'a gap in what NAW saw of the sender': f => { f.ra.emit('nativeBlock', { id: 'gap-1', role: 'system', kind: 'gap', text: 'gap' }); },
  'the sender\'s connection changing': f => { const s = f.source.get(f.a); s.connectionRevision = (s.connectionRevision || 0) + 1; },
  'the sender\'s runtime gone': f => { f.ra.transportDisconnected = true; },
  'another agent writing to the sender through background control': async f => { await backgroundOperation.run(ACTOR, () => f.source.send(f.a, 'From another agent.', 'source-owner')); f.ra.emit('state', 'idle'); },
  'another agent\'s terminal keys through background control': async f => { f.source.get(f.a).view = 'terminal'; f.ra.terminal = { alive: true, input() {} }; await backgroundOperation.run(ACTOR, () => f.source.input(f.a, 'x', 'source-owner')); },
};
for (const [name, act] of Object.entries(withdrawn)) test(`held for a recipient at work, it never goes after: ${name}`, async t => {
  const f = await held(t);
  await act(f); await settle();
  idle(f); for (let i = 0; i < 3; i++) await f.look();
  assert.equal(f.to(f.b).length, 0);
  assert.ok(['cancelled', 'not-sent'].includes(f.row.wake.status), f.row.wake.status);
  assert.equal(f.source.wakeHoldTimer, null, 'nothing is left to try');
});

// Writing to the sender through a space also pauses its handoffs, as before: not part of what the person decided.
test('the person writing to the sender through a space still withdraws it at once', async t => {
  const f = await fixture(t); f.source.join(f.a, true); busy(f);
  await f.turn('one', 'While it works.');
  const row = f.rows().at(-1); assert.equal(row.wake.status, 'held');
  await f.source.send(f.a, 'Through the space.', 'source-owner', null, { roomId: 'shared' });
  assert.equal(row.wake.status, 'cancelled'); assert.match(row.text, /真人输入优先/);
  f.ra.emit('state', 'idle'); idle(f); await f.look();
  assert.equal(f.to(f.b).length, 0);
});

// 「绝不走中途」
for (const provider of ['claude', 'codex']) test(`a held message never enters a running turn of ${provider}, though the native way in has opened`, async t => {
  const f = await held(t, { provider });
  Object.assign(f.rb, { queueAvailable: true, midturnAvailable: true, steerAvailable: true, turnId: 'recipient-turn', finishTurn() {} });
  await f.look(); await f.look();
  assert.deepEqual([f.row.wake.status, f.rb.midturn.length, f.writes.length], ['held', 0, 0]);
  f.rb.turnId = null; idle(f); await f.look();
  assert.deepEqual([f.row.wake.status, f.rb.midturn.length, f.to(f.b).length], ['submitted', 0, 1]);
});
test('also one staged as held, whose turn ends while the native way in is open', async t => {
  const f = await fixture(t, { provider: 'claude' }); busy(f);
  f.begin('one'); assert.equal((await f.call('Held from the start.', 'call-one')).readiness, 'held');
  Object.assign(f.rb, { queueAvailable: true, midturnAvailable: true });
  await f.end();
  const row = f.rows().at(-1);
  assert.deepEqual([row.wake.status, f.rb.midturn.length, f.writes.length], ['held', 0, 0]);
});

test('once held, it waits out the recipient\'s other passing states too; the minute between two messages stays', async t => {
  const f = await held(t), states = [
    ['an approval', () => { f.rb.nativeInputRequired = true; }, () => { f.rb.nativeInputRequired = false; }],
    ['an input on its way in', () => { f.target.get(f.b).pendingTag = 'other'; }, () => { f.target.get(f.b).pendingTag = null; }],
  ];
  idle(f);
  for (const [name, on, off] of states) { on(); await f.look(); assert.deepEqual([f.row.wake.status, f.row.text], ['held', `${BUSY_TEXT}\nWhile it works.`], name); off(); }
  // Another session's message gets in first: the minute after it is the recipient's, as before.
  const c = await f.target.create('codex', f.root, 'target-owner', THIRD);
  f.advance(MIN - 1000); await f.turn('third', 'First in.', f.b, f.target, c); f.reply();
  const first = f.to(f.b)[0].at;
  f.advance(1000); await f.retry();
  assert.equal(f.row.wake.status, 'held', 'its minute is not over');
  assert.equal(f.row.wake.retryAt, first + MIN);
  f.advance(MIN); await f.retry();
  assert.deepEqual([f.row.wake.status, f.to(f.b).length], ['submitted', 2]);
  assert.ok(f.to(f.b)[1].at - first >= MIN);
});

test('every other refusal ends it: the limit of three in a row, the recipient switched off, gone', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) { if (i) f.advance(MIN + 1); await f.turn('t' + i, `Task ${i}.`); f.reply(); }
  busy(f); f.advance(MIN + 1);
  const fourth = await f.turn('four', 'Fourth.');
  assert.equal(fourth.status, 'not-sent'); assert.match(fourth.message, /连续 3 次/);
  // Two held before the limit: the first goes, the second is the fourth in a row.
  const g = await fixture(t);
  for (let i = 0; i < 2; i++) { if (i) g.advance(MIN + 1); await g.turn('t' + i, `Task ${i}.`); g.reply(); }
  busy(g); g.advance(MIN + 1);
  await g.turn('three', 'Third.'); await g.turn('four', 'Fourth.');
  assert.deepEqual(g.rows().slice(2).map(r => r.wake.status), ['held', 'held']);
  idle(g); await g.look(); g.reply(); await g.look();
  assert.deepEqual(g.rows().slice(2).map(r => r.wake.status), ['submitted', 'not-sent']); assert.equal(g.to(g.b).length, 3);
  assert.match(g.rows().at(-1).text, /连续 3 次/);
  // Off without a new boundary (an older backend's record): refused, not held.
  const h = await held(t); h.target.get(h.b).wakeDisabled = true; idle(h); await h.look();
  assert.deepEqual([h.row.wake.status, h.to(h.b).length], ['not-sent', 0]);
});

test('after two hours it expires: not sent, said so, and never tried again', async t => {
  const f = await held(t);
  f.advance(120 * MIN - 1000); await f.retry();
  assert.equal(f.row.wake.status, 'held', 'not yet');
  assert.ok(f.row.wake.retryAt <= f.row.wake.heldAt + 120 * MIN, 'looked at again by its deadline');
  f.advance(1000); await f.retry();
  assert.equal(f.row.wake.status, 'not-sent'); assert.equal(f.row.wake.settledAt, f.now());
  assert.equal(f.row.text, '自动消息没有发出；不会自动重发。\n等了 2 小时，收件方一直没空下来，这条到期了。\nWhile it works.');
  assert.equal(locale.displayText('en', f.row.text, f.row.uiMessage), 'Automatic message was not sent; it will not be retried automatically.\nThe recipient was not free for 2 hours; this one has expired.\nWhile it works.');
  idle(f); await f.look();
  assert.deepEqual([f.to(f.b).length, f.source.wakeHoldTimer], [0, null]);
});

test('at most 32 held for recipients at work on one backend: the next is refused as before', async t => {
  const f = await fixture(t); busy(f);
  for (let i = 0; i < 32; i++) assert.equal((await f.turn('t' + i, `Held ${i}.`)).readiness, 'held', `message ${i}`);
  const last = await f.turn('t32', 'One too many.');
  assert.deepEqual([last.status, last.message], ['not-sent', '自动消息没有发出；不会自动重发。\nReceiver 正在干活。\nOne too many.']);
  assert.equal(f.rows().filter(r => r.wake.status === 'held').length, 32);
  // One look a minute for the recipient, however many wait for it.
  f.calls.wakeReceive = 0; f.advance(MIN); await f.retry(); await f.retry(); await f.retry();
  assert.equal(f.calls.wakeReceive, 1);
});

test('a reopened backend never sends one, and says so', async t => {
  const f = await held(t); f.advance(5000); f.source.persist();
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  const row = reopened.get(f.a).messages.find(m => m.wake);
  assert.deepEqual([row.wake.status, row.text], ['cancelled', 'NAW 后台重开过；存着的自动消息没有补送。\nWhile it works.']);
  assert.equal(row.wake.settledAt, f.now(), 'when it ended, for whoever is told');
  wake.retryHeld(reopened); await settle();
  assert.deepEqual([f.to(f.b).length, reopened.wakeHoldTimer ?? null], [0, null]);
});

test('a recipient\'s backend that does not ask to hold keeps the old answer: not sent', async t => {
  const f = await fixture(t, { old: true }); busy(f);
  const result = await f.turn('one', 'To an old backend.');
  assert.deepEqual([result.status, f.rows().at(-1).text], ['not-sent', '自动消息没有发出；不会自动重发。\nReceiver 正在干活。\nTo an old backend.']);
  const g = await fixture(t, { old: true });
  g.begin('one'); await g.call('Free when called.', 'call-one'); busy(g); await g.end();
  assert.equal(g.rows().at(-1).wake.status, 'not-sent'); assert.equal(g.source.wakeHoldTimer, null);
});
test('a recipient that asks to hold for any other reason is not followed', async t => {
  for (const key of ['error.wake.recipientAwaiting', 'error.wake.recipientInputPending', 'error.wake.recipientCooldown', 'error.wake.recipientDisabled', 'error.wake.recipientIdentityChanged', 'error.wake.consecutiveLimit', null]) {
    const f = await fixture(t);
    f.source.peerRunner.transferWake = async () => ({ status: 'not-sent', reason: 'Synthetic refusal.', reasonUiMessage: key && { version: 1, key, params: {} }, hold: true, retryAt: Date.now() + 1000 });
    await f.turn('one', 'First.');
    assert.deepEqual([f.rows().at(-1).wake.status, f.source.wakeHoldTimer ?? null], ['not-sent', null], key);
  }
});
test('once held, the recipient switched off, changed or past its three in a row ends it, also when its backend asks to hold', async t => {
  for (const key of ['error.wake.recipientDisabled', 'error.wake.recipientIdentityChanged', 'error.wake.consecutiveLimit', 'error.wake.recipientBoundaryChanged', null]) {
    const f = await held(t);
    f.source.peerRunner.transferWake = async () => ({ status: 'not-sent', reason: 'Synthetic refusal.', reasonUiMessage: key && { version: 1, key, params: {} }, hold: true, retryAt: Date.now() + 1000 });
    await f.look();
    assert.deepEqual([f.row.wake.status, f.source.wakeHoldTimer ?? null], ['not-sent', null], key);
  }
});

test('the sender is told of a held message that did not go out, once, with its next message', async t => {
  const f = await held(t);
  f.source.claim(f.a, 'source-owner-2'); await f.look();
  assert.equal(f.row.wake.status, 'cancelled');
  idle(f); f.begin('two'); const second = await f.call('Next.', 'call-two'); await f.end();
  assert.match(second.message, /你之前存着等送的一条没有送到：发给 .+，「While it works\.」：存着的自动消息没有补送：补送前核对发送方和授权没通过。/);
  assert.ok(second.message.includes(f.b), 'names the recipient');
  f.advance(MIN); f.begin('three'); const third = await f.call('Again.', 'call-three'); await f.end();
  assert.doesNotMatch(third.message, /没有送到/, 'once');
  // Expired, and the next call itself refused: still told.
  const g = await held(t); g.advance(120 * MIN); await g.retry();
  assert.equal(g.row.wake.status, 'not-sent');
  g.target.get(g.b).wakeDisabled = true; g.begin('two'); const refused = await g.call('Next.', 'call-two'); await g.end();
  assert.equal(refused.status, 'not-sent'); assert.match(refused.message, /你之前存着等送的一条没有送到：.*到期了/);
  // Delivered, or refused at once without being held: nothing to tell.
  const h = await held(t); idle(h); await h.look(); h.reply(); h.advance(MIN);
  h.begin('two'); const fine = await h.call('Next.', 'call-two'); await h.end();
  assert.doesNotMatch(fine.message, /没有送到/);
  const i = await fixture(t); i.target.get(i.b).wakeDisabled = true; await i.turn('one', 'Refused.'); i.target.get(i.b).wakeDisabled = false;
  i.begin('two'); assert.doesNotMatch((await i.call('Next.', 'call-two')).message, /没有送到/); await i.end();
  // The native session that sent it, not another one in its place.
  const k = await held(t); k.source.claim(k.a, 'source-owner-2'); await k.look();
  k.source.get(k.a).nativeId = 'native-fresh'; k.begin('two');
  assert.doesNotMatch((await k.call('Next.', 'call-two')).message, /没有送到/);
});

test('held for the butler\'s minute, then at work: it keeps waiting, for any sender', async t => {
  const f = await fixture(t, { steward: 'recipient' });
  await f.turn('first', 'First.'); f.reply(); f.advance(10000);
  await f.turn('second', 'Second.');
  const row = f.rows().at(-1); assert.deepEqual([row.wake.status, row.wake.busyHold], ['held', undefined]);
  busy(f); await f.look();
  assert.equal(row.wake.status, 'held'); assert.ok(row.wake.busyHold);
  // The role moves on: a message for a recipient at work was never only the butler's to keep.
  fs.rmSync(path.join(f.root, 'steward.json')); idle(f); await f.look();
  assert.deepEqual([row.wake.status, f.to(f.b).length], ['submitted', 2]);
});

test('a quiet window that opens on the recipient\'s backend keeps it until the window closes; its two hours still count', async t => {
  const f = await held(t), file = path.join(f.root, 'quiet-windows.json');
  const open = () => fs.writeFileSync(file, JSON.stringify({ format: 1, windows: [{ id: randomUUID(), scope: `backend:${KEY}`, reason: 'migration', openedBy: 'naw', openedAt: f.now(), deadline: f.now() + 40 * MIN, waited: 'busy', sessions: [f.b] }], history: [] }), { mode: 0o600 });
  open(); idle(f); await f.look(); assert.deepEqual([f.row.wake.status, f.to(f.b).length], ['held', 0]);
  fs.writeFileSync(file, JSON.stringify({ format: 1, windows: [], history: [] }), { mode: 0o600 });
  busy(f); await f.look(); assert.equal(f.row.wake.status, 'held');
  assert.equal(f.row.wake.quietWindow, undefined, 'held for the recipient again, not for a window that is over');
  idle(f); await f.look(); assert.deepEqual([f.row.wake.status, f.to(f.b).length], ['submitted', 1]);
});
