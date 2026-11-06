const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture({ holdInitial = false } = {}) {
  const elements = new Map(), tasks = [], creates = [], selections = [], notices = [], initial = deferred(); let initialReads = 0;
  const $ = id => {
    if (!elements.has(id)) elements.set(id, { value: '', disabled: false, readOnly: false, hidden: false, open: false, isConnected: true,
      showModal() { this.open = true; }, close() { this.open = false; }, focus() { this.focused = true; } });
    return elements.get(id);
  };
  const context = vm.createContext({ $, attempt: fn => { const p = fn(); tasks.push(p); return p; },
    api: { spaceCreate(name) { const request = { name, ...deferred() }; creates.push(request); return request.promise; },
      initial() { initialReads++; return holdInitial ? initial.promise : Promise.resolve({ rooms: ['created-room'] }); } },
    updateState() {}, render() {}, selectSpace: async id => selections.push(id), toastMessage: key => notices.push(key),
    toastError: error => notices.push(error.message), ui: { showError: (element, error) => { element.textContent = error.message; } } });
  vm.runInContext(source.slice(source.indexOf('const dialogTickets ='), source.indexOf('let trustScope =')), context);
  vm.runInContext(source.slice(source.indexOf('function openSpaceCreate()'), source.indexOf('let mergeDialog;')), context);
  vm.runInContext(source.slice(source.indexOf("$('cancel-space-create').onclick"), source.indexOf("$('workspace-group').addEventListener")), context);
  const open = value => { context.openSpaceCreate(); $('space-create-name').value = value; };
  const submit = () => { $('space-create-form').onsubmit({ preventDefault() {} }); return tasks.at(-1); };
  return { $, open, submit, creates, selections, notices, initial, initialReads: () => initialReads };
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
