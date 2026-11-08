// Owned source-GUI fixture: real canonical Terminal, no PTY/provider process.
const path = require('node:path'), cp = require('node:child_process'), Module = require('node:module');
const { EventEmitter, once } = require('node:events');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const sources = new Map(), counts = { fakeWorkers: 0, disposed: 0, inputs: [], commands: [], snapshots: [], serializations: [] };
const originalSpawn = cp.spawn, originalLoad = Module._load;
cp.spawn = function (_file, argv) {
  if (!Array.isArray(argv) || path.basename(argv[0] || '') !== 'pty_host.py') throw Error('Unexpected fixture child process');
  counts.fakeWorkers++;
  const worker = new EventEmitter();
  worker.stdout = new EventEmitter(); worker.stdout.setEncoding = () => worker.stdout;
  worker.stderr = new EventEmitter(); worker.stdin = new EventEmitter(); worker.stdin.writable = true;
  worker.stdin.write = line => { const command = JSON.parse(line); counts.commands.push(command.type || 'initialize'); if (command.type === 'input') counts.inputs.push(command.data); return true; };
  return worker;
};
Module._load = function (request, parent, ...args) {
  if (request === './platform.cjs' && parent?.filename === path.join(root, 'app/adapters.cjs')) return {
    executable: () => 'fixture-only', pythonExecutable: () => 'fixture-python-never-executed', nativeEnvironment: env => env,
  };
  return originalLoad.call(this, request, parent, ...args);
};
let NativeHost, Terminal;
try {
  require('./loading-terminal.cjs');
  ({ NativeHost, Terminal } = require(path.join(root, 'app/adapters.cjs')));
} finally { cp.spawn = originalSpawn; Module._load = originalLoad; }
const create = NativeHost.prototype.create;
NativeHost.prototype.create = function (record) {
  const runtime = create.call(this, record), terminal = new Terminal(['fixture-never-executed'], record.cwd, {});
  runtime.terminal = terminal;
  terminal.on('data', value => runtime.emit('terminal', value));
  const serialize = terminal.serializeFrame.bind(terminal);
  terminal.serializeFrame = () => {
    const before = counts.commands.length, frame = serialize();
    counts.serializations.push({ sourceCommands: counts.commands.length - before, continuationVersion: frame.continuation?.version });
    return frame;
  };
  const snapshot = terminal.snapshot.bind(terminal);
  terminal.snapshot = async () => {
    const before = counts.commands.length, frame = await snapshot();
    counts.snapshots.push({ sequence: frame.sequence, epoch: frame.epoch, cols: frame.cols, rows: frame.rows,
      continuationVersion: frame.continuation?.version, sourceCommandsDuringCapture: counts.commands.length - before });
    return frame;
  };
  const stop = runtime.stop;
  runtime.stop = async () => {
    if (terminal.alive) {
      terminal.keyboardModes.dispose(); terminal.cursorModes.dispose(); terminal.screen.dispose(); terminal.alive = false; counts.disposed++;
    }
    return stop.call(runtime);
  };
  sources.set(record.id, terminal);
  return runtime;
};
function sourceState(terminal) {
  const screen = terminal.screen, pen = screen._core._inputHandler._curAttrData;
  return { cols: screen.cols, rows: screen.rows, sequence: terminal.sequence, epoch: terminal.journal.epoch, pid: terminal.pid,
    pen: { id: pen.extended.urlId, active: Boolean(pen.hasExtendedAttrs()), uri: screen._core._oscLinkService.getLinkData(pen.extended.urlId)?.uri || null },
    cells: [0, 1, 2].map(x => { const c = screen.buffer.active.getLine(0).getCell(x); return { text: c.getChars(), uri: c.hasExtendedAttrs() ? screen._core._oscLinkService.getLinkData(c.extended.urlId)?.uri || null : null }; }) };
}
process.on('message', async request => {
  if (request.channel !== 't79-continuation') return;
  try {
    const terminal = sources.get(request.target);
    if (request.method === 'output') {
      if (!terminal?.alive) throw Error('Owned terminal is not alive');
      const done = once(terminal, 'data');
      terminal.worker.stdout.emit('data', JSON.stringify({ type: 'data', data: Buffer.from(request.value).toString('base64') }) + '\n');
      await done;
    }
    const state = terminal?.alive ? sourceState(terminal) : null;
    process.send({ channel: request.channel, requestId: request.id, counts, state });
  } catch (error) { process.send({ channel: request.channel, requestId: request.id, error: error.message }); }
});
