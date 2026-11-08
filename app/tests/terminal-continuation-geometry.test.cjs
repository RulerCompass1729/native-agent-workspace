const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util'), { createRequire } = require('node:module');
const { Terminal: Screen } = require('@xterm/headless');
const continuation = require('../terminal-continuation.js');
const adapter = require.resolve('../adapters.cjs'), requireAt = createRequire(adapter);
const code = fs.readFileSync(adapter, 'utf8'), start = code.indexOf('function createTerminalSerializeAddon()');
const end = code.indexOf('\nconst delay =', start); assert.ok(start >= 0 && end > start);
const Addon = vm.runInNewContext(code.slice(start, end) + '\ncreateTerminalSerializeAddon()',
  { fs, path, crypto, require: requireAt, module, Buffer, console });
const ESC = '\x1b', open = (id = '') => ESC + ']8;' + (id ? 'id=' + id : '') + ';https://example.invalid/grid' + ESC + '\\';
const close = ESC + ']8;;' + ESC + '\\';
const write = (screen, data = '') => new Promise(resolve => screen.write(data, resolve));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function screen(t, cols, rows) {
  const term = new Screen({ cols, rows, scrollback: 5000, allowProposedApi: true }), addon = new Addon();
  term.loadAddon(addon); t.after(() => term.dispose()); return { term, addon };
}
function capture(term) {
  const identities = new Map(), core = term._core, result = { cols: term.cols, rows: term.rows,
    active: term.buffer.active.type, modes: term.modes, buffers: {} };
  const link = id => {
    if (!id) return null;
    const data = core._oscLinkService.getLinkData(id); if (!data) return { unresolved: true };
    if (!identities.has(id)) identities.set(id, identities.size + 1);
    return { uri: data.uri, group: identities.get(id) };
  };
  for (const name of ['normal', 'alternate']) {
    const b = term.buffer[name], backing = core._bufferService.buffers[name === 'normal' ? 'normal' : 'alt'];
    result.buffers[name] = { x: b.cursorX, y: b.cursorY, base: b.baseY,
      savedX: backing.savedX, savedY: backing.savedY,
      lines: Array.from({ length: b.length }, (_, y) => {
        const row = b.getLine(y);
        return { length: row.length, isWrapped: row.isWrapped,
          // Include every backing cell, including the columns hidden by the current grid.
          cells: Array.from({ length: row.length }, (_, x) => {
            const cell = row.getCell(x), id = cell.hasExtendedAttrs() ? cell.extended.urlId : 0;
            const attr = cell.clone(); attr.extended.urlId = 0; attr.updateExtended();
            return [cell.getChars(), cell.getWidth(), attr.fg, attr.bg, attr.extended.ext, link(id)];
          }) };
      }),
      visible: Array.from({ length: term.rows }, (_, y) => b.getLine(b.baseY + y)?.translateToString(false, 0, term.cols) ?? null) };
  }
  const pen = core._inputHandler._curAttrData;
  result.pen = { fg: pen.fg, bg: pen.bg, ext: pen.extended.ext, link: link(pen.extended.urlId) };
  return result;
}
function firstDifference(source, receiver, at = '$') {
  if (isDeepStrictEqual(source, receiver)) return null;
  if (!source || !receiver || typeof source !== 'object' || typeof receiver !== 'object') return { at, source, receiver };
  if (Array.isArray(source) && source.length !== receiver.length) return { at: at + '.length', source: source.length, receiver: receiver.length };
  for (const key of new Set([...Object.keys(source), ...Object.keys(receiver)])) {
    const found = firstDifference(source[key], receiver[key], at + '.' + key); if (found) return found;
  }
  return { at, source, receiver };
}
async function replay(t, source) {
  const before = capture(source.term), frame = source.addon.serializeSnapshot();
  assert.deepEqual(capture(source.term), before, 'Current serialization cannot mutate its source backing cells or cursor');
  const target = screen(t, source.term.cols, source.term.rows); let restorationError = null;
  await write(target.term, frame.buffer);
  try {
    if (continuation.validate(frame.continuation) !== true) restorationError = 'Current geometry frame omitted continuation';
    else if (continuation.restore(target.term, frame.continuation) !== true) restorationError = 'Current geometry continuation was not restored';
  } catch (error) { restorationError = error.message; }
  return { ...target, frame, restorationError };
}

