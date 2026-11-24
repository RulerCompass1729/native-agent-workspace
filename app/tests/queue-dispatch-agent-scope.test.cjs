// Items paused for an install read as 「等你决定」 (the person's board, 2026-11-23: 「至少 41 等你」): the butler's
// queueAdd started the dispatcher pass inside its own call, each send carried the butler, and the reply to an input
// marked as the butler's could not be NAW's dispatch (input-purpose-unconfirmed). Synthetic; no model.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const background = require('../background-operation.cjs'), rules = require('../queue-dispatch.cjs');
const { RoomState } = require('../room-state.cjs'), { Workspace } = require('../workspace.cjs'), { Codex } = require('../adapters.cjs');
const AGENT = { id: 'butler', name: 'Synthetic butler', nativeId: 'native-butler', provider: 'claude', callId: 'call-1', turnId: 'turn-1', operationId: 'op-1' };
const CAPABILITIES = [rules.CAPABILITY, rules.ROTATION_CAPABILITY, rules.CREATE_SETTINGS_CAPABILITY];

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-agent-scope-'));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// The service end of a 'dispatch' call: ServiceConnection.call sends the caller's scope (service-connection.cjs) and
// the daemon runs workspace.send under it (daemon.cjs).
function client(snapshot, dispatch) {
  const c = Object.assign(new EventEmitter(), {
    close() {}, refresh: async () => {},
    snapshot: () => ({ ...snapshot(), capabilities: CAPABILITIES, wakePolicy: { enabled: true }, operatorPolicy: { domains: [] } }),
    route: () => ({ client: c, state: { capabilities: CAPABILITIES } }),
    call: async (method, ...args) => {
      if (method === 'initial') return c.snapshot();
      if (method !== 'dispatch') throw Error(method);
      const actor = background.current(), send = () => dispatch(...args);
      return actor ? background.run(actor, send) : send();
    },
  });
  return c;
}
function dispatcher(t, dir, roomState, c) {
  const d = new rules.QueueDispatcher({ roomState, dataDir: dir, connect: async () => c, clients: () => c, steward: () => null,
    settleMs: 0, tickMs: 3600000, transcriptRoot: path.join(dir, 'none'), sampleProcesses: async () => '', samplePressure: async () => '',
    compactions: { async sample() { return new Map(); } } });
  t.after(() => d.close());
  return d;
}

test('a pass an agent\'s queueAdd started sends with no agent attached', async t => {
  const dir = temp(t), roomState = new RoomState(dir), seen = [];
  const member = { id: 'm1', nativeId: 'native-m1', provider: 'claude', model: 'claude-test-model', state: 'idle', roomIds: ['shared'], roomId: 'shared',
    serviceCapabilities: [rules.CAPABILITY], chatAvailable: true, background: 0, scheduled: 0, messages: [], fleet: [], liveDraft: '', cwd: dir,
    createdAt: Date.now() - 3600000, lastActivityAt: Date.now() - 3600000 };
  const c = client(() => ({ sessions: [member], rooms: [] }), async (...args) => {
    seen.push({ to: args[0], item: args[3], actor: background.current() });
    member.state = 'working';
    return 'receipt-1';
  });
  const d = dispatcher(t, dir, roomState, c);
  await background.run(AGENT, () => {
    roomState.queueAdd('Synthetic task', null);
    return d.schedule();
  });
  assert.equal(seen.length, 1, 'the item went out');
  assert.equal(seen[0].actor, null, 'sent as NAW, not as the agent whose call started the pass');
});

test('the member\'s reply to that item settles done, not as waiting for the person', async t => {
  const dir = temp(t), roomState = new RoomState(dir);
  const host = { binaries: {}, codexTargets: new Map(), close() {}, rpc: { nativeVersion: '0.167.0', call: async () => ({ turn: { id: 'work-turn' } }) } };
  const w = new Workspace(host, dir);
  t.after(() => w.close());
  const s = { id: 'member-a', nativeId: '11111111-1111-4111-8111-111111111111', provider: 'codex', model: 'model-a', cwd: dir, view: 'chat',
    owner: 'synthetic-window', state: 'idle', createdAt: Date.now() - 3600000, controlRevision: 0, memberRevision: 0, messages: [], roomId: 'shared',
    roomIds: ['shared'], serviceCapabilities: [rules.CAPABILITY, 'nativeInputIsolation', 'rotationControlEpochV1'], background: 0, scheduled: 0 };
  const r = new Codex(s, host);
  w.sessions.set(s.id, s); w.runtimes.set(s.id, r); w.bind(s, r);
  const c = client(() => w.snapshot(), (id, text, _nativeId, itemId, control) =>
    w.send(id, text, 'naw-dispatcher', null, null, null, null, null, null, null, { itemId, control }));
  // A change in the service reaches the window as a state event (service-connection.cjs).
  w.on('change', () => c.emit('state'));
  const d = dispatcher(t, dir, roomState, c);
  let itemId;
  await background.run(AGENT, () => {
    itemId = roomState.queueAdd('Synthetic task', null);
    return d.schedule();
  });
  const sent = roomState.queueFind('shared', itemId);
  assert.equal(sent.status, 'sent');
  const input = w.snapshot().sessions.find(x => x.id === s.id).messages.find(m => m.id === sent.tag);
  // The member's turn: the input, a final answer, the turn's end.
  const frame = (method, params) => r.event({ method, params: { threadId: s.nativeId, ...params } }, host.rpc);
  frame('turn/started', { turn: { id: 'work-turn' } });
  frame('item/completed', { turnId: 'work-turn', item: { id: 'input-item', type: 'userMessage', clientId: sent.tag, content: [{ type: 'inputText', text: 'Synthetic task' }] } });
  frame('item/completed', { turnId: 'work-turn', item: { id: 'reply', type: 'agentMessage', phase: 'final_answer', text: 'Paused until the install finishes.' } });
  frame('turn/completed', { turn: { id: 'work-turn', status: 'completed' } });
  await d.schedule();
  const settled = roomState.queueFind('shared', itemId);
  assert.deepEqual([input.origin, settled.status, settled.reason ?? null], ['naw-dispatch', 'done', null]);
});
