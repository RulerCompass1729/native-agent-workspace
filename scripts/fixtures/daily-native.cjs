// Synthetic provider transport only. The Codex adapter, workspace, IPC and UI
// are the shipped code, including real first-attachment pagination and events.
const path = require('node:path'), { EventEmitter } = require('node:events');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost, Codex } = require(path.join(root, 'app/adapters.cjs'));
const runtimes = new Map(), sends = [], inputs = [], calls = [], decisions = [];
const heldSends = new Map();
let heldPause;
let holdPeerPause = false; const peerPauseWaiters = [];
if (require('node:fs').existsSync(path.join(root, 'app/service-connection.cjs'))) {
const { ServiceClient } = require(path.join(root, 'app/service-connection.cjs'));
const originalPeerCall = ServiceClient.prototype.call;
ServiceClient.prototype.call = async function(method, ...args) {
  const value = await originalPeerCall.call(this, method, ...args);
  if (method !== 'peerPause' || !holdPeerPause) return value;
  return new Promise((resolve, reject) => peerPauseWaiters.push({ resolve: () => resolve(value), reject }));
};
}
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const originalPause = Workspace.prototype.pause;
Workspace.prototype.pause = function (...args) {
  const result = originalPause.apply(this, args);
  if (heldPause && args[0]?.startsWith('你暂停')) return new Promise((resolve, reject) => { heldPause = { resolve, reject }; });
  return result;
};
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
    }, reply: (id, result) => decisions.push({ id, result }) };
    r.start = async () => { r.emit('state', 'idle'); r.observing = r.observeFirstTurn(); r.observing.catch(e => { r.emit('activity', e.message); r.emit('state', 'error'); }); };
  } else {
    r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag, guard) => {
      if (!guard()) throw Error('Invalid dispatch'); sends.push({ id: record.id, text, tag });
      if (heldSends.has(record.id)) {
        r.emit('state', 'working');
        try { await new Promise((resolve, reject) => heldSends.set(record.id, { resolve, reject })); }
        finally { r.emit('state', 'idle'); }
      }
      r.emit('submitted', tag); r.emit('state', 'working');
    };
    r.interrupt = async () => r.emit('state', 'idle');
  }
  runtimes.set(record.id, r); return r;
};
process.on('message', q => {
  if (q.method === 'holdPeerPause') holdPeerPause = true;
  if (['releasePeerPause', 'rejectPeerPause'].includes(q.method)) {
    holdPeerPause = false; const waiting = peerPauseWaiters.splice(0);
    waiting.forEach((p, i) => q.method === 'rejectPeerPause' && i === 0 ? p.reject(Error('Synthetic lost pause ACK')) : p.resolve());
  }
  if (q.method === 'holdPause') heldPause = true;
  if (['releasePause', 'rejectPause'].includes(q.method)) {
    const pending = heldPause; heldPause = null;
    if (typeof pending?.resolve !== 'function') throw Error('No pending pause acknowledgement');
    if (q.method === 'rejectPause') pending.reject(new Error(q.text)); else pending.resolve();
  }
  if (q.method === 'holdSend') heldSends.set(q.target, null);
  if (['rejectSend', 'confirmSend'].includes(q.method)) {
    const held = heldSends.get(q.target); heldSends.delete(q.target);
    if (!held) throw Error('No held send for fixture target');
    if (q.method === 'rejectSend') held.reject(new Error(q.text)); else held.resolve();
  }
  if (q.method === 'event') runtimes.get(q.target).event(q.value);
  if (q.method === 'events') for (const event of q.value) runtimes.get(q.target).event(event);
  if (q.method === 'release') {
    const sent = q.target ? sends.findLast(s => s.id === q.target) : sends.at(-1), r = runtimes.get(sent.id);
    if (r.record.provider === 'codex') {
      notify(r, 'item/completed', { turnId: sent.turnId, item: { id: 'answer-' + sent.turnId, type: 'agentMessage', text: q.text } });
      notify(r, 'turn/completed', { turn: { id: sent.turnId, status: 'completed' } });
    } else { r.emit('state', 'idle'); r.emit('complete', { tag: sent.tag, text: q.text }); }
  }
  process.send({ requestId: q.id, peerPausePending: peerPauseWaiters.length, sends: sends.map(({ id, text }) => ({ id, text })), inputs, calls, decisions, pausePending: typeof heldPause?.resolve === 'function', nativeProcesses: 0, modelCalls: 0 });
});
