const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const cp = require('node:child_process'), { createRequire } = require('node:module');
const { Terminal: Screen } = require('@xterm/headless');
const continuation = require('../terminal-continuation.js');
const { TerminalJournal } = require('../observation.cjs');
const { LegacyObservation } = require('../legacy-observation.cjs');
const adapter = require.resolve('../adapters.cjs'), requireAt = createRequire(adapter);
const adapterSource = fs.readFileSync(adapter, 'utf8');
const factoryStart = adapterSource.indexOf('function createTerminalSerializeAddon()');
const factoryEnd = adapterSource.indexOf('\nconst delay =', factoryStart);
assert.ok(factoryStart >= 0 && factoryEnd > factoryStart);
const Addon = vm.runInNewContext(adapterSource.slice(factoryStart, factoryEnd) + '\ncreateTerminalSerializeAddon()',
  { fs, path, crypto, require: requireAt, module, Buffer, console });
const processMethods = ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync'];
const savedProcessMethods = Object.fromEntries(processMethods.map(name => [name, cp[name]]));
let Terminal;
try {
  for (const name of processMethods) cp[name] = () => { throw Error('Continuation flow tests cannot launch native or provider processes'); };
  Terminal = require('../adapters.cjs').Terminal;
} finally { Object.assign(cp, savedProcessMethods); }
const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const rendererStart = renderer.indexOf('function restoreTerminalContinuation(');
const rendererEnd = renderer.indexOf('\nconst disposers = [', rendererStart);
assert.ok(rendererStart >= 0 && rendererEnd > rendererStart);
const ESC = '\x1b', uri = 'https://example.invalid/flow';
const hidden = ESC + '7' + ESC + ']8;;' + uri + ESC + '\\B' + ESC + '8';
const clone = value => JSON.parse(JSON.stringify(value));
const write = (term, value = '') => new Promise(resolve => term.write(value, resolve));
function screen(t, cols = 20, rows = 5) {
  const term = new Screen({ cols, rows, scrollback: 10, allowProposedApi: true }), addon = new Addon();
  term.loadAddon(addon); t.after(() => term.dispose()); return { term, addon };
}
function sourceTerminal(source, { sequence = 7, flags = 9 } = {}) {
  // The real production methods run without executing its PTY constructor.
  return Object.assign(Object.create(Terminal.prototype), { screen: source.term, serialize: source.addon,
    cursorModes: { snapshot: () => '' }, keyboardModes: { flags },
    journal: new TerminalJournal(source.term.cols, source.term.rows), sequence, pid: 12345, alive: true });
}
function visible(term) {
  const groups = new Map(), service = term._core._oscLinkService;
  const group = id => {
    const data = id && service.getLinkData(id); if (!data) return null;
    if (!groups.has(id)) groups.set(id, groups.size + 1);
    return { uri: data.uri, group: groups.get(id) };
  };
  const b = term.buffer.active;
  const rows = Array.from({ length: b.length }, (_, y) => {
    const line = b.getLine(y);
    return { wrapped: line.isWrapped, cells: Array.from({ length: line.length }, (_, x) => {
      const c = line.getCell(x);
      return [c.getChars(), c.getWidth(), c.fg, c.bg, c.hasExtendedAttrs() ? c.extended.ext : 0,
        group(c.hasExtendedAttrs() ? c.extended.urlId : 0)];
    }) };
  });
  const p = term._core._inputHandler._curAttrData;
  return { cols: term.cols, rows: term.rows, active: b.type, x: b.cursorX, y: b.cursorY, base: b.baseY,
    lines: rows, pen: [p.fg, p.bg, p.extended.ext, group(p.extended.urlId)] };
}
function rendererFixture(t, target = screen(t)) {
  const id = 'synthetic-session', terminals = new Map(), errors = [], calls = [];
  const entry = { term: target.term, epoch: 'native-epoch', sequence: 0, observationIndex: 0,
    ready: true, failed: false, queued: [], keyboardFlags: 0, columnReading: true };
  terminals.set(id, entry);
  const api = new Proxy({}, { get: (_object, name) => () => { calls.push(name); throw Error('No native API in replay'); } });
  const context = { window: { nativeWorkspaceTerminalContinuation: continuation }, terminals,
    document: { activeElement: null }, api, uiError: code => Error(code),
    render() {}, toastError: error => errors.push(error.message), revealTerminalCursor() { throw Error('No focus change'); } };
  const functions = vm.runInNewContext(renderer.slice(rendererStart, rendererEnd) + '\n({writeTerminal,flushTerminalEvents})', context);
  return { ...target, ...functions, id, terminals, entry, errors, calls };
}
function eventFor(target, frame, extra = {}) {
  return { id: target.id, epoch: target.entry.epoch, sequence: 1, index: 1,
    kind: 'snapshot', cols: frame.cols || 20, rows: frame.rows || 5,
    data: ESC + 'c' + frame.buffer, continuation: frame.continuation, keyboardFlags: 13, ...extra };
}
function holdBarrier(target) {
  const originalWrite = target.term.write.bind(target.term), originalResize = target.term.resize.bind(target.term);
  const operations = []; let release, held = false, arrive;
  const waiting = new Promise(resolve => { arrive = resolve; });
  target.term.write = (data, done) => {
    operations.push(['write', data]);
    if (!held && data === '' && typeof done === 'function') {
      held = true; return originalWrite(data, () => { release = done; arrive(); });
    }
    return originalWrite(data, done);
  };
  target.term.resize = (cols, rows) => { operations.push(['resize', cols, rows]); return originalResize(cols, rows); };
  return { operations, waiting, release: () => { assert.equal(typeof release, 'function'); release(); },
    drain: () => new Promise(resolve => originalWrite('', resolve)) };
}

