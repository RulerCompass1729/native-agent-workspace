const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const cp = require('node:child_process'), { EventEmitter, once } = require('node:events');
const { Terminal: Screen } = require('@xterm/headless');
const { SerializeAddon: Upstream } = require('@xterm/addon-serialize');
const write = (screen, data) => new Promise(resolve => screen.write(data, resolve));
const close = '\x1b]8;;\x1b\\';
const open = (uri, id) => `\x1b]8;${id === undefined ? '' : 'id=' + id};${uri}\x1b\\`;

function actualTerminal(t, mutate) {
  const worker = new EventEmitter(), commands = [], spawns = [];
  worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => worker.stdout;
  worker.stderr = new EventEmitter(); worker.stdin = new EventEmitter(); worker.stdin.writable = true;
  worker.stdin.write = data => { commands.push(JSON.parse(data)); return true; };
  const forbidden = () => { throw Error('Hyperlink checks cannot start native processes or read program configuration'); };
  const names = ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync'];
  const saved = Object.fromEntries(names.map(n => [n, cp[n]])), cached = new Set(Object.keys(require.cache));
  const file = require.resolve('../adapters.cjs'), isolated = new Module(file, module);
  isolated.filename = file; isolated.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = isolated.require.bind(isolated);
  isolated.require = name => {
    if (mutate === 'source' && name === 'node:fs') return { ...fs, readFileSync(file, ...args) {
      const data = fs.readFileSync(file, ...args);
      return file === require.resolve('@xterm/addon-serialize') ? data + '\n' : data;
    } };
    if (mutate === name) return { ...originalRequire(name), version: '0.0.0-unqualified' };
    if (name === 'node:child_process') return { ...saved, execFileSync: forbidden,
      spawn(binary, args) { assert.equal(binary, '/synthetic/no-exec'); assert.equal(path.basename(args[0]), 'pty_host.py'); spawns.push(binary); return worker; } };
    if (name === './platform.cjs') return { executable: forbidden, pythonExecutable: () => '/synthetic/no-exec', nativeEnvironment: e => ({ ...e }) };
    return originalRequire(name);
  };
  let terminal;
  try {
    for (const name of names) cp[name] = forbidden;
    isolated._compile(fs.readFileSync(file, 'utf8'), file);
    terminal = new isolated.exports.Terminal(['synthetic-no-provider'], '/synthetic/workspace');
  } finally {
    for (const name of names) cp[name] = saved[name];
    for (const name of Object.keys(require.cache)) if (!cached.has(name)) delete require.cache[name];
  }
  assert.equal(spawns.length, 1);
  t.after(() => { terminal.cursorModes.dispose(); terminal.keyboardModes.dispose(); terminal.screen.dispose(); worker.removeAllListeners(); });
  return { terminal, commands, async output(data) {
    const done = once(terminal, 'data');
    worker.stdout.emit('data', JSON.stringify({ type: 'data', data: Buffer.from(data).toString('base64') }) + '\n');
    return (await done)[0];
  } };
}

