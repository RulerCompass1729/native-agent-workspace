const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { uiError } = require('../ui-errors.cjs');

// R207: who may ask for a rotation now, and who may take it back (main.cjs sessionRotation). Synthetic sessions only.
const source = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
const refusal = key => error => error?.uiMessage?.key === key;
const REGION = ["  register('sessionRotation'", "  register('modelChoices'"];
function handlers({ person = true, dispatcher, ...globals } = {}) {
  const start = source.indexOf(REGION[0]), end = source.indexOf(REGION[1], start);
  assert.ok(start > 0 && end > start);
  const calls = [], registered = new Map();
  const applicationHandlers = new Map();
  const queueDispatcher = dispatcher === undefined ? {
    requestRotation: async (...args) => { calls.push(['now', ...args]); },
    withdrawRotation: async (...args) => { calls.push(['undo', ...args]); },
  } : dispatcher;
  let told = 0;
  vm.runInContext(source.slice(start, end), vm.createContext({
    register: (name, fn) => { registered.set(name, fn); applicationHandlers.set(name, fn); },
    applicationHandlers, queueDispatcher, uiError, broadcastRoom: async () => { told += 1; },
    isCurrentHumanContext: c => !c.background && person, ...globals,
  }));
  return { calls, registered, applicationHandlers, told: () => told,
    person: (name, ...args) => registered.get(name)({ background: false }, ...args),
    agent: (name, ...args) => registered.get(name)({ background: true }, ...args) };
}

