// Synthetic provider transport only. The Codex adapter, workspace, IPC and UI
// are the shipped code, including real first-attachment pagination and events.
const path = require('node:path'), { EventEmitter } = require('node:events');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost, Codex } = require(path.join(root, 'app/adapters.cjs'));
const runtimes = new Map(), sends = [], inputs = [], calls = [];
function notify(r, method, params) { r.event({ method, params: { threadId: r.record.nativeId, ...params } }); }
const item = (i, text = 'PRIVATE-HISTORY-' + i) => ({ turnId: 'history-turn', item: { id: 'history-' + i, type: i % 2 ? 'agentMessage' : 'userMessage', ...(i % 2 ? { text } : { content: [{ type: 'text', text }] }) } });
const history = Array.from({ length: 105 }, (_, i) => item(i));
NativeHost.prototype.start = async function () { this.binaries = { claude: 'fixture', codex: 'fixture', python: 'fixture' }; };
NativeHost.prototype.close = function () {};
NativeHost.prototype.create = function (record) {
  const r = record.provider === 'codex' ? new Codex(record, this) : new EventEmitter();
  r.record = record; record.nativeId = 'synthetic-' + record.id; r.chatAvailable = record.provider !== 'codex';
  r.terminal = { alive: true, resize() {}, input(data) { inputs.push({ id: record.id, data }); }, snapshot: async () => ({ buffer: 'SYNTHETIC TERMINAL - no provider process\r\n> ', sequence: 0, cols: 100, rows: 30 }) };
  r.openTerminal = async () => r.terminal;
  r.stop = async () => { r.stopped = true; r.terminal.alive = false; return { state: 'ended' }; };
  if (record.provider === 'codex') {
    this.rpc = { call: async (method, params) => {
      const r = [...runtimes.values()].find(candidate => candidate.record.nativeId === params.threadId);
      if (!r) throw Error('Unknown fixture thread');
      calls.push(method);
      if (method === 'thread/read') return { thread: { id: r.record.nativeId, preview: 'synthetic saved history', status: { type: 'idle' } } };
      if (method === 'thread/resume') return { thread: { id: r.record.nativeId } };
      if (method === 'thread/items/list') {
        if (!params.cursor) return { data: history.slice(0, 100), nextCursor: 'second-page' };
        // Live overlap while the second page is in flight.
        notify(r, 'turn/started', { turn: { id: 'history-turn' } });
        notify(r, 'item/completed', { turnId: 'history-turn', item: item(104).item });
        notify(r, 'turn/completed', { turn: { id: 'history-turn', status: 'completed' } });
        return { data: history.slice(100), nextCursor: null };
      }
      if (method === 'turn/start') {
        const turnId = 'fixture-turn-' + sends.length;
        sends.push({ id: r.record.id, text: params.input[0].text, turnId, tag: params.clientUserMessageId });
        notify(r, 'turn/started', { turn: { id: turnId } });
        notify(r, 'item/completed', { turnId, item: { id: 'input-' + turnId, type: 'userMessage', clientId: params.clientUserMessageId, content: params.input } });
        return { turn: { id: turnId } };
      }
      if (method === 'turn/interrupt') return {};
      throw Error('Unexpected fixture method: ' + method);
    } };
    r.start = async () => { r.emit('state', 'idle'); r.observing = r.observeFirstTurn(); r.observing.catch(e => { r.emit('activity', e.message); r.emit('state', 'error'); }); };
  } else {
    r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag, guard) => { if (!guard()) throw Error('Invalid dispatch'); sends.push({ id: record.id, text, tag }); r.emit('submitted', tag); r.emit('state', 'working'); };
    r.interrupt = async () => r.emit('state', 'idle');
  }
  runtimes.set(record.id, r); return r;
};
process.on('message', q => {
  if (q.method === 'release') {
    const sent = sends.at(-1), r = runtimes.get(sent.id);
    if (r.record.provider === 'codex') {
      notify(r, 'item/completed', { turnId: sent.turnId, item: { id: 'answer-' + sent.turnId, type: 'agentMessage', text: q.text } });
      notify(r, 'turn/completed', { turn: { id: sent.turnId, status: 'completed' } });
    } else { r.emit('state', 'idle'); r.emit('complete', { tag: sent.tag, text: q.text }); }
  }
  process.send({ requestId: q.id, sends: sends.map(({ id, text }) => ({ id, text })), inputs, calls, nativeProcesses: 0, modelCalls: 0 });
});
