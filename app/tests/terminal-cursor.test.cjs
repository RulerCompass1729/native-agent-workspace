const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const cp = require('node:child_process');
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