test('R207: the person asks and takes back in their own window; nobody else, and no agent finds the call', async () => {
  const f = handlers();
  await f.person('sessionRotation', 's1', 'now');
  await f.person('sessionRotation', 's1', 'undo');
  assert.deepEqual(f.calls, [['now', 's1', 'person'], ['undo', 's1', 'person']]);
  assert.equal(f.told(), 2, 'the windows are told');
  await assert.rejects(f.agent('sessionRotation', 's1', 'now'), refusal('error.rotation.personOnly'));
  await assert.rejects(handlers({ person: false }).person('sessionRotation', 's1', 'now'), refusal('error.rotation.personOnly'), 'not the person\'s current window');
  for (const bad of [[undefined, 'now'], ['s1', 'again'], ['s1'], [{ id: 's1' }, 'now']]) await assert.rejects(f.person('sessionRotation', ...bad), refusal('error.rotation.unavailable'));
  await assert.rejects(handlers({ dispatcher: null }).person('sessionRotation', 's1', 'now'), refusal('error.rotation.unavailable'));
  assert.equal(f.calls.length, 2, 'a refused call reaches nothing');
  assert.equal(f.applicationHandlers.has('sessionRotation'), false, 'not among what agents can call');
  assert.ok(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8').includes("'sessionRotation'"));
});

test('R207: where rotations stand is for the person\'s windows, not in what agents read', () => {
  assert.match(source, /\.\.\.\(context\?\.background \? \{\} : \{ modelChanges: [^}]*sessionRotations: queueDispatcher\?\.rotationRows \|\| \{\} \}\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../background-operation.cjs'), 'utf8'), /sessionRotations/);
});

// 甲: the designated butler asks for its own rotation, through main.cjs's own stewardCaller.
const { StewardRole } = require('../steward-role.cjs');
const { roomIds } = require('../collaboration-spaces.cjs');
const os = require('node:os');
function butlerSetup(t, { sessions, dispatcher, actor }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-rotate-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const role = new StewardRole(dir);
  const state = { actor };
  const start = source.indexOf('async function stewardCaller(c) {'), end = source.indexOf('function conversationReaderAllowed(actor)', start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({
    backgroundOperation: { current: () => state.actor }, stewardOf: () => role.current(), roomState: { apply: value => value },
    sessionLabels: { labels: new Map() }, roomIds,
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.caller = stewardCaller;', context);
  const f = handlers({ dispatcher, stewardCaller: context.caller });
  const client = { call: async () => ({ sessions }) };
  return { ...f, role, state, dir, rotate: (...args) => f.registered.get('stewardRotate')({ background: true, client }, ...args) };
}
const OWN = { id: 'butler', nativeId: 'native-butler', name: 'Synthetic butler', state: 'working', roomIds: [], roomId: null };
const OTHER = { id: 'other', nativeId: 'native-other', name: 'Other', state: 'working', roomIds: [], roomId: null };
const butlerOnly = refusal('error.rotation.butlerOnly');

test('R207 甲: the designated butler asks for its own rotation, and only its own', async t => {
  const asked = [], dispatcher = { requestRotation: async (...args) => { asked.push(args); return { state: 'requested', gate: 'not-idle', undo: true, next: { id: 'x', name: 'private' } }; } };
  const f = butlerSetup(t, { sessions: [OWN, OTHER], dispatcher, actor: { id: 'butler', nativeId: 'native-butler' } });
  await assert.rejects(f.rotate(), butlerOnly, 'nobody is designated');
  f.role.set({ sessionId: 'butler', nativeId: 'native-butler' });
  assert.deepEqual(JSON.parse(JSON.stringify(await f.rotate())), { state: 'requested', gate: 'not-idle' });
  await f.rotate('butler');
  assert.deepEqual(asked, [['butler', 'steward'], ['butler', 'steward']]);
  for (const bad of [['other'], ['butler', 'other'], [null], [{ id: 'butler' }], [undefined], ['butler', 'undo'], ['']]) await assert.rejects(f.rotate(...bad), butlerOnly, JSON.stringify(bad));
  // Not the butler; the butler of a moment ago; its native session replaced; in a space; archived.
  f.state.actor = { id: 'other', nativeId: 'native-other' };
  await assert.rejects(f.rotate(), butlerOnly); await assert.rejects(f.rotate('other'), butlerOnly); await assert.rejects(f.rotate('butler'), butlerOnly, 'a member cannot rotate the butler');
  f.state.actor = { id: 'butler', nativeId: 'native-butler' };
  f.role.set({ sessionId: 'other', nativeId: 'native-other' });
  await assert.rejects(f.rotate(), butlerOnly, 'the designation moved'); await assert.rejects(f.rotate('other'), butlerOnly, 'an old butler cannot rotate the new one');
  f.role.set(null);
  await assert.rejects(f.rotate(), butlerOnly, 'revoked');
  f.role.set({ sessionId: 'butler', nativeId: 'native-butler' });
  f.state.actor = { id: 'butler', nativeId: 'native-older' };
  await assert.rejects(f.rotate(), butlerOnly);
  f.state.actor = null;
  await assert.rejects(f.rotate(), butlerOnly, 'no agent behind the call');
  assert.equal(asked.length, 2, 'a refused call reaches nothing');
  for (const extra of [{ roomIds: ['shared'], roomId: 'shared' }, { archived: true }, { state: 'ended' }, { nativeContextPending: true }]) {
    const held = butlerSetup(t, { sessions: [{ ...OWN, ...extra }], dispatcher, actor: { id: 'butler', nativeId: 'native-butler' } });
    held.role.set({ sessionId: 'butler', nativeId: 'native-butler' });
    await assert.rejects(held.rotate(), butlerOnly, JSON.stringify(extra));
  }
  assert.equal(asked.length, 2);
});

test('R207 甲: not a call of the person\'s window, refused while NAW sends nothing, and the butler has no undo', async t => {
  const f = butlerSetup(t, { sessions: [OWN], dispatcher: null, actor: { id: 'butler', nativeId: 'native-butler' } });
  f.role.set({ sessionId: 'butler', nativeId: 'native-butler' });
  await assert.rejects(f.registered.get('stewardRotate')({ background: false, client: { call: async () => ({ sessions: [OWN] }) } }), butlerOnly, 'the person has their own');
  await assert.rejects(f.rotate(), refusal('error.rotation.unavailable'));
  assert.deepEqual([...f.registered.keys()], ['sessionRotation', 'stewardRotate']);
  assert.equal(fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8').includes('stewardRotate'), false);
  const body = source.slice(source.indexOf("register('stewardRotate'"), source.indexOf("register('modelChoices'"));
  assert.equal(/withdrawRotation/.test(body), false);
});

test('R207 甲: a local call the butler finds in the catalog, and each call is a step of its record, in words', t => {
  const local = source.slice(source.indexOf('const local = new Set(['), source.indexOf(']);', source.indexOf('const local = new Set([')));
  assert.ok(local.includes("'stewardRotate'"));
  assert.equal(local.includes("'sessionRotation'"), false);
  const { BackgroundControl } = require('../background-control.cjs');
  const entry = new BackgroundControl({ dataDir: os.tmpdir(), handlers: new Map([['stewardRotate', () => null]]) }).catalog().find(item => item.method === 'stewardRotate');
  assert.match(entry.parameters[0], /your own[\s\S]*designated butler only[\s\S]*the person can undo it/u);
  const records = require('../steward-record.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-steward-rotate-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = new records.StewardRecord(dir, { steward: () => ({ sessionId: 'butler', nativeId: 'native-butler' }), now: () => 1800000000000 });
  for (const args of [[], ['butler'], ['other']]) {
    record.append({ kind: 'step', id: String(args.length) + (args[0] || ''), session: { id: 'butler', nativeId: 'native-butler', provider: 'claude', name: 'Synthetic butler' },
      action: 'invoke', method: 'stewardRotate', arguments: JSON.stringify(args), operationId: null });
  }
  const shown = records.view(record, { sessions: [OWN, OTHER] }).entries.filter(e => e.method === 'stewardRotate');
  assert.deepEqual(shown.map(e => e.rotate === true).sort(), [false, true, true], 'one for another session is shown as the command it was');
  const { zh, en } = require('../ui-messages.js').messages || require('../ui-messages.js');
  for (const key of ['stewardRecord.step.rotateNow', 'error.rotation.butlerOnly', 'error.rotation.personOnly', 'error.rotation.unavailable', 'error.rotation.cannotUndo']) {
    assert.ok(zh[key] && en[key], key);
  }
});
