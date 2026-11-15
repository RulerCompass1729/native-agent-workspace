const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { RoomState } = require('../room-state.cjs');
test('queue events keep exact item IDs through repeated task text and restart', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-stream-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir);
  const a = room.queueAdd('Same task', null), b = room.queueAdd('Same task', null);
  room.queueMarkSent('shared', a, 'agent-a', 'Agent A', Date.now());
  room.queueSettle('shared', a, 'waiting', '', 'Agent A', 'Needs your decision: choose one');
  room.queueCancel(b);
  const events = new RoomState(dir).value.events.filter(e => !e.monitor);
  assert.deepEqual(events.map(e => e.itemId), [a, b, a, a, b]);
});
test('delivery facts identify their item, while whole-queue facts have no invented item', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-stream-ready-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir), id = room.queueAdd('A delivery', null);
  room.queueMarkSent('shared', id, 'agent-a', 'Agent A', Date.now());
  room.queueSettle('shared', id, 'done', '', 'Agent A', 'Done', undefined, { branch: 'lane/example', commit: 'abc1234' });
  assert.equal(room.value.events.find(e => e.monitor?.kind === 'ready').itemId, id);
  assert.equal(room.value.events.find(e => e.monitor?.kind === 'queue-dry').itemId, undefined);
});
