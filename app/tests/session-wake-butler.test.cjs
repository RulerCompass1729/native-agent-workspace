// R253 (the person, 2026-11-25: 「说明你和大管家之间的交流不畅」). A space's manager wrote the butler's eight-character
// id from the board twice and got 「没有找到准确的原会话 ID」; its retry with another id in the same turn was refused,
// the turn's one message already taken by a call that had registered nothing. `butler` now names the butler the person
// designated, and a call that registered nothing takes no sender's turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { PeerRunner } = require('../peer-handoffs.cjs');
const wake = require('../session-wake.cjs');
const locale = require('../ui-locale.js');

const ONE = '11111111-1111-1111-1111-111111111111';

// Two backends: the sender's, and the butler's.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-butler-')), key = 'backends/aaaaaaaaaaaaaaaaaaaa';
  const dirs = [root, path.join(root, key)];
  fs.mkdirSync(dirs[1], { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(dirs[1]), 0o700);
  fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', key] }), { mode: 0o600 });
  const runtimes = [], writes = [];
  const workspaces = dirs.map(dir => new Workspace({ binaries: {}, close() {}, create(s) {
    const r = new EventEmitter();
    r.record = s;
    s.nativeId = 'native-' + s.id;
    r.host = { rpc: { call: async () => ({ goal: null }) } };
    r.chatAvailable = r.addressedSendAvailable = true;
    r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag, guard) => {
      assert.equal(guard(), true);
      writes.push(text);
      r.emit('submitted', tag);
    };
    runtimes.push(r);
    return r;
  } }, dir));
  const connect = async dir => {
    const w = workspaces[dirs.indexOf(dir)];
    return { close() {}, async call(method, spec) {
      if (method === 'initial') return { ...w.snapshot(), capabilities: ['agentWakeV1', 'agentWakePreflightV1'] };
      return { wakeCheck: wake.check, wakeTake: wake.take, wakeReceive: wake.receive }[method](w, spec);
    } };
  };
  workspaces.forEach((w, index) => { w.peerRunner = new PeerRunner(w, dirs[index], connect); });
  t.after(() => { workspaces.forEach(w => w.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const [source, target] = workspaces;
  const a = await source.create('codex', root, 'source-owner', 'Manager'), b = await target.create('codex', root, 'target-owner', 'Butler');
  Object.assign(source.get(a), { roomIds: [ONE], roomId: null });
  Object.assign(target.get(b), { roomIds: [], roomId: null });
  const [ra] = runtimes;
  ra.turnId = 'turn-one';
  ra.emit('nativeTurnStart', { nativeId: source.get(a).nativeId, turnId: 'turn-one' });
  ra.emit('state', 'working');
  let calls = 0;
  // Async: a refusal thrown at once and one after the lookup both come back as a rejection.
  const call = async (recipient, message) => ra.addressedCall({ nativeId: source.get(a).nativeId, turnId: ra.turnId, callId: `call-${++calls}` }, { recipient_id: recipient, message });
  const finish = async () => {
    ra.turnId = null;
    ra.emit('state', 'idle');
    ra.emit('nativeTurnEnd', { nativeId: source.get(a).nativeId, turnId: 'turn-one', status: 'completed' });
    for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
  };
  const designate = () => fs.writeFileSync(path.join(root, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: b, nativeId: target.get(b).nativeId } }), { mode: 0o600 });
  return { root, source, target, a, b, writes, call, finish, designate, rows: () => source.get(a).messages.filter(m => m.wake) };
}
const keyOf = error => error?.uiMessage?.key;

test('a member in a space addresses the designated butler as `butler`, without its id', async t => {
  const f = await fixture(t);
  f.designate();
  const result = await f.call('butler', 'Please ask the person for two sessions.');
  assert.equal(result.status, 'staged');
  assert.equal(f.rows()[0].wake.recipientId, f.b, 'registered for the butler\'s exact session');
  assert.match(f.rows()[0].text, /发给 Butler 的消息已登记/u);
  await f.finish();
  assert.deepEqual(f.writes.filter(text => text.includes('Please ask the person')).length, 1, 'delivered once, into the butler\'s session');
});

test('with no butler designated, `butler` is refused with that reason and names nobody else', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call('butler', 'Anyone there?'), error => keyOf(error) === 'error.wake.noButler');
  assert.equal(locale.format('zh', 'error.wake.noButler').includes('大管家'), true);
  assert.ok(locale.format('en', 'error.wake.noButler'));
  assert.deepEqual(f.rows(), []);
  await f.finish();
  assert.deepEqual(f.writes, []);
});

test('an ordinary sender\'s call that registered nothing leaves the turn its one message; a registered one still takes it', async t => {
  const f = await fixture(t);
  await assert.rejects(f.call(f.b.slice(0, 8), 'First try, short id.'), error => keyOf(error) === 'error.peer.exactSessionMissing');
  const second = await f.call(f.b, 'Second try, exact id.');
  assert.equal(second.status, 'staged', 'the retry with the exact id goes');
  await assert.rejects(f.call(f.b, 'A third one.'), error => ['error.wake.turnAlreadyRequested', 'error.wake.turnAlreadyRegistered'].includes(keyOf(error)), 'still one message a turn');
  await f.finish();
  assert.equal(f.writes.filter(text => text.includes('Second try')).length, 1);
  assert.equal(f.writes.some(text => text.includes('A third one')), false);
});

// Review of 8f89855a: a call its own plugin refused (no root turn of its own) kept `butler` as written, and the butler
// hears only of refusals addressed to its own session (butler-ingress.cjs observeWakeUndelivered).
test('a refused call addressed to `butler` before NAW saw it reaches the designated butler\'s record', async t => {
  const { ButlerLedger } = require('../butler-ledger.cjs'), { ButlerIngress } = require('../butler-ingress.cjs'), { RoomState } = require('../room-state.cjs');
  const f = await fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-butler-ingress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Before the refusals: it tells of those since it started.
  const ledger = new ButlerLedger(dir), ingress = new ButlerIngress(dir, { roomState: new RoomState(dir), ledger });
  const record = f.source.get(f.a), runtime = f.source.runtimes.get(f.a);
  assert.equal(wake.unbound(f.source, record, runtime, 'butler'), true);
  f.designate();
  assert.equal(wake.unbound(f.source, record, runtime, 'butler'), true);
  const kept = f.source.snapshot().sessions.find(s => s.id === f.a);
  assert.deepEqual(kept.wakeUndelivered.map(e => [e.recipientId, e.sourceIssue]), [['butler', 'root-turn-unbound'], [f.b, 'root-turn-unbound']],
    'with no butler, as written; with one, its session');
  ingress.observeWakeUndelivered([kept], { steward: () => ({ sessionId: f.b, nativeId: f.target.get(f.b).nativeId }) });
  const events = ledger.snapshot().events.filter(e => e.eventId.startsWith('wake-undelivered:'));
  assert.deepEqual(events.map(e => e.payload.outcome), ['not-sent:root-turn-unbound'], 'the butler is told once');
});
