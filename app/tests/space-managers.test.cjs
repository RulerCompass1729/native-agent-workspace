const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SpaceManagers, visibleTo, refusedSpace } = require('../space-managers.cjs');
const { DEFAULT_ROOM_ID } = require('../collaboration-spaces.cjs');

const ROOM_A = '11111111-1111-4111-8111-111111111111';
const ROOM_B = '22222222-2222-4222-8222-222222222222';
const manager = { sessionId: 'manager', nativeId: 'native-manager' };
const next = { sessionId: 'next', nativeId: 'native-next' };
const session = (id, rooms, changes = {}) => ({
  id, nativeId: `native-${id}`, name: `Session ${id}`, state: 'idle', roomIds: rooms, roomId: rooms.includes(DEFAULT_ROOM_ID) ? DEFAULT_ROOM_ID : null, ...changes,
});
const done = (from, to, event = 'done') => ({ time: 100, event, spaces: [ROOM_A], old: { id: from.sessionId, nativeId: from.nativeId }, new: { id: to.sessionId, nativeId: to.nativeId } });
const key = expected => error => error.uiMessage?.key === expected;

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-space-managers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const role = new SpaceManagers(dir);
  const log = entries => fs.writeFileSync(role.logFile, entries.map(value => `${JSON.stringify(value)}\n`).join(''), { mode: 0o600 });
  return { dir, role, log };
}

test('each space has at most one manager, kept after reopen; clearing one leaves the others', t => {
  const { dir, role } = setup(t);
  assert.equal(role.current(ROOM_A), null);
  role.set(ROOM_A, manager);
  role.set(ROOM_B, next);
  const reopened = new SpaceManagers(dir);
  assert.deepEqual(reopened.current(ROOM_A), manager);
  assert.deepEqual(reopened.current(ROOM_B), next);
  assert.equal(fs.statSync(role.file).mode & 0o777, 0o600);
  reopened.set(ROOM_A, null);
  assert.equal(new SpaceManagers(dir).current(ROOM_A), null);
  assert.deepEqual(new SpaceManagers(dir).current(ROOM_B), next);
  assert.throws(() => role.set(ROOM_A, { ...manager, extra: true }), /Invalid/);
  assert.throws(() => role.set('not-a-room', manager), /Invalid/);
});

test('one session manages one space: choosing it for another ends the former, also when the record still names its predecessor', t => {
  const { role, log } = setup(t);
  role.set(ROOM_A, manager);
  role.set(ROOM_B, manager);
  assert.equal(role.current(ROOM_A), null);
  assert.deepEqual(role.current(ROOM_B), manager);
  log([done(manager, next)]);
  role.set(ROOM_A, next);
  assert.equal(role.current(ROOM_B), null);
  assert.deepEqual(role.current(ROOM_A), next);
});

test('the role follows a finished rotation and stays put on a branch, per space', t => {
  const { role, log } = setup(t);
  role.set(ROOM_A, manager);
  log([done(manager, next, 'kept')]);
  assert.deepEqual(role.current(ROOM_A), manager);
  log([done(manager, next)]);
  assert.deepEqual(role.current(ROOM_A), next);
  log([done(manager, next), done(manager, { sessionId: 'other', nativeId: 'native-other' })]);
  assert.deepEqual(role.current(ROOM_A), manager);
});

test('the seat a finished rotation hands over is the one the successor adds with; a kept or branched one adds nothing (R220.2)', t => {
  const other = { sessionId: 'other', nativeId: 'native-other' };
  const records = [session('manager', [ROOM_A]), session('next', [ROOM_A]), session('other', [ROOM_A])];
  const adds = (role, actor) => role.creator({ id: actor.sessionId, nativeId: actor.nativeId }, ROOM_A, null, records, new Map());
  const kept = setup(t);
  kept.role.set(ROOM_A, manager); kept.log([done(manager, next, 'kept')]);
  assert.equal(adds(kept.role, manager).sessionId, 'manager', 'a kept replacement leaves the seat where it was');
  assert.throws(() => adds(kept.role, next), key('error.queue.managerOnly'), 'a kept successor does not add');
  const finished = setup(t);
  finished.role.set(ROOM_A, manager); finished.log([done(manager, next)]);
  assert.equal(adds(finished.role, next).sessionId, 'next', 'a finished rotation hands the seat to the successor that joined the space');
  assert.throws(() => adds(finished.role, manager), key('error.queue.managerOnly'), 'the session that went away adds nothing');
  const branch = setup(t);
  branch.role.set(ROOM_A, manager); branch.log([done(manager, next), done(manager, other)]);
  assert.throws(() => adds(branch.role, next), key('error.queue.managerOnly'), 'neither side of a branch adds');
  assert.throws(() => adds(branch.role, other), key('error.queue.managerOnly'), 'neither side of a branch adds');
});