// Numeric URL ids are local to each xterm. Compare their full membership
// partition as well as every URI, rather than accidentally approving two
// anonymous links merged together (or one open link split during continuation).
function capture(screen) {
  const groups = new Map(), explicitIds = [], buffers = {};
  for (const name of ['normal', ...(screen.buffer.active.type === 'alternate' ? ['alternate'] : [])]) {
    const b = screen.buffer[name], lines = [];
    for (let y = 0; y < b.length; y++) {
      const line = b.getLine(y), cells = [];
      for (let x = 0; x < screen.cols; x++) {
        const c = line.getCell(x), id = c.hasExtendedAttrs() ? c.extended.urlId : 0;
        const data = id ? screen._core._oscLinkService.getLinkData(id) : null;
        if (id && !groups.has(id)) groups.set(id, groups.size + 1);
        const attr = c.clone(); attr.extended.urlId = 0; attr.updateExtended();
        cells.push({ chars: c.getChars(), width: c.getWidth(), fg: attr.fg, bg: attr.bg,
          extended: attr.extended.ext, uri: data?.uri || null, group: id ? groups.get(id) : 0 });
        explicitIds.push({ name, y, x, id: data?.id });
      }
      lines.push({ wrapped: line.isWrapped, cells });
    }
    buffers[name] = { lines, x: b.cursorX, y: b.cursorY, base: b.baseY };
  }
  return { value: { active: screen.buffer.active.type, buffers }, explicitIds };
}
function equivalent(source, target) {
  const a = capture(source), b = capture(target);
  assert.deepEqual(b.value, a.value);
  for (let i = 0; i < a.explicitIds.length; i++) {
    const original = a.explicitIds[i];
    if (original.id !== undefined) assert.equal(b.explicitIds[i].id, original.id, 'Original explicit OSC8 id survives');
  }
}

const uri = 'https://example.invalid/path;a?x=1%20two#section';
const scenarios = [
  ['boundaries', 'prefix ' + open(uri) + 'label with spaces' + close + ' plain'],
  ['anonymous grouping', open(uri) + 'FIRST' + close + ' ' + open(uri) + 'SECOND' + close],
  ['explicit grouping', open(uri, 'native=first') + 'FIRST' + close + ' ' + open(uri, 'native=first') + 'SAME' + close],
  ['wide wrapped', open(uri, 'wide') + '中e\u0301😀'.repeat(35) + close + 'END'],
  ['anonymous wrapped', open(uri) + 'A'.repeat(125) + close + 'END'],
  ['anonymous CRLF rows', open(uri) + Array.from({ length: 40 }, (_, i) => 'ANON' + i + '\r\n').join('') + close],
  ['scrollback', Array.from({ length: 40 }, (_, i) => open(uri + i, 'row' + i) + 'ROW' + i + close + '\r\n').join('')],
  ['alternate', open(uri, 'normal') + 'NORMAL' + close + '\x1b[?1049h' + open(uri, 'alternate') + 'ALT' + close],
  ['open anonymous middle', 'previous plain content\x1b[H' + open(uri) + 'LABEL'],
  ['restored cursor inactive explicit link', '\x1b7' + open(uri, 'saved') + 'A\x1b8B'],
  ['restored cursor inactive anonymous link', '\x1b7' + open(uri) + 'A\x1b8B'],
  ['styles and erase', '\x1b[38;2;12;145;231m' + open(uri, 'style') + 'LINK' + close + '\x1b[1;4mBOLD\x1b[0mAFTER\x1b[2;1H' + open(uri) + 'erase this\x1b[5D\x1b[3X' + close],
];
for (const route of ['snapshot', 'output rollover', 'resize rollover']) {
  for (const [name, input] of scenarios) test(`actual Terminal OSC8 ${route}: ${name}`, async t => {
    const { terminal, output, commands } = actualTerminal(t), epoch = terminal.journal.epoch;
    terminal.resize(40, 8); await write(terminal.screen, '');
    if (route === 'output rollover') terminal.journal.maxEvents = 0;
    const event = await output('\x1b[?12h\x1b[6 q' + input);
    let frame;
    if (route === 'snapshot') frame = await terminal.snapshot();
    else {
      if (route === 'resize rollover') {
        terminal.journal.maxEvents = 0;
        // Rows exercise the same checkpoint writer without the stock addon's
        // separate cursor-position defect after column reflow.
        const done = once(terminal, 'data'); terminal.resize(40, 9); await done;
      } else assert.equal(event.checkpointRequired, true);
      const observation = await terminal.observe(); frame = observation.checkpoint;
      assert.ok(frame); assert.equal(observation.epoch, epoch); assert.equal(observation.truncated, true);
    }
    assert.equal(terminal.journal.epoch, epoch); assert.equal(terminal.sequence, 1);
    const target = new Screen({ cols: frame.cols, rows: frame.rows, scrollback: 5000, allowProposedApi: true });
    try {
      await write(target, frame.buffer); equivalent(terminal.screen, target);
      assert.deepEqual(target._core.coreService.decPrivateModes, terminal.screen._core.coreService.decPrivateModes);
      await output('NEXT'); await write(target, 'NEXT'); equivalent(terminal.screen, target);
      const before = capture(terminal.screen), repeated = await terminal.snapshot();
      assert.deepEqual(capture(terminal.screen), before, 'Serialization does not mutate canonical cells');
      const again = new Screen({ cols: repeated.cols, rows: repeated.rows, scrollback: 5000, allowProposedApi: true });
      try { await write(again, repeated.buffer); equivalent(terminal.screen, again); } finally { again.dispose(); }
      if (terminal.screen.buffer.active.type === 'alternate') {
        await output('\x1b[?1049l'); await write(target, '\x1b[?1049l'); equivalent(terminal.screen, target);
      }
      assert.equal(commands.filter(c => c.type === 'input' || c.type === 'stop').length, 0);
      assert.ok(commands.slice(1).every(c => c.type === 'resize'));
    } finally { target.dispose(); }
  });
}
test('unlinked snapshots keep upstream bytes and the shared addon stays unpatched', async t => {
  const { terminal, output } = actualTerminal(t);
  await output('\x1b[31mPLAIN\x1b[0m\r\nbody');
  const addon = new Upstream(); terminal.screen.loadAddon(addon);
  assert.equal(terminal.serialize.serialize(), addon.serialize());
  await output(open(uri) + 'LINK' + close);
  assert.ok(terminal.serialize.serialize().includes('\x1b]8;'));
  assert.ok(!addon.serialize().includes('\x1b]8;'));
  assert.equal(require('@xterm/addon-serialize').SerializeAddon, Upstream);
});

