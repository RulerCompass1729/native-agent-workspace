const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture({ holdInitial = false, manager = true, claude = true } = {}) {
  const elements = new Map(), tasks = [], creates = [], selections = [], notices = [], arranged = [], initial = deferred(); let initialReads = 0;
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, readOnly: false, hidden: false, open: false, isConnected: true,
      showModal() { this.open = true; }, close() { this.open = false; }, focus() { this.focused = true; } });
    return elements.get(id);
  };
  const context = vm.createContext({ $, document: { activeElement: null }, attempt: fn => { const p = fn(); tasks.push(p); return p; },
    api: { spaceCreate(name) { const request = { name, ...deferred() }; creates.push(request); return request.promise; },
      initial() { initialReads++; return holdInitial ? initial.promise : Promise.resolve({ rooms: ['created-room'] }); },
      ...(manager ? { spaceManager: async (roomId, choice) => { arranged.push([roomId, { ...choice }]); if (manager instanceof Error) throw manager; } } : {}) },
    state: { preflight: { claude } }, uiError: (key, params) => Object.assign(Error(key + ': ' + params.reason), { key }),
    updateState() {}, render() {}, selectSpace: async id => selections.push(id), toastMessage: key => notices.push(key),
    toastError: error => notices.push(error.message), ui: { errorText: error => error.message, showError: (element, error) => { element.textContent = error.message; } } });
  vm.runInContext(source.slice(source.indexOf('const dialogTickets ='), source.indexOf('let trustScope =')), context);
  vm.runInContext(source.slice(source.indexOf('function openSpaceCreate()'), source.indexOf('let mergeDialog;')), context);
  vm.runInContext(source.slice(source.indexOf("$('cancel-space-create').onclick"), source.indexOf("$('workspace-group').addEventListener")), context);
  vm.runInContext(source.slice(source.indexOf('async function chooseManager('), source.indexOf('// The butler the person talks to is one session outside every space.')), context);
  const open = value => { context.openSpaceCreate(); $('space-create-name').value = value; };
  const submit = () => { $('space-create-form').onsubmit({ preventDefault() {} }); return tasks.at(-1); };
  return { $, open, submit, creates, selections, notices, arranged, initial, initialReads: () => initialReads };
}

test('an unchanged submitted name creates once, closes and selects the acknowledged space', async () => {
  const f = fixture(); f.open('Space A'); const done = f.submit();
  assert.equal(f.$('confirm-space-create').disabled, true); assert.equal(f.creates[0].name, 'Space A');
  f.creates[0].resolve('room-A'); await done;
  assert.equal(f.$('space-create-dialog').open, false); assert.deepEqual(f.selections, ['room-A']); assert.equal(f.creates.length, 1);
});

test('a newer name typed while spaceCreate is pending survives the old acknowledgement', async () => {
  const f = fixture(); f.open('Space A'); const done = f.submit();
  assert.equal(f.$('space-create-name').disabled, false); assert.equal(f.$('space-create-name').readOnly, false);
  f.$('space-create-name').value = '  Space B 🧪  '; f.creates[0].resolve('room-A'); await done;
  assert.equal(f.$('space-create-dialog').open, true, 'late ACK must not close the newer edit');
  assert.equal(f.$('space-create-name').value, '  Space B 🧪  '); assert.deepEqual(f.selections, []);
  assert.deepEqual(f.notices, ['toast.createdSpaceRetained']); assert.equal(f.$('confirm-space-create').disabled, false);
  assert.deepEqual(f.creates.map(request => request.name), ['Space A']);
});

test('a name edited during the following initial read also stays open and unsubmitted', async () => {
  const f = fixture({ holdInitial: true }); f.open('Space A'); const done = f.submit(); f.creates[0].resolve('room-A');
  for (let n = 0; n < 4 && !f.initialReads(); n++) await Promise.resolve(); assert.equal(f.initialReads(), 1);
  f.$('space-create-name').value = 'Space B'; f.initial.resolve({ rooms: ['room-A'] }); await done;
  assert.equal(f.$('space-create-dialog').open, true, 'initial ACK must not close the newer edit');
  assert.equal(f.$('space-create-name').value, 'Space B'); assert.deepEqual(f.selections, []); assert.equal(f.creates.length, 1);
});

test('a pending submission still refuses reentry without disabling the editable name', async () => {
  const f = fixture(); f.open('Space A'); const first = f.submit(); f.$('space-create-name').value = 'Space B';
  await f.submit(); assert.equal(f.creates.length, 1); assert.equal(f.$('space-create-name').disabled, false);
  f.creates[0].resolve('room-A'); await first;
});

test('an explicit second create is required to submit the retained newer name', async () => {
  const f = fixture(); f.open('Space A'); const first = f.submit(); f.$('space-create-name').value = 'Space B';
  f.creates[0].resolve('room-A'); await first;
  assert.equal(f.$('space-create-dialog').open, true); assert.equal(f.creates.length, 1);
  const second = f.submit(); assert.equal(f.creates[1].name, 'Space B'); f.creates[1].resolve('room-B'); await second;
  assert.equal(f.$('space-create-dialog').open, false); assert.deepEqual(f.selections, ['room-B']);
});

