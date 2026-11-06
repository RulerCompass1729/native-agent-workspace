const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { RoomState } = require('../room-state.cjs');

function fixture() {
  const sessions = [
    { id: 'visible', nativeId: 'native-visible', name: 'Visible', state: 'ended' },
    { id: 'hidden', nativeId: 'native-hidden', name: 'Archived', state: 'ended' },
  ];
  const snapshot = { sessions, room: { messages: [] } };
  const records = { old: { sessions: sessions.map(({ id, nativeId, name }) => ({ id, nativeId, name })) } };
  const cleared = [], profile = Object.create(RoomState.prototype);
  profile.value = { name: 'Shared', notes: '', revision: 0, events: [], memberOrder: [], files: [], archivedSessions: ['hidden'] };
  profile.spaces = { rooms: [] };
  let settingsHandler;
  const context = vm.createContext({
    roomState: profile, dataDir: 'synthetic-only', backendSwitching: null, switchRecords: records,
    backendSwitch: {
      readSettings: () => ({ auto: true }), readRecords: () => records,
      clearRecord: (_directory, key) => { cleared.push(key); delete records[key]; },
    },
    register: (name, handler) => { assert.equal(name, 'backendSwitchSettings'); settingsHandler = handler; },
  });
  const main = fs.readFileSync(require.resolve('../main.cjs'), 'utf8');
  const start = main.indexOf('const notReconnected = '), end = main.indexOf('async function runBackendSwitch(', start);
  const ipcStart = main.indexOf("register('backendSwitchSettings',"), ipcEnd = main.indexOf("register('switchBackend',", ipcStart);
  assert.ok(start >= 0 && end > start && ipcStart >= 0 && ipcEnd > ipcStart);
  vm.runInContext(main.slice(start, end) + main.slice(ipcStart, ipcEnd), context);
  const settings = async () => JSON.parse(JSON.stringify(await settingsHandler({ client: { refresh: async () => {}, snapshot: () => snapshot } })));
  return { sessions, records, profile, cleared, settings };
}

test('interrupted-session menu applies profile archive metadata to raw backend records', async () => {
  const f = fixture(), before = JSON.stringify(f.sessions);
  assert.equal(f.sessions[1].archived, undefined, 'Archiving belongs to the app profile, not the raw backend');
  assert.deepEqual(await f.settings(), { auto: true, interrupted: ['Visible'] });
  assert.equal(JSON.stringify(f.sessions), before, 'Displaying the menu must not alter backend records');
  assert.deepEqual(f.cleared, []);
});

test('hiding an archived pending session preserves its resume record and restores its menu entry', async () => {
  const f = fixture();
  f.sessions[0].state = 'idle';
  assert.deepEqual((await f.settings()).interrupted, []);
  assert.deepEqual(f.cleared, [], 'Archive filtering must not clear the pending native resume metadata');
  assert.ok(f.records.old);
  f.profile.value.archivedSessions = [];
  assert.deepEqual((await f.settings()).interrupted, ['Archived']);
});

test('record cleanup still uses raw live native identities and connection states', async () => {
  const f = fixture();
  f.sessions[0].state = 'idle';
  f.sessions[1].nativeId = 'different-native';
  assert.deepEqual((await f.settings()).interrupted, []);
  assert.deepEqual(f.cleared, ['old']);
  assert.deepEqual(Object.keys(f.records), []);
});
