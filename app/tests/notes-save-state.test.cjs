const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
function declaration(name) {
  const from = source.indexOf('function ' + name + '('), to = source.indexOf('\n}', from);
  assert.ok(from > 0 && to > from); return source.slice(from, to + 2);
}
const from = source.indexOf("$('notes-form').onsubmit ="), to = source.indexOf('\n};', from) + 3;
assert.ok(from > 0 && to > from);
const closeFrom = source.indexOf("else if (dialog.id === 'notes-dialog') {"), closeTo = source.indexOf("} else", closeFrom);
assert.ok(closeFrom > 0 && closeTo > closeFrom);
const clearNotes = source.slice(source.indexOf('{', closeFrom) + 1, closeTo);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  const save = deferred(), refresh = deferred(), writes = [], notices = [], errors = [];
  const elements = { 'notes-form': {}, 'notes-dialog': { isConnected: true, open: true },
    'room-notes-text': { value: 'Submitted original' }, 'save-notes': { disabled: false }, 'notes-error': { hidden: true, textContent: '' } };
  const dialogTickets = new WeakMap(), dialog = elements['notes-dialog'];
  const context = { $: id => elements[id], dialogTickets, notesRevision: 5, Number,
    uiError: key => Object.assign(Error(key), { uiMessage: { key } }),
    ui: { showError(e, error) { errors.push(error.message); e.textContent = error.message; }, errorText: e => e.message, display: { unbind() {} } },
    toastMessage: key => notices.push(key),
    api: { spaceAction(room, action, args) { writes.push({ room, action, args }); return save.promise; }, initial() { context.refreshes++; return refresh.promise; } }, refreshes: 0 };
  vm.createContext(context); vm.runInContext(declaration('currentDialogTicket') + '\n' + source.slice(from, to), context);
  function open(text = 'Submitted original', revision = 5, roomId = 'owned-room') {
    dialog.open = true; elements['room-notes-text'].value = text; elements['save-notes'].disabled = false;
    context.notesRevision = revision; dialogTickets.set(dialog, { dialog, roomId });
  }
  dialog.close = () => { dialog.open = false; vm.runInContext(clearNotes, context); };
  open();
  return { context, elements, dialog, open, save, refresh, writes, notices, errors,
    submit: () => elements['notes-form'].onsubmit({ preventDefault() {} }),
    async tick() { await Promise.resolve(); await Promise.resolve(); },
    snapshot(notes = 'Submitted original', metadataRevision = 6) { return { rooms: [{ id: 'owned-room', notes, metadataRevision }] }; } };
}
test('unchanged successful notes close and clear without an extra snapshot', async () => {
  const f = fixture(), pending = f.submit(); assert.equal(f.elements['save-notes'].disabled, true);
  f.save.resolve(); await pending; assert.equal(f.dialog.open, false); assert.equal(f.elements['room-notes-text'].value, ''); assert.equal(f.context.refreshes, 0);
  assert.equal(f.writes[0].room, 'owned-room'); assert.equal(f.writes[0].args[0], 'Submitted original'); assert.equal(f.writes[0].args[1], 5);
});
test('an edit typed during Save survives and a later explicit Save uses the verified revision', async () => {
  const f = fixture(), pending = f.submit(); f.elements['room-notes-text'].value = 'Later unsaved edit'; f.save.resolve();
  await f.tick(); f.refresh.resolve(f.snapshot()); await pending;
  assert.equal(f.dialog.open, true, 'Saving an earlier version must not discard a newer edit'); assert.equal(f.elements['room-notes-text'].value, 'Later unsaved edit');
  assert.equal(f.elements['save-notes'].disabled, false); assert.equal(f.context.notesRevision, 6); assert.equal(f.writes.length, 1, 'Never automatically re-save');
  await f.submit(); assert.equal(f.writes.length, 2); assert.equal(f.writes[1].args[0], 'Later unsaved edit'); assert.equal(f.writes[1].args[1], 6); assert.equal(f.dialog.open, false);
});
for (const value of [null, { rooms: [] }, { rooms: [{ id: 'other-room', notes: 'Submitted original', metadataRevision: 6 }] }, { rooms: [{ id: 'owned-room', notes: 'Other writer', metadataRevision: 7 }] }, { rooms: [{ id: 'owned-room', notes: 'Submitted original', metadataRevision: NaN }] }]) {
  test('missing, mismatched or divergent metadata cannot rebase or discard a late edit: ' + JSON.stringify(value), async () => {
    const f = fixture(), pending = f.submit(); f.elements['room-notes-text'].value = 'Keep my late edit'; f.save.resolve(); await f.tick(); f.refresh.resolve(value); await pending;
    assert.equal(f.dialog.open, true); assert.equal(f.elements['room-notes-text'].value, 'Keep my late edit'); assert.equal(f.context.notesRevision, 5);
    assert.equal(f.elements['notes-error'].hidden, false); assert.deepEqual(f.errors, ['error.room.dataChangedElsewhere']); assert.equal(f.writes.length, 1); assert.equal(f.elements['save-notes'].disabled, false);
  });
}
test('refresh failure keeps the late edit visible with the actual error', async () => {
  const f = fixture(), pending = f.submit(); f.elements['room-notes-text'].value = 'Keep on read failure'; f.save.resolve(); await f.tick(); f.refresh.reject(Error('Read unavailable')); await pending;
  assert.equal(f.dialog.open, true); assert.equal(f.elements['room-notes-text'].value, 'Keep on read failure'); assert.deepEqual(f.errors, ['Read unavailable']); assert.equal(f.context.notesRevision, 5);
});
test('a reopened dialog is untouched by the original save response', async () => {
  const f = fixture(), pending = f.submit(); f.dialog.close(); f.open('New opening', 20, 'other-room'); f.save.resolve(); await pending;
  assert.equal(f.dialog.open, true); assert.equal(f.elements['room-notes-text'].value, 'New opening'); assert.equal(f.context.notesRevision, 20); assert.equal(f.context.refreshes, 0); assert.deepEqual(f.notices, ['toast.notesSavedEarlier']);
});
test('a reopened dialog is untouched by a late post-save snapshot', async () => {
  const f = fixture(), pending = f.submit(); f.elements['room-notes-text'].value = 'Late edit'; f.save.resolve(); await f.tick();
  f.dialog.close(); f.open('Another new opening', 20, 'other-room'); f.refresh.resolve(f.snapshot()); await pending;
  assert.equal(f.dialog.open, true); assert.equal(f.elements['room-notes-text'].value, 'Another new opening'); assert.equal(f.context.notesRevision, 20); assert.equal(f.elements['save-notes'].disabled, false);
});
test('ordinary save rejection retains the original draft and error', async () => {
  const f = fixture(), pending = f.submit(); f.save.reject(Error('Revision conflict')); await pending;
  assert.equal(f.dialog.open, true); assert.equal(f.elements['room-notes-text'].value, 'Submitted original'); assert.deepEqual(f.errors, ['Revision conflict']); assert.equal(f.elements['notes-error'].hidden, false); assert.equal(f.elements['save-notes'].disabled, false);
});
test('a closed dialog cannot submit notes', async () => {
  const f = fixture(); f.dialog.close(); await f.submit(); assert.equal(f.writes.length, 0);
});