// These eight inputs are verbatim selections from C4's original X1 probe-contract.cjs.
// Only the CURRENT production factory/state is run; the old private candidate is not loaded.
const cases = [
  ['color70', ESC + '[38;2;12;145;231m' + 'C'.repeat(70) + 'END'],
  ['explicit70', open('native') + 'A'.repeat(70) + close + 'B'],
  ['anonymous70', open() + 'A'.repeat(70) + close + 'B'],
  ['wideCombined', '中e\u0301'.repeat(35)],
  ['wideEdge', 'A'.repeat(24) + '中' + 'B'.repeat(30)],
  ['alternateAscii', 'NORMAL' + ESC + '[?1049h' + 'A'.repeat(70) + 'B'],
  ['alternateWide', 'NORMAL' + ESC + '[?1049h' + 'A'.repeat(24) + '中' + 'B'.repeat(30)],
  ['erasedWrap', ESC + '[44m' + 'A'.repeat(70) + ESC + '[49m' + ESC + '[H' + ESC + '[2K'],
];
for (const [name, input] of cases) test('current continuation retains full backing geometry through shrink/replay/regrow: ' + name, async t => {
  const source = screen(t, 100, 30), stages = [], failures = [];
  source.term.resize(40, 5); await write(source.term, ESC + '[6 q' + input);
  source.term.resize(25, 5); await write(source.term);
  const target = await replay(t, source);
  if (target.restorationError) failures.push({ stage: 'initial25.restore', error: target.restorationError });
  function record(label, receiver = target) {
    const a = capture(source.term), b = capture(receiver.term), difference = firstDifference(a, b);
    stages.push({ label, source: a, receiver: b });
    if (difference) failures.push({ stage: label, sourceDigest: hash(a), receiverDigest: hash(b), firstDifference: difference });
  }
  record('initial25');
  await write(source.term, 'NEXT'); await write(target.term, 'NEXT'); record('NEXT25');
  const repeated = await replay(t, source);
  if (repeated.restorationError) failures.push({ stage: 'repeated25.restore', error: repeated.restorationError });
  record('repeated25', repeated);
  for (const cols of [30, 40]) {
    source.term.resize(cols, 5); target.term.resize(cols, 5); repeated.term.resize(cols, 5);
    await write(source.term); await write(target.term); await write(repeated.term);
    record('grow' + cols); record('repeatedGrow' + cols, repeated);
  }
  if (name.startsWith('alternate')) {
    for (const term of [source.term, target.term, repeated.term]) await write(term, ESC + '[?1049l');
    record('leaveAlternate'); record('repeatedLeaveAlternate', repeated);
  }
  // A later ordinary clear must not retain replay-only cells or change the native grid.
  for (const term of [source.term, target.term, repeated.term]) await write(term, ESC + '[2J' + ESC + '[H' + 'AFTER CLEAR');
  record('clear40'); record('repeatedClear40', repeated);
  t.diagnostic(JSON.stringify({ kind: 'CURRENT_IMPLEMENTATION_X1_GEOMETRY', name,
    input, history: '100x30→40x5; write ESC[6q+input; shrink25x5; snapshot/replay at25 only; NEXT; repeat; grow30→40; optional leaveAlt; ED2; cursor home; AFTER CLEAR',
    normalization: 'Only allocator-local hyperlink IDs are compared as URI/group partitions; all backing lengths/cells/attributes/isWrapped are retained',
    failures, stages }));
  assert.deepEqual(failures, [], 'Current source/replay backing cells, geometry and subsequent visible output must agree');
});

const linkedBoundary = open() + 'A'.repeat(12) + close + open() + 'B'.repeat(12) + close +
  open('native') + '中' + 'C'.repeat(20) + close;
async function repairedFixture(t) {
  const source = screen(t, 100, 30);
  source.term.resize(40, 5); await write(source.term, linkedBoundary);
  source.term.resize(25, 5); await write(source.term);
  const target = await replay(t, source);
  assert.equal(target.restorationError, null);
  assert.ok(target.frame.continuation.buffers.normal.repairRows?.length, 'The positive fixture must require actual backing-row repair');
  assert.ok(target.frame.continuation.links?.length >= 3, 'The repaired rows must carry two anonymous groups and one explicit group');
  return { source, target };
}
function mutationWitness(term) {
  const core = term._core, buffers = core._bufferService.buffers, service = core._oscLinkService;
  return { content: capture(term), nextLink: service._nextId,
    links: [...service._dataByLinkId].map(([id, entry]) => ({ id, data: { ...entry.data },
      markers: entry.lines.map(marker => ({ buffer: ['normal', 'alt'].find(name => buffers[name].markers.includes(marker)), line: marker.line })) })) };
}
function rejectBeforeMutation(fixture, state) {
  const before = mutationWitness(fixture.target.term), sourceBefore = mutationWitness(fixture.source.term);
  assert.throws(() => continuation.validate(state));
  assert.throws(() => continuation.restore(fixture.target.term, state));
  assert.deepEqual(mutationWitness(fixture.target.term), before, 'Invalid rows cannot change cells, allocate link IDs or alter marker lifetime');
  assert.deepEqual(mutationWitness(fixture.source.term), sourceBefore);
}