test('an OSC8 opening line can leave scrollback while later linked rows survive', async t => {
  const { terminal, output } = actualTerminal(t); terminal.screen.options.scrollback = 10;
  await output(open(uri, 'trimmed') + Array.from({ length: 50 }, (_, i) => 'ROW' + i + '\r\n').join('') + close);
  const frame = await terminal.snapshot();
  assert.ok(!terminal.screen.buffer.normal.getLine(0).translateToString(true).includes('ROW0'));
  const target = new Screen({ cols: frame.cols, rows: frame.rows, scrollback: 5000, allowProposedApi: true });
  try { await write(target, frame.buffer); equivalent(terminal.screen, target); } finally { target.dispose(); }
});

for (const route of ['snapshot', 'output rollover', 'resize rollover']) test(`over-budget links keep the stock whole text in ${route}`, async t => {
  const { terminal, output, commands } = actualTerminal(t);
  terminal.journal.maxCheckpointBytes = 4096;
  if (route === 'output rollover') terminal.journal.maxEvents = 0;
  const input = Array.from({ length: 80 }, (_, i) => open(uri + '/' + 'a'.repeat(100) + i) + 'ROW' + i + close + '\r\n').join('');
  await output(input);
  let frame;
  if (route === 'snapshot') frame = await terminal.snapshot();
  else {
    if (route === 'resize rollover') {
      terminal.journal.maxEvents = 0; const done = once(terminal, 'data'); terminal.resize(100, 31); await done;
    }
    frame = (await terminal.observe()).checkpoint;
  }
  assert.ok(frame); assert.ok(Buffer.byteLength(JSON.stringify(frame.buffer)) <= 4096);
  assert.equal(frame.buffer, terminal.serialize.serializePlain() + terminal.cursorModes.snapshot());
  assert.ok(frame.buffer.includes('ROW0')); assert.ok(frame.buffer.includes('ROW79'));
  assert.ok(!frame.buffer.includes('\x1b]8;'), 'This is an explicit degraded boundary, not full link fidelity');
  assert.equal(terminal.serialize.linkFallbackWarned, true);
  assert.equal(commands.filter(c => c.type === 'input').length, 0);
});

