const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const cp = require('node:child_process');
const vm = require('node:vm');
const { EventEmitter, once } = require('node:events');
const { Terminal: Screen } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { trackKeyboardModes, trackCursorModes } = require('../terminal-keyboard.cjs');
const write = (screen, data) => new Promise(resolve => screen.write(data, resolve));
const nativeCursor = screen => {
  const modes = screen._core.coreService.decPrivateModes;
  return { style: modes.cursorStyle, blink: modes.cursorBlink };
};
test('completed native cursor requests survive snapshots without guessing receiving defaults', async () => {
  const cases = [
    ['', false], ['\x1b[ q', false], ['\x1b[?12h', true], ['\x1b[?12l', true],
    ['\x1b[?12:2h', true], ['\x1b[?1;12h', true],
    ...Array.from({ length: 9 }, (_, i) => [`\x1b[${i} q`, false]),
    ['\x1b[?12h\x1b[6 q\x1b[0 q', true],
    ['\x1b[?12l\x1b[3 q\x1b[2147483647 q', true],
    ['\x1b[?12h\x1b[3 q\x1b[8 q', true],
    ['\x1b[?12h\x1b[6 q\x1bc', true],
    ['\x1b[?12h\x1b[6 q\x1b[!p', true],
  ];
  for (const [data, nativeFallback] of cases) {
    const screen = new Screen({ allowProposedApi: true }), modes = trackCursorModes(screen);
    const serializer = new SerializeAddon(); screen.loadAddon(serializer);
    try {
      // One-byte writes also exercise complete controls split across chunks.
      for (const byte of data) await write(screen, byte);
      await write(screen, 'POSITIVE');
      assert.ok(Buffer.byteLength(modes.snapshot()) <= 50);
      for (const fallback of [true, false]) {
        const target = new Screen({ allowProposedApi: true, cursorBlink: fallback, cursorStyle: 'underline' });
        try {
          await write(target, serializer.serialize() + modes.snapshot());
          assert.deepEqual(nativeCursor(target), nativeCursor(screen));
          assert.equal(target.options.cursorBlink, nativeFallback ? screen.options.cursorBlink : fallback);
          assert.equal(target.options.cursorStyle, 'underline');
          assert.equal(target.buffer.active.getLine(0).translateToString(true), 'POSITIVE');
        } finally { target.dispose(); }
      }
    } finally { modes.dispose(); screen.dispose(); }
  }
});
test('observing cursor requests preserves canonical replies and native keyboard flags', async () => {
  const a = new Screen({ allowProposedApi: true }), b = new Screen({ allowProposedApi: true });
  const cursor = trackCursorModes(a), keyboardA = trackKeyboardModes(a), keyboardB = trackKeyboardModes(b);
  const left = [], right = []; a.onData(data => left.push(data)); b.onData(data => right.push(data));
  try {
    const data = '\x1b[>5u\x1b[?12h\x1b[6 q\x1bP$q q\x1b\\\x1b[?12$p';
    await write(a, data); await write(b, data);
    assert.deepEqual(left, right); assert.ok(left.length > 0, 'Positive query response channel');
    assert.deepEqual(nativeCursor(a), nativeCursor(b));
    assert.equal(keyboardA.flags, 5); assert.equal(keyboardA.flags, keyboardB.flags);
    cursor.dispose(); await write(a, '\x1b[5 q');
    const target = new Screen({ allowProposedApi: true });
    try { await write(target, cursor.snapshot()); assert.equal(nativeCursor(target).blink, false, 'Disposed observer retains no new native commands'); }
    finally { target.dispose(); }
  } finally { cursor.dispose(); keyboardA.dispose(); keyboardB.dispose(); a.dispose(); b.dispose(); }
});

