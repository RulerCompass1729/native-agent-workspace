// The person, 2026-11-23: 「保证不会让项目经理被其他空间的任务干扰」. A message from a session in another space does not
// reach a space's project manager: refused when it is registered, and again just before delivery.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { PeerRunner } = require('../peer-handoffs.cjs');
const { SpaceManagers } = require('../space-managers.cjs');
const wake = require('../session-wake.cjs');
const locale = require('../ui-locale.js');

const ONE = '11111111-1111-1111-1111-111111111111', TWO = '22222222-2222-2222-2222-222222222222';

// Two backends, so the manager's is another one than the sender's.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-wake-manager-')), key = 'backends/aaaaaaaaaaaaaaaaaaaa';
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
  const a = await source.create('codex', root, 'source-owner', 'Sender'), b = await target.create('codex', root, 'target-owner', 'Manager');
  const [ra] = runtimes;
  ra.turnId = 'turn-one';
  ra.emit('nativeTurnStart', { nativeId: source.get(a).nativeId, turnId: 'turn-one' });
  ra.emit('state', 'working');
  const put = (w, id, ...rooms) => Object.assign(w.get(id), { roomIds: rooms, roomId: null });
  const call = message => ra.addressedCall({ nativeId: source.get(a).nativeId, turnId: ra.turnId, callId: 'call-' + message.length }, { recipient_id: b, message });
  const finish = async () => {
    ra.turnId = null;
    ra.emit('state', 'idle');
    ra.emit('nativeTurnEnd', { nativeId: source.get(a).nativeId, turnId: 'turn-one', status: 'completed' });
    for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve));
  };
  const managers = new SpaceManagers(root);
  const designate = (roomId = TWO) => managers.set(roomId, { sessionId: b, nativeId: target.get(b).nativeId });
  return { root, source, target, a, b, writes, managers, designate, call, finish,
    sender: (...rooms) => put(source, a, ...rooms), manager: (...rooms) => put(target, b, ...rooms), row: () => source.get(a).messages.find(m => m.wake) };
}

test("a message from another space to a project manager is refused in the calling turn, with the reason", async t => {
  const f = await fixture(t);
  f.sender(ONE);
  f.manager(TWO);
  f.designate();
  const result = await f.call('Work from another space.');
  assert.equal(result.status, 'not-sent');
  assert.match(result.message, /别的空间/u);
  assert.equal(f.row().wake.status, 'not-sent');
  assert.equal(f.row().wake.body, 'Work from another space.', 'the sender keeps its text');
  assert.equal(locale.displayText('en', f.row().text, f.row().uiMessage).split('\n')[1], locale.format('en', 'error.wake.managerSpace', { name: 'Manager' }));
  await f.finish();
  assert.deepEqual(f.writes, []);
});

test('a session in its space, and one in no space, reach it', async t => {
  for (const rooms of [[TWO], [ONE, TWO], []]) {
    const f = await fixture(t);
    f.sender(...rooms);
    f.manager(TWO);
    f.designate();
    assert.equal((await f.call('For this space.')).status, 'staged', rooms.join());
    await f.finish();
    assert.equal(f.writes.length, 1, rooms.join());
    assert.equal(f.row().wake.status, 'submitted');
  }
});

test('a member that manages nothing, and one designated for a space it left, take messages from other spaces as before', async t => {
  for (const set of [f => { f.manager(TWO); }, f => { f.manager(ONE.replace('1', '3')); f.designate(); }, f => { f.manager(); f.designate(); }]) {
    const f = await fixture(t);
    f.sender(ONE);
    set(f);
    assert.equal((await f.call('Ordinary.')).status, 'staged');
    await f.finish();
    assert.equal(f.writes.length, 1);
  }
});

test('made the manager after the message was registered: it is not delivered', async t => {
  const f = await fixture(t);
  f.sender(ONE);
  f.manager(TWO);
  assert.equal((await f.call('Registered before.')).status, 'staged');
  f.designate();
  await f.finish();
  assert.deepEqual(f.writes, []);
  assert.equal(f.row().wake.status, 'not-sent');
  assert.equal(f.row().uiMessage && locale.displayText('zh', f.row().text, f.row().uiMessage).split('\n')[1], locale.format('zh', 'error.wake.managerSpace', { name: 'Manager' }));
});

test('a record that cannot be read refuses a message across spaces and no other', async t => {
  for (const [rooms, status] of [[[ONE], 'not-sent'], [[TWO], 'staged'], [[], 'staged']]) {
    const f = await fixture(t);
    f.sender(...rooms);
    f.manager(TWO);
    fs.writeFileSync(path.join(f.root, 'space-managers.json'), '{broken', { mode: 0o600 });
    assert.equal((await f.call('Unreadable.')).status, status, rooms.join());
    await f.finish();
    assert.equal(f.writes.length, status === 'staged' ? 1 : 0, rooms.join());
  }
});