test('large native URI expansion stops at a finite budget before preserving stock text', { timeout: 5000 }, async t => {
  const { terminal, output } = actualTerminal(t); terminal.journal.maxBytes = 8 * 1024 * 1024;
  const input = Array.from({ length: 500 }, (_, i) => open('https://example.invalid/' + i + '/' + 'a'.repeat(10000)) + 'ROW' + i + close + '\r\n').join('');
  await output(input);
  const frame = await terminal.snapshot();
  assert.equal(frame.buffer, terminal.serialize.serializePlain() + terminal.cursorModes.snapshot());
  assert.equal(terminal.serialize.linkFallbackWarned, true);
  assert.ok(frame.buffer.includes('ROW0')); assert.ok(frame.buffer.includes('ROW499'));
});

test('missing native link entries do not amplify close sequences', async t => {
  const { terminal, output } = actualTerminal(t); await output(open(uri, 'stale') + 'LABEL'.repeat(3) + close);
  const cell = terminal.screen.buffer.normal.getLine(0).getCell(0), id = cell.extended.urlId;
  terminal.screen._core._oscLinkService._dataByLinkId.delete(id); // A deliberately invalid canonical fixture.
  const frame = await terminal.snapshot();
  assert.ok(!frame.buffer.includes('\x1b]8;'));
  assert.ok(frame.buffer.includes('LABEL'.repeat(3)));
});

for (const mutation of ['source', '@xterm/headless/package.json', '@xterm/addon-serialize/package.json']) {
  test(`unqualified ${mutation} retains terminal startup through the stock fallback`, async t => {
    const { terminal, output, commands } = actualTerminal(t, mutation);
    await output(open(uri) + 'POSITIVE' + close);
    const frame = await terminal.snapshot(); assert.ok(frame.buffer.includes('POSITIVE'));
    assert.ok(!frame.buffer.includes('\x1b]8;'));
    assert.equal(commands.filter(c => c.type === 'input').length, 0);
  });
}

test('the UI/package build rejects an unqualified serializer source before writing output', () => {
  const vm = require('node:vm'), file = path.resolve(__dirname, '../../scripts/build-ui.cjs');
  let writes = 0;
  const fakeFs = { ...fs, readFileSync(file, ...args) {
    const data = fs.readFileSync(file, ...args);
    return file === require.resolve('@xterm/addon-serialize') ? data + '\n' : data;
  }, writeFileSync() { writes++; throw Error('Unexpected build output'); } };
  assert.throws(() => vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: name => name === 'node:fs' ? fakeFs : require(name), __dirname: path.dirname(file), console,
  }), /Requalify native hyperlink snapshots/);
  assert.equal(writes, 0);
});

