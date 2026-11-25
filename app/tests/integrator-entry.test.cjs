const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const vm = require('node:vm');
const { uiError } = require('../ui-errors.cjs');
const { roomIds } = require('../collaboration-spaces.cjs');
const { IntegratorRole } = require('../integrator-role.cjs');
const { RoomState } = require('../room-state.cjs');
const backgroundOperation = require('../background-operation.cjs');

// The real `register` wrapper and the real `integrator` handler from main.cjs (B6, section 5):
// only the person's own window designates or revokes the integrator. Synthetic sessions only.
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-integrator-entry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const role = new IntegratorRole(directory), room = new RoomState(directory);
  const handlers = new Map(), broadcasts = [];
  const context = vm.createContext({
    applicationHandlers: handlers, backgroundOperation, uiError, roomIds, integratorRole: role, roomState: room,
    ipcMain: { handle() {} }, assertManagerDelivery() {}, broadcastRoom: async () => { broadcasts.push(role.selected); }, ...extra,
  });
  const wrapper = source.indexOf('function register(name, handler) {');
  vm.runInContext(source.slice(wrapper, source.indexOf('async function replaceBackendSockets', wrapper)), context);
  const start = source.indexOf("  register('integrator', async (c, id) => {"), end = source.indexOf("  register('rename',", start);
  assert.ok(wrapper > 0 && start > 0 && end > start, 'The integrator entry is where this test reads it');
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext("register('send', () => 'should require backend support');", context);
  const sessions = [
    { id: 'outside', nativeId: 'native-outside', name: 'Outside', state: 'idle', roomIds: [] },
    { id: 'member', nativeId: 'native-member', name: 'Member', state: 'idle', roomIds: ['shared'] },
    { id: 'legacy-member', nativeId: 'native-legacy', name: 'Legacy member', state: 'idle', roomId: 'shared' },
    { id: 'no-native', nativeId: null, name: 'No native id', state: 'idle', roomIds: [] },
    // The backend does not know about archiving: its record of an archived session looks like any other.
    { id: 'archived', nativeId: 'native-archived', name: 'Archived', state: 'idle', roomIds: [] },
    { id: 'pending', nativeId: 'native-pending', name: 'Pending', state: 'idle', nativeContextPending: true, roomIds: [] },
    { id: 'ended', nativeId: 'native-ended', name: 'Ended', state: 'ended', roomIds: [] },
    { id: 'background', nativeId: 'native-background', name: 'Background', state: 'background', roomIds: [] },
    { id: 'broken', nativeId: 'native-broken', name: 'Broken membership', state: 'idle', roomIds: 'shared' },
    { id: 'other', nativeId: 'native-other', name: 'Other', state: 'idle', roomIds: [] },
  ];
  // A backend without background-control support: the entry is local to this desktop and does not need it.
  const client = { call: async () => ({ sessions }), entries: [{ state: { sessions: [{ id: 'old' }], capabilities: [] } }], refresh: async () => {}, snapshot: () => ({ wakePolicy: { enabled: true }, sessions: [{ id: 'old' }, ...sessions] }) };
  const person = { client };
  const agent = id => {
    const record = sessions.find(session => session.id === id);
    const actor = { id, nativeId: record.nativeId, name: record.name, provider: 'claude', turnId: 'turn', callId: 'call', operationId: 'op' };
    const c = { background: true, actor, client, view: { selected: id }, win: { destroy() {} }, checkActor: async () => {} };
    return (name, args) => backgroundOperation.run(actor, () => handlers.get(name)(c, ...args), { context: c, valid: async () => {} });
  };
  return { directory, role, room, handlers, broadcasts, sessions, person, agent, call: (...args) => handlers.get('integrator')(person, ...args) };
}
const key = name => error => error.uiMessage?.key === name;

test('the person designates a session outside every space, replaces it, and revokes it', async t => {
  const f = fixture(t);
  assert.equal(f.role.current(), null);
  await f.call('outside');
  assert.deepEqual(f.role.current(), { sessionId: 'outside', nativeId: 'native-outside' });
  assert.deepEqual(new IntegratorRole(f.directory).current(), { sessionId: 'outside', nativeId: 'native-outside' }, 'The designation is saved');
  await f.call('other');
  assert.deepEqual(f.role.current(), { sessionId: 'other', nativeId: 'native-other' }, 'There is one integrator: the newer replaces the older');
  await f.call(null);
  assert.equal(f.role.current(), null);
  assert.equal(new IntegratorRole(f.directory).current(), null);
  assert.equal(f.broadcasts.length, 3, 'Every window is told after each change');
});

