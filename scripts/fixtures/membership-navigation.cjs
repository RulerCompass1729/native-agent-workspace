// Source-only owned Electron fixture. Delay the real IPC handler, retaining
// its event, authorization, state changes and return value. Never used by app.
function install({ ipcMain }) {
  const handlers = ipcMain._invokeHandlers;
  if (!handlers?.get || !handlers?.set) throw Error('Owned IPC delay fixture unavailable');
  const plans = new Map(), waiting = new Map(), calls = [];
  const key = (method, id) => `${method}:${id ?? 'room'}`;
  for (const method of ['join', 'restoreSession', 'restoreRoom']) {
    const channel = `workspace:${method}`, original = handlers.get(channel);
    if (typeof original !== 'function') throw Error('Owned navigation handler unavailable');
    handlers.set(channel, async (event, ...args) => {
      const id = key(method, args[0]), plan = plans.get(id); plans.delete(id);
      const call = { method, id: args[0], phase: 'before' }; calls.push(call);
      const hold = () => new Promise((resolve, reject) => waiting.set(id, { resolve, reject, phase: call.phase, call }));
      if (plan === 'before') await hold();
      const value = await original(event, ...args); call.phase = 'after';
      if (plan === 'after') await hold();
      call.phase = 'done'; return value;
    });
  }
  globalThis.navigationFixture = {
    hold(method, id, phase = 'before') { plans.set(key(method, id), phase); },
    release(method, id, fail = false) {
      const k = key(method, id), pending = waiting.get(k);
      if (!pending) throw Error('Owned request has not reached its gate');
      waiting.delete(k);
      if (fail) { pending.call.phase = `rejected-${pending.phase}`; pending.reject(Error('Synthetic navigation operation failed')); }
      else pending.resolve();
    },
    status() { return { calls, waiting: [...waiting].map(([id, p]) => ({ id, phase: p.phase })) }; },
    close() { for (const p of waiting.values()) p.reject(Error('Owned fixture closed')); waiting.clear(); plans.clear(); },
  };
  return { methods: ['join', 'restoreSession', 'restoreRoom'] };
}
module.exports = { install };
if (typeof process.send === 'function') {
  require('./collaboration-overview.cjs');
  const path = require('node:path'), root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
  const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
  const { NativeHost } = require(path.join(root, 'app/adapters.cjs'));
  const held = new Set(), waiting = new Map(), inputs = [];
  const claim = Workspace.prototype.claim;
  Workspace.prototype.claim = function (id, ...args) {
    if (!held.delete(id)) return claim.call(this, id, ...args);
    return new Promise((resolve, reject) => waiting.set(id, () => {
      try { resolve(claim.call(this, id, ...args)); } catch (error) { reject(error); }
    }));
  };
  const create = NativeHost.prototype.create;
  NativeHost.prototype.create = function (record) {
    const runtime = create.call(this, record), input = runtime.terminal.input;
    runtime.terminal.input = function (data) { inputs.push({ id: record.id, data }); return input.call(this, data); };
    return runtime;
  };
  process.prependListener('message', q => {
    if (q.method === 'navigation-hold-claim') held.add(q.target);
    if (q.method === 'navigation-release-claim') { const release = waiting.get(q.target); waiting.delete(q.target); release?.(); }
  });
  const send = process.send;
  process.send = function (message, ...args) {
    if (message?.stats) message.navigation = { waitingClaims: [...waiting.keys()], inputs };
    return send.call(this, message, ...args);
  };
}
