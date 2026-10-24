// No native processes or model calls. Hold terminal snapshots until the runner
// releases them, so first-mount and stale-completion races are deterministic.
const { EventEmitter } = require('node:events');
const path = require('node:path');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const pending = [], inputs = [], runtimes = new Map();
const sends = [], interruptions = [];
const heldClaims = new Set(), claims = [];
const claim = Workspace.prototype.claim;
Workspace.prototype.claim = function (id, ...args) {
  if (!heldClaims.delete(id)) return claim.call(this, id, ...args);
  return new Promise((resolve, reject) => claims.push({ id, release: method => {
    if (method === 'fail-claim') return reject(Error('Synthetic control failure'));
    claim.call(this, id, ...args);
    if (method === 'release-taken') claim.call(this, id, 'other-test-view', 'terminal');
    resolve();
  } }));
};
const heldInputs = new Set(), heldInputAcks = new Set(), waitingInputs = [];
const originalInput = Workspace.prototype.input;
Workspace.prototype.input = function (id, ...args) {
  if (heldInputAcks.delete(id)) {
    originalInput.call(this, id, ...args);
    return new Promise(resolve => waitingInputs.push({ id, release: () => resolve() }));
  }
  if (!heldInputs.delete(id)) return originalInput.call(this, id, ...args);
  return new Promise((resolve, reject) => waitingInputs.push({ id, release: fail => {
    if (fail) return reject(Error('Synthetic input unconfirmed'));
    try { resolve(originalInput.call(this, id, ...args)); } catch (error) { reject(error); }
  } }));
};
NativeHost.prototype.start = async function () { this.binaries = { claude: 'fixture', codex: 'fixture', python: 'fixture' }; };
NativeHost.prototype.close = function () {};
NativeHost.prototype.create = function (record) {
  const r = new EventEmitter(); r.chatAvailable = true; r.record = record;
  record.nativeId = 'synthetic-' + record.id;
  r.start = async () => r.emit('state', 'idle');
  r.stop = async () => ({ state: 'ended' });
  r.send = async (text, tag, guard) => {
    if (!r.chatAvailable || !guard()) throw Error('Synthetic send unavailable');
    sends.push({ id: record.id, text }); r.pendingTag = tag;
    r.emit('submitted', tag); r.emit('state', 'working');
  };
  r.interrupt = async () => { interruptions.push(record.id); r.emit('state', 'idle'); r.emit('complete', { tag: r.pendingTag, text: 'Synthetic interrupted reply' }); };
  r.terminal = { alive: true, resize() {}, input(data) { inputs.push({ id: record.id, data }); }, snapshot() {
    return new Promise((resolve, reject) => pending.push({ id: record.id, resolve, reject }));
  } };
  r.openTerminal = async () => r.terminal;
  runtimes.set(record.id, r); return r;
};
process.on('message', q => {
  if (['delta', 'messageItem', 'terminal'].includes(q.method)) runtimes.get(q.target).emit(q.method, q.value);
  if (q.method === 'history') runtimes.get(q.target).emit('history', q.value.items || q.value, q.value.turns);
  if (q.method === 'nativeBlock') { const r = runtimes.get(q.target); r.emit('nativeBlock', { ...q.value, nativeId: r.record.nativeId }); }
  if (q.method === 'replyBound') { const r = runtimes.get(q.target); r.turnId = q.value.turnId; r.nativeActivity = { nativeId: r.record.nativeId, turnId: r.turnId, label: '正在处理' }; r.emit('replyBound', { ...q.value, tag: r.pendingTag, nativeId: r.record.nativeId }); }
  if (q.method === 'complete') { const r = runtimes.get(q.target); r.turnId = null; r.nativeActivity = null; r.emit('complete', { ...q.value, tag: r.pendingTag }); r.emit('state', 'idle'); }
  if (q.method === 'nativeInput') runtimes.get(q.target).emit('nativeInput',q.value,{id:'private-control-input'});
  if (q.method === 'native-activity') { const r=runtimes.get(q.target);r.turnId=q.value?.turnId || null;r.nativeActivity=q.value ? {...q.value,nativeId:r.record.nativeId}:null;r.emit('state',q.value?'working':'idle'); }
  if (q.method === 'native-permission') { const r=runtimes.get(q.target);r.nativeApproval=q.value;if(q.value)r.emit('nativeControlBoundary','control:permission');r.emit('state',q.value?'approval':'working'); }
  if (q.method === 'hold-input-ack') heldInputAcks.add(q.target);
  if (q.method === 'hold-input') heldInputs.add(q.target);
  if (['release-input', 'fail-input'].includes(q.method)) { const at = waitingInputs.findIndex(c => c.id === q.target); if (at >= 0) waitingInputs.splice(at, 1)[0].release(q.method === 'fail-input'); }

  if (q.method === 'hold-claim') heldClaims.add(q.target);
  if (['release-claim', 'fail-claim', 'release-taken'].includes(q.method)) { const at = claims.findIndex(c => c.id === q.target); if (at >= 0) claims.splice(at, 1)[0].release(q.method); }
  if (q.method === 'release') {
    const at = pending.findIndex(p => p.id === q.target);
    if (at >= 0) pending.splice(at, 1)[0].resolve({ buffer: 'Synthetic terminal ready\r\n> ', sequence: 0, cols: 100, rows: 30 });
  }
  if (q.method === 'state') runtimes.get(q.target).emit('state', 'idle');
  if (q.method === 'unavailable' || q.method === 'available') {
    const r = runtimes.get(q.target); r.chatAvailable = q.method === 'available'; r.emit('capability');
  }
  if (q.method === 'set-state') runtimes.get(q.target).emit('state', q.value);
  if (q.method === 'set-owner') { const r = runtimes.get(q.target); r.record.owner = q.value; r.emit('capability'); }
  if (q.method === 'replace') {
    const r = runtimes.get(q.target); r.record.connectionRevision = (r.record.connectionRevision || 0) + 1; r.emit('state', 'idle');
  }
  if (q.method === 'fail') { const at = pending.findIndex(p => p.id === q.target); if (at >= 0) pending.splice(at, 1)[0].reject(Error('Synthetic snapshot failure')); }
  if (q.method === 'first-message-required') { const at = pending.findIndex(p => p.id === q.target); if (at >= 0) pending.splice(at, 1)[0].reject(Error('请先在对话中发送第一条消息，再打开同一会话的原生终端。')); }
  process.send({ requestId: q.id, waitingInputs: waitingInputs.map(c => c.id), pending: pending.map(p => p.id), claims: claims.map(c => c.id), inputs, sends, interruptions });
});