test('real Terminal snapshot and observation retain paired state plus existing identity and keyboard fields', async t => {
  const source = screen(t); await write(source.term, hidden);
  const terminal = sourceTerminal(source), before = visible(source.term), frame = await terminal.snapshot();
  assert.equal(continuation.validate(frame.continuation), true);
  assert.equal(frame.sequence, 7); assert.equal(frame.epoch, terminal.journal.epoch);
  assert.equal(frame.observationIndex, 0); assert.equal(frame.pid, 12345);
  assert.equal(frame.keyboardFlags, 9); assert.equal(frame.cursorModesVersion, 1);
  assert.equal(frame.cols, 20); assert.equal(frame.rows, 5); assert.deepEqual(visible(source.term), before);
  terminal.journal.maxEvents = 0;
  const output = terminal.journal.append('output', 'native delta', 20, 5, () => terminal.serializeFrame());
  const observed = await terminal.observe();
  assert.equal(output.checkpointRequired, true); assert.equal(observed.alive, true);
  assert.equal(observed.epoch, frame.epoch); assert.equal(observed.checkpoint.index, output.index);
  assert.equal(continuation.validate(observed.checkpoint.continuation), true);
});

test('paired checkpoint cap rejects the whole checkpoint while the unchanged legacy string contract still fits', async t => {
  const source = screen(t); await write(source.term, hidden); const frame = source.addon.serializeSnapshot();
  const limit = Buffer.byteLength(JSON.stringify(frame.buffer));
  const paired = new TerminalJournal(20, 5, { maxEvents: 0, maxCheckpointBytes: limit });
  paired.append('output', 'X', 20, 5, () => frame);
  assert.equal(paired.checkpoint, null); assert.deepEqual(paired.events, []);
  assert.equal(paired.truncated, true); assert.equal(typeof paired.snapshot().unavailable, 'string');
  const legacy = new TerminalJournal(20, 5, { maxEvents: 0, maxCheckpointBytes: limit });
  legacy.append('output', 'X', 20, 5, () => frame.buffer);
  assert.equal(legacy.checkpoint.buffer, frame.buffer);
  assert.equal(legacy.checkpoint.continuation, undefined);
});

test('snapshot-event metadata is counted against event bytes and cannot bypass journal rollover', async t => {
  const source = screen(t); await write(source.term, hidden); const frame = source.addon.serializeSnapshot();
  const journal = new TerminalJournal(20, 5);
  const event = journal.append('snapshot', ESC + 'c' + frame.buffer, 20, 5, () => frame, frame.continuation);
  assert.equal(journal.bytes, Buffer.byteLength(JSON.stringify(event)));
  const small = new TerminalJournal(20, 5), stripped = { ...event, epoch: small.epoch };
  delete stripped.continuation; small.maxBytes = Buffer.byteLength(JSON.stringify(stripped));
  const next = small.append('snapshot', ESC + 'c' + frame.buffer, 20, 5, () => frame, frame.continuation);
  assert.equal(next.checkpointRequired, true); assert.deepEqual(small.events, []);
  assert.equal(small.checkpoint.continuation, frame.continuation);
});

test('legacy observation forwards paired event and checkpoint, and does not skip a same-sequence new epoch', async t => {
  const source = screen(t); await write(source.term, hidden);
  let frame = { ...source.addon.serializeSnapshot(), cols: 20, rows: 5, sequence: 3, epoch: 'first-native-epoch' };
  const published = [], observer = new LegacyObservation(async () => frame, event => published.push(event));
  t.after(() => observer.dispose()); observer.journal.maxEvents = 0;
  const initial = await observer.observe();
  assert.equal(published.length, 1); assert.equal(published[0].data, ESC + 'c' + frame.buffer);
  assert.equal(published[0].continuation, frame.continuation);
  assert.equal(initial.terminal.checkpoint.continuation, frame.continuation);
  await observer.capture(); assert.equal(published.length, 1, 'Exactly unchanged legacy snapshots are still coalesced');
  frame = { ...frame, epoch: 'replacement-native-epoch' }; await observer.capture();
  assert.equal(published.length, 2); assert.equal(published[1].index, 2);
});

