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
