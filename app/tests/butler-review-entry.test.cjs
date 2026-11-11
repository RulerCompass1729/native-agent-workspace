'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const start = renderer.indexOf('// The existing butler view owns visibility and state;');
const end = renderer.indexOf('let newDirectory = false, creatingSession = false;', start);
assert.ok(start >= 0 && end > start);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  let value = { available: true, hasData: true, activation: 'off', recordPeriod: 'off' }, callbacks, entryOptions, focusCount = 0;
  const calls = [], lifecycle = [], errors = [], listeners = new Map();
  const row = { hidden: true, focus: () => focusCount++ };
  const dialog = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => { assert.equal(listeners.get(name), fn); listeners.delete(name); } };
  const api = { butlerReview: async (...args) => { calls.push(args); return value; } };
  const adapter = { open: () => lifecycle.push('read'), freeze: () => lifecycle.push('freeze'), confirm: draft => lifecycle.push(draft), dispose: () => lifecycle.push('adapter-dispose') };
  const view = { open: async () => lifecycle.push('view-open'), dispose: () => lifecycle.push('view-dispose') };
  const sandbox = { api, $: id => { assert.ok(['butler-row', 'butler-dialog', 'butler-review-dialog'].includes(id), 'No second entry may be queried'); return id === 'butler-row' ? row : dialog; },
    uiText() {}, uiError: key => Object.assign(Error('Fixed local failure'), { code: key }), toastError: error => errors.push(error),
    ui: { display: {}, showError() {}, language: { getSnapshot: () => ({ active: 'en' }) } }, document: {},
    setTimeout() { throw Error('The panel route must not poll'); },
    window: { nativeWorkspaceButlerReviewAdapter: { create: options => { assert.equal(options.api, api); return adapter; } },
      nativeWorkspaceButlerReview: { create: options => { callbacks = options; return view; } },
      nativeWorkspaceButlerEntry: { bind: options => { entryOptions = options; return {}; } } } };
  vm.createContext(sandbox); vm.runInContext(renderer.slice(start, end), sandbox);
  return { calls, lifecycle, errors, listeners, row, callbacks, entryOptions, setValue(next) { value = next; },
    open: () => entryOptions.openReview(), dispose: () => sandbox.disposeButlerReview(), focusCount: () => focusCount };
}

test('the existing butler panel owns the only review route; mounting neither reads nor freezes', () => {
  const f = fixture(); assert.deepEqual(f.calls, []); assert.deepEqual(f.lifecycle, []);
  assert.equal(f.callbacks.entry, undefined); assert.equal(f.entryOptions.row, f.row);
  assert.equal(typeof f.entryOptions.openReview, 'function');
});

test('a hidden host entry or unavailable/empty review never opens a record table', async () => {
  const f = fixture(); await f.open(); assert.equal(f.calls.length, 0);
  f.row.hidden = false;
  for (const value of [null, {}, { available: true }, { available: false, hasData: true }, { available: true, hasData: false }]) {
    f.setValue(value); await f.open(); assert.deepEqual(f.lifecycle, []);
  }
  assert.equal(f.errors.length, 5); assert.ok(f.calls.every(call => call.length === 1 && call[0] === 'availability'));
});

test('only an explicit panel action checks current data and opens once while its reply is pending', async () => {
  const f = fixture(), pending = deferred(); f.row.hidden = false; f.setValue(pending.promise);
  const first = f.open(); for (let n = 0; n < 100; n++) await f.open(); assert.equal(f.calls.length, 1);
  pending.resolve({ available: true, hasData: true }); await first;
  assert.deepEqual(f.lifecycle, ['view-open']); assert.deepEqual(f.errors, []);
});

test('closing the host entry or disposing the view suppresses a late availability reply', async () => {
  for (const dispose of [false, true]) {
    const f = fixture(), pending = deferred(); f.row.hidden = false; f.setValue(pending.promise);
    const first = f.open(); if (dispose) f.dispose(); else f.row.hidden = true;
    pending.resolve({ available: true, hasData: true }); await first;
    assert.ok(!f.lifecycle.includes('view-open'));
    if (dispose) { await f.open(); assert.equal(f.calls.length, 1); assert.equal(f.listeners.size, 0); assert.deepEqual(f.lifecycle, ['view-dispose', 'adapter-dispose']); }
  }
});

test('review close returns focus to the one visible butler row and never a hidden or disposed surface', () => {
  const f = fixture(), close = f.listeners.get('close'); f.row.hidden = false; close(); assert.equal(f.focusCount(), 1);
  f.row.hidden = true; close(); assert.equal(f.focusCount(), 1); f.dispose(); f.row.hidden = false; close(); assert.equal(f.focusCount(), 1);
});

test('read, explicit new audit and save retain their distinct durable adapter operations', () => {
  const f = fixture(); f.callbacks.read(); f.callbacks.readNew(); const draft = { token: 'test', allRead: true, marks: [] }; f.callbacks.confirm(draft);
  assert.deepEqual(f.lifecycle, ['read', 'freeze', draft]);
});