function actualTerminal(t) {
  const worker = new EventEmitter(), commands = [], spawns = [];
  worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => worker.stdout;
  worker.stderr = new EventEmitter(); worker.stdin = new EventEmitter(); worker.stdin.writable = true;
  worker.stdin.write = data => { commands.push(JSON.parse(data)); return true; };
  const forbidden = () => { throw Error('This cursor test cannot start a process or read native program configuration'); };
  const launchNames = ['spawn', 'spawnSync', 'fork', 'exec', 'execSync', 'execFile', 'execFileSync'];
  const saved = Object.fromEntries(launchNames.map(name => [name, cp[name]]));
  const cached = new Set(Object.keys(require.cache));
  const file = require.resolve('../adapters.cjs'), isolated = new Module(file, module);
  isolated.filename = file; isolated.paths = Module._nodeModulePaths(path.dirname(file));
  const originalRequire = isolated.require.bind(isolated);
  isolated.require = name => {
    if (name === 'node:child_process') return { ...saved, execFileSync: forbidden,
      spawn(binary, args) { assert.equal(binary, '/synthetic/python-no-exec'); assert.equal(path.basename(args[0]), 'pty_host.py'); spawns.push({ binary, args }); return worker; } };
    if (name === './platform.cjs') return { executable: forbidden, pythonExecutable: () => '/synthetic/python-no-exec', nativeEnvironment: extra => ({ ...extra }) };
    return originalRequire(name);
  };
  let terminal;
  try {
    for (const name of launchNames) cp[name] = forbidden;
    isolated._compile(fs.readFileSync(file, 'utf8'), file);
    terminal = new isolated.exports.Terminal(['synthetic-no-provider'], '/synthetic/workspace');
  } finally {
    for (const name of launchNames) cp[name] = saved[name];
    for (const name of Object.keys(require.cache)) if (!cached.has(name)) delete require.cache[name];
  }
  assert.equal(spawns.length, 1); assert.deepEqual(commands[0].argv, ['synthetic-no-provider']);
  assert.ok(!terminal.screen.options.windowOptions.setWinLines, 'Requalify cursor tracking if column-mode resets are enabled');
  t.after(() => { terminal.cursorModes?.dispose(); terminal.keyboardModes.dispose(); terminal.screen.dispose(); worker.removeAllListeners(); });
  return { terminal, commands,
    async output(data) { const done = once(terminal, 'data'); worker.stdout.emit('data', JSON.stringify({ type: 'data', data: Buffer.from(data).toString('base64') }) + '\n'); return (await done)[0]; },
  };
}
async function verifyFrame(buffer, screen) {
  for (const fallback of [true, false]) {
    const target = new Screen({ allowProposedApi: true, cols: screen.cols, rows: screen.rows, cursorBlink: fallback, cursorStyle: 'underline' });
    try {
      await write(target, buffer); assert.deepEqual(nativeCursor(target), nativeCursor(screen));
      assert.equal(target.options.cursorBlink, true, 'Explicit native mode12 survives its shape override');
      assert.equal(target.buffer.active.getLine(0).translateToString(true), 'PROBE');
      assert.equal(target.buffer.active.getLine(0).getCell(0).getFgColor(), 0x0c91e7);
    } finally { target.dispose(); }
  }
}
for (const route of ['direct snapshot', 'output rollover', 'resize rollover']) test(`the actual Terminal preserves cursor state in ${route}`, async t => {
  const { terminal, output, commands } = actualTerminal(t), epoch = terminal.journal.epoch;
  if (route === 'output rollover') terminal.journal.maxEvents = 0;
  const event = await output('\x1b[>5u\x1b[38;2;12;145;231mPROBE\x1b[?12h\x1b[6 q');
  assert.equal(event.sequence, 1); assert.equal(event.epoch, epoch);
  assert.equal(event.keyboardFlags, 5);
  let buffer;
  if (route === 'direct snapshot') {
    const snapshot = await terminal.snapshot(); buffer = snapshot.buffer;
    assert.equal(snapshot.sequence, 1); assert.equal(snapshot.epoch, epoch);
    assert.equal(snapshot.keyboardFlags, 5);
    assert.equal(snapshot.cursorModesVersion, 1, 'Only the completed cursor snapshot contract is advertised');
  } else {
    if (route === 'resize rollover') {
      terminal.journal.maxEvents = 0;
      const done = once(terminal, 'data'); terminal.resize(60, 15); const [resized] = await done;
      assert.equal(resized.sequence, 1); assert.equal(resized.epoch, epoch);
      assert.equal(terminal.screen.cols, 60); assert.equal(terminal.screen.rows, 15);
      assert.equal(commands.at(-1).type, 'resize');
    } else assert.equal(event.checkpointRequired, true);
    buffer = terminal.journal.snapshot().checkpoint.buffer;
    assert.equal(terminal.journal.snapshot().epoch, epoch);
  }
  await verifyFrame(buffer, terminal.screen);
  assert.equal((await terminal.snapshot()).keyboardFlags, 5);
  assert.equal(commands.filter(command => command.type === 'input').length, 0);
});