test('leaving and reentering the same terminal cell requests its current link afresh', () => {
  const vm = require('node:vm'), root = path.resolve(__dirname, '../..');
  let source;
  // A clean checkout has no generated client. Run the real builder in memory,
  // as the cursor/background checks do, and leave the working output untouched.
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/build-ui.cjs'), 'utf8'), {
    require: name => name === 'node:fs' ? { ...fs, writeFileSync(file, value) {
      assert.equal(file, path.join(root, 'app/dsh/client.js')); source = value;
    } } : require(name),
    __dirname: path.join(root, 'scripts'), console: { log() {} },
  });
  assert.equal(typeof source, 'string');
  const moves = [...source.matchAll(/_handleMouseMove\((\w+)\)\{([\s\S]*?)\}_handleHover\(/g)].filter(m => m[2].includes('_lastBufferCell'));
  const leaves = [...source.matchAll(/"mouseleave",\(\(\)=>\{([^}]+)\}\)\)/g)].filter(m => m[1].includes('_isMouseOut'));
  const hovers = [...source.matchAll(/_handleHover\((\w+)\)\{([\s\S]*?)\}_askForLink\(/g)];
  assert.equal(moves.length, 1); assert.equal(leaves.length, 1); assert.equal(hovers.length, 1);
  const move = vm.runInNewContext(`(function(${moves[0][1]}){${moves[0][2]}})`);
  const leave = vm.runInNewContext(`(function(){${leaves[0][1]}})`);
  const hover = vm.runInNewContext(`(function(${hovers[0][1]}){${hovers[0][2]}})`);
  const requests = [], state = {
    _lastBufferCell: { x: 1, y: 1 }, _activeLine: 1, _wasResized: false, _isMouseOut: false,
    _currentLink: { link: { text: 'https://example.invalid/previous-buffer' } },
    _positionFromMouseEvent: () => ({ x: 1, y: 1 }),
    _clearCurrentLink() { this._currentLink = undefined; }, _handleHover: hover,
    _askForLink(position, useCache) { requests.push({ x: position.x, y: position.y, useCache }); },
  };
  const event = { composedPath: () => [{ classList: { contains: name => name === 'xterm' } }] };
  leave.call(state); move.call(state, event);
  assert.deepEqual(requests, [{ x: 1, y: 1, useCache: false }], 'A buffer may change while the pointer is outside; reuse neither the old cell nor its provider reply');
  move.call(state, event); assert.equal(requests.length, 1, 'Repeated movement within the current cell keeps the existing fast path');
});