test('legacy missing/future state stays compatible and malformed known state publishes nothing', async t => {
  const source = screen(t); await write(source.term, 'LEGACY'); const known = source.addon.serializeSnapshot();
  let frame = { ...known, cols: 20, rows: 5, sequence: 0, epoch: 'legacy-a', continuation: undefined };
  const published = [], observer = new LegacyObservation(async () => frame, event => published.push(event));
  t.after(() => observer.dispose()); await observer.observe();
  assert.equal(published.length, 1); assert.equal(published[0].continuation, undefined);
  frame = { ...frame, epoch: 'legacy-b', continuation: { version: 999 } }; await observer.capture();
  assert.equal(published.length, 2); assert.equal(published[1].continuation, undefined);
  const before = { last: [...observer.last], index: observer.journal.index, bytes: observer.journal.bytes };
  const bad = clone(known.continuation); bad.pen.bg = 'invalid';
  frame = { ...frame, epoch: 'legacy-c', continuation: bad };
  await assert.rejects(observer.capture(), error => error.uiMessage?.key === 'error.legacy.nativeScreenInvalid');
  assert.equal(published.length, 2); assert.deepEqual(observer.last, before.last);
  assert.equal(observer.journal.index, before.index); assert.equal(observer.journal.bytes, before.bytes);
});

test('real receiver snapshot restoration completes before queued resize and the next native SGR output', async t => {
  const source = screen(t); await write(source.term, hidden);
  const frame = await sourceTerminal(source).snapshot(), target = rendererFixture(t), held = holdBarrier(target);
  target.writeTerminal(target.entry, eventFor(target, frame)); await held.waiting;
  assert.equal(target.entry.ready, true);
  assert.equal(target.entry.restoring, true);
  target.writeTerminal(target.entry, { id: target.id, epoch: target.entry.epoch, sequence: 1, index: 2, kind: 'resize', cols: 30, rows: 5 });
  target.writeTerminal(target.entry, { id: target.id, epoch: target.entry.epoch, sequence: 2, index: 3, kind: 'output', data: ESC + '[4mC', keyboardFlags: 21 });
  assert.equal(target.entry.queued.length, 2); assert.deepEqual(held.operations, [['write', '']]);
  held.release(); await target.entry.pending; await held.drain();
  source.term.resize(30, 5); await write(source.term, ESC + '[4mC');
  assert.deepEqual(visible(target.term), visible(source.term));
  assert.equal(target.entry.ready, true); assert.equal(target.entry.failed, false);
  assert.equal(target.entry.queued.length, 0); assert.equal(target.entry.sequence, 2);
  assert.equal(target.entry.observationIndex, 3); assert.equal(target.entry.keyboardFlags, 21);
  assert.deepEqual(target.errors, []); assert.deepEqual(target.calls, []);
});

test('known invalid snapshot is refused before reset/resize/write and disables input readiness without retry', async t => {
  const source = screen(t); await write(source.term, hidden);
  const frame = await sourceTerminal(source).snapshot(), target = rendererFixture(t);
  await write(target.term, 'KEEP'); const before = visible(target.term), held = holdBarrier(target);
  const bad = clone(frame.continuation); bad.pen.bg = 'invalid';
  target.writeTerminal(target.entry, eventFor(target, frame, { continuation: bad }));
  assert.deepEqual(held.operations, []); assert.deepEqual(visible(target.term), before);
  assert.equal(target.entry.failed, true); assert.equal(target.entry.ready, false);
  assert.equal(target.errors.length, 1); assert.deepEqual(target.calls, []);
  target.writeTerminal(target.entry, { id: target.id, epoch: target.entry.epoch, sequence: 2, index: 2, kind: 'output', data: 'NO RETRY' });
  assert.deepEqual(held.operations, []); assert.equal(target.entry.queued.length, 0);
});

test('retired entry cannot receive the snapshot held at its real write barrier', async t => {
  const source = screen(t); await write(source.term, hidden);
  const frame = await sourceTerminal(source).snapshot(), target = rendererFixture(t), held = holdBarrier(target);
  target.writeTerminal(target.entry, eventFor(target, frame)); await held.waiting;
  const replacement = { ready: true, label: 'new view' }; target.terminals.set(target.id, replacement);
  held.release(); await target.entry.pending; await held.drain();
  assert.deepEqual(held.operations, [['write', '']]);
  assert.equal(target.terminals.get(target.id), replacement); assert.equal(replacement.ready, true);
  assert.equal(target.term.buffer.active.getLine(0).translateToString(true), '');
  assert.deepEqual(target.calls, []);
});

