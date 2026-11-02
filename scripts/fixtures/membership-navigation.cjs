// Source-only owned Electron fixture. Delay the real IPC handler, retaining
// its event, authorization, state changes and return value. Never used by app.
function install({ ipcMain }) {
  const handlers = ipcMain._invokeHandlers;
  if (!handlers?.get || !handlers?.set) throw Error('Owned IPC delay fixture unavailable');
  const plans = new Map(), waiting = new Map(), calls = [];
  const key = (method, id) => `${method}:${id ?? 'room'}`;
  // Since the multi-space change (c9800cc) the window joins, leaves and restores a space
  // through spaceAction(space, action, args); map those back to the gate names.
  const route = (channel, event, args) => channel !== 'workspace:spaceAction' ? { method: channel.slice(10), id: args[0] }
    : args[1] === 'join' ? { method: 'join', id: args[2]?.[0] } : args[1] === 'restore' ? { method: 'restoreRoom', id: undefined } : null;
  for (const channel of ['workspace:join', 'workspace:restoreSession', 'workspace:restoreRoom', 'workspace:spaceAction']) {
    const original = handlers.get(channel);
    if (typeof original !== 'function') throw Error('Owned navigation handler unavailable');
    handlers.set(channel, async (event, ...args) => {
      const target = route(channel, event, args);
      if (!target) return original(event, ...args);
      const { method } = target, id = key(method, target.id), plan = plans.get(id); plans.delete(id);
      const call = { method, id: target.id, phase: 'before' }; calls.push(call);
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
  return { methods: ['join', 'restoreSession', 'restoreRoom', 'spaceAction'] };
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