test('the role counts only while the very native session is a member of its space', t => {
  const { role } = setup(t);
  role.set(ROOM_A, manager);
  assert.equal(role.roomOf(session('manager', [ROOM_A])), ROOM_A);
  assert.equal(role.roomOf(session('manager', [ROOM_A, ROOM_B])), ROOM_A);
  assert.equal(role.roomOf(session('manager', [ROOM_B])), null);
  assert.equal(role.roomOf(session('manager', [ROOM_A], { nativeId: 'another' })), null);
  assert.equal(role.roomOf(session('someone', [ROOM_A])), null);
  assert.equal(role.roomOf(null), null);
});

test('two spaces whose records arrived at the same successor give it no role', t => {
  const { role, log } = setup(t);
  const other = { sessionId: 'other', nativeId: 'native-other' };
  role.set(ROOM_A, manager);
  role.set(ROOM_B, other);
  log([done(manager, next)]);
  fs.writeFileSync(role.file, JSON.stringify({ version: 1, managers: { [ROOM_A]: manager, [ROOM_B]: next }, secretaryRetired: { roomId: null } }), { mode: 0o600 });
  const reopened = new SpaceManagers(path.dirname(role.file));
  assert.equal(reopened.roomOf(session('next', [ROOM_A, ROOM_B])), null);
});

test('a manager adds only to its own space, never to itself, under its trusted label', t => {
  const { role } = setup(t);
  role.set(ROOM_A, manager);
  const records = [session('manager', [ROOM_A, ROOM_B]), session('worker', [ROOM_A])];
  const actor = { id: 'manager', nativeId: 'native-manager', name: 'forged' };
  const labels = new Map([['manager', 'Space lead']]);
  assert.deepEqual(role.creator(actor, ROOM_A, 'worker', records, labels), { kind: 'secretary', name: 'Space lead', sessionId: 'manager' });
  assert.deepEqual(role.creator(actor, ROOM_A, null, records, new Map()), { kind: 'secretary', name: 'Session manager', sessionId: 'manager' });
  assert.throws(() => role.creator(actor, ROOM_A, 'manager', records, labels), key('error.queue.managerSelf'));
  assert.throws(() => role.creator(actor, ROOM_B, null, records, labels), key('error.queue.managerOnly'));
  assert.throws(() => role.creator({ id: 'worker', nativeId: 'native-worker' }, ROOM_A, null, records, labels), key('error.queue.managerOnly'));
  assert.throws(() => role.creator({ ...actor, nativeId: 'other' }, ROOM_A, null, records, labels), key('error.queue.managerOnly'));
  assert.throws(() => role.creator(null, ROOM_A, null, records, labels), key('error.queue.managerOnly'));
  for (const changes of [{ archived: true }, { nativeContextPending: true }, { state: 'ended' }, { state: 'background' }]) {
    assert.throws(() => role.creator(actor, ROOM_A, null, [session('manager', [ROOM_A], changes)], labels), key('error.queue.managerOnly'));
  }
});

