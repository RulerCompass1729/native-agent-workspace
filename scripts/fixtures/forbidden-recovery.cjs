// The shipped Claude adapter decision, workspace, IPC and UI; synthetic transport and no provider process.
// The adapter is built as a reader (it writes no settings, installs no plugin and starts no CLI), bound the way the
// bridge binds it, and then fed the bridge's own frames and the classic StopFailure hook. The saved row it reads
// carries typed fields only, never native's wording.
require('./daily-native.cjs');
const fs = require('node:fs'), path = require('node:path'), { randomUUID } = require('node:crypto');
const root = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost, Claude } = require(path.join(root, 'app/adapters.cjs'));
const { Workspace } = require(path.join(root, 'app/workspace.cjs'));
const create = NativeHost.prototype.create, runtimes = new Map(), scheduled = new Map(), sends = [];
NativeHost.prototype.create = function (record) {
  if (record.provider !== 'claude') return create.call(this, record);
  const r = new Claude(record, this, { attachOnly: true });
  record.nativeId = randomUUID(); r.sequence = 0;
  r.terminal = { alive: true, resize() {}, input() {}, snapshot: async () => ({ buffer: 'SYNTHETIC TERMINAL - no provider process\r\n> ', sequence: 0, cols: 100, rows: 30 }) };
  r.openTerminal = async () => r.terminal;
  r.stop = async () => { r.stopped = true; r.terminal.alive = false; return { state: 'ended' }; };
  r.start = async () => {
    r.bindRoot({ sessionId: record.nativeId, nativeBlocks: true, nativeCapacity: true, nativeAbort: false });
    r.submission.status(true); r.ready = true; r.emit('state', 'idle');
  };
  // The production send writes to the native CLI. This one keeps its guard and failed-turn claim and records the text.
  r.send = async (text, tag, guard) => {
    if (!guard()) throw Error('Invalid dispatch');
    r.claimFailedTurnInput(); sends.push({ id: record.id, text }); r.emit('submitted', tag); r.emit('state', 'working');
  };
  r.interrupt = async () => r.emit('state', 'idle');
  runtimes.set(record.id, r); return r;
};
const schedule = Workspace.prototype.scheduleCapacity;
Workspace.prototype.scheduleCapacity = function (session, ...args) {
  const result = schedule.call(this, session, ...args); scheduled.set(session.id, this); return result;
};
process.on('message', q => {
  const reply = extra => process.send?.({ requestId: q.id, forbiddenFixture: true, sends, nativeProcesses: 0, modelCalls: 0, ...extra });
  if (q.method === 'refuse') {
    // One failed native turn as the bridge and the classic hook report it: the turn's start, its failed end naming
    // the saved row the bridge could not classify, and StopFailure with the transcript that holds the typed row.
    const r = runtimes.get(q.target), id = r.record.nativeId, file = path.join(q.directory, id + '.jsonl');
    const promptId = r.lastPromptId = randomUUID(), turnId = randomUUID(), row = randomUUID();
    fs.writeFileSync(file, JSON.stringify({ uuid: row, sessionId: id, type: 'assistant', isSidechain: false, isApiErrorMessage: true,
      message: { model: '<synthetic>' }, apiErrorStatus: q.status, error: 'authentication_failed' }) + '\n', { mode: 0o600 });
    const block = extra => r.observeBlock({ sessionId: id, lease: r.rootLease, epoch: r.observationEpoch, sequence: ++r.sequence, ...extra });
    block({ id: 'control:turn-start', kind: 'control', status: 'running', promptId, turnId });
    block({ id: 'turn:' + turnId, kind: 'turn', turnId, status: 'failed', failedRequest: true, errorMessageId: row, errorRowUnclassified: true });
    r.hook({ hook_event_name: 'StopFailure', session_id: id, prompt_id: promptId, transcript_path: file });
    return reply({ refused: q.status });
  }
  if (q.method === 'advanceRecovery') {
    // Advance only the existing scheduled clock. The production tick, checks and dispatch still run.
    const recovery = scheduled.get(q.target)?.capacityRecoveries.get(q.target), advanced = recovery?.status === 'scheduled';
    if (advanced) recovery.due = Date.now();
    return reply({ advanced });
  }
  reply();
});
