// Isolated desktop regression for space queues: replace only the provider transport,
// never spawn a native agent or call a model. Each send is accepted at once and the
// turn stays "working" until the runner releases that session with a reply.
const { EventEmitter } = require('node:events');
const path = require('node:path');
const appRoot = process.env.NAW_TEST_APP_ROOT || path.resolve(__dirname, '../..');
const { NativeHost } = require(path.join(appRoot, 'app/adapters.cjs'));
const { Workspace } = require(path.join(appRoot, 'app/workspace.cjs'));

const sends = [];
const turns = new Map();
// 11-13 (eddb1c16): with NAW_TEST_QUEUE_CLAUDE_ADAPTER=1 a Claude member runs on the real Claude adapter and only its
// transport is synthetic. NAW's send is accepted as one native prompt; the runner then plays the hook events that
// real Claude 2.1.322 sent in the 11-12 loopback probe, under that prompt's id.
const claudeAdapter = process.env.NAW_TEST_QUEUE_CLAUDE_ADAPTER === '1';
const prompts = new Map();
const failNext = new Set();
const runtimes = new Map();

NativeHost.prototype.start = async function () {
  this.binaries = { claude: 'fixture', codex: 'fixture', python: 'fixture' };
};
NativeHost.prototype.close = function () {};
NativeHost.prototype.create = function (record) {
  if (claudeAdapter && record.provider === 'claude') {
    const { Claude } = require(path.join(appRoot, 'app/adapters.cjs'));
    const runtime = Object.create(Claude.prototype);
    EventEmitter.call(runtime);
    Object.assign(runtime, { record, ready: true, chatAvailable: true, terminal: { input() {} } });
    runtime.submission = {
      request: async (text, tag, guard) => {
        if (!guard()) throw Error('Synthetic acceptance refused');
        const promptId = require('node:crypto').randomUUID();
        sends.push({ id: record.id, text });
        turns.set(record.id, tag);
        prompts.set(record.id, { promptId, text });
        return { promptId };
      },
    };
    runtime.start = async () => {
      runtime.emit('model', 'fixture-model');
      runtime.emit('state', 'idle');
    };
    runtime.stop = async () => {
      turns.delete(record.id);
      return { state: 'ended' };
    };
    runtimes.set(record.id, runtime);
    return runtime;
  }
  const runtime = new EventEmitter();
  runtime.chatAvailable = true;
  runtime.start = async () => {
    // Like a native CLI: it reports the model it was started with, else its default.
    let model = 'fixture-model';
    if (record.requestedSettings && record.requestedSettings.model) {
      model = record.requestedSettings.model;
    }
    runtime.emit('model', model);
    runtime.emit('state', 'idle');
  };
  runtime.stop = async () => {
    turns.delete(record.id);
    return { state: 'ended' };
  };
  // Like the Claude adapter's (adapters.cjs): the service's last check, then the ordinary stop.
  runtime.stopForMaintenance = check => { check(); return runtime.stop(); };
  runtime.send = (text, tag, guard) => new Promise((resolve, reject) => {
    if (failNext.delete(record.id)) { reject(Error('Synthetic send failure')); return; }
    if (!guard()) {
      reject(new Error('Synthetic acceptance refused'));
      return;
    }
    sends.push({ id: record.id, text });
    turns.set(record.id, tag);
    runtime.emit('submitted', tag);
    resolve();
    runtime.emit('state', 'working');
  });
  runtimes.set(record.id, runtime);
  return runtime;
};

function release(id, reply) {
  const runtime = runtimes.get(id);
  const tag = turns.get(id);
  if (!runtime || !tag) {
    return false;
  }
  turns.delete(id);
  runtime.emit('background', { count: 0, scheduled: 0, kinds: [], ids: [] });
  runtime.emit('state', 'idle');
  runtime.emit('complete', { tag, text: reply });
  return true;
}

