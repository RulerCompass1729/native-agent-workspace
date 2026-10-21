// Real PTY + Python echo process; synthetic provider lifecycle, no model calls.
const { EventEmitter } = require('node:events');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost, Terminal } = require(path.join(root, 'app/adapters.cjs'));
const { pythonExecutable } = require(path.join(root, 'app/platform.cjs'));
const runtimes = new Set();
const source = `import os,sys,signal,json
signal.alarm(180)
print('PTY ECHO READY',flush=True)
for line in sys.stdin:
 print('RECEIVED:'+json.dumps(line.rstrip('\\n'),ensure_ascii=False),flush=True)
`;
NativeHost.prototype.start = async function () { this.binaries = { claude: 'echo-fixture', codex: 'echo-fixture', python: pythonExecutable() }; };
NativeHost.prototype.create = function (record) {
  const r = new EventEmitter(); r.record = record; r.chatAvailable = true;
  r.terminal = new Terminal([pythonExecutable(), '-u', '-c', source], record.cwd);
  r.terminal.on('data', event => r.emit('terminal', event));
  r.terminal.on('started', pid => r.emit('pid', pid));
  r.terminal.on('closed', () => r.emit('state', 'ended'));
  r.start = async () => r.emit('state', 'idle');
  r.openTerminal = async () => r.terminal;
  r.send = async () => { throw Error('This fixture never submits model tasks'); };
  r.stop = async () => { await r.terminal.stop(); return { state: 'ended' }; };
  runtimes.add(r); return r;
};
NativeHost.prototype.close = function () { for (const r of runtimes) if (r.terminal.alive) r.stop().catch(() => {}); };
