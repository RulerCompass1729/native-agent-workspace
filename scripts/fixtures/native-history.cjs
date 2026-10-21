// Synthetic native transport. Real workspace, Codex adapter, IPC and renderer.
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost, Codex } = require(path.join(root, 'app/adapters.cjs'));
const { NativeHistory } = require(path.join(root, 'app/native-history.cjs'));
const calls = [], runtimes = new Map(); let holdRead = false, releaseRead;
const ids = [1, 2, 3].map(n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0'));
const names = ['周末计划', '正在其他窗口工作', '历史读取失败'];
const row = n => ({ id: ids[n], cwd: process.argv[2], name: names[n], model: 'synthetic-original', updatedAt: 100, canAcceptDirectInput: true, status: { type: 'idle' } });
NativeHost.prototype.start = async function () {
  this.binaries = { codex: 'fixture', python: 'fixture' }; this.codexProcess = { pid: process.pid };
  this.rpc = { call: async (method, params) => {
    calls.push({ method, params }); const index = ids.indexOf(params.threadId);
    if (method === 'thread/list') {
      await new Promise(resolve => setTimeout(resolve, 150));
      const data = params.searchTerm ? names.flatMap((name, i) => name.includes(params.searchTerm) ? [row(i)] : []) : params.cursor ? [row(2)] : [row(0), row(1)];
      return { data, nextCursor: !params.searchTerm && !params.cursor ? 'more' : null };
    }
    if (method === 'thread/read') { if (holdRead) await new Promise(resolve => { releaseRead = resolve; }); return { thread: row(index) }; }
    if (method === 'thread/resume') {
      if (index === 1) { const error = Error('该会话仍在其他原生连接中使用。请先在那里结束连接，再继续；原连接未被修改。'); error.nativeActiveWriter = true; throw error; }
      return { model: 'synthetic-original', thread: row(index) };
    }
    if (method === 'thread/items/list') {
      if (index === 2) throw Error('Synthetic history pagination failure');
      return { data: [{ item: { id: 'external-user', type: 'userMessage', content: [{ type: 'text', text: '周末三人预算，每人午餐18元交通7元。' }] } }, { item: { id: 'external-result', type: 'agentMessage', text: '原会话核查结果：合计75元，人均25元。' } }], nextCursor: null };
    }
    if (method === 'thread/unsubscribe') return { status: 'notLoaded' };
    throw Error('No model calls allowed in history fixture: ' + method);
  } };
};
NativeHost.prototype.startCodex = async function () {};
NativeHost.prototype.close = function () {};
NativeHost.prototype.create = function (record) {
  const r = new Codex(record, this); runtimes.set(record.id, r);
  r.openTerminal = async () => {
    r.terminal = { alive: true, input() {}, resize() {}, stop: async () => {}, snapshot: async () => ({ buffer: 'SYNTHETIC NATIVE HISTORY\r\n原会话核查结果：合计75元，人均25元。\r\n> ', sequence: 0, cols: 100, rows: 30 }) };
    return r.terminal;
  };
  return r;
};
NativeHistory.prototype.ready = async function () { return this.host.rpc; };
process.on('message', request => { if (request.method === 'holdRead') holdRead = true; if (request.method === 'releaseRead') { holdRead = false; releaseRead?.(); } process.send({ requestId: request.id, calls, models: 0, nativeProcesses: 0 }); });