test('an unreadable record or log is an error, never nobody; choosing again keeps the damaged file aside', t => {
  const { dir, role } = setup(t);
  role.set(ROOM_A, manager);
  fs.writeFileSync(role.logFile, '{broken\n', { mode: 0o600 });
  assert.throws(() => role.current(ROOM_A), key('error.manager.state'));
  assert.throws(() => role.roomOf(session('manager', [ROOM_A])), key('error.manager.state'));
  fs.rmSync(role.logFile);
  fs.writeFileSync(role.file, '{broken', { mode: 0o600 });
  const reopened = new SpaceManagers(dir);
  assert.throws(() => reopened.current(ROOM_A), key('error.manager.state'));
  assert.throws(() => reopened.retireSecretary(manager, [session('manager', [ROOM_A])], [{ id: ROOM_A }]), key('error.manager.state'));
  assert.throws(() => reopened.set(ROOM_B, next), key('error.manager.state'));
  assert.throws(() => reopened.set(ROOM_B, null), key('error.manager.state'));
  assert.equal(fs.readFileSync(role.file, 'utf8'), '{broken', 'nothing is written without the person starting over');
  fs.chmodSync(dir, 0o500);
  assert.throws(() => reopened.set(ROOM_B, next, { reset: true }), key('error.manager.save'));
  fs.chmodSync(dir, 0o700);
  assert.equal(reopened.failed, true);
  reopened.set(ROOM_B, next, { reset: true });
  assert.deepEqual(reopened.current(ROOM_B), next);
  assert.deepEqual(new SpaceManagers(dir).current(ROOM_B), next);
  assert.deepEqual(new SpaceManagers(dir).secretaryRetired, { roomId: null });
  const aside = fs.readdirSync(dir).filter(name => name.startsWith('space-managers.json.damaged-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{broken');
});

test('starting over never leaves the place of the record empty; one that cannot be saved leaves it as it was', t => {
  const { dir, role } = setup(t);
  fs.writeFileSync(role.file, '{broken', { mode: 0o600 });
  const reopened = new SpaceManagers(dir);
  reopened.save = () => {
    assert.equal(fs.readFileSync(role.file, 'utf8'), '{broken');
    throw Error('full');
  };
  assert.throws(() => reopened.set(ROOM_A, manager, { reset: true }), /full/);
  assert.equal(fs.readFileSync(role.file, 'utf8'), '{broken');
  assert.deepEqual(fs.readdirSync(dir), ['space-managers.json']);
});

test('a record that can be read again is, without starting over', t => {
  const { dir, role } = setup(t);
  role.set(ROOM_A, manager);
  fs.chmodSync(role.file, 0o000);
  const reopened = new SpaceManagers(dir);
  assert.equal(reopened.failed, true);
  fs.chmodSync(role.file, 0o600);
  reopened.read();
  assert.equal(reopened.failed, false);
  assert.deepEqual(reopened.current(ROOM_A), manager);
});

test('a change that cannot be saved leaves the managers as they were, in memory and on disk', t => {
  const { dir, role } = setup(t);
  role.set(ROOM_A, manager);
  fs.chmodSync(dir, 0o500);
  assert.throws(() => role.set(ROOM_A, next), key('error.manager.save'));
  assert.throws(() => role.set(ROOM_A, null), key('error.manager.save'));
  fs.chmodSync(dir, 0o700);
  assert.deepEqual(role.current(ROOM_A), manager);
  assert.deepEqual(new SpaceManagers(dir).current(ROOM_A), manager);
  role.set(ROOM_B, next);
  assert.deepEqual(role.current(ROOM_A), manager);
  assert.deepEqual(role.current(ROOM_B), next);
});

test('a saved change counts though the directory cannot be synced', t => {
  const { dir, role } = setup(t);
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...rest) => {
    if (file === dir) {
      throw Error('no directory descriptor');
    }
    return open(file, ...rest);
  });
  role.set(ROOM_A, manager);
  assert.deepEqual(role.current(ROOM_A), manager);
  assert.deepEqual(new SpaceManagers(dir).current(ROOM_A), manager);
});

test('links and records open to others are refused', t => {
  const { dir, role } = setup(t);
  role.set(ROOM_A, manager);
  fs.chmodSync(role.file, 0o644);
  assert.throws(() => new SpaceManagers(dir).current(ROOM_A), key('error.manager.state'));
  fs.rmSync(role.file);
  fs.writeFileSync(path.join(dir, 'real.json'), '{}', { mode: 0o600 });
  fs.symlinkSync(path.join(dir, 'real.json'), role.file);
  assert.throws(() => new SpaceManagers(dir).current(ROOM_A), key('error.manager.state'));
});