test('repaired partial-wide rows preserve distinct anonymous and explicit link groups through repeat and regrow', async t => {
  const { source, target } = await repairedFixture(t);
  function assertGroups(term) {
    const line = term.buffer.normal.getLine(0), service = term._core._oscLinkService;
    const ids = [0, 12, 24].map(x => line.getCell(x).extended.urlId);
    assert.equal(new Set(ids).size, 3); assert.ok(ids.every(id => id > 0));
    assert.ok(ids.every(id => service.getLinkData(id)?.uri === 'https://example.invalid/grid'));
    assert.equal(service.getLinkData(ids[2]).id, 'native');
  }
  assertGroups(source.term); assertGroups(target.term);
  const repeated = await replay(t, target); assert.equal(repeated.restorationError, null);
  for (const term of [source.term, target.term, repeated.term]) await write(term, 'NEXT');
  assert.deepEqual(capture(target.term), capture(source.term)); assert.deepEqual(capture(repeated.term), capture(source.term));
  for (const cols of [30, 40]) {
    for (const term of [source.term, target.term, repeated.term]) { term.resize(cols, 5); await write(term); }
    assert.deepEqual(capture(target.term), capture(source.term)); assert.deepEqual(capture(repeated.term), capture(source.term));
    assertGroups(source.term); assertGroups(target.term); assertGroups(repeated.term);
  }
});

test('malformed repaired-row width is rejected before any receiver or source mutation', async t => {
  const fixture = await repairedFixture(t), bad = JSON.parse(JSON.stringify(fixture.target.frame.continuation));
  bad.buffers.normal.repairRows[0].width = 401;
  rejectBeforeMutation(fixture, bad);
});

test('overlapping sparse repaired cells are rejected before writing a partial row', async t => {
  const fixture = await repairedFixture(t), bad = JSON.parse(JSON.stringify(fixture.target.frame.continuation));
  const cells = bad.buffers.normal.repairRows[0].cells;
  assert.ok(cells.length >= 3); cells.push([...cells[0]]);
  rejectBeforeMutation(fixture, bad);
});

test('bad repaired-cell link index and wrong marker coverage are rejected without link allocation', async t => {
  const fixture = await repairedFixture(t), valid = fixture.target.frame.continuation;
  const badIndex = JSON.parse(JSON.stringify(valid));
  badIndex.buffers.normal.repairRows[0].cells[0][6] = badIndex.links.length;
  rejectBeforeMutation(fixture, badIndex);
  const badCoverage = JSON.parse(JSON.stringify(valid));
  const ref = badCoverage.buffers.normal.repairRows[0].cells[0][6]; assert.ok(ref >= 0);
  badCoverage.links[ref].markers = [{ buffer: 'normal', line: 1 }];
  rejectBeforeMutation(fixture, badCoverage);
});

test('otherwise bounded sparse rows cannot exceed the combined four-MiB continuation budget', async t => {
  const fixture = await repairedFixture(t), tooLarge = JSON.parse(JSON.stringify(fixture.target.frame.continuation));
  tooLarge.links = []; tooLarge.pen.link = null; tooLarge.pen.unresolved = false;
  const buffer = tooLarge.buffers.normal; buffer.lineCount = 10000;
  buffer.repairRows = Array.from({ length: buffer.lineCount }, () => ({ width: 400, wrapped: false,
    cells: [[0, 'X'.repeat(400), 'r', 0, 0, 0, -1]] }));
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge), 'utf8') > continuation.MAX_BYTES);
  rejectBeforeMutation(fixture, tooLarge);
});


test('inconsistent backing base and out-of-grid current cursor are rejected before mutation', async t => {
  const fixture = await repairedFixture(t), valid = fixture.target.frame.continuation;
  for (const mutate of [
    state => { state.buffers.normal.baseY = state.buffers.normal.lineCount; },
    state => { state.buffers.normal.currentY = state.rows; },
    state => { state.buffers.normal.lineCount = 0; state.buffers.normal.repairRows = []; },
  ]) {
    const bad = JSON.parse(JSON.stringify(valid)); mutate(bad); rejectBeforeMutation(fixture, bad);
  }
});