test('a closed or replaced opening cannot close or select over a new opening', async () => {
  const f = fixture(); f.open('Space A'); const first = f.submit(); f.$('cancel-space-create').onclick();
  f.open('Space B'); const second = f.submit(); f.creates[0].resolve('room-A'); await first;
  assert.equal(f.$('space-create-dialog').open, true); assert.equal(f.$('space-create-name').value, 'Space B');
  assert.equal(f.$('confirm-space-create').disabled, true); assert.deepEqual(f.selections, []);
  f.creates[1].resolve('room-B'); await second; assert.deepEqual(f.selections, ['room-B']);
});

test('a failed original create preserves a newer name and the original error', async () => {
  const f = fixture(); f.open('Space A'); const done = f.submit(); f.$('space-create-name').value = 'Space B';
  f.creates[0].reject(Error('original create failure')); await done;
  assert.equal(f.$('space-create-dialog').open, true); assert.equal(f.$('space-create-name').value, 'Space B');
  assert.equal(f.$('space-create-error').hidden, false); assert.equal(f.$('space-create-error').textContent, 'original create failure');
  assert.equal(f.$('confirm-space-create').disabled, false); assert.deepEqual(f.selections, []);
});

test('a new space gets a project manager unless the person clears the box; the choice is the one submitted', async () => {
  let f = fixture(); f.open('Space A');
  assert.deepEqual(['space-create-manager-option', 'space-create-manager-help'].map(id => f.$(id).hidden), [false, false]);
  assert.equal(f.$('space-create-manager').checked, true, 'on by default');
  let done = f.submit(); f.$('space-create-manager').checked = false; f.creates[0].resolve('room-A'); await done;
  assert.deepEqual(f.arranged, [['room-A', { create: true }]]);
  f = fixture(); f.open('Space B'); f.$('space-create-manager').checked = false; done = f.submit(); f.creates[0].resolve('room-B'); await done;
  assert.deepEqual([f.arranged, f.selections], [[], ['room-B']]);
  f.open('Space C'); assert.equal(f.$('space-create-manager').checked, true, 'the next opening starts from the default');
  f = fixture(); f.open('Space D'); done = f.submit(); f.creates[0].reject(Error('not created')); await done;
  assert.deepEqual(f.arranged, [], 'no space, no manager');
});

test('a project manager that could not be set up leaves the space as it is and says so', async () => {
  const f = fixture({ manager: Error('synthetic refusal') }); f.open('Space A'); const done = f.submit(); f.creates[0].resolve('room-A'); await done;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([f.selections, f.arranged.length, f.notices], [['room-A'], 1, ['error.manager.notArranged: synthetic refusal']]);
  assert.equal(f.$('space-create-dialog').open, false);
});

test('without Claude on this machine, or on a window that cannot arrange one, the box is not offered', async () => {
  for (const options of [{ claude: false }, { manager: false }]) {
    const f = fixture(options); f.open('Space A');
    assert.deepEqual([f.$('space-create-manager-option').hidden, f.$('space-create-manager-help').hidden, f.$('space-create-manager').checked], [true, true, false]);
    const done = f.submit(); f.creates[0].resolve('room-A'); await done;
    assert.deepEqual([f.arranged, f.selections], [[], ['room-A']]);
  }
});

test('a space made while starting a session gets its project manager only when the box was left on, after the session joined', async () => {
  for (const manager of [true, false]) {
    const order = [], person = { id: 'session', name: 'Session', roomIds: [] }, room = { id: 'room-new', name: 'Plans' };
    const ticket = { creation: { choice: { kind: 'new', name: 'Plans', manager }, sessionId: 'session', roomId: '', view: 'chat' } };
    const context = vm.createContext({
      $: () => ({ open: true, close() {}, textContent: '' }), selectionRevision: 1, creatingSession: false, createReadiness() {}, updateState() {}, render() {},
      state: { sessions: [person] }, rooms: [], allSpaces: () => context.rooms, spaceRecord: id => context.rooms.find(item => item.id === id),
      currentDialogTicket: () => true, uiText: key => key, uiError: key => Error(key), sessionShortId: id => id, spaceName: item => item.name,
      inSpace: (record, id) => record.roomIds.includes(id), placementProof: () => ({}), select: async () => order.push('select'), toastMessage() {},
      window: { nativeWorkspaceSpaces: { canJoin: () => true } }, ui: { display: { unbind() {}, text() {} }, errorText: error => error.message, language: { getSnapshot: () => ({ active: 'zh' }) } },
      api: { initial: async () => ({}), spaceCreate: async () => { order.push('create'); context.rooms = [room]; return room.id; }, spaceAction: async () => { order.push('join'); person.roomIds = [room.id]; } },
      arrangeManager: id => order.push('manager ' + id),
    });
    vm.runInContext(source.slice(source.indexOf('async function finishCreateSpace('), source.indexOf('function resetCreateDirectory(')), context);
    await context.finishCreateSpace(ticket, 1);
    assert.deepEqual(order, ['create', 'join', 'select', ...(manager ? ['manager room-new'] : [])]);
  }
});
