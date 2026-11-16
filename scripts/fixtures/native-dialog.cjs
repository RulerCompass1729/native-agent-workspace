// One owned daemon, real PTY and cooked terminal; only the provider is synthetic.
const path = require('node:path'), { EventEmitter } = require('node:events');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost, Terminal } = require(path.join(root, 'app/adapters.cjs'));
const { SubmissionChannel } = require(path.join(root, 'app/claude-submit.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
NativeHost.prototype.start = async function () { this.binaries = { claude: 'fixture', codex: 'fixture', python: 'fixture' }; };
NativeHost.prototype.close = function () {};
const runtimes = new Map();
NativeHost.prototype.create = function(record) {
  const runtime = new EventEmitter();
  runtime.chatAvailable = true;
  runtime.start = async () => {
    const terminal = runtime.terminal = new Terminal(['/usr/bin/python3', path.join(__dirname, 'native-dialog-tui.py'), path.join(process.env.NAW_DIALOG_LOG_ROOT, record.id + '.jsonl')], record.cwd);
    terminal.on('data', event => runtime.emit('terminal', event));
    runtime.emit('state', 'idle');
  };
  runtime.openTerminal = async () => runtime.terminal;
  runtime.send = async (text, tag, guard) => {
    if (process.env.NAW_DIALOG_RACE === 'authorize' && !runtime.raced) {
      runtime.raced = true;
      const channel = new SubmissionChannel(); channel.status(true);
      const pending = channel.request(text, tag, guard); pending.catch(() => {});
      channel.poll = { end() {} }; channel.flush();
      await reopen(runtime);
      channel.authorize({ id: tag, text });
      channel.result({ id: tag, status: 'blocked' });
      try { return await pending; } finally { channel.close(); }
    }
    if (!guard()) throw Object.assign(Error('Not sent'), { notSent: true });
    runtime.terminal.input('\x1b[200~' + text + '\x1b[201~');
    runtime.terminal.input('\r');
    runtime.emit('submitted', tag);
  };
  runtime.stop = async () => { await runtime.terminal.stop(); return { state: 'ended' }; };
  runtimes.set(record.id, runtime); return runtime;
};
const bind = Workspace.prototype.bind;
Workspace.prototype.bind = function(s, runtime) { bind.call(this, s, runtime); s.terminalInputPending = true; };

process.on('message', q => {
  if (q.method !== 'dismiss') return;
  const runtime = runtimes.get(q.target);
  if (!runtime) return process.send({ requestId: q.id, error: 'Unknown owned fixture' });
  runtime.terminal.input('\x1b'); process.send({ requestId: q.id, ok: true });
});

async function reopen(runtime) {
  runtime.terminal.input('\x12');
  for (let i = 0; i < 100; i++) {
    const text = (await runtime.terminal.snapshot()).buffer;
    if (text.includes('Teach auto mode')) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Owned race popup did not appear');
}
const send = Workspace.prototype.send;
Workspace.prototype.send = async function(...args) {
  const runtime = this.runtimes.get(args[0]);
  if (args[10] && process.env.NAW_DIALOG_RACE === 'before-send' && !runtime.raced) {
    runtime.raced = true; await reopen(runtime);
  }
  return send.apply(this, args);
};
