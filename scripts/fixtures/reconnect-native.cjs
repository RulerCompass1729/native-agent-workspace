// Actual Codex/workspace lifecycle with deterministic native transport, no model.
const path = require('node:path');
const { NativeHost, Codex } = require(path.join(process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..'), 'app/adapters.cjs'));
let fail = false; const calls = [], records = new Map(), runtimes = new Map();
NativeHost.prototype.start = async function () { this.binaries = { codex: 'fixture', python: 'fixture' }; };
NativeHost.prototype.close = function () {};
NativeHost.prototype.startCodex = async function () {
  this.codexProcess = { pid: process.pid };
  this.rpc = { call: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') {
      const record = [...records.values()].find(r => !r.nativeId);
      return { thread: { id: 'fixture-' + record.id }, model: 'fixture-model' };
    }
    if (method === 'thread/resume') { if (fail) throw Error('Synthetic connection interruption'); return { thread: { id: params.threadId, status: { type: 'idle' } } }; }
    if (method === 'thread/items/list') return { data: [{ turnId: 'earlier', item: { id: 'saved-answer', type: 'agentMessage', text: '保留的原生历史' } }] };
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' };
    throw Error('Unexpected native request: ' + method);
  } };
};
NativeHost.prototype.create = function (record) {
  records.set(record.id, record); const runtime = new Codex(record, this); runtimes.set(record.id, runtime);
  runtime.openTerminal = async () => {
    if (runtime.stopped) throw Error('Disconnected');
    if (!runtime.terminal?.alive) runtime.terminal = { alive: true, async stop() { this.alive = false; }, resize() {}, input() { throw Error('No native input permitted'); }, snapshot: async () => ({ buffer: 'Same native session\r\n> ', sequence: 0, cols: 100, rows: 30 }) };
    return runtime.terminal;
  };
  return runtime;
};
process.on('message', q => {
  if (q.method === 'history') { const r = runtimes.get(q.target); r.hasHistory = true; r.emit('history', [{ id: 'saved-answer', type: 'agentMessage', text: '保留的原生历史' }]); }
  if (q.method === 'fail') fail = q.value;
  process.send({ requestId: q.id, calls });
});