// Stuck records (B6 E4): a synthetic permission prompt, and its five minutes made to have passed.
// A prompt is reported the way a bridged Claude reports one: the runtime holds it as nativeApproval
// and the state becomes approval; no request object reaches the backend.
// The real one-shot timer is covered by unit tests; here only the wait's start is moved back and
// the backend is told its state changed, so the desktop sees what it would see at the limit.
let workspace = null;
const bind = Workspace.prototype.bind;
Workspace.prototype.bind = function (...args) { workspace = this; return bind.apply(this, args); };
function stuck(request) {
  const runtime = runtimes.get(request.session);
  if (!runtime) return false;
  // Version gate (B6 E4): the session as it is after being started on the last verified Claude version.
  if (request.method === 'pin') {
    const session = workspace?.sessions.get(request.session);
    if (!session) return false;
    session.nativePin = { pinned: '2.1.322', requested: '2.1.330', until: Date.now() + 7 * 24 * 60 * 60 * 1000, expired: false };
    workspace.changed();
    return true;
  }
  if (request.method === 'approval') {
    runtime.nativeApproval = { nativeOnly: true, observedAt: Date.now(), requests: [{ id: 'permission:1', title: 'Bash', input: 'synthetic command', incomplete: false }] };
    runtime.emit('state', 'approval'); return true;
  }
  if (request.method === 'approval-resolved') { runtime.nativeApproval = null; runtime.emit('state', 'working'); return true; }
  const wait = workspace?.stuckWaits.get(request.session + ':approval');
  if (!wait) return false;
  wait.since -= 5 * 60 * 1000 + 2000;
  workspace.changed();
  return true;
}

// B5: a synthetic initiator uses the operator interface the way a Claude root turn does, under the grant the
// person (the script, through the desktop's own API) has given it. Nothing here grants or widens anything.
function operator(request) {
  const runtime = runtimes.get(request.session), session = workspace?.sessions.get(request.session);
  if (!runtime || !session) return Promise.resolve({ done: false, error: 'No such synthetic session' });
  if (request.method === 'operator-ready') {
    // What a real Claude runtime reports: a current root turn, its permission mode, and that the interface is usable.
    runtime.operatorAvailable = true; runtime.liveTurn = { id: 'turn-' + session.id, promptId: 'prompt-' + session.id };
    session.nativePermissionMode = 'default'; workspace.changed();
    return Promise.resolve({ done: Boolean(session.nativeId), nativeId: session.nativeId || null });
  }
  const identity = { nativeId: session.nativeId, turnId: runtime.liveTurn?.id, promptId: runtime.liveTurn?.promptId, callId: 'call-' + Date.now() + '-' + Math.random().toString(16).slice(2) };
  return Promise.resolve().then(() => runtime.operatorCall(identity, 'workspace_open', JSON.parse(request.reply)))
    .then(result => ({ done: true, result }), error => ({ done: false, error: String(error?.message || error).slice(0, 300) }));
}

// One hook event for the member's current prompt; '$sent' stands for the text NAW sent. With '$forward' the event is
// the payload as Claude writes it, and only what NAW's real hook forwarder passes on reaches the adapter.
async function hook(request) {
  const runtime = runtimes.get(request.session);
  const prompt = prompts.get(request.session);
  if (!claudeAdapter || !runtime || !prompt) {
    return false;
  }
  const { $forward, ...written } = JSON.parse(request.reply);
  if (written.prompt === '$sent') {
    written.prompt = prompt.text;
  }
  let event = { session_id: runtime.record.nativeId, prompt_id: prompt.promptId, ...written };
  if ($forward) {
    const { received } = await require('./claude-hook-forward.cjs').runForwarder(event, { appRoot });
    if (received.length !== 1) {
      return false;
    }
    event = JSON.parse(received[0]);
  }
  runtime.hook(event);
  if (event.hook_event_name === 'Stop') {
    turns.delete(request.session);
  }
  return true;
}

process.on('message', request => {
  if (request.method === 'fail-next-send') failNext.add(request.session);
  if (request.method === 'hook') {
    hook(request)
      .then(done => process.send({ requestId: request.id, done, sends: sends.map(({ id, text }) => ({ id, text })) }))
      .catch(error => process.send({ requestId: request.id, done: false, error: error.message, sends: sends.map(({ id, text }) => ({ id, text })) }));
    return;
  }
  if (['operator-ready', 'open'].includes(request.method)) {
    operator(request).then(result => process.send({ requestId: request.id, ...result, sends: sends.map(({ id, text }) => ({ id, text })) }));
    return;
  }
  if (['approval', 'approval-resolved', 'age-waits', 'pin'].includes(request.method)) {
    process.send({ requestId: request.id, done: stuck(request), sends: sends.map(({ id, text }) => ({ id, text })) });
    return;
  }
  let released = null;
  if (request.method === 'release') {
    released = release(request.session, request.reply);
  }
  const working = [];
  for (const id of turns.keys()) {
    working.push(id);
  }
  process.send({ requestId: request.id, released, working, sends: sends.map(({ id, text }) => ({ id, text })) });
});
