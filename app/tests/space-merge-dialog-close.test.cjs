const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
function declaration(name) {
  const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, name);
  return source.slice(start, end + 2);
}
const start = source.indexOf("$('close-space-merge').onclick ="), end = source.indexOf('async function submitSpaceMerge(', start);
assert.ok(start >= 0 && end > start);

function fixture({ rejectDiscard = false } = {}) {
  const queuedClose = [], listeners = new Map(), calls = [], rendered = [], errors = [];
  const elements = new Map(), dialogTickets = new WeakMap();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, textContent: '', focused: false, focus() { this.focused = true; } });
    return elements.get(id);
  };
  const dialog = Object.assign(element('space-merge-dialog'), {
    open: false, isConnected: true,
    addEventListener(name, handler) { listeners.set(name, handler); },
    close() { this.open = false; queuedClose.push(() => listeners.get('close')()); },
  });
  const state = {
    rooms: [{ id: 'one', messages: [{ id: 'original-record' }] }, { id: 'two', messages: [] }],
    sessions: [{ id: 'member', nativeId: 'original-native', liveDraft: 'Positive private draft', roomIds: ['one'] }],
    viewState: { sharedDraft: 'Positive shared draft', selected: 'room', spaceId: 'one' },
  };
  const unchanged = JSON.stringify(state);
  element('message-input').value = 'Positive private draft'; element('shared-input').value = 'Positive shared draft';
  let resolvePreview;
  const preview = new Promise(resolve => { resolvePreview = resolve; });
  const context = vm.createContext({
    $: element, dialogTickets, mergeDialog: null, state, viewState: state.viewState,
    ui: { display: { unbind() {} }, showError(_element, error) { errors.push(error); } },
    attempt: action => action(), toastError: error => errors.push(error),
    mergeSpec: () => ({ sourceIds: ['one', 'two'], name: 'Combined' }),
    renderMergeBatch: batch => rendered.push(batch), updateMergePreview() {},
    api: { spaceMerge(action, spec) {
      calls.push({ action, spec: JSON.parse(JSON.stringify(spec)) });
      if (action === 'preview') return preview;
      if (action === 'discard') return rejectDiscard ? Promise.reject(Error('Unconfirmed discard')) : Promise.resolve();
      return Promise.reject(Error('Unexpected merge action: ' + action));
    } },
  });
  vm.runInContext(['currentDialogTicket', 'mergeButtons', 'mergeError'].map(declaration).join('\n') + '\n' + source.slice(start, end), context);
  function open({ operationId = null, record = null } = {}) {
    const ticket = { dialog }, selections = new Map([['one', { messages: new Set(['original-record']) }]]);
    dialog.open = true; dialogTickets.set(dialog, ticket); element('preview-space-merge').disabled = false;
    const draft = { ticket, batch: operationId ? { operationId } : null, record, selections };
    context.mergeDialog = draft;
    return draft;
  }
  return {
    context, calls, rendered, errors, dialog, open, element, resolvePreview,
    close: () => element('close-space-merge').onclick(),
    deliverClose: () => { assert.ok(queuedClose.length); queuedClose.shift()(); },
    back: () => element('back-space-merge').onclick(),
    preview: () => element('preview-space-merge').onclick(),
    assertOriginalData() {
      assert.equal(context.state, state); assert.equal(context.viewState, state.viewState);
      assert.equal(JSON.stringify(state), unchanged);
      assert.equal(element('message-input').value, 'Positive private draft');
      assert.equal(element('shared-input').value, 'Positive shared draft');
    },
  };
}

test('closing before preview sends no merge request or data mutation', () => {
  const f = fixture(); f.open(); f.close(); f.deliverClose();
  assert.equal(f.context.mergeDialog, null); assert.deepEqual(f.calls, []); f.assertOriginalData();
});

test('closing an unsubmitted preview discards its exact operation once', () => {
  const f = fixture(); f.open({ operationId: 'preview-a' }); f.close(); f.deliverClose();
  f.close(); f.deliverClose();
  assert.deepEqual(f.calls, [{ action: 'discard', spec: { operationId: 'preview-a' } }]);
  assert.equal(f.context.mergeDialog, null); f.assertOriginalData();
});

test('closing a committed merge record never discards its batch', () => {
  const f = fixture(), record = { stage: 'ready', targetId: 'combined' };
  const draft = f.open({ operationId: 'committed-a', record }); f.close(); f.deliverClose();
  assert.deepEqual(f.calls, []); assert.equal(draft.record, record); f.assertOriginalData();
});

test('Back discards the preview while retaining original choices for another preview', () => {
  const f = fixture(), draft = f.open({ operationId: 'preview-a' }), choices = draft.selections;
  f.back(); f.back();
  assert.equal(f.context.mergeDialog, draft); assert.equal(draft.selections, choices); assert.equal(draft.batch, null);
  assert.equal(f.element('space-merge-options').hidden, false); assert.equal(f.element('space-merge-preview').hidden, true);
  assert.deepEqual(f.calls, [{ action: 'discard', spec: { operationId: 'preview-a' } }]); f.assertOriginalData();
});

test('a queued old close cannot clear or discard a newly opened preview', () => {
  const f = fixture(); f.open({ operationId: 'preview-a' }); f.close();
  const next = f.open({ operationId: 'preview-b' }); f.deliverClose();
  assert.equal(f.context.mergeDialog, next); assert.equal(next.batch.operationId, 'preview-b');
  assert.deepEqual(f.calls, []); f.assertOriginalData();
});

for (const reopen of [false, true]) test('a preview arriving after close is discarded without replacing ' + (reopen ? 'the new dialog' : 'the closed dialog'), async () => {
  const f = fixture(); f.open(); const pending = f.preview();
  f.close(); f.deliverClose(); const next = reopen ? f.open({ operationId: 'preview-b' }) : null;
  f.resolvePreview({ operationId: 'late-a' }); await pending;
  assert.equal(f.context.mergeDialog, next); if (next) assert.equal(next.batch.operationId, 'preview-b');
  assert.deepEqual(f.calls, [
    { action: 'preview', spec: { sourceIds: ['one', 'two'], name: 'Combined' } },
    { action: 'discard', spec: { operationId: 'late-a' } },
  ]);
  assert.deepEqual(f.rendered, []); assert.equal(f.element('confirm-space-merge').focused, false); f.assertOriginalData();
});

test('an unconfirmed discard does not retry or submit a merge after close', async () => {
  const f = fixture({ rejectDiscard: true }); f.open({ operationId: 'preview-a' }); f.close(); f.deliverClose();
  await Promise.resolve();
  assert.deepEqual(f.calls, [{ action: 'discard', spec: { operationId: 'preview-a' } }]);
  assert.equal(f.context.mergeDialog, null); f.assertOriginalData();
});