const renderer = fs.readFileSync(require.resolve('../renderer/renderer.js'), 'utf8');
const hydrationStart = '      const snapshot = await api.terminalSnapshot(id);';
const hydrationEnd = '      entry.queued = []; loading.remove(); surface.hidden = false; surface.inert = false;';
assert.equal(renderer.split(hydrationStart).length, 2);
assert.equal(renderer.split(hydrationEnd).length, 2);
const hydration = renderer.slice(renderer.indexOf(hydrationStart), renderer.indexOf(hydrationEnd));
const eventWriter = renderer.match(/^function writeTerminal\(entry, event\) \{.+\}$/m)[0];
async function hydrate(frame, { queued = [], retired = false, staleEpoch = false } = {}) {
  const term = new Screen({ allowProposedApi: true, cursorBlink: true, cols: 40, rows: 10 });
  const entry = { term, queued }, state = { sessions: [{ id: 'synthetic', terminalState: { alive: true, epoch: staleEpoch ? 'another-epoch' : frame.epoch } }] };
  const context = { term, entry, state, id: 'synthetic', terminals: new Map([['synthetic', retired ? {} : entry]]),
    api: { terminalSnapshot: async () => frame, initial: async () => state }, document: { activeElement: null },
    revealTerminalCursor() { throw Error('No DOM focus or input in this headless replay'); } };
  context.updateState = next => { context.state = next; };
  vm.createContext(context);
  try {
    await vm.runInContext(eventWriter + '\n(async()=>{' + hydration + '})()', context);
    await write(term, '');
    return { term, entry };
  } catch (error) { term.dispose(); throw error; }
}
test('the actual renderer selects a steady default only for qualified snapshots before native replay', async t => {
  assert.ok(renderer.includes('lineHeight: 1, cursorBlink: true,'), 'Legacy constructor default is retained');
  const nativeCases = ['', '\x1b[5 q', '\x1b[6 q', '\x1b[?12h\x1b[0 q', '\x1b[?12l\x1b[0 q',
    '\x1b[?12h\x1b[6 q\x1bc', '\x1b[?12h\x1b[6 q\x1b[!p'];
  for (const data of nativeCases) {
    const { terminal, output, commands } = actualTerminal(t);
    await output(data + '\x1b[38;2;12;145;231mPOSITIVE');
    const frame = await terminal.snapshot();
    assert.equal(frame.cursorModesVersion, 1);
    for (const version of [undefined, 1, '1', true, 0, 2, null]) {
      const descriptor = { ...frame, cursorModesVersion: version }, { term, entry } = await hydrate(descriptor);
      try {
        const explicitFallback = data.includes('\x1b[?12');
        assert.equal(term.options.cursorBlink, explicitFallback ? terminal.screen.options.cursorBlink : version !== 1,
          'Native DEC12 is replayed after the qualified default: ' + JSON.stringify([data, version]));
        assert.deepEqual(nativeCursor(term), nativeCursor(terminal.screen));
        assert.equal(term.cols, frame.cols); assert.equal(term.rows, frame.rows);
        assert.equal(entry.epoch, frame.epoch); assert.equal(entry.sequence, frame.sequence);
        assert.equal(entry.keyboardFlags, frame.keyboardFlags); assert.equal(entry.ready, true);
        assert.equal(term.buffer.active.getLine(0).translateToString(true), 'POSITIVE');
        assert.equal(term.buffer.active.getLine(0).getCell(0).getFgColor(), 0x0c91e7);
      } finally { term.dispose(); }
    }
    assert.equal(commands.filter(command => command.type === 'input').length, 0);
  }
});
test('qualified hydration preserves queued native overrides and ignores retired or stale displays', async t => {
  const { terminal, output, commands } = actualTerminal(t);
  await output('POSITIVE'); const frame = await terminal.snapshot();
  assert.equal(frame.cursorModesVersion, 1);
  const events = [
    { epoch: frame.epoch, sequence: frame.sequence + 1, data: '\x1b[5 q', keyboardFlags: 5 },
    { epoch: 'old-epoch', sequence: frame.sequence + 2, data: '\x1b[6 q' },
    { epoch: frame.epoch, sequence: frame.sequence + 1, data: '\x1b[6 q' },
  ];
  const { term, entry } = await hydrate(frame, { queued: events });
  try {
    assert.equal(term.options.cursorBlink, false); assert.deepEqual(nativeCursor(term), { style: 'bar', blink: true });
    assert.equal(entry.sequence, frame.sequence + 1); assert.equal(entry.keyboardFlags, 5);
  } finally { term.dispose(); }
  const retired = await hydrate(frame, { retired: true });
  try { assert.equal(retired.term.options.cursorBlink, true); assert.equal(retired.entry.ready, undefined); }
  finally { retired.term.dispose(); }
  await assert.rejects(hydrate(frame, { staleEpoch: true }), /终端画面已变化/);
  assert.equal(commands.filter(command => command.type === 'input').length, 0);
});
test('a bare legacy serialized native blink request cannot justify changing its receiving default', async t => {
  const { terminal, output } = actualTerminal(t); await output('\x1b[5 qPOSITIVE');
  const frame = await terminal.snapshot(), legacy = terminal.serialize.serialize();
  const old = await hydrate({ ...frame, buffer: legacy, cursorModesVersion: undefined });
  try {
    assert.equal(old.term.options.cursorBlink, true); assert.equal(nativeCursor(old.term).blink, undefined);
    assert.equal(old.term.buffer.active.getLine(0).translateToString(true), 'POSITIVE');
  } finally { old.term.dispose(); }
  const naive = new Screen({ allowProposedApi: true, cursorBlink: false });
  try { await write(naive, legacy); assert.equal(naive.options.cursorBlink, false); assert.equal(nativeCursor(naive).blink, undefined); }
  finally { naive.dispose(); }
});