test('old epoch is rejected immediately and an epoch change during the barrier prevents replay', async t => {
  const source = screen(t); await write(source.term, hidden);
  const frame = await sourceTerminal(source).snapshot(), target = rendererFixture(t), held = holdBarrier(target);
  target.writeTerminal(target.entry, eventFor(target, frame, { epoch: 'old-native-epoch' }));
  assert.deepEqual(held.operations, []); assert.equal(target.entry.ready, true);
  target.writeTerminal(target.entry, eventFor(target, frame)); await held.waiting;
  target.entry.epoch = 'new-native-epoch'; held.release(); await target.entry.pending; await held.drain();
  assert.deepEqual(held.operations, [['write', '']]); assert.equal(target.entry.ready, false);
  assert.equal(target.term.buffer.active.getLine(0).translateToString(true), '');
  assert.deepEqual(target.calls, []);
});

test('future snapshot metadata replays existing text and subsequent output without becoming an input error', async t => {
  const source = screen(t); await write(source.term, 'LEGACY');
  const frame = await sourceTerminal(source).snapshot(), target = rendererFixture(t);
  target.writeTerminal(target.entry, eventFor(target, frame, { continuation: { version: 999 } }));
  await target.entry.pending; await write(target.term);
  target.writeTerminal(target.entry, { id: target.id, epoch: target.entry.epoch, sequence: 2, index: 2, kind: 'output', data: ' NEXT' });
  await write(target.term);
  assert.equal(target.term.buffer.active.getLine(0).translateToString(true), 'LEGACY NEXT');
  assert.equal(target.entry.ready, true); assert.equal(target.entry.failed, false);
  assert.deepEqual(target.errors, []); assert.deepEqual(target.calls, []);
});


test('live snapshot replay keeps already-authorized human input and rejects an owner or connection change', async t => {
  const source = screen(t); await write(source.term, hidden);
  const frame = await sourceTerminal(source).snapshot(), target = rendererFixture(t), held = holdBarrier(target);
  const record = { id: target.id, owner: 'synthetic-owner', view: 'terminal', connectionRevision: 0,
    nativeId: 'synthetic-native', terminalState: { alive: true, epoch: target.entry.epoch } };
  Object.assign(target.entry, { generation: 0, nativeId: record.nativeId });
  const calls = []; let input;
  const start = renderer.indexOf('function terminalCanInput('), end = renderer.indexOf('\nfunction cancelViewInput(', start);
  const onDataStart = renderer.indexOf('  term.onData(data => {'), onDataEnd = renderer.indexOf('\n  let confirmingEnter', onDataStart);
  assert.ok(start >= 0 && end > start && onDataStart >= 0 && onDataEnd > onDataStart);
  const context = { terminals: target.terminals, state: { sessions: [record] }, owner: record.owner, disconnected: false,
    terminalContextVisible: () => true, nativeUsable: () => true, columnTerminalBinding: () => null,
    id: target.id, entry: target.entry, term: { onData: callback => { input = callback; } },
    api: { input: (id, data) => { calls.push([id, data]); return Promise.resolve(); } },
    uiError: code => Error(code), preserveUnconfirmed() { throw Error('Unexpected input uncertainty'); },
    toastError(error) { throw error; }, render() {} };
  const gate = vm.runInNewContext(renderer.slice(start, end) + '\nterminalCanInput', context);
  context.canCaptureTerminal = () => false; context.canFlushComposition = () => false;
  vm.runInNewContext(renderer.slice(onDataStart, onDataEnd), context);
  assert.equal(gate(target.id), true);
  target.writeTerminal(target.entry, eventFor(target, frame)); await held.waiting;
  try {
    assert.equal(target.entry.keyboardFlags, 13, 'Accepted native keyboard modes must not wait for display parsing');
    target.writeTerminal(target.entry, { id: target.id, epoch: target.entry.epoch, sequence: 2, index: 2, kind: 'output', data: ' NEXT', keyboardFlags: 21 });
    assert.equal(target.entry.keyboardFlags, 21, 'Queued newer native output still controls current key encoding');
    input('a');
    assert.deepEqual(calls, [[target.id, 'a']], 'A replay barrier must not drop a legitimate human key');
    record.owner = 'another-owner'; input('b');
    assert.deepEqual(calls, [[target.id, 'a']], 'Replay does not bypass the existing ownership guard');
    record.owner = context.owner; record.connectionRevision++; input('c');
    assert.deepEqual(calls, [[target.id, 'a']], 'Replay does not bypass the existing connection guard');
  } finally { held.release(); await target.entry.pending; await held.drain(); }
  assert.equal(target.entry.keyboardFlags, 21, 'Older display replay cannot roll back the current key encoding');
});
