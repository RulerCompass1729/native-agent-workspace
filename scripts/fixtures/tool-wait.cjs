// Test-only, two explicit scopes. Never load a real OS notification or provider.
const { EventEmitter } = require('node:events');
if (process.versions.electron && process.type === 'browser') {
  const Module = require('node:module'), load = Module._load, electron = require('electron');
  const cp = require('node:child_process'), spawn = cp.spawn;
  // If the owned fixture service disappears, refuse the normal bootstrap
  // fallback before it could launch a daemon with real provider adapters.
  cp.spawn = function (executable, args, ...options) {
    if (args?.some(arg => typeof arg === 'string' && /(?:^|[\\/])daemon\.cjs$/.test(arg))) throw Error('Tool-wait fixture forbids normal daemon bootstrap');
    return spawn.call(this, executable, args, ...options);
  };
  globalThis.toolWaitNotificationRequests = [];
  class FixtureNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; }
    show() { globalThis.toolWaitNotificationRequests.push(this.options); }
  }
  const wrapped = Object.create(electron, { Notification: { value: FixtureNotification } });
  Module._load = function (request, ...args) { return request === 'electron' ? wrapped : load.call(this, request, ...args); };
} else if (process.env.NAW_TOOL_WAIT_DAEMON_FIXTURE === '1') {
  require('./loading-terminal.cjs');
  const path = require('node:path'), root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
  const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
  const bind = Workspace.prototype.bind, targets = new Map();
  Workspace.prototype.bind = function (record, runtime) {
    let activity;
    Object.defineProperty(runtime, 'nativeActivity', { get() {
      if (!activity) return null;
      const notice = runtime.toolWaitNotice;
      return { ...activity, ...(notice?.nativeId === record.nativeId && notice.turnId === activity.turnId &&
        notice.marker === activity.toolWait?.marker && notice.progressAt === activity.toolWait?.progressAt ? { waitNotice: notice } : {}) };
    }, set(value) { activity = value; }, configurable: true });
    targets.set(record.id, { workspace: this, runtime, record }); return bind.call(this, record, runtime);
  };
  // The base fixture replies once. Run this scope-limited adjustment first;
  // age only the local observation/quiet-reset clocks, never bypass validity.
  process.prependListener('message', q => {
    const target = targets.get(q.target);
    if (!target || !['tool-wait-start', 'tool-wait-age', 'tool-wait-progress', 'tool-wait-tick'].includes(q.method)) return;
    const { runtime: r, record, workspace: w } = target;
    if (q.method === 'tool-wait-start') {
      r.turnId = q.value?.turnId || 'synthetic-original-turn';
      r.nativeActivity = { nativeId: record.nativeId, turnId: r.turnId, label: 'commandExecution',
        toolWait: { source: 'live-observation', marker: r.turnId + ':synthetic-live-command', progressAt: Date.now() } };
      r.emit('state', 'working');
    }
    if (q.method === 'tool-wait-age' && r.nativeActivity?.toolWait) {
      const at = Date.now() - 5 * 60 * 1000 - 100;
      r.nativeActivity.toolWait.progressAt = at; r.toolWaitQuietResetAt = at;
    }
    if (q.method === 'tool-wait-progress' && r.nativeActivity?.toolWait) r.nativeActivity.toolWait.progressAt = Date.now();
    w.tickToolWait(); r.emit('capability');
  });
}