const root = path.resolve(__dirname, '../..');
const rawHover = 'c=this._optionsService.rawOptions.cursorBlink,d=this._optionsService.rawOptions.cursorStyle,';
function builtTerminal(transform = text => text) {
  let output;
  const files = Object.create(fs);
  files.readFileSync = (file, ...args) => {
    const value = fs.readFileSync(file, ...args);
    return file === path.join(root, 'node_modules/@xterm/xterm/lib/xterm.js') ? transform(value) : value;
  };
  files.writeFileSync = (file, value) => { assert.equal(file, path.join(root, 'app/dsh/client.js')); output = value; };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/build-ui.cjs'), 'utf8'), {
    __dirname: path.join(root, 'scripts'), console: { log() {} },
    require(name) { return name === 'node:fs' ? files : require(name); },
  });
  assert.equal(typeof output, 'string'); return output;
}
function underlineMethod(source) {
  const signature = '_setCellUnderline(e,t,i,s,r,n){', start = source.indexOf(signature);
  assert.ok(start >= 0); let depth = 0;
  for (let i = start + signature.length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && !--depth) return vm.runInNewContext('({' + source.slice(start, i + 1) + '})._setCellUnderline');
  }
  assert.fail('Actual pinned underline method is incomplete');
}
test('the actual bundled link hover and leave painter keep native cursor precedence and existing bounds', () => {
  const built = builtTerminal(), paint = underlineMethod(built);
  assert.equal(built.includes(rawHover), false);
  for (const text of [
    'createRow(e,t,i,s,r,a,l,c,u,f,g,nawColumns=Infinity){',
    'let b,C=Math.min(e.getNoBgTrimmedLength(),nawColumns);',
    'if(x+C>nawColumns)continue;const W=this._isCellInSelection(x,t),H=i&&x===a,K=P&&x>=f&&x<=g;',
    'this._rowFactory.createRow(h,e,e===s,o,a,r,n,this.dimensions.css.cell.width,this._widthCache,-1,-1,this._bufferService.cols)',
    'this._rowFactory.createRow(p,_,_===l,d,u,h,c,this.dimensions.css.cell.width,this._widthCache,n?o===i?e:0:-1,n?(o===s?t:r)-1:-1,this._bufferService.cols)',
    'this._scrollableElement.getDomNode().style.backgroundColor=n.colors.background.css,e.querySelector(".xterm-viewport").style.backgroundColor=n.colors.background.css',
  ]) assert.equal(built.split(text).length, 2, 'Existing pinned DOM/background repair remains unique');
  for (const enabled of [true, false]) for (const [raw, blink, style] of [
    [false, true, 'bar'], [true, false, 'bar'], [false, true, 'underline'],
    [true, false, 'underline'], [true, undefined, undefined], [false, undefined, undefined],
  ]) {
    const calls = [], fixture = {
      _bufferService: { rows: 1, cols: 5, buffer: { x: 0, y: 0, ybase: 0, ydisp: 0, lines: { get: () => ({}) } } },
      _optionsService: { rawOptions: { cursorBlink: raw, cursorStyle: 'block', cursorInactiveStyle: 'outline' } },
      _coreService: { decPrivateModes: { cursorBlink: blink, cursorStyle: style } },
      _rowElements: [{ replaceChildren() {} }], _rowFactory: { createRow(...args) { calls.push(args); return []; } },
      dimensions: { css: { cell: { width: 10 } } }, _widthCache: {},
    };
    paint.call(fixture, 0, 2, 0, 0, 50, enabled); assert.equal(calls.length, 1);
    const args = calls[0]; assert.equal(args[2], true); assert.equal(args[3], style ?? 'block');
    assert.equal(args[6], blink ?? raw); assert.equal(args[9], enabled ? 0 : -1);
    assert.equal(args[10], enabled ? 1 : -1); assert.equal(args[11], 5);
    assert.equal(fixture._optionsService.rawOptions.cursorBlink, raw, 'Painting never rewrites native/default state');
  }
});
test('a changed native cursor hover fragment fails the actual pinned build', () => {
  assert.throws(() => builtTerminal(text => text.replace(rawHover, rawHover.replace('cursorBlink', 'anotherValue'))), /Pinned terminal DOM source changed/);
});
test('an ambiguous native cursor hover fragment fails the actual pinned build', () => {
  assert.throws(() => builtTerminal(text => text + '\n/* ' + rawHover + ' */'), /Pinned terminal DOM source changed/);
});