test('the former secretary takes over its one live space; in none or in several it is only retired, once', t => {
  const rooms = [{ id: ROOM_A, archived: false }, { id: ROOM_B, archived: false }];
  const cases = [
    { sessions: [session('manager', [ROOM_A])], rooms, roomId: ROOM_A },
    { sessions: [session('manager', [])], rooms, roomId: null },
    { sessions: [session('manager', [ROOM_A, ROOM_B])], rooms, roomId: null },
    { sessions: [session('manager', [ROOM_A, ROOM_B])], rooms: [{ id: ROOM_A, archived: false }, { id: ROOM_B, archived: true }], roomId: ROOM_A },
    { sessions: [session('manager', [ROOM_A], { archived: true })], rooms, roomId: null },
    { sessions: [session('manager', [ROOM_A], { archived: true, state: 'ended' })], rooms, roomId: null },
    { sessions: [session('manager', [ROOM_A], { nativeId: 'another' })], rooms, roomId: null },
  ];
  for (const { sessions, rooms: list, roomId } of cases) {
    const { dir, role } = setup(t);
    const result = role.retireSecretary(manager, sessions, list);
    assert.equal(result.status, 'retired');
    assert.equal(result.roomId, roomId);
    assert.deepEqual(new SpaceManagers(dir).current(ROOM_A), roomId ? manager : null);
    assert.deepEqual(new SpaceManagers(dir).secretaryRetired, { roomId });
    assert.deepEqual(new SpaceManagers(dir).retireSecretary(manager, [session('manager', [ROOM_A])], rooms), { status: 'done' });
  }
});

test('the former secretary is decided only once it and each of its spaces can be told', t => {
  const rooms = [{ id: ROOM_A, archived: false }, { id: ROOM_B, archived: false }];
  const waiting = [
    [[session('manager', [ROOM_A], { nativeContextPending: true })], rooms],
    [[session('manager', [ROOM_A], { state: 'ended' })], rooms],
    [[session('manager', [ROOM_A], { state: 'background' })], rooms],
    [[session('manager', [ROOM_A])], [rooms[1]]],
    [[session('manager', [ROOM_A, ROOM_B])], [rooms[0], { ...rooms[1], unavailable: true }]],
  ];
  for (const [sessions, list] of waiting) {
    const { dir, role } = setup(t);
    assert.deepEqual(role.retireSecretary(manager, sessions, list), { status: 'waiting' });
    assert.equal(role.secretaryRetired, null);
    assert.equal(fs.existsSync(role.file), false);
    assert.equal(role.retireSecretary(manager, [session('manager', [ROOM_A])], rooms).roomId, ROOM_A, 'decided once it can be told');
    assert.deepEqual(new SpaceManagers(dir).current(ROOM_A), manager);
  }
});

test('a space the person decided about while the former secretary was away is not handed to it', t => {
  const rooms = [{ id: ROOM_A, archived: false }, { id: ROOM_B, archived: false }], back = [session('manager', [ROOM_A])];
  const decisions = [
    role => role.set(ROOM_A, null),
    role => { role.set(ROOM_A, next); role.set(ROOM_A, null); },
    role => { role.set(ROOM_A, next); role.set(ROOM_B, next); },
  ];
  for (const decide of decisions) {
    const { dir, role } = setup(t);
    assert.equal(role.retireSecretary(manager, [], rooms).status, 'waiting');
    decide(role);
    const reopened = new SpaceManagers(dir);
    assert.equal(reopened.current(ROOM_A), null);
    assert.equal(reopened.retireSecretary(manager, back, rooms).roomId, null);
    assert.equal(reopened.current(ROOM_A), null);
    assert.equal(JSON.parse(fs.readFileSync(role.file, 'utf8')).managers[ROOM_A], undefined, 'decided: nothing more to keep');
    assert.equal(new SpaceManagers(dir).failed, false);
  }
  const { dir, role } = setup(t);
  role.set(ROOM_B, next);
  assert.equal(role.retireSecretary(manager, back, rooms).roomId, ROOM_A, 'another space is not a decision about this one');
  assert.deepEqual(new SpaceManagers(dir).current(ROOM_B), next);
});