test('an agent can neither designate nor revoke, whoever it is and whatever it names', async t => {
  const f = fixture(t);
  await f.call('outside');
  const before = fs.readFileSync(path.join(f.directory, 'integrator.json'), 'utf8');
  // The integrator itself, another session outside the spaces, and a space member.
  for (const who of ['outside', 'other', 'member']) {
    for (const target of [null, 'outside', 'other', who]) await assert.rejects(f.agent(who)('integrator', [target]), key('error.integrator.personOnly'), `${who} -> ${target}`);
  }
  assert.equal(fs.readFileSync(path.join(f.directory, 'integrator.json'), 'utf8'), before);
  assert.deepEqual(f.role.current(), { sessionId: 'outside', nativeId: 'native-outside' });
  assert.equal(f.broadcasts.length, 1, 'A refused call changes nothing and announces nothing');
  // The refusal is the entry's own: the general background gate has no row for this method.
  assert.equal(backgroundOperation.deliveryTargets('integrator', ['outside']), null);
  // Without an originating operation an agent's call does not get as far as the entry.
  const c = { background: true, client: f.person.client };
  await assert.rejects(f.handlers.get('integrator')(c, 'other'), /originating operation/);
  // The entry is local: a backend too old for background control does not stop the refusal above,
  // while a method that does deliver to a session is still held back for an agent.
  await assert.rejects(f.agent('other')('send', ['old', 'text']), /adopt background-control support/);
  assert.deepEqual(f.role.current(), { sessionId: 'outside', nativeId: 'native-outside' });
});

test('a session in a space, or one that cannot be used, is not designated, and the earlier choice stays', async t => {
  const f = fixture(t);
  // The person archives a session the real way; only the desktop's own record says so.
  // (Archiving checks every membership record first, so the one unreadable record joins the list afterwards.)
  const broken = f.sessions.splice(f.sessions.findIndex(session => session.id === 'broken'), 1)[0];
  await f.room.archiveSession(f.person.client, 'archived', 'Archived');
  f.sessions.push(broken);
  assert.deepEqual(f.room.value.archivedSessions, ['archived']);
  assert.equal((await f.person.client.call('initial')).sessions.find(session => session.id === 'archived').archived, undefined);
  await f.call('outside');
  for (const id of ['member', 'legacy-member']) await assert.rejects(f.call(id), key('error.integrator.inSpace'), id);
  for (const id of ['no-native', 'archived', 'pending', 'ended', 'background', 'broken', 'missing', undefined, 7, ['outside'], { id: 'outside' }]) {
    await assert.rejects(f.call(id), key('error.integrator.invalid'), JSON.stringify(id));
  }
  assert.deepEqual(f.role.current(), { sessionId: 'outside', nativeId: 'native-outside' });
  assert.equal(f.broadcasts.length, 1);
});

test('a designation that cannot be saved is reported and nothing is announced', async t => {
  const f = fixture(t);
  fs.chmodSync(f.directory, 0o500);
  try { await assert.rejects(f.call('outside'), key('error.integrator.state')); }
  finally { fs.chmodSync(f.directory, 0o700); }
  assert.equal(f.broadcasts.length, 0);
  assert.equal(new IntegratorRole(f.directory).current(), null);
});

test('the entry is wired: the role is built from the data folder, shown in the state, and reachable from the window', () => {
  assert.ok(source.includes("const { IntegratorRole } = require('./integrator-role.cjs');"));
  assert.match(source, /spaceManagers = new SpaceManagers\(dataDir\);\n[^\n]*\n  integratorRole = new IntegratorRole\(dataDir\);/);
  assert.match(source, /try \{ integrator = integratorRole\?\.current\(\) \|\| null; \} catch \{ integratorWarning = displayText\('error\.integrator\.state'\); \}/);
  assert.match(source, /const result = \{ \.\.\.display, spaceManagers: managers, integrator, /);
  const preload = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.match(preload, /for \(const name of \['spaceManager', 'integrator', /);
  // Nothing but this entry writes the designation.
  assert.equal(source.match(/integratorRole\.set\(/g).length, 2);
  for (const file of fs.readdirSync(path.join(__dirname, '..')).filter(name => /\.c?js$/.test(name) && !['main.cjs', 'integrator-role.cjs'].includes(name))) {
    assert.ok(!/integratorRole|IntegratorRole|integrator\.json/.test(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')), file);
  }
});