// Exercise the real compiled Linkifier and OSC provider with real terminal
// cells. Only DOM/mouse/render event wiring is synthetic; no page is opened.
let hoverUpdateClasses;
function hoverUpdateCompiledClasses(stock = false) {
  const vm = require('node:vm'), root = path.resolve(__dirname, '../..');
  let source;
  if (stock) source = fs.readFileSync(require.resolve('@xterm/xterm'), 'utf8');
  else {
    vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/build-ui.cjs'), 'utf8'), {
      require: name => name === 'node:fs' ? { ...fs, writeFileSync(file, value) {
        assert.equal(file, path.join(root, 'app/dsh/client.js')); source = value;
      } } : require(name), __dirname: path.join(root, 'scripts'), console: { log() {} },
    });
    assert.equal(typeof source, 'string');
  }
  const oldListenerRegistrations = source.split('_linkCacheDisposables.push(').length - 1;
  const map = '//# sourceMappingURL=xterm.js.map';
  assert.equal(source.split(map).length, 2);
  source = source.slice(0, source.indexOf(map));
  // Expose the existing module loader without starting the browser terminal.
  const startup = 'var s={};return(()=>{var e=s;';
  assert.equal(source.split(startup).length, 2);
  source = source.replace(startup, 'var s={};globalThis.probeRequire=i;return false&&(()=>{var e=s;');
  const context = { module: { exports: {} }, exports: {}, document: {},
    navigator: { platform: 'MacIntel', userAgent: 'NAW-synthetic-test', language: 'en-US', maxTouchPoints: 0 },
    URL, console, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, performance };
  vm.createContext(context); vm.runInContext(source, context);
  function exported(name) {
    const prefix = source.slice(0, source.indexOf('t.' + name + '=void 0'));
    const modules = [...prefix.matchAll(/(?:^|},)(\d+):(?:function|\(e,t)/g)];
    assert.ok(modules.length); return context.probeRequire(Number(modules.at(-1)[1]))[name];
  }
  return { Linkifier: exported('Linkifier'), OscLinkProvider: exported('OscLinkProvider'), oldListenerRegistrations };
}
function hoverUpdateFixture(t, { stock = false, wrapped = false } = {}) {
  const { Linkifier, OscLinkProvider, oldListenerRegistrations } = stock ? hoverUpdateCompiledClasses(true) :
    (hoverUpdateClasses ||= hoverUpdateCompiledClasses());
  const screen = new Screen({ cols: 40, rows: 5, scrollback: 5000, allowProposedApi: true });
  const listeners = new Map(), rendered = new Set(), requests = [], hovered = [], left = [], activations = [];
  const names = new Set(['xterm']);
  const element = { classList: { contains: n => names.has(n), add: n => names.add(n),
    remove: n => names.delete(n), toggle: (n, v) => v ? names.add(n) : names.delete(n) },
    addEventListener(n, fn) { listeners.set(n, fn); }, removeEventListener(n, fn) { if (listeners.get(n) === fn) listeners.delete(n); } };
  const handler = { activate(e, uri) { activations.push(uri); }, hover(e, uri) { hovered.push(uri); }, leave(e, uri) { left.push(uri); } };
  const native = new OscLinkProvider(screen._core._bufferService, { rawOptions: { linkHandler: handler } }, screen._core._oscLinkService);
  let wrappedUri = 'https://example.invalid/wrapped-old';
  const provider = { provideLinks(y, callback) {
    requests.push(y);
    if (!wrapped) return native.provideLinks(y, callback);
    callback([{ text: wrappedUri, range: { start: { x: 1, y: 1 }, end: { x: 4, y: 3 } },
      activate: handler.activate, hover: handler.hover, leave: handler.leave }]);
  } };
  const linkifier = new Linkifier(element, { getCoords: e => [e.x, e.y] }, {
    onRenderedViewportChange(fn) { rendered.add(fn); return { dispose() { rendered.delete(fn); } }; },
  }, screen._core._bufferService, { linkProviders: [provider] });
  t.after(() => { linkifier.dispose(); screen.dispose(); assert.equal(activations.length, 0); });
  return { screen, linkifier, rendered, requests, hovered, left, activations, oldListenerRegistrations,
    move(x, y = 1) { listeners.get('mousemove')({ x, y, composedPath: () => [element] }); },
    leave() { listeners.get('mouseleave')(); },
    render(start, end) { for (const fn of [...rendered]) fn({ start, end }); },
    output: data => write(screen, data), setWrappedUri(uri) { wrappedUri = uri; } };
}
const hoverOld = 'https://example.invalid/old-row', hoverNew = 'https://example.invalid/current-row';
async function hoverUpdateGapJourney(h) {
  await h.output('    ' + open(hoverOld) + 'FIRST' + close); h.move(1);
  await h.output('\x1b[H' + open(hoverNew) + 'SECOND-LABEL' + close);
  h.render(0, 0); h.move(1); h.move(6);
}
test('T79 render stock control reproduces the stale URI after a row changes', async t => {
  const h = hoverUpdateFixture(t, { stock: true }); await hoverUpdateGapJourney(h);
  assert.equal(h.linkifier.currentLink.link.text, hoverOld);
  assert.equal(h.requests.length, 1);
});
test('T79 render changing a cached gap refreshes the actual OSC URI without mouseleave', async t => {
  const h = hoverUpdateFixture(t); await hoverUpdateGapJourney(h);
  assert.equal(h.linkifier.currentLink.link.text, hoverNew);
  assert.deepEqual(h.hovered, [hoverNew]); assert.equal(h.requests.length, 2);
  assert.equal(h.rendered.size, 1);
});
test('T79 render owns one listener through hovers and none after disposal', async t => {
  const h = hoverUpdateFixture(t); assert.equal(h.rendered.size, 1);
  assert.equal(h.oldListenerRegistrations, 0, 'Remove the old per-hover listener');
  await h.output(open(hoverOld) + 'LINK' + close); h.move(2);
  for (let i = 0; i < 3; i++) h.render(0, 0);
  assert.equal(h.rendered.size, 1); h.linkifier.dispose(); assert.equal(h.rendered.size, 0);
});
test('T79 render unrelated rows and same-cell movement retain the query fast path', async t => {
  const h = hoverUpdateFixture(t); await hoverUpdateGapJourney(h);
  const cell = h.linkifier._lastBufferCell, count = h.requests.length;
  h.render(1, 1); assert.equal(h.requests.length, count); assert.equal(h.linkifier._lastBufferCell, cell);
  h.move(6); assert.equal(h.requests.length, count);
});
test('T79 render overlapping updates leave once, hover once, and erase the old target', async t => {
  const h = hoverUpdateFixture(t); await h.output(open(hoverOld) + 'FIRST' + close); h.move(2);
  await h.output('\x1b[H' + open(hoverNew) + 'SECOND' + close); h.render(0, 0);
  assert.deepEqual(h.left, [hoverOld]); assert.deepEqual(h.hovered, [hoverOld, hoverNew]);
  assert.equal(h.linkifier.currentLink.link.text, hoverNew);
  await h.output('\x1b[H\x1b[2K'); h.render(0, 0);
  assert.equal(h.linkifier.currentLink, undefined); assert.deepEqual(h.left, [hoverOld, hoverNew]);
  const count = h.requests.length; h.move(2); assert.equal(h.requests.length, count);
});
test('T79 render after mouseleave makes no provider request', async t => {
  const h = hoverUpdateFixture(t); await h.output(open(hoverOld) + 'FIRST' + close); h.move(2); h.leave();
  const count = h.requests.length; await h.output('\x1b[H' + open(hoverNew) + 'SECOND' + close); h.render(0, 4);
  assert.equal(h.requests.length, count); assert.equal(h.linkifier.currentLink, undefined); assert.equal(h.rendered.size, 1);
});
test('T79 render scroll and full refresh resolve the current visible cell', async t => {
  const h = hoverUpdateFixture(t); await h.output('a\r\nb\r\nc\r\nd\r\n' + open(hoverOld) + 'FIRST' + close); h.move(2, 5);
  assert.equal(h.linkifier.currentLink.link.text, hoverOld);
  await h.output('\r\n' + open(hoverNew) + 'BOTTOM' + close); h.render(0, 4);
  assert.equal(h.screen.buffer.active.baseY, 1); assert.equal(h.linkifier.currentLink.link.text, hoverNew);
  assert.equal(h.requests.length, 2);
});
test('T79 render partly overlapping wrapped links are cleared before refresh', t => {
  const h = hoverUpdateFixture(t, { wrapped: true }); h.move(2, 2);
  h.setWrappedUri(hoverNew); h.render(0, 0);
  assert.deepEqual(h.left, ['https://example.invalid/wrapped-old']);
  assert.deepEqual(h.hovered, ['https://example.invalid/wrapped-old', hoverNew]);
  assert.equal(h.linkifier.currentLink.link.text, hoverNew); assert.equal(h.rendered.size, 1);
});

function rejectHoverUpdateSource(transform) {
  const vm = require('node:vm'), root = path.resolve(__dirname, '../..'); let writes = 0;
  const files = { ...fs, readFileSync(file, ...args) {
    const value = fs.readFileSync(file, ...args);
    return file === require.resolve('@xterm/xterm') ? transform(value) : value;
  }, writeFileSync() { writes++; } };
  assert.throws(() => vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/build-ui.cjs'), 'utf8'), {
    __dirname: path.join(root, 'scripts'), console: { log() {} },
    require: name => name === 'node:fs' ? files : require(name),
  }), /Pinned terminal link lifecycle changed/);
  assert.equal(writes, 0);
}
test('T79 render changed old listener source refuses the real build', () => {
  rejectHoverUpdateSource(text => text.replace('_linkCacheDisposables.push(', '_linkCacheDisposables.unshift('));
});
test('T79 render ambiguous constructor source refuses the real build', () => {
  const marker = 'this._register(this._bufferService.onResize((()=>{this._clearCurrentLink(),this._wasResized=!0})))';
  rejectHoverUpdateSource(text => text.replace(marker, marker + ',' + marker));
});
