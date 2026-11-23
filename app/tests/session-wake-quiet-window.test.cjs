'use strict';
// The PM's 11-23 brief (a quiet window before a migration, approved by the butler): while the recipient's backend is
// in a quiet window, an automatic message to it is held, not refused; once the window closes it is tried once more,
// on whichever backend the same native session lives then. Synthetic workspaces; no model, no real backend.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs'), { PeerRunner } = require('../peer-handoffs.cjs');
const wake = require('../session-wake.cjs'), locale = require('../ui-locale.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (count = 12) => { for (let i = 0; i < count; i++) await tick(); };
const KEY = 'backends/aaaaaaaaaaaaaaaaaaaa', MOVED = 'backends/cccccccccccccccccccc', MIN = 60000;

function host(writes) {
  return { binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); r.record = s; s.nativeId = 'native-' + s.id;
    r.host = { rpc: { call: async method => { assert.equal(method, 'thread/goal/get'); return { goal: null }; } } };
    r.chatAvailable = r.addressedSendAvailable = true;
    r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag, guard) => { assert.equal(guard(), true); writes.push({ id: s.id, text, tag }); r.emit('submitted', tag); };
    return r;
  } };
}
// A sender on the root backend and a recipient on KEY; `move` puts the recipient's backend at MOVED, as a migration does.
async function fixture(t) {
  const realNow = Date.now; let now = realNow(); Date.now = () => now; t.after(() => { Date.now = realNow; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-quiet-')); fs.chmodSync(root, 0o700);
  const dirs = [root, path.join(root, KEY)];
  fs.mkdirSync(dirs[1], { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dirs[1]), 0o700);
  const layout = entries => fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries }), { mode: 0o600 });
  layout(['.', KEY]);
  const writes = [], places = new Map();
  const workspaces = dirs.map(dir => { const w = new Workspace(host(writes), dir); places.set(dir, w); return w; });
  const connect = async dir => {
    const w = places.get(dir); assert.ok(w, `no backend at ${path.relative(root, dir)}`);
    return { close() {}, async call(method, spec) {
      if (method === 'initial') return { ...w.snapshot(), capabilities: ['agentWakeV1', 'agentWakePreflightV1'] };
      if (method === 'wakeCheck') return wake.check(w, spec);
      if (method === 'wakeTake') return wake.take(w, spec);
      if (method === 'wakeReceive') return wake.receive(w, spec);
      throw Error('Unexpected method ' + method);
    } };
  };
  workspaces.forEach((w, i) => { w.peerRunner = new PeerRunner(w, dirs[i], connect); });
  t.after(() => { workspaces.forEach(w => w.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const [source, target] = workspaces;
  const a = await source.create('codex', root, 'source-owner', 'Sender');
  const b = await target.create('codex', root, 'target-owner', 'Receiver');
  const ra = source.runtimes.get(a), rb = target.runtimes.get(b);
  const turn = async (id, text, to = b) => {
    const nativeId = source.get(a).nativeId;
    ra.turnId = id; ra.emit('nativeTurnStart', { nativeId, turnId: id }); ra.emit('state', 'working');
    const result = await ra.addressedCall({ nativeId, turnId: id, callId: 'call-' + id }, { recipient_id: to, message: text });
    const finish = async () => { ra.turnId = null; ra.emit('state', 'idle'); ra.emit('nativeTurnEnd', { nativeId, turnId: id, status: 'completed' }); await settle(); };
    return { result, finish };
  };
  const reply = () => { const tag = writes.at(-1).tag; rb.emit('state', 'idle'); rb.emit('complete', { tag, text: 'An ordinary reply.', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); };
  // The record NAW keeps in the profile (quiet-windows.cjs), in its own format.
  const file = path.join(root, 'quiet-windows.json');
  const open = (minutes = 40, key = KEY) => {
    const window = { id: randomUUID(), scope: `backend:${key}`, reason: 'migration', openedBy: 'naw', openedAt: now, deadline: now + minutes * MIN, waited: 'busy', sessions: [b] };
    fs.writeFileSync(file, JSON.stringify({ format: 1, windows: [window], history: [] }), { mode: 0o600 });
    return window;
  };
  const close = () => fs.writeFileSync(file, JSON.stringify({ format: 1, windows: [], history: [] }), { mode: 0o600 });
  const move = () => {
    const moved = path.join(root, MOVED);
    target.persist(); fs.renameSync(dirs[1], moved); target.dataDir = moved;
    places.delete(dirs[1]); places.set(moved, target);
    target.peerRunner = new PeerRunner(target, moved, connect);
    layout(['.', MOVED]);
  };
  const rows = () => source.get(a).messages.filter(m => m.wake);
  const retry = async () => { wake.retryHeld(source); await settle(); };
  return { root, file, source, target, a, b, ra, rb, writes, turn, reply, open, close, move, rows, retry, advance: ms => { now += ms; }, now: () => now };
}

test('held, not refused, while the recipient\'s backend is in a quiet window; tried once it closes, counted as any other', async t => {
  const f = await fixture(t); f.open(40);
  const one = await f.turn('one', 'First.');
  assert.equal(one.result.status, 'staged'); assert.equal(one.result.readiness, 'held');
  assert.equal(one.result.message, '已保存，尚未投递。收件方的后台在安静窗口（迁移 aaaaaaa）中，最迟约 40 分钟后由 NAW 再送一次；你不要等待或重试。真人可随时撤销。');
  await one.finish();
  const row = f.rows().at(-1);
  assert.equal(row.wake.status, 'held'); assert.equal(f.writes.length, 0, 'nothing goes into the window');
  assert.equal(row.text, '收件方的后台在迁移前的安静窗口里；这条先存着，窗口结束后再试一次。\nFirst.');
  assert.equal(locale.displayText('en', row.text, row.uiMessage), 'The recipient\'s backend is in the quiet window before a migration; this one is held and tried once more when the window ends.\nFirst.');
  assert.equal(row.wake.retryAt, f.now() + MIN, 'looked at again in a minute'); assert.equal(f.source.wakeHoldAt, row.wake.retryAt, 'the one timer is set');
  f.advance(MIN); await f.retry();
  assert.equal(row.wake.status, 'held', 'still open: still held'); assert.equal(f.writes.length, 0);
  f.close(); f.advance(MIN); await f.retry();
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].text.split('\n')[1], 'First.');
  assert.equal(row.wake.status, 'submitted'); assert.match(row.text, /原生已接收/);
  assert.equal(f.target.get(f.b).wakeBudget.senders[f.source.get(f.a).nativeId].streak, 1, 'its streak counts as before');
  assert.equal(f.source.wakeHoldTimer, null, 'no timer once nothing is held');
});

test('one staged before the window opened is held at its turn end; one past the deadline or from an unsafe record is not', async t => {
  const f = await fixture(t);
  const one = await f.turn('one', 'Before.');
  assert.notEqual(one.result.readiness, 'held');
  f.open(40); await one.finish();
  assert.equal(f.rows().at(-1).wake.status, 'held'); assert.equal(f.writes.length, 0);
  // A window past its deadline holds nothing.
  const g = await fixture(t); g.open(5); g.advance(5 * MIN);
  const two = await g.turn('two', 'After the deadline.'); await two.finish();
  assert.equal(g.rows().at(-1).wake.status, 'submitted'); assert.equal(g.writes.length, 1);
  // A record others could write is not NAW's.
  const h = await fixture(t); h.open(40); fs.chmodSync(h.file, 0o644);
  const three = await h.turn('three', 'Unsafe record.'); await three.finish();
  assert.equal(h.rows().at(-1).wake.status, 'submitted'); assert.equal(h.writes.length, 1);
});

test('a recipient at work is held in the window; a refusal the window does not end is refused at once, as before', async t => {
  const f = await fixture(t); f.open(40); f.rb.emit('state', 'working');
  const busy = await f.turn('busy', 'While it works.');
  assert.equal(busy.result.readiness, 'held'); await busy.finish();
  assert.equal(f.rows().at(-1).wake.status, 'held');
  const g = await fixture(t); g.open(40); g.target.get(g.b).wakeDisabled = true;
  const off = await g.turn('off', 'Paused recipient.');
  assert.equal(off.result.status, 'not-sent'); await off.finish();
  assert.equal(g.rows().at(-1).wake.status, 'not-sent'); assert.equal(g.writes.length, 0);
});

test('at most 32 held on one backend: the 33rd is not sent and says so; after the window the streak rule is unchanged', async t => {
  const f = await fixture(t); f.open(90);
  for (let i = 0; i < 32; i++) {
    const turn = await f.turn(`t${i}`, `Held ${i}.`);
    assert.equal(turn.result.readiness, 'held', `message ${i}`); await turn.finish();
  }
  const last = await f.turn('t32', 'One too many.');
  assert.equal(last.result.status, 'not-sent');
  assert.match(last.result.message, /收件方的后台在迁移前的安静窗口里，这边已存着 32 条等窗口结束的自动消息，这条不再存。/);
  await last.finish();
  assert.equal(f.rows().filter(r => r.wake.status === 'held').length, 32); assert.equal(f.rows().at(-1).wake.status, 'not-sent');
  assert.equal(f.writes.length, 0);
  f.close();
  for (let i = 0; i < 3; i++) { f.advance(MIN); await f.retry(); assert.equal(f.writes.length, i + 1, `sent ${i + 1}`); f.reply(); }
  f.advance(MIN); await f.retry();
  const fourth = f.rows()[3];
  assert.equal(fourth.wake.status, 'not-sent', 'three in a row from one sender: the fourth is refused as before'); assert.match(fourth.text, /连续 3 次/);
  assert.equal(f.writes.length, 3);
});

test('the person still ends a held one: pausing handoffs at once, typing into the sender at its next look', async t => {
  const f = await fixture(t); f.open(40);
  const one = await f.turn('one', 'Paused.'); await one.finish();
  f.source.pauseAll('你暂停了后续交接');
  assert.deepEqual([f.rows().at(-1).wake.status, f.rows().at(-1).text], ['cancelled', '真人操作或交接边界已变化；自动消息未投递。\nPaused.']);
  const g = await fixture(t); g.open(40);
  const two = await g.turn('two', 'Typed over.'); await two.finish();
  g.ra.emit('nativeInput', 'The person types into the sender', { id: 'sender-native-input' });
  g.advance(MIN); await g.retry();
  assert.deepEqual([g.rows().at(-1).wake.status, g.rows().at(-1).text], ['cancelled', '存着的自动消息没有补送：补送前核对发送方和授权没通过。\nTyped over.'], 'even with the window still open');
  assert.equal(g.writes.length, 0);
});

test('after the move the same native session gets it on its new backend; another native session there does not', async t => {
  const f = await fixture(t); f.open(40);
  const one = await f.turn('one', 'Across the move.'); await one.finish();
  const row = f.rows().at(-1); assert.equal(row.wake.status, 'held');
  f.move(); f.close(); f.advance(MIN); await f.retry();
  assert.equal(row.wake.status, 'submitted'); assert.equal(row.wake.targetKey, MOVED); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].id, f.b);
  const g = await fixture(t); g.open(40);
  const two = await g.turn('two', 'Someone else now.'); await two.finish();
  g.move(); g.target.get(g.b).nativeId = 'native-someone-else'; g.close(); g.advance(MIN); await g.retry();
  const other = g.rows().at(-1);
  assert.equal(other.wake.status, 'not-sent'); assert.match(other.text, /收件方已不是登记时的那个会话/); assert.equal(g.writes.length, 0);
});

test('the person\'s own words to the recipient are not held by the window', async t => {
  const f = await fixture(t); f.open(40);
  await f.target.send(f.b, 'The person writes.', 'target-owner');
  assert.deepEqual(f.writes.map(w => w.text), ['The person writes.']);
});
