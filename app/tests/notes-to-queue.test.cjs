'use strict';
// R121 (a), the person 11-23: only the person, in the app, turns 「派活时附上这份笔记」 on or off, and while it is on
// only the person changes the notes, so what goes out with queued work is what the person sees in the dialog.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { RoomState } = require('../room-state.cjs');
const { uiError } = require('../ui-errors.cjs');
const locale = require('../ui-locale.js');

const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const key = expected => error => error.uiMessage?.key === expected;

function roomSetup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-notes-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = new RoomState(dir);
  const revision = () => room.metadata('shared').revision;
  return { dir, room, revision };
}

test('only the person turns the switch on or off; it is off by default and kept per space', t => {
  const { dir, room, revision } = roomSetup(t);
  assert.equal(room.apply({ sessions: [], rooms: [] }).rooms.find(r => r.id === 'shared').notesToQueue, false);
  room.notes('Goal', revision());
  assert.throws(() => room.notes('Goal', revision(), 'shared', { attach: true }), key('error.room.notesAttachPersonOnly'));
  assert.throws(() => room.notes('Goal', revision(), 'shared', { person: false, attach: true }), key('error.room.notesAttachPersonOnly'));
  room.notes('Goal', revision(), 'shared', { person: true, attach: true });
  assert.equal(room.metadata('shared').notesToQueue, true);
  assert.throws(() => room.notes('Goal', revision(), 'shared', { attach: false }), key('error.room.notesAttachPersonOnly'), 'turning it off is the person\'s too');
  room.notes('Goal', revision(), 'shared', { attach: true });
  const other = room.create('Other');
  assert.notEqual(room.metadata(other).notesToQueue, true, 'another space keeps its own switch');
  assert.equal(new RoomState(dir).metadata('shared').notesToQueue, true, 'saved with the space');
  assert.throws(() => room.notes('Goal', revision(), 'shared', { person: true, attach: 'yes' }), key('error.invalidSpaceAction'));
  room.notes('Goal', revision(), 'shared', { person: true, attach: false });
  assert.notEqual(room.metadata('shared').notesToQueue, true);
});

test('while the switch is on an agent cannot change the notes; while it is off it still can', t => {
  const { room, revision } = roomSetup(t);
  room.notes('Agent draft', revision());
  assert.equal(room.metadata('shared').notes, 'Agent draft');
  room.notes('Person text', revision(), 'shared', { person: true, attach: true });
  assert.throws(() => room.notes('Agent edit', revision()), key('error.room.notesPersonOnly'));
  assert.throws(() => room.notes('', revision(), 'shared', { person: false }), key('error.room.notesPersonOnly'));
  room.notes('Person text', revision());
  assert.equal(room.metadata('shared').notes, 'Person text', 'an agent that saves the same text changes nothing');
  room.notes('Person edit', revision(), 'shared', { person: true });
  assert.equal(room.metadata('shared').notes, 'Person edit');
});

test('the projection gives the dispatcher the switch and the turn-on revision; a requeue forgets the notes it carried', t => {
  const { room, revision } = roomSetup(t);
  room.notes('Goal', revision(), 'shared', { person: true, attach: true });
  const on = revision();
  const projected = room.apply({ sessions: [], rooms: [] }).rooms.find(r => r.id === 'shared');
  assert.deepEqual([projected.notes, projected.notesToQueue, projected.notesToQueueSince], ['Goal', true, on]);
  const id = room.queueAdd('task', null);
  room.queueMarkSent('shared', id, 'a', 'Agent a', Date.now(), false, 'native-a', 'marker-1');
  assert.equal(room.value.queue.find(i => i.id === id).notesSent, 'marker-1');
  room.queueRequeue('shared', id, 'not-sent', 3, 'Agent a');
  assert.equal(Object.hasOwn(room.value.queue.find(i => i.id === id), 'notesSent'), false);
  room.queueMarkSent('shared', id, 'a', 'Agent a', Date.now(), false, 'native-a');
  assert.equal(Object.hasOwn(room.value.queue.find(i => i.id === id), 'notesSent'), false);
});

// The real main.cjs callers: spaceAction notes (the dialog and workspace_control) and the older roomNotes command.
function spaceAction(room) {
  const start = source.indexOf("  register('spaceAction', async (c, roomId, action, args = []) => {");
  const end = source.indexOf("  register('spaceFiles',", start);
  assert.ok(start > 0 && end > start);
  let handler;
  const context = vm.createContext({
    require: require('node:module').createRequire(path.join(__dirname, '../main.cjs')),
    register(_name, fn) { handler = fn; },
    validRoomId: () => true, uiError, roomState: room, broadcastRoom: async () => {},
    isCurrentHumanContext: c => Boolean(c && !c.background && c.human === true),
  });
  vm.runInContext(source.slice(start, end), context);
  return handler;
}
function roomNotes(room) {
  const line = source.split('\n').find(l => l.startsWith("  register('roomNotes',"));
  assert.ok(line);
  let handler;
  vm.runInNewContext(line, { register(_name, fn) { handler = fn; }, roomState: room, broadcastRoom: async () => {},
    isCurrentHumanContext: c => Boolean(c && !c.background && c.human === true) });
  return handler;
}

test('through main.cjs an agent cannot flip the switch or edit switched-on notes; the person\'s window can', async t => {
  const { room, revision } = roomSetup(t);
  const action = spaceAction(room), legacy = roomNotes(room);
  const agent = { background: true }, person = { human: true };
  await assert.rejects(action(agent, 'shared', 'notes', ['Goal', revision(), true]), key('error.room.notesAttachPersonOnly'));
  await assert.rejects(action({}, 'shared', 'notes', ['Goal', revision(), true]), key('error.room.notesAttachPersonOnly'), 'a window that is not the person\'s current one');
  await action(person, 'shared', 'notes', ['Goal', revision(), true]);
  assert.equal(room.metadata('shared').notesToQueue, true);
  await assert.rejects(action(agent, 'shared', 'notes', ['Changed by agent', revision()]), key('error.room.notesPersonOnly'));
  await assert.rejects(action(agent, 'shared', 'notes', ['Goal', revision(), false]), key('error.room.notesAttachPersonOnly'));
  await assert.rejects(legacy(agent, 'Changed by agent', revision()), key('error.room.notesPersonOnly'));
  assert.equal(room.metadata('shared').notes, 'Goal');
  await action(person, 'shared', 'notes', ['Goal, edited by the person', revision(), true]);
  assert.equal(room.metadata('shared').notes, 'Goal, edited by the person');
  await action(person, 'shared', 'notes', ['Goal, edited by the person', revision(), false]);
  await legacy(agent, 'Agent edit while off', revision());
  assert.equal(room.metadata('shared').notes, 'Agent edit while off');
});

test('the dialog wording names the switch and its consequence in both languages (review W1, W2)', () => {
  const zh = k => locale.format('zh', k), en = k => locale.format('en', k);
  assert.equal(zh('notes.attach'), '派活时附上这份笔记');
  assert.equal(en('notes.attach'), 'Attach these notes to queued work');
  assert.match(zh('notes.attachOn'), /笔记改过后，下一件活再附一次/);
  assert.match(en('notes.attachOn'), /and again with the next item after the notes change/);
  assert.match(zh('notes.help'), /打开下面这一项后，派活时也会附上/);
  assert.match(en('notes.help'), /with the option below turned on, they are also attached to queued work/);
  for (const k of ['error.room.notesPersonOnly', 'error.room.notesAttachPersonOnly']) {
    assert.notEqual(zh(k), k); assert.notEqual(en(k), k); assert.notEqual(zh(k), en(k));
  }
});
