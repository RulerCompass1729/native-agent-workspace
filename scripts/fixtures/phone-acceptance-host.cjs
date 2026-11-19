const path = require('node:path'), { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const root = process.env.NAW_PHONE_TARGET;
if (!root || process.argv[2] !== process.env.NAW_MOBILE_FIXTURE_ROOT) throw Error('Owned phone fixture required');
const calls = [], runtimes = new Map();
class Host {
  constructor() { this.binaries = { claude: 'synthetic', codex: 'synthetic' }; }
  async start() {}
  create(record) {
    record.nativeId ||= randomUUID();
    const r = new EventEmitter(); r.chatAvailable = true;
    r.queueAvailable = true; r.midturnAvailable = false; r.steerAvailable = true; r.turnId = 'synthetic-turn';
    r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag, valid) => {
      if (!valid()) throw Error('Synthetic guard refused');
      calls.push({ id: record.id, type: 'send', text }); r.emit('submitted', tag); r.emit('state', 'working');
    };
    r.queue = async (text, tag, valid) => {
      if (!valid()) throw Object.assign(Error('Synthetic guard refused'), { notSent: true });
      calls.push({ id: record.id, type: 'queue', text });
      return new Promise(resolve => { r.drain = () => { r.emit('submitted', tag); resolve({ mode: 'append', turnId: r.turnId }); }; });
    };
    r.steer = async (text, tag, turn, valid) => {
      if (turn !== r.turnId || !valid()) throw Object.assign(Error('Synthetic turn changed'), { notSent: true });
      calls.push({ id: record.id, type: 'steer', text, turnId: turn });
      r.emit('submitted', tag); return turn;
    };
    r.stop = async () => r.emit('state', 'ended'); runtimes.set(record.id, r); return r;
  }
  close() {}
}
require(path.join(root, 'app/adapters.cjs')).NativeHost = Host;
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
let workspace;
const bind = Workspace.prototype.bind;
Workspace.prototype.bind = function (...args) { workspace = this; return bind.apply(this, args); };
process.on('message', value => {
  if (!value?.phoneAcceptance) return;
  try {
    if (value.phoneAcceptance === 'seed') {
      for (const row of value.sessions) {
        const s = workspace.get(row.id); s.messages = row.messages;
        s.state = row.state || 'idle';
      }
      if (value.final) workspace.changed();
    }
    if (value.phoneAcceptance === 'state') runtimes.get(value.sessionId).emit('state', value.state);
    if (value.phoneAcceptance === 'capabilities') Object.assign(runtimes.get(value.sessionId), value.values);
    if (value.phoneAcceptance === 'drain') runtimes.get(value.sessionId).drain?.();
    process.send?.({ phoneAcceptanceResult: value.sequence, ok: true,
      ...(value.phoneAcceptance === 'truth' ? { calls, requests: (workspace.mobileRequests || []).map(r => ({ sessionId: r.sessionId, action: r.action, status: r.status })), states: [...workspace.sessions.values()].map(s => ({ id: s.id, nativeId: s.nativeId, state: s.state, messages: s.messages.length })) } : {}) });
  } catch { process.send?.({ phoneAcceptanceResult: value.sequence, ok: false }); }
});
