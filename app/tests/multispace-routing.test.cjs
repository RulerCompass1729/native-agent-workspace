const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const { isMember } = require('../collaboration-spaces.cjs');
const { PeerLeases, identity } = require('../peer-handoffs.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-spaces-')), runtimes = [], sent = [];
  const host = { binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); s.nativeId = `native-${s.id}`; r.nativeBlocks = true;
    r.start = async () => r.emit('state', 'idle'); r.interrupt = async () => {};
    r.send = async (text, tag, guard) => { assert.equal(guard(), true); sent.push({ id: s.id, text, tag }); r.emit('submitted', tag); };
    runtimes.push(r); return r;
  } };
  const w = new Workspace(host, dir), a = randomUUID(), b = randomUUID();
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ids = [await w.create('claude', dir, 'owner', 'A'), await w.create('codex', dir, 'owner', 'B')];
  for (const id of ids) for (const room of ['shared', a, b]) w.join(id, true, room);
  const bind = (i, turn = `turn-${i}`) => {
    const tag = sent.findLast(x => x.id === ids[i]).tag;
    runtimes[i].emit('replyBound', { tag, nativeId: w.get(ids[i]).nativeId, turnId: turn, promptId: `prompt-${i}` }); return tag;
  };
  const block = (i, value) => runtimes[i].emit('nativeBlock', { nativeId: w.get(ids[i]).nativeId, turnId: `turn-${i}`, promptId: `prompt-${i}`, ...value });
  return { w, dir, host, runtimes, sent, ids, a, b, bind, block };
}
test('late original native blocks and final receipts stay in the captured space after reading another space', async t => {
  const { w, ids, a, b, bind, block, runtimes, sent } = await fixture(t);
  await w.forward(ids[0], 'Only A material', 'owner', '', a); const tag = bind(0);
  block(0, { id: 'display:answer', kind: 'response', text: 'A streamed', status: 'streaming' });
  const aRow = w.roomFor(a).messages.find(m => m.role === 'assistant');
  assert.ok(aRow); assert.equal(w.room.messages.length, 0); assert.equal(w.roomFor(b).messages.length, 0);
  assert.equal(w.snapshot().rooms.find(r => r.id === b).messages.length, 0);
  w.join(ids[0], false, b); w.join(ids[0], true, b);
  block(0, { id: 'display:answer', kind: 'response', text: 'A after B membership change', status: 'complete' });
  assert.equal(aRow.text, 'A after B membership change', 'A authorization uses its own pair revision');
  runtimes[0].emit('complete', { tag, messageId: aRow.nativeMessageId, text: 'A final' });
  assert.equal(aRow.text, 'A final'); assert.equal(aRow.finalReply, true); assert.equal(aRow.replyTo, tag);
  assert.equal(w.room.messages.length, 0); assert.equal(w.roomFor(b).messages.length, 0); assert.equal(sent.length, 1);
});
test('leave/rejoin cannot revive old A grants and clearing B cannot stop an authorized A stream', async t => {
  const { w, ids, a, b, bind, block } = await fixture(t);
  await w.forward(ids[1], 'A request', 'owner', '', a); const tag = bind(1);
  block(1, { id: 'answer', kind: 'response', text: 'Before clear', status: 'streaming' });
  const row = w.roomFor(a).messages.find(m => m.role === 'assistant');
  w.clearSharedHistory(b); block(1, { id: 'answer', kind: 'response', text: 'After B clear', status: 'streaming' });
  assert.equal(row.text, 'After B clear'); assert.equal(w.sharedReplies.grants.get(tag).closed, false);
  w.join(ids[1], false, a); w.join(ids[1], true, a);
  block(1, { id: 'answer', kind: 'response', text: 'PRIVATE AFTER ABA', status: 'complete' });
  assert.equal(row.text, 'After B clear'); assert.equal(w.sharedReplies.grants.get(tag).closed, true);
  assert.ok(!JSON.stringify([...w.rooms.values()]).includes('PRIVATE AFTER ABA'));
});
test('finite automatic exchange captures the room in both deliveries and never adopts another room membership', async t => {
  const { w, ids, a, b, bind, block, runtimes, sent } = await fixture(t);
  for (const id of ids) w.join(id, false);
  await w.startRun(ids, 'A shared goal', 2, 'replies', {}, undefined, '', a);
  const tag = bind(0); block(0, { id: 'display:a', kind: 'response', text: 'A answer', status: 'complete' });
  const row = w.roomFor(a).messages.find(m => m.role === 'assistant');
  runtimes[0].emit('complete', { tag, messageId: row.nativeMessageId, text: 'A answer', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false });
  await tick();
  assert.equal(sent.length, 2); assert.equal(sent[1].id, ids[1]);
  assert.ok(w.roomFor(a).messages.some(m => m.deliveries?.some(d => d.id === sent[1].tag)));
  assert.equal(w.roomFor(a).run.roomId, a); assert.equal(w.roomFor(b).messages.length, 0); assert.equal(w.room.messages.length, 0);
  assert.ok(ids.every(id => isMember(w.get(id), a) && !isMember(w.get(id), 'shared')));
});
test('cold reopening preserves original IDs, drafts and every room history but restores no grant or pending dispatch', async t => {
  const { w, dir, ids, a, b, bind, block } = await fixture(t);
  w.setDraft(ids[0], 'Unsent human draft', 'owner');
  await w.forward(ids[1], 'A request', 'owner', '', a); bind(1);
  block(1, { id: 'answer', kind: 'response', text: 'A unfinished', status: 'streaming' });
  w.roomFor(b).messages.push({ id: randomUUID(), role: 'system', text: 'B retained', time: 1 }); w.persist();
  const before = fs.readFileSync(path.join(dir, 'room-records.json'), 'utf8');
  const reopened = new Workspace({ binaries: {}, close() {} }, dir);
  t.after(() => reopened.close());
  assert.deepEqual([...reopened.sessions.keys()], ids); assert.equal(reopened.get(ids[0]).nativeId, w.get(ids[0]).nativeId);
  assert.equal(reopened.drafts.get(ids[0]), 'Unsent human draft'); assert.equal(reopened.sharedReplies.grants.size, 0); assert.equal(reopened.versions.dispatches, 0);
  assert.equal(reopened.roomFor(a).messages.find(m => m.text === 'A unfinished').status, 'unconfirmed');
  assert.ok(reopened.roomFor(b).messages.some(m => m.text === 'B retained'));
  assert.equal(fs.readFileSync(path.join(dir, 'room-records.json'), 'utf8'), before, 'Loading never migrates or checkpoints data');
});
test('an additional-room save failure prevents the actual native send and retains its honest unconfirmed source', async t => {
  const { w, ids, a, sent } = await fixture(t);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to.endsWith('room-records.json')) throw Error('Synthetic disk failure'); return rename(from, to); });
  await assert.rejects(w.forward(ids[0], 'Never dispatched', 'owner', '', a), /未能保存/);
  assert.equal(sent.length, 0); assert.match(w.storageWarning, /保存失败/);
  assert.equal(w.roomFor(a).messages[0].status, 'unconfirmed'); assert.equal(w.sharedReplies.grants.values().next().value.closed, true);
});
test('peer lease proofs bind both the selected room and its membership generation', async t => {
  const { w, ids, a, b } = await fixture(t), leases = w.peerLeases = new PeerLeases(w), client = {};
  const spec = { id: randomUUID(), roomId: a, ids, expected: Object.fromEntries(ids.map(id => [id, identity(w.get(id), a)])), deadline: Date.now() + 60000, maxSteps: 2, names: Object.fromEntries(ids.map(id => [id, id])), mode: 'replies' };
  assert.equal(leases.prepare(client, 'owner', spec), true); const grant = leases.leases.get(spec.id);
  w.join(ids[0], false, b); assert.equal(leases.valid(grant), true, 'Changing B must not revoke A routing');
  assert.deepEqual(identity(w.get(ids[0]), a), spec.expected[ids[0]], 'Changing B leaves the A pair proof unchanged');
  leases.pause(client, grant.id, 'Explicit A pause before a fresh authorization');
  const next = { ...spec, id: randomUUID() }; assert.equal(leases.prepare(client, 'owner', next), true);
  const nextGrant = leases.leases.get(next.id); assert.equal(leases.valid(nextGrant), true);
  w.join(ids[0], false, a); w.join(ids[0], true, a); assert.equal(leases.valid(nextGrant), false);
  const wrong = { ...spec, id: randomUUID(), expected: Object.fromEntries(ids.map(id => [id, identity(w.get(id), b)])) };
  assert.throws(() => leases.prepare(client, 'owner', wrong), /身份|控制权/);
  assert.throws(() => leases.prepare(client, 'owner', { ...wrong, id: randomUUID(), roomId: 'shared', expected: Object.fromEntries(ids.map(id => [id, identity(w.get(id), a)])) }), /身份|控制权/, 'A proof cannot authorize the default room');
});
test('modern Claude activity is visible only in the authorized extra space, with no legacy bridge involved', async t => {
  const { w, ids, a, b, runtimes, bind } = await fixture(t);
  await w.forward(ids[0], 'A activity', 'owner', '', a); bind(0);
  runtimes[0].nativeActivity = { nativeId: w.get(ids[0]).nativeId, turnId: 'turn-0', label: 'Synthetic original phase' };
  const session = w.snapshot().sessions.find(s => s.id === ids[0]);
  assert.equal(session.sharedActivity, null); assert.equal(session.sharedActivities[b], null);
  assert.equal(session.sharedActivities[a].label, 'Synthetic original phase');
});
test('missing extension after a partial checkpoint fails closed on cold load without overwriting the original files', async t => {
  const { w, ids, dir, a } = await fixture(t), c = randomUUID(), original = fs.readFileSync(path.join(dir, 'room-records.json'), 'utf8'), rename = fs.renameSync;
  const failure = t.mock.method(fs, 'renameSync', (from, to) => { if (to.endsWith('room-records.json')) throw Error('Synthetic extension failure'); return rename(from, to); });
  assert.throws(() => w.join(ids[0], true, c), /保存失败/); failure.mock.restore();
  const before = fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8');
  const reopened = new Workspace({ binaries: {}, close() {} }, dir); t.after(() => reopened.close());
  assert.match(reopened.storageWarning, /成员与共享记录未能核对/); assert.equal(reopened.rooms.has(c), false); assert.equal(reopened.rooms.has(a), true);
  assert.equal(fs.readFileSync(path.join(dir, 'room-records.json'), 'utf8'), original); assert.equal(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8'), before);
  assert.throws(() => reopened.clearSharedHistory(a)); assert.throws(() => reopened.join(ids[1], true, c));
});
test('clear refuses a preexisting save failure and reports a new failure instead of acknowledging an unpersisted erase', async t => {
  const { w, dir, a } = await fixture(t); w.roomFor(a).messages.push({ id: 'keep', role: 'human', text: 'Original retained' }); w.persist();
  w.storageWarning = 'Synthetic existing save failure'; assert.throws(() => w.clearSharedHistory(a), /existing save failure/); assert.equal(w.roomFor(a).messages.length, 1);
  w.storageWarning = null; const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to.endsWith('room-records.json')) throw Error('Synthetic disk failure'); return rename(from, to); });
  assert.throws(() => w.clearSharedHistory(a), /保存失败/); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'room-records.json'), 'utf8')).rooms.find(r => r.id === a).messages.length, 1);
  assert.equal(w.roomFor(a).messages[0].text, 'Original retained', 'A later retry must not make an acknowledged failure erase the restored history');
});
for (const kind of ['queue', 'steer']) test(`shared ${kind} to a different physical member in B preserves A running`, async t => {
  const { w, ids, a, b } = await fixture(t), provider = kind === 'queue' ? 'claude' : 'codex';
  const third = await w.create(provider, w.dataDir, 'owner', 'Independent B member'); w.join(third, true, b);
  const r = w.runtime(third); r.emit('state', 'working'); r.queueAvailable = true; r.steerAvailable = true; r.turnId = 'working-B'; r.finishTurn = () => {};
  let inputs = 0; r[kind] = async (...args) => { const guard = args[kind === 'queue' ? 2 : 3]; assert.equal(guard(), true); inputs++; };
  await w.startRun(ids, 'Keep A running', 2, 'replies', {}, undefined, '', a);
  const run = w.roomFor(a).run;
  if (kind === 'queue') await w.queue(third, 'B queued text', 'owner', { roomId: b });
  else await w.steer(third, 'B steer text', 'owner', 'working-B', { roomId: b });
  assert.equal(inputs, 1); assert.equal(run.status, 'running'); assert.equal(w.roomFor(a).run, run); assert.equal(run.awaiting.sessionId, ids[0]);
});
test('clear prunes orphaned forwarding metadata only for the selected space', async t => {
  const { w, a, b } = await fixture(t);
  w.forwards.set('a-orphan', { roomId: a }); w.forwards.set('b-orphan', { roomId: b }); w.forwards.set('legacy-orphan', {});
  w.clearSharedHistory(a); assert.deepEqual([...w.forwards.keys()], ['b-orphan', 'legacy-orphan']);
  w.clearSharedHistory(); assert.deepEqual([...w.forwards.keys()], ['b-orphan']);
});