test('the former secretary waits for its backend, and never displaces a manager the person chose', t => {
  const { role } = setup(t);
  const rooms = [{ id: ROOM_A, archived: false }];
  assert.deepEqual(role.retireSecretary(manager, [], rooms), { status: 'waiting' });
  assert.equal(role.secretaryRetired, null);
  role.set(ROOM_A, next);
  assert.equal(role.retireSecretary(manager, [session('manager', [ROOM_A])], rooms).roomId, null);
  assert.deepEqual(role.current(ROOM_A), next);
  const fresh = setup(t).role;
  assert.deepEqual(fresh.retireSecretary(null, [], rooms), { status: 'retired', roomId: null });
  assert.deepEqual(fresh.secretaryRetired, { roomId: null });
});

test('a manager\'s items never go to a manager, its own space\'s or another\'s', t => {
  const { role } = setup(t);
  role.set(ROOM_A, manager);
  role.set(ROOM_B, { sessionId: 'other', nativeId: 'native-other' });
  const records = [session('manager', [ROOM_A]), session('other', [ROOM_A, ROOM_B]), session('worker', [ROOM_A])];
  const actor = { id: 'manager', nativeId: 'native-manager' };
  assert.throws(() => role.creator(actor, ROOM_A, 'other', records, new Map()), key('error.queue.managerSelf'));
  assert.deepEqual([...role.activeIds(records)], ['manager', 'other']);
  assert.deepEqual([...role.activeIds([session('manager', [ROOM_B])])], []);
});

test('a session in another space cannot reach a manager automatically; its own space and sessions in no space can', t => {
  const { dir, role } = setup(t);
  role.set(ROOM_A, manager);
  const target = session('manager', [ROOM_A]);
  assert.equal(refusedSpace(role, session('worker', [ROOM_A]), target), null);
  assert.equal(refusedSpace(role, session('worker', [ROOM_A, ROOM_B]), target), null);
  assert.equal(refusedSpace(role, session('outside', [ROOM_B]), target), ROOM_A);
  assert.equal(refusedSpace(role, session('butler', []), target), null);
  assert.equal(refusedSpace(role, session('outside', [ROOM_B]), session('worker', [ROOM_A])), null);
  assert.equal(refusedSpace(role, session('outside', [ROOM_B]), session('manager', [ROOM_B])), null);
  fs.writeFileSync(role.file, '{broken', { mode: 0o600 });
  const broken = new SpaceManagers(dir);
  assert.throws(() => refusedSpace(broken, session('outside', [ROOM_B]), target), key('error.manager.state'));
  assert.equal(refusedSpace(broken, session('worker', [ROOM_A]), target), null);
  assert.equal(refusedSpace(broken, session('outside', [ROOM_B]), session('butler', [])), null);
  assert.equal(refusedSpace(broken, session('butler', []), target), null);
});

test('a manager is shown its own space\'s members only', t => {
  const { dir, role } = setup(t);
  role.set(ROOM_A, manager);
  const list = [session('manager', [ROOM_A]), session('worker', [ROOM_A]), session('outside', [ROOM_B]), session('alone', [])];
  const shown = viewer => list.filter(visibleTo(dir, viewer)).map(entry => entry.id);
  assert.deepEqual(shown(list[0]), ['manager', 'worker']);
  assert.deepEqual(shown(list[1]), ['manager', 'worker', 'outside', 'alone']);
  assert.deepEqual(shown(list[3]), ['manager', 'worker', 'outside', 'alone']);
  fs.writeFileSync(role.file, '{broken', { mode: 0o600 });
  assert.deepEqual(shown(list[0]), ['manager', 'worker']);
  assert.deepEqual(shown(list[2]), ['outside']);
  assert.deepEqual(shown(list[3]), ['manager', 'worker', 'outside', 'alone']);
});
