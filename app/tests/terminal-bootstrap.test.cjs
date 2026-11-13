const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
function between(start, end) {
  const a = renderer.indexOf(start), b = renderer.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'Use the actual renderer function');
  return renderer.slice(a, b);
}
const functions = [
  between('function updateState(', '\n// Like a native TUI queue'),
  between('function currentTerminalDisplay(', '\nfunction canCaptureTerminal('),
  between('function terminalCanInput(', '\nfunction currentTerminalDisplay('),
  between('function focusTerminal(', '\n// 原生终端'),
  between('function restoreTerminalContinuation(', '\nconst disposers'),
  between('async function ensureTerminal(', '\nfunction fitTerminal(')
].join('\n');
const bootstrap = between('  entry.pending = (async () => {', '\n  return entry.pending;');

async function hydrate(change, snapshotEpoch = 'A') {
  let releaseWrite, writeStarted;
  const writing = new Promise(resolve => { writeStarted = resolve; });
  const calls = { snapshot: 0, initial: 0, mounts: 0, renders: 0, fits: 0, focus: 0, input: 0 };
  const record = { id: 's', nativeId: 'synthetic-native', connectionRevision: 0, terminalState: { epoch: 'A', alive: true }, owner: 'view', view: 'terminal', state: 'idle', liveDraft: 'ORIGINAL UNSENT DRAFT' };
  const writes = [], term = { options: {}, textarea: {}, resize() {}, focus() { calls.focus++; }, write(data, done) { writes.push(data); if (data === 'SNAPSHOT') { releaseWrite = done; writeStarted(); } else done?.(); } };
  const entry = { term, nativeId: record.nativeId, generation: 0, ready: false, queued: [{ id: 's', epoch: 'A', sequence: 11, index: 11, kind: 'output', data: 'QUEUED' }] };
  const surface = { hidden: true, inert: true }, loading = { removed: false, remove() { this.removed = true; } };
  const c = vm.createContext({ Promise, Map, Number, Boolean, id: 's', owner: 'view', entry, term, surface, loading, state: { sessions: [record] }, terminals: new Map([['s', entry]]), intent: 1, selectionRevision: 1,
    projectSpace: s => s, legacyProgressOffline: () => false, latestViewStorage: undefined, sessionComposers: new Map(), queuedInputs: new Map(), queuedRoomInputs: new Map(), shownKnown: new Set(),
    columnTerminalBinding: () => false, terminalContextVisible: () => true, nativeUsable: s => s?.state === 'idle', inputFocusAllowed: () => true, canCaptureTerminal: () => false, disconnected: false,
    activeSessionId: () => 's', syncTerminalMount() { calls.mounts++; }, fitTerminal() { calls.fits++; }, render() { calls.renders++; }, revealTerminalCursor() {}, document: { activeElement: null },
    uiError: key => new Error(key), ui: { display: { text(node, key) { node.key = key; } } },
    api: { async terminalSnapshot() { calls.snapshot++; return { buffer: 'SNAPSHOT', epoch: snapshotEpoch ?? undefined, sequence: 10, observationIndex: 10, cols: 20, rows: 5 }; }, async initial() { calls.initial++; return c.state; }, input() { calls.input++; throw Error('No native input in this test'); } }
  });
  vm.runInContext(functions, c);
  const pending = vm.runInContext(bootstrap + '\nentry.pending', c); pending.catch(() => {});
  await writing;
  if (change === 'replaced') c.terminals.set('s', { ready: false, pending: Promise.resolve() });
  else if (change) {
    const terminalState = change === 'epoch' ? { epoch: 'B', alive: true } : change === 'ended' ? { epoch: 'A', alive: false } : { alive: true };
    c.updateState({ sessions: [{ ...record, terminalState }] });
    // render's actual existing-entry reconciliation must not hide this race.
    c.ensureTerminal('s').catch(() => {});
    assert.equal(c.terminals.get('s'), entry);
  }
  releaseWrite(); let error;
  try { await pending; } catch (e) { error = e.message; }
  assert.equal(c.state.sessions[0].nativeId, record.nativeId);
  assert.equal(c.state.sessions[0].owner, record.owner);
  assert.equal(c.state.sessions[0].liveDraft, record.liveDraft);
  assert.equal(calls.snapshot, 1); assert.equal(calls.initial, 0); assert.equal(calls.input, 0);
  return { entry, surface, loading, writes, calls, error, inputAllowed: c.terminalCanInput('s') };
}

test('unchanged display finishes its snapshot and queued native output once', async () => {
  const r = await hydrate();
  assert.equal(r.error, undefined); assert.equal(r.entry.ready, true); assert.equal(r.surface.hidden, false); assert.equal(r.surface.inert, false); assert.equal(r.loading.removed, true);
  assert.deepEqual(r.writes, ['SNAPSHOT', 'QUEUED']); assert.equal(r.inputAllowed, true); assert.equal(r.calls.focus, 1);
});
test('epoch drift during snapshot write fails before ready, visibility and queued output', async () => {
  const r = await hydrate('epoch');
  assert.equal(r.error, 'error.terminalViewChanged'); assert.equal(r.entry.ready, false); assert.equal(r.entry.failed, true); assert.equal(r.surface.hidden, true); assert.equal(r.surface.inert, true);
  assert.equal(r.loading.removed, false); assert.equal(r.loading.key, 'terminal.connectFailed'); assert.equal(r.entry.queued.length, 0);
  assert.deepEqual(r.writes, ['SNAPSHOT']); assert.equal(r.calls.renders, 0); assert.equal(r.calls.fits, 0); assert.equal(r.calls.focus, 0); assert.equal(r.inputAllowed, false);
});
test('a replaced entry stays unpublished without failing the replacement', async () => {
  const r = await hydrate('replaced');
  assert.equal(r.error, undefined); assert.equal(r.entry.ready, false); assert.equal(r.entry.failed, undefined); assert.equal(r.surface.hidden, true);
  assert.deepEqual(r.writes, ['SNAPSHOT']); assert.equal(r.calls.focus, 0);
});
test('a legacy snapshot without an epoch keeps its existing display behavior', async () => {
  const r = await hydrate(undefined, null);
  assert.equal(r.entry.epoch, undefined); assert.equal(r.error, undefined); assert.equal(r.entry.ready, true); assert.equal(r.surface.hidden, false);
  assert.deepEqual(r.writes, ['SNAPSHOT', 'QUEUED']);
});
test('a legacy state without an epoch is not mistaken for a proved mismatch', async () => {
  const r = await hydrate('legacy');
  assert.equal(r.error, undefined); assert.equal(r.entry.ready, true); assert.equal(r.surface.hidden, false);
  assert.deepEqual(r.writes, ['SNAPSHOT', 'QUEUED']);
});
test('an ended display with the same epoch remains readable and cannot take input', async () => {
  const r = await hydrate('ended');
  assert.equal(r.error, undefined); assert.equal(r.entry.ready, true); assert.equal(r.surface.hidden, false); assert.equal(r.inputAllowed, false);
  assert.deepEqual(r.writes, ['SNAPSHOT', 'QUEUED']);
});
