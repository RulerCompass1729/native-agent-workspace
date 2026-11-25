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
    r.start = async () => r.emit('state', 'idle'); r.stop = async () => ({ state: 'ended' }); r.stopForMaintenance = async begin => { begin(); r.stopped = true; return { state: 'ended' }; };
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
  'Esc in the recipient\'s terminal': f => { f.target.get(f.b).view = 'terminal'; f.rb.terminal = { alive: true, input() {} }; f.target.input(f.b, '\x1b', f.target.get(f.b).owner); },
  'Ctrl-C in the recipient\'s terminal': f => { f.target.get(f.b).view = 'terminal'; f.rb.terminal = { alive: true, input() {} }; f.target.input(f.b, '\x03', f.target.get(f.b).owner); },
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

test('every other refusal ends it: the limit of eight in a row, the recipient switched off, gone', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) { if (i) f.advance(MIN + 1); await f.turn('t' + i, `Task ${i}.`); f.reply(); }
  busy(f); f.advance(MIN + 1);
  const ninth = await f.turn('nine', 'Ninth.');
  assert.equal(ninth.status, 'not-sent'); assert.match(ninth.message, /连续 8 次/);
  // Two held before the limit: the first goes, the second is the ninth in a row.
  const g = await fixture(t);
  for (let i = 0; i < 7; i++) { if (i) g.advance(MIN + 1); await g.turn('t' + i, `Task ${i}.`); g.reply(); }
  busy(g); g.advance(MIN + 1);
  await g.turn('eight', 'Eighth.'); await g.turn('nine', 'Ninth.');
  assert.deepEqual(g.rows().slice(7).map(r => r.wake.status), ['held', 'held']);
  idle(g); await g.look(); g.reply(); await g.look();
  assert.deepEqual(g.rows().slice(7).map(r => r.wake.status), ['submitted', 'not-sent']); assert.equal(g.to(g.b).length, 8);
  assert.match(g.rows().at(-1).text, /连续 8 次/);
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
  const row = f.rows().at(-1);
  assert.match(locale.displayText('en', row.text, row.uiMessage), /\nReceiver is working\.\n/);
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
test('once held, the recipient switched off, changed or past its eight in a row ends it, also when its backend asks to hold', async t => {
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

// Answered as held, then ended before its turn did (the reviewer, 11-24): the promise to say so covers these too.
const beforeHeld = {
  'the sender\'s turn is interrupted': f => f.end(f.source, f.a, 'interrupted'),
  'the sender is taken over': async f => { f.source.claim(f.a, 'another-window'); await f.end(); f.source.claim(f.a, 'source-owner'); },
  'the person presses Esc in the recipient': async f => { f.target.get(f.b).view = 'terminal'; f.rb.terminal = { alive: true, input() {} }; f.target.input(f.b, '\x1b', f.target.get(f.b).owner); await f.end(); },
  'handoffs are paused': async f => { f.source.pauseAll('你暂停了后续交接'); await f.end(); },
  'eight in a row': async f => { f.target.get(f.b).wakeBudget = { version: 2, lastAt: 0, humanRevision: f.target.get(f.b).wakeHumanRevision || 0, senders: { [f.source.get(f.a).nativeId]: { id: 'earlier', streak: 8 } } }; await f.end(); },
  'its turn outlasts the two hours': async f => { f.advance(120 * MIN); await f.end(); },
};
for (const [name, act] of Object.entries(beforeHeld)) test(`answered as held, ended before its turn did, and said so with the next message: ${name}`, async t => {
  const f = await fixture(t); busy(f);
  f.begin('one');
  assert.equal((await f.call('While it works.', 'call-one')).readiness, 'held');
  await act(f);
  const row = f.rows().at(-1);
  assert.ok(['not-sent', 'cancelled'].includes(row.wake.status), `${name}: ${row.wake.status}`);
  assert.equal(f.writes.length, 0, name);
  f.advance(MIN); f.begin('two');
  const told = (await f.call('Next.', 'call-two')).message;
  assert.match(told, new RegExp(`\\n你之前存着等送的一条没有送到：发给 ${f.b}，「While it works\\.」：.`), name);
  await f.end(); f.advance(MIN); f.begin('three');
  assert.ok(!(await f.call('Third.', 'call-three')).message.includes('While it works.'), 'once');
});
test('one whose outcome is unknown is not said to have failed', async t => {
  const f = await held(t);
  f.source.peerRunner.transferWake = async () => { throw Error('The connection closed.'); };
  await f.look();
  assert.equal(f.row.wake.status, 'unconfirmed');
  f.begin('two');
  const told = (await f.call('Next.', 'call-two')).message;
  assert.match(told, new RegExp(`\\n你之前存着等送的一条没能确认是否送到，可能已经送到，先别重发：发给 ${f.b}，「While it works\\.」`));
  assert.ok(!told.includes('没有送到'));
});
test('a notice that could not be saved with its answer is given with the next one', async t => {
  const f = await held(t);
  f.source.claim(f.a, 'another-window'); await f.look(); f.source.claim(f.a, 'source-owner');
  assert.equal(f.row.wake.status, 'cancelled');
  f.begin('two');
  const persist = f.source.persist; f.source.persist = function () { this.storageWarning = { key: 'x' }; };
  await assert.rejects(f.call('Not saved.', 'call-two'));
  f.source.persist = persist; f.source.storageWarning = null;
  await f.end(); f.advance(MIN); f.begin('three');
  const told = (await f.call('Next.', 'call-three')).message;
  assert.match(told, /「While it works\.」/);
  assert.ok(!told.includes('Not saved.'), 'a message that could not be saved was never answered as held');
});

// 298's independent review, 11-24: findings 1 and 2, and the PM's three rows.
const LOSS = '你之前存着等送的一条没有送到：', UNKNOWN = '你之前存着等送的一条没能确认是否送到';
const saved = f => JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8')).sessions.find(s => s.id === f.a).messages;
const windows = (f, open) => fs.writeFileSync(path.join(f.root, 'quiet-windows.json'), JSON.stringify({ format: 1, history: [],
  windows: open ? [{ id: randomUUID(), scope: `backend:${KEY}`, reason: 'migration', openedBy: 'naw', openedAt: f.now(), deadline: f.now() + 40 * MIN, waited: 'busy', sessions: [f.b] }] : [] }), { mode: 0o600 });
test('what an answer tells of a lost message is saved with that answer: never told again after the backend ends', async t => {
  const f = await held(t), other = await f.target.create('codex', f.root, 'other-owner', 'Other');
  idle(f); await stopped(f); await settle(); await f.look();
  assert.equal(f.row.wake.status, 'not-sent');
  f.begin('two'); const told = await f.call('Next.', 'call-two', other);
  assert.equal(told.status, 'staged'); assert.ok(told.message.includes(LOSS) && told.message.includes('While it works.'));
  // The backend ends here: what it reopens with is what was saved with the answer.
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  f.source.get(f.a).messages = saved(f);
  f.advance(MIN); f.begin('three'); const again = await f.call('Third.', 'call-three', other);
  assert.equal(again.status, 'staged'); assert.ok(!again.message.includes(LOSS) && !again.message.includes('While it works.'));
  assert.equal(f.to(f.b).length, 0);
  assert.equal(reopened.get(f.a).messages.find(m => m.id === f.row.id).wake.senderTold, true);
});
test('an answer that could not be saved has told nothing: the next one does, also from what is saved later', async t => {
  const f = await held(t);
  f.source.claim(f.a, 'another-window'); await f.look(); f.source.claim(f.a, 'source-owner');
  f.begin('two');
  const persist = f.source.persist; let during = null;
  f.source.persist = function () { during = f.row.wake.senderTold; this.storeSnapshot(); this.storageWarning = { key: 'x' }; };
  await assert.rejects(f.call('Not saved.', 'call-two'));
  f.source.persist = persist; f.source.storageWarning = null;
  assert.deepEqual([during, f.row.wake.senderTold, f.rows().at(-1).wake.saidHeld], [undefined, undefined, undefined], 'not marked before the answer is saved');
  const later = JSON.parse(f.source.storeSnapshot(undefined, true).workspace).sessions.find(s => s.id === f.a).messages;
  assert.equal(later.find(m => m.id === f.row.id).wake.senderTold, undefined);
  await f.end(); f.advance(MIN); f.begin('three');
  assert.ok((await f.call('Next.', 'call-three')).message.includes(LOSS));
});
// 298's independent review of that, 11-25: a save replaces workspace.json, then the room records. `fail` refuses a
// file's rename in the saves it returns true for; what was refused is listed.
const saving = async (f, fail, act) => {
  const rename = fs.renameSync, refused = []; let saves = 0;
  f.source.rooms.set('99999999-9999-4999-8999-999999999999', { id: '99999999-9999-4999-8999-999999999999', name: 'Two', messages: [], revision: 0 });
  fs.renameSync = (from, to) => {
    const name = path.dirname(String(to)) === f.root ? path.basename(String(to)) : '';
    if (name === 'workspace.json') saves += 1;
    if (['workspace.json', 'room-records.json'].includes(name) && fail(saves, name)) { refused.push(`${saves} ${name}`); throw Object.assign(Error('no space'), { code: 'ENOSPC' }); }
    return rename(from, to);
  };
  try { return { answer: await act().catch(error => ({ error })), refused, saves }; } finally { fs.renameSync = rename; }
};
const reopen = f => { f.source.storageWarning = null; f.source.storageFailure = null; f.source.get(f.a).messages = saved(f); };
const lossOf = async t => {
  const f = await held(t); f.other = await f.target.create('codex', f.root, 'other-owner', 'Other');
  idle(f); await stopped(f); await settle(); await f.look(); assert.equal(f.row.wake.status, 'not-sent');
  f.onDisk = () => saved(f).find(m => m.id === f.row.id).wake.senderTold;
  f.begin('two'); f.next = () => f.call('Next.', 'call-two', f.other);
  return f;
};
test('a save that replaced workspace.json and failed on the room records told nothing: told once after the backend reopens', async t => {
  const f = await lossOf(t);
  const { answer, refused } = await saving(f, (save, name) => name === 'room-records.json', f.next);
  assert.ok(answer.error); assert.deepEqual(refused, ['1 room-records.json']);
  assert.deepEqual([f.onDisk(), f.row.wake.senderTold], [undefined, undefined]);
  assert.ok(saved(f).some(m => m.wake?.body === 'Next.'), 'workspace.json is the one the failed save wrote');
  reopen(f);
  f.advance(MIN); f.begin('three'); const told = await f.call('Third.', 'call-three', f.other);
  assert.ok(told.message.includes(LOSS) && told.message.includes('「While it works.」'), told.message);
  assert.equal(f.onDisk(), true);
  reopen(f); f.advance(MIN); f.begin('four');
  assert.ok(!(await f.call('Fourth.', 'call-four', f.other)).message.includes('「While it works.」'), 'once');
  assert.equal(f.to(f.b).length, 0, 'nothing is sent again');
});
test('the save of the mark that wrote neither file: the answer does not tell the loss, and one later answer does', async t => {
  const f = await lossOf(t);
  f.source.get(f.a).messages.push({ id: randomUUID(), role: 'system', kind: 'notice', origin: 'agent-wake-intent', text: 'Old.', wake: { nativeId: f.source.get(f.a).nativeId, status: 'cancelled', heldAt: 1, recipientId: f.b, body: 'Another lost.' } });
  const { answer, refused } = await saving(f, (save, file) => save === 2 && file === 'workspace.json', f.next);
  assert.deepEqual([answer.status, refused], ['staged', ['2 workspace.json']]);
  assert.ok(!answer.message.includes('你之前存着等送的一条'), answer.message);
  assert.deepEqual([f.row.wake.senderTold, f.onDisk()], [undefined, undefined]);
  const later = JSON.parse(f.source.storeSnapshot(undefined, true).workspace).sessions.find(s => s.id === f.a).messages;
  assert.equal(later.find(m => m.id === f.row.id).wake.senderTold, undefined, 'nor in what is saved later');
  assert.ok(saved(f).some(m => m.wake?.body === 'Next.' && m.wake.status === 'staged'), 'what was answered is saved');
  f.source.storageWarning = null; f.source.storageFailure = null;
  await f.end(); f.advance(MIN); f.begin('three');
  const told = (await f.call('Third.', 'call-three', f.other)).message;
  assert.deepEqual(told.split('「').slice(1).map(part => part.split('」')[0]), ['While it works.', 'Another lost.'], 'once the warning is cleared');
  assert.equal(f.onDisk(), true);
  await f.end(); f.advance(MIN); f.begin('four');
  assert.ok(!(await f.call('Fourth.', 'call-four', f.other)).message.includes('「While it works.」'), 'once');
});
test('the save of the mark that wrote neither file, then a restart: one later answer tells the loss', async t => {
  const f = await lossOf(t);
  const { answer } = await saving(f, (save, file) => save === 2 && file === 'workspace.json', f.next);
  assert.ok(!answer.message.includes('「While it works.」'));
  reopen(f); f.advance(MIN); f.begin('three');
  const told = await f.call('Third.', 'call-three', f.other);
  assert.ok(told.message.includes(LOSS) && told.message.includes('「While it works.」'), told.message);
  reopen(f); f.advance(MIN); f.begin('four');
  assert.ok(!(await f.call('Fourth.', 'call-four', f.other)).message.includes('「While it works.」'), 'once');
  assert.equal(f.to(f.b).length, 0, 'nothing is sent again');
});
test('the save of the mark that wrote only workspace.json: the answer tells the loss, and none after it', async t => {
  const f = await lossOf(t);
  const { answer, refused } = await saving(f, (save, file) => save === 2 && file === 'room-records.json', f.next);
  assert.deepEqual([answer.status, refused], ['staged', ['2 room-records.json']]);
  assert.ok(answer.message.includes('「While it works.」'));
  assert.deepEqual([f.row.wake.senderTold, f.onDisk()], [true, true]);
  reopen(f); f.advance(MIN); f.begin('three');
  assert.ok(!(await f.call('Third.', 'call-three', f.other)).message.includes('「While it works.」'), 'not again after a restart');
});
test('an answer that tells of nothing is saved once', async t => {
  const f = await fixture(t); f.begin('one');
  const { answer, saves } = await saving(f, () => false, () => f.call('Plain.', 'call-one'));
  assert.deepEqual([answer.status, saves], ['staged', 1]);
});
// Each answered `readiness: 'held'` while still staged, and lost before anything held it.
const cooldown = async t => {
  const f = await fixture(t, { steward: 'recipient' }); await f.turn('first', 'Seed.'); f.reply(); f.advance(10000); return f;
};
const quietly = async t => { const f = await fixture(t); windows(f, true); return f; };
const answeredHeld = {
  'the butler\'s minute, the recipient stopped': [cooldown, async f => { await stopped(f); await f.end(); }, 'not-sent'],
  'the butler\'s minute, the sender\'s turn interrupted': [cooldown, f => f.end(f.source, f.a, 'interrupted'), 'cancelled'],
  'a quiet window, the sender\'s turn interrupted': [quietly, f => f.end(f.source, f.a, 'interrupted'), 'cancelled'],
  'a quiet window that closed, the recipient stopped': [quietly, async f => { windows(f, false); await stopped(f); await f.end(); }, 'not-sent'],
  'a quiet window that closed, the connection lost': [quietly, async f => { windows(f, false); f.source.peerRunner.transferWake = async () => { throw Error('The connection closed.'); }; await f.end(); }, 'unconfirmed'],
};
for (const [name, [make, act, status]] of Object.entries(answeredHeld)) test(`answered as held, told once when it is lost: ${name}`, async t => {
  const f = await make(t), sent = f.writes.length, other = await f.target.create('codex', f.root, 'other-owner', 'Other');
  f.begin('two'); const ack = await f.call('Probe text.', 'call-two');
  assert.deepEqual([ack.status, ack.readiness], ['staged', 'held']);
  const row = f.rows().at(-1);
  assert.equal(row.wake.heldAt ?? row.wake.busyHold, undefined);
  const kept = saved(f).find(m => m.id === row.id).wake.saidHeld;
  await act(f); assert.equal(row.wake.status, status); windows(f, false);
  delete f.source.peerRunner.transferWake;
  f.advance(MIN); f.begin('three'); const next = await f.call('Next.', 'call-three', other);
  assert.equal(next.status, 'staged');
  assert.ok(next.message.includes(`\n${status === 'unconfirmed' ? UNKNOWN : LOSS}`) && next.message.includes('「Probe text.」'), next.message);
  await f.end(); f.advance(MIN); f.begin('four');
  assert.ok(!(await f.call('Fourth.', 'call-four', other)).message.includes('Probe text.'), 'once');
  assert.equal(f.to(f.b).length, sent, 'nothing is sent again');
  assert.equal(kept, true, 'saved with the answer');
});
test('answered as held and delivered, or answered as checked and lost: nothing to tell; a row from before the mark neither', async t => {
  const f = await quietly(t); f.begin('one'); assert.equal((await f.call('Probe text.', 'call-one')).readiness, 'held');
  windows(f, false); await f.end(); assert.equal(f.rows().at(-1).wake.status, 'submitted'); f.reply();
  f.advance(MIN); f.begin('two'); const checked = await f.call('Plain text.', 'call-two');
  assert.equal(checked.readiness, 'checked'); assert.equal(f.rows().at(-1).wake.saidHeld, undefined);
  await f.end(f.source, f.a, 'interrupted'); assert.equal(f.rows().at(-1).wake.status, 'cancelled');
  const { nativeId } = f.source.get(f.a), old = wake => f.source.get(f.a).messages.push({ id: randomUUID(), role: 'system', kind: 'notice', origin: 'agent-wake-intent', text: 'Old.', wake });
  old({ nativeId, status: 'cancelled', quietWindow: { id: 'w', deadline: 1 }, recipientId: f.b, body: 'Old quiet.' });
  old({ nativeId, status: 'not-sent', recipientId: f.b, body: 'Old cooldown.' }); old(null); old(undefined);
  f.advance(MIN); f.begin('three'); const next = await f.call('Next.', 'call-three');
  assert.ok(!next.message.includes('你之前存着等送的一条'));
  // One that was held, or held for a recipient at work, needs no mark.
  old({ nativeId, status: 'not-sent', heldAt: 1, recipientId: f.b, body: 'Old held.' });
  old({ nativeId, status: 'cancelled', busyHold: { deadline: 1 }, recipientId: f.b, body: 'Old busy.' });
  await f.end(f.source, f.a, 'interrupted'); f.advance(MIN); f.begin('four'); const last = await f.call('Last.', 'call-four');
  assert.deepEqual(last.message.split('「').slice(1).map(part => part.split('」')[0]), ['Old held.', 'Old busy.']);
  await f.end(f.source, f.a, 'interrupted'); f.advance(MIN); f.begin('five');
  assert.ok(!(await f.call('Then.', 'call-five')).message.includes('「Old '), 'each once, those told together too');
});
test('the person writing to the sender through a space during an offer withdraws it: not held again', async t => {
  const f = await fixture(t); f.source.join(f.a, true); busy(f);
  await f.turn('one', 'While it works.');
  const row = f.rows().at(-1); assert.equal(row.wake.status, 'held');
  const run = f.source.peerRunner.transferWake.bind(f.source.peerRunner);
  f.source.peerRunner.transferWake = async intent => { const result = await run(intent); await f.source.send(f.a, 'Through the space.', 'source-owner', null, { roomId: 'shared' }); return result; };
  await f.look();
  f.source.peerRunner.transferWake = run;
  assert.equal(row.wake.status, 'cancelled');
  f.ra.emit('state', 'idle'); idle(f); await f.look();
  assert.equal(f.to(f.b).length, 0);
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

// The recipient ended before it was offered (298, R203): nothing was read from the sender and nothing written, so it is
// not sent. A rotation stops the old session this way; its successor is another session.
const stopped = f => f.target.stop(f.b, { check() {}, participantOnly: true, expected: { ...f.target.get(f.b), draftRevision: 0 } });
const gone = { 'stopped as a rotation stops it': stopped, 'its record is gone': async f => { await stopped(f); f.target.forget(f.b); } };
const reason = { 'stopped as a rotation stops it': ['会话已经结束；保存的记录仍可查看。', 'The session has ended. Its saved records remain available.', 'error.sessionEnded'],
  'its record is gone': ['找不到这个会话。', 'This session could not be found.', 'error.sessionMissing'] };
for (const provider of ['codex', 'claude']) for (const [name, end] of Object.entries(gone)) test(`a held message whose recipient ended (${provider}, ${name}) is not sent, and the sender is told so once`, async t => {
  const f = await held(t, { provider });
  const other = await f.target.create('codex', f.root, 'other-owner', 'Other');
  idle(f); await end(f); await settle();
  await f.look();
  const [zh, en, key] = reason[name];
  assert.equal(f.row.wake.status, 'not-sent'); assert.ok(Number.isSafeInteger(f.row.wake.settledAt));
  assert.equal(f.row.text, `自动消息没有发出；不会自动重发。\n${zh}\nWhile it works.`);
  assert.equal(locale.displayText('en', f.row.text, f.row.uiMessage), `Automatic message was not sent; it will not be retried automatically.\n${en}\nWhile it works.`);
  assert.equal(f.row.uiMessage.cause.key, key);
  assert.equal(f.writes.length, 0); assert.equal(f.source.wakeHoldTimer, null, 'not looked at again');
  f.begin('two');
  const told = (await f.call('Next.', 'call-two', other)).message;
  assert.match(told, new RegExp(`\\n你之前存着等送的一条没有送到：发给 ${f.b}，「While it works\\.」：`));
  assert.ok(!told.includes('可能已经送到') && !told.includes('先别重发'));
  await f.end(); f.advance(MIN); f.begin('three');
  assert.ok(!(await f.call('Third.', 'call-three', other)).message.includes('While it works.'), 'once');
  await f.end(); await f.look();
  assert.equal(f.to(f.b).length, 0, 'nothing went to the recipient');
});
for (const [name, end] of Object.entries(gone)) test(`an ordinary message whose recipient ended before the turn did (${name}) is not sent`, async t => {
  const f = await fixture(t);
  f.begin('one');
  assert.equal((await f.call('Plain.', 'call-one')).readiness, 'checked');
  await end(f); await f.end();
  const row = f.rows().at(-1);
  assert.deepEqual([row.wake.status, row.uiMessage.cause.key, f.writes.length, f.calls.wakeReceive], ['not-sent', reason[name][2], 0, 1]);
  assert.equal(row.text, `自动消息没有发出；不会自动重发。\n${reason[name][0]}\nPlain.`);
});
// Once it took the message, an ended recipient or a lost connection leaves the outcome unknown, as before.
const afterTake = {
  'the recipient ends while it is written': f => { const send = f.target.send.bind(f.target); f.target.send = async (...args) => { await stopped(f); return send(...args); }; return 0; },
  'the answer is lost after it was written': f => { const run = f.source.peerRunner.transferWake.bind(f.source.peerRunner); f.source.peerRunner.transferWake = async intent => { await run(intent); throw Error('The connection closed.'); }; return 1; },
  'the take is answered and its answer lost': f => { const take = f.target.peerRunner.takeWake.bind(f.target.peerRunner); f.target.peerRunner.takeWake = async spec => { await take(spec); throw Error('The connection closed.'); }; return 0; },
};
for (const [name, act] of Object.entries(afterTake)) test(`after the recipient took it the outcome stays unknown: ${name}`, async t => {
  const f = await held(t);
  const other = await f.target.create('codex', f.root, 'other-owner', 'Other');
  idle(f); const written = act(f);
  await f.look();
  assert.deepEqual([f.row.wake.status, f.to(f.b).length], ['unconfirmed', written]);
  f.begin('two');
  const told = (await f.call('Next.', 'call-two', other)).message;
  assert.match(told, new RegExp(`\\n你之前存着等送的一条没能确认是否送到，可能已经送到，先别重发：发给 ${f.b}，「While it works\\.」`));
  await f.end(); await f.look();
  assert.equal(f.to(f.b).length, written, 'not sent again');
});
