const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { Terminal: Screen } = require('@xterm/headless');
const continuation = require('../terminal-continuation.js');
const adapter = require.resolve('../adapters.cjs'), requireAt = createRequire(adapter);
const adapterSource = fs.readFileSync(adapter, 'utf8');
const factoryStart = adapterSource.indexOf('function createTerminalSerializeAddon()');
const factoryEnd = adapterSource.indexOf('\nconst delay =', factoryStart);
assert.ok(factoryStart >= 0 && factoryEnd > factoryStart);
const context = { fs, path, crypto, require: requireAt, module, Buffer, console };
const Addon = vm.runInNewContext(adapterSource.slice(factoryStart, factoryEnd) + '\ncreateTerminalSerializeAddon()', context);
const frameStart = adapterSource.indexOf('\n  serializeFrame() {');
const frameEnd = adapterSource.indexOf('\n  }', frameStart);
assert.ok(frameStart >= 0 && frameEnd > frameStart);
const serializeFrame = vm.runInNewContext('({' + adapterSource.slice(frameStart, frameEnd + 4) + '})', context).serializeFrame;
const ESC = '\x1b', close = ESC + ']8;;' + ESC + '\\';
const uri = 'https://example.invalid/continuation';
const open = (id, address = uri) => ESC + ']8;' + (id === undefined ? '' : 'id=' + id) + ';' + address + ESC + '\\';
const write = (screen, data = '') => new Promise(resolve => screen.write(data, resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const buffers = screen => screen._core._bufferService.buffers;
const pen = screen => screen._core._inputHandler._curAttrData;
const links = screen => screen._core._oscLinkService;
function screen(t, { cols = 20, rows = 5, scrollback = 10 } = {}) {
  const value = new Screen({ cols, rows, scrollback, allowProposedApi: true }), addon = new Addon();
  value.loadAddon(addon); t.after(() => value.dispose());
  return { screen: value, addon };
}
function markerLines(screen, id) {
  const entry = links(screen)._dataByLinkId.get(id);
  return (entry?.lines || []).map(marker => {
    const owner = ['normal', 'alt'].find(name => buffers(screen)[name].markers.includes(marker));
    assert.ok(owner, 'Every retained link marker belongs to a real source/receiver buffer');
    return [owner, marker.line];
  }).sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);
}
function witness(screen) {
  const groups = new Map();
  const link = id => {
    if (!id) return null;
    const data = links(screen).getLinkData(id);
    if (!data) return { unresolved: true };
    if (!groups.has(id)) groups.set(id, groups.size + 1);
    return { uri: data.uri, group: groups.get(id) };
  };
  const attr = (a, hidden = false) => ({ fg: a.fg, bg: a.bg,
    ext: hidden || a.hasExtendedAttrs() ? a.extended.ext : 0,
    link: link(hidden || a.hasExtendedAttrs() ? a.extended.urlId : 0) });
  const result = { cols: screen.cols, rows: screen.rows, active: screen.buffer.active.type, buffers: {} };
  for (const name of ['normal', 'alt']) {
    const b = buffers(screen)[name];
    result.buffers[name] = { x: b.x, y: b.y, base: b.ybase, region: [b.scrollTop, b.scrollBottom],
      savedX: b.savedX, savedY: b.savedY, savedFG: b.savedCurAttrData.fg, savedBG: b.savedCurAttrData.bg,
      savedCharset: clone(b.savedCharset || null),
      lines: Array.from({ length: b.lines.length }, (_, y) => {
        const line = screen.buffer[name === 'normal' ? 'normal' : 'alternate'].getLine(y);
        return { wrapped: line.isWrapped, cells: Array.from({ length: line.length }, (_, x) => {
          const cell = line.getCell(x); return { chars: cell.getChars(), width: cell.getWidth(), ...attr(cell) };
        }) };
      }) };
  }
  result.pen = attr(pen(screen), true);
  const c = screen._core._charsetService;
  result.charset = { current: clone(c.charset || null), level: c.glevel,
    banks: Array.from(c._charsets || [], item => clone(item || null)) };
  return result;
}
async function replay(t, source, receiverOptions, seed) {
  const target = screen(t, receiverOptions || { cols: source.screen.cols, rows: source.screen.rows });
  seed?.(target.screen);
  const before = witness(source.screen), frame = source.addon.serializeSnapshot();
  assert.deepEqual(witness(source.screen), before, 'Capturing a frame cannot mutate its live source');
  assert.equal(continuation.validate(frame.continuation), true, 'This semantic case must exercise the new state, not legacy fallback');
  await write(target.screen, frame.buffer);
  assert.equal(continuation.restore(target.screen, frame.continuation), true);
  assert.deepEqual(witness(target.screen), before);
  return { ...target, frame };
}
async function advance(source, target, data) {
  await write(source.screen, data); await write(target.screen, data);
  assert.deepEqual(witness(target.screen), witness(source.screen));
}
function cellLink(screen, x, y = 0, name = 'normal') {
  const cell = screen.buffer[name === 'normal' ? 'normal' : 'alternate'].getLine(y).getCell(x);
  return cell.hasExtendedAttrs() ? cell.extended.urlId : 0;
}

test('missing and future-version state is a legacy no-op', async t => {
  const target = screen(t); await write(target.screen, open('existing') + 'KEEP');
  const before = witness(target.screen);
  for (const state of [undefined, null, { version: 999, pen: { bg: 'unknown future schema' } }]) {
    assert.equal(continuation.validate(state), false);
    assert.equal(continuation.restore(target.screen, state), false);
    assert.deepEqual(witness(target.screen), before);
  }
});

test('known malformed state is rejected before changing receiver attributes, links or saved state', async t => {
  const source = screen(t); await write(source.screen, open('source') + 'SOURCE' + ESC + '7');
  const target = await replay(t, source), bad = clone(target.frame.continuation);
  await write(target.screen, close + ESC + '[31mKEPT'); const before = witness(target.screen);
  const markers = markerLines(target.screen, cellLink(target.screen, 0)); bad.pen.bg = 'invalid';
  assert.throws(() => continuation.validate(bad));
  assert.throws(() => continuation.restore(target.screen, bad));
  assert.deepEqual(witness(target.screen), before);
  assert.deepEqual(markerLines(target.screen, cellLink(target.screen, 0)), markers);
});

test('capture uses the caller wire identity and does not mutate live link markers', async t => {
  const source = screen(t); await write(source.screen, ESC + '7' + open() + 'B' + ESC + '8' + ESC + '[4;1H');
  const id = pen(source.screen).extended.urlId, before = witness(source.screen), markers = markerLines(source.screen, id), calls = [];
  const state = continuation.capture(source.screen, (sourceId, data) => {
    calls.push({ sourceId, uri: data.uri }); return { id: 'same-snapshot-wire', uri: data.uri };
  });
  assert.deepEqual(calls, [{ sourceId: id, uri }]);
  assert.equal(state.pen.link.id, 'same-snapshot-wire');
  assert.equal(continuation.validate(state), true);
  assert.deepEqual(witness(source.screen), before); assert.deepEqual(markerLines(source.screen, id), markers);
});

test('hidden hyperlink stays inactive for plain text and revives on SGR 4 in the original group', async t => {
  // ESC8 restores a non-extended saved pen while xterm retains its raw urlId.
  const source = screen(t); await write(source.screen, ESC + '7' + open() + 'B' + ESC + '8');
  const target = await replay(t, source);
  const sourceId = pen(source.screen).extended.urlId, targetId = pen(target.screen).extended.urlId;
  await advance(source, target, 'C'); assert.equal(cellLink(source.screen, 0), 0); assert.equal(cellLink(target.screen, 0), 0);
  await advance(source, target, ESC + '[4mD');
  assert.ok(sourceId); assert.equal(cellLink(source.screen, 1), sourceId); assert.equal(cellLink(target.screen, 1), targetId);
});

test('same-URI anonymous A/B groups remain distinct and continued C belongs to B', async t => {
  const source = screen(t); await write(source.screen, open() + 'A' + close + open() + 'B');
  const target = await replay(t, source);
  await advance(source, target, 'C');
  for (const value of [source.screen, target.screen]) {
    assert.notEqual(cellLink(value, 0), cellLink(value, 1));
    assert.equal(cellLink(value, 1), cellLink(value, 2));
  }
});

test('explicit id plus URI keeps its group across a later reopen of that link', async t => {
  const source = screen(t); await write(source.screen, open('native-explicit') + 'A' + close);
  const target = await replay(t, source);
  await advance(source, target, open('native-explicit') + 'B');
  for (const value of [source.screen, target.screen]) {
    assert.equal(cellLink(value, 0), cellLink(value, 1));
    assert.equal(links(value).getLinkData(cellLink(value, 0)).id, 'native-explicit');
  }
});

test('receiver allocations cannot be mistaken for source numeric hyperlink ids', async t => {
  const source = screen(t); await write(source.screen, open() + 'A' + ESC + '[0m');
  const target = await replay(t, source, undefined, receiver => {
    for (let i = 0; i < 12; i++) links(receiver).registerLink({ id: 'receiver-existing-' + i, uri: 'https://example.invalid/receiver-' + i });
  });
  assert.notEqual(pen(source.screen).extended.urlId, pen(target.screen).extended.urlId);
  await advance(source, target, ESC + '[4mC');
});

test('a second snapshot and replay retains original anonymous groups and later output', async t => {
  const source = screen(t); await write(source.screen, open() + 'A' + close + open() + 'B' + ESC + '[0m');
  const target = await replay(t, source); await advance(source, target, ESC + '[4mC');
  const again = await replay(t, target); await write(source.screen, 'D'); await write(target.screen, 'D'); await write(again.screen, 'D');
  assert.deepEqual(witness(again.screen), witness(source.screen)); assert.deepEqual(witness(target.screen), witness(source.screen));
});

test('DECSC saved position, pen and charset survive a snapshot before DECRC', async t => {
  const source = screen(t); await write(source.screen, ESC + '(0' + ESC + '[34m' + 'q' + ESC + '7' + ESC + '(B' + ESC + '[31m' + ESC + '[3;2H' + 'N');
  const target = await replay(t, source); await advance(source, target, ESC + '8q');
});

test('independent G0/G1 selection controls subsequent SI and SO text', async t => {
  const source = screen(t); await write(source.screen, ESC + '(0' + ESC + ')B' + '\x0eq');
  const target = await replay(t, source); await advance(source, target, '\x0fq\x0eq');
  assert.equal(buffers(source.screen).normal.lines.get(0).translateToString(true), 'q─q');
});

test('normal and alternate saved slots remain independent when the alternate snapshot exits', async t => {
  const source = screen(t); await write(source.screen, ESC + '[34m' + ESC + '[4;3H' + ESC + '7' + ESC + '[?47h' + ESC + '[31m' + ESC + '[2;5H' + ESC + '7' + ESC + '[H' + 'ALT');
  const target = await replay(t, source); await advance(source, target, ESC + '8A' + ESC + '[?47l' + ESC + '8N');
});

for (const kind of ['normal', 'alt']) test(kind + ' savedY 19 survives 20→5→20 rows without changing snapshot geometry', async t => {
  const source = screen(t, { cols: 20, rows: 20 });
  await write(source.screen, (kind === 'alt' ? ESC + '[?47h' : '') + ESC + '[20;1H' + ESC + '7' + ESC + '[H');
  source.screen.resize(20, 5); await write(source.screen);
  assert.equal(buffers(source.screen)[kind].savedY, 19, 'The source itself retains this offscreen saved position');
  const target = await replay(t, source); assert.equal(target.frame.continuation.rows, 5); assert.equal(target.screen.rows, 5);
  source.screen.resize(20, 20); target.screen.resize(20, 20); await advance(source, target, ESC + '8Z');
});

for (const [name, input] of [['ASCII', 'A'.repeat(20)], ['wide', 'A'.repeat(18) + '中']])
test('pending-wrap ' + name + ' retains the full-column cursor before continued output', async t => {
  const source = screen(t); await write(source.screen, open() + input);
  assert.equal(source.screen.buffer.active.cursorX, 20);
  const target = await replay(t, source); await advance(source, target, ESC + '[4mNEXT');
});

test('restored hidden pen keeps the original marker buffer and line, not the replay cursor row', async t => {
  const source = screen(t); await write(source.screen, ESC + '7' + open() + 'B' + ESC + '8' + ESC + '[5;1H');
  const sourceId = pen(source.screen).extended.urlId, expected = markerLines(source.screen, sourceId);
  assert.deepEqual(expected, [['normal', 0]]);
  const target = await replay(t, source);
  assert.deepEqual(markerLines(target.screen, pen(target.screen).extended.urlId), expected);
});

test('scrollback trim disposes the restored pen link at the same point as its source', async t => {
  const source = screen(t, { scrollback: 3 }); await write(source.screen, ESC + '7' + open() + 'B' + ESC + '8' + ESC + '[5;1H');
  const target = await replay(t, source, { cols: 20, rows: 5, scrollback: 3 });
  const a = pen(source.screen).extended.urlId, b = pen(target.screen).extended.urlId;
  for (let i = 0; i < 5; i++) {
    await advance(source, target, '\r\n');
    assert.equal(Boolean(links(target.screen).getLinkData(b)), Boolean(links(source.screen).getLinkData(a)));
  }
  assert.equal(links(source.screen).getLinkData(a), undefined);
  assert.equal(links(target.screen).getLinkData(b), undefined);
  await advance(source, target, ESC + '[4mC');
});

test('unresolvable source link is reported without inventing a URI or copying its numeric id', async t => {
  const source = screen(t), target = screen(t), id = links(source.screen).registerLink({ uri });
  pen(source.screen).extended.urlId = id; pen(source.screen).updateExtended(); links(source.screen)._dataByLinkId.delete(id);
  let called = false; const state = continuation.capture(source.screen, () => { called = true; throw Error('No resolvable source link'); });
  assert.equal(called, false); assert.equal(state.pen.unresolved, true); assert.equal(state.pen.link, null);
  assert.equal(continuation.restore(target.screen, state), true); assert.equal(pen(target.screen).extended.urlId, 0);
});

test('combined frame bytes count escaped control bytes, UTF-8 and optional metadata', () => {
  const frame = { buffer: ESC + '[4 q中\\\n', continuation: { note: 'metadata 中' } };
  assert.equal(continuation.frameBytes(frame), Buffer.byteLength(JSON.stringify(frame), 'utf8'));
  assert.ok(continuation.frameBytes(frame) > Buffer.byteLength(frame.buffer, 'utf8'));
  assert.equal(continuation.MAX_BYTES, 4 * 1024 * 1024);
});

test('production frame cap drops continuation atomically with hyperlink metadata and retains cursor bytes', async t => {
  const source = screen(t); await write(source.screen, open() + 'A' + ESC + '[0m');
  const cursor = ESC + '[4 q', full = source.addon.serializeSnapshot();
  const plain = source.addon.serializePlain() + cursor;
  const limit = continuation.frameBytes({ buffer: plain });
  assert.ok(continuation.frameBytes({ buffer: full.buffer + cursor, continuation: full.continuation }) > limit);
  const frame = serializeFrame.call({ serialize: source.addon, cursorModes: { snapshot: () => cursor }, journal: { maxCheckpointBytes: limit } });
  assert.equal(frame.buffer, plain); assert.equal(frame.continuation ?? null, null);
  assert.ok(continuation.frameBytes(frame) <= limit);
});
