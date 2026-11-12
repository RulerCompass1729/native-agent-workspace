// Agent background windows closed for lack of use (UI lag, 2026-11-12): what closing one must leave alone.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { BackgroundControl } = require('../background-control.cjs');
const { WorkspaceClient } = require('../workspace-client.cjs');
const sender = { id: 'agent', nativeId: 'native', provider: 'codex', name: 'Agent' };
const identity = { nativeId: 'native', sessionId: 'native-session', turnId: 'turn', callId: 'call' };
const binding = (changes = {}) => ({ sender, identity, valid: () => true, ...changes });
const invoke = (id, method, args = []) => ({ action: 'invoke', operation_id: id, method, arguments: args });
const MINUTE = 60 * 1000;

function setup(t, handlers = new Map(), options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-background-retire-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: 1_000_000 }, contexts = [], actors = { list: [sender] };
  const config = { dataDir: dir, handlers, now: () => clock.now, ...options, context: async (actor, saved, kept) => {
    const c = { background: true, actor, view: saved || { owner: 'owner-' + contexts.length, selected: actor.id }, kept, closedWindow: false,
      confirmationActors: () => actors.list, checkActor: async () => {}, retireRefused: false, held: false };
    Object.assign(c, kept);
    c.client = { retired: false, retire() { if (c.retireRefused) return false; this.retired = true; return true; }, close() {} };
    c.win = { destroyed: false, isDestroyed() { return this.destroyed; }, destroy() { this.destroyed = true; } };
    c.retain = () => c.held ? null : { clipboardText: c.clipboardText };
    contexts.push(c); return c;
  } };
  return { controller: new BackgroundControl(config), contexts, clock, actors, dir };
}

test('an idle window closes after five minutes and the next call opens one under the same owner, with what was kept', async t => {
  let runs = 0;
  const f = setup(t, new Map([['initial', c => ({ selected: c.view.selected })], ['copy', (c, text) => { runs++; c.clipboardText = text; return true; }]]));
  t.after(() => f.controller.close());
  await f.controller.call(binding(), { action: 'snapshot' });
  const first = f.contexts[0];
  assert.equal(await f.controller.call(binding(), invoke('copy-1', 'copy', ['KEPT TEXT'])).then(r => r.state), 'complete');
  f.clock.now += 4 * MINUTE;
  assert.equal(f.controller.retireIdle(), 0, 'Used four minutes ago: kept open');
  f.clock.now += 1 * MINUTE;
  assert.equal(f.controller.retireIdle(), 1);
  assert.equal(first.client.retired, true); assert.equal(first.win.destroyed, true);
  assert.equal(f.controller.contexts.size, 0);
  // The receipt of an earlier operation comes back unchanged and its handler does not run again.
  const again = await f.controller.call(binding(), invoke('copy-1', 'copy', ['KEPT TEXT']));
  assert.equal(again.duplicate, true); assert.equal(runs, 1);
  const receipt = await f.controller.call(binding(), { action: 'receipt', operation_id: 'copy-1' });
  assert.equal(receipt.receipt.state, 'complete');
  assert.equal(f.contexts.length, 2, 'Reopened on demand');
  const second = f.contexts[1];
  assert.equal(second.view.owner, first.view.owner, 'Same saved owner, so control the agent held stays with it');
  assert.equal(second.clipboardText, 'KEPT TEXT');
});

test('a window that was only looked at keeps its owner when it comes back', async t => {
  const f = setup(t, new Map([['initial', c => ({ selected: c.view.selected })]]));
  t.after(() => f.controller.close());
  await f.controller.call(binding(), { action: 'snapshot' });
  f.clock.now += 6 * MINUTE;
  assert.equal(f.controller.retireIdle(), 1);
  await f.controller.call(binding(), { action: 'snapshot' });
  assert.equal(f.contexts[1].view.owner, f.contexts[0].view.owner);
});

test('nothing closes under a call, an outbox request, a reservation or a record waiting for the person', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let hold = false;
  const f = setup(t, new Map([['initial', () => ({})], ['hold', async () => { await waiting; return true; }]]), { retireHold: () => hold });
  t.after(() => f.controller.close());
  await f.controller.call(binding(), { action: 'snapshot' });
  const other = binding({ sender: { ...sender, id: 'other', nativeId: 'other-native' } });
  await f.controller.call(other, { action: 'snapshot' });
  f.clock.now += 10 * MINUTE;
  const pending = f.controller.call(binding(), invoke('hold-1', 'hold'));
  assert.equal(f.controller.retireIdle(), 0, 'A call under way holds every window, not only its own');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.retireIdle(), 0, 'Still held while the handler waits');
  release(); await pending;
  hold = true;
  f.clock.now += 10 * MINUTE;
  assert.equal(f.controller.retireIdle(), 0, 'An outbox request under way holds every window');
  hold = false;
  // A reservation (decide reserves before it opens the window) holds every window too.
  f.controller.inflight.set('reserved', Promise.resolve());
  assert.equal(f.controller.retireIdle(), 0, 'An operation reserved holds every window');
  f.controller.inflight.clear();
  f.controller.data.records.push({ id: 'ask', actor: { ...sender }, command: invoke('ask', 'hold'), state: 'confirmation-required', at: f.clock.now });
  assert.equal(f.controller.retireIdle(), 1, 'Only the other agent\'s window closes');
  assert.equal(f.contexts[0].win.destroyed, false); assert.equal(f.contexts[1].win.destroyed, true);
});

test('a window whose native session ended or was replaced closes at once and hands nothing on', async t => {
  const f = setup(t, new Map([['initial', () => ({})]]));
  t.after(() => f.controller.close());
  await f.controller.call(binding(), { action: 'snapshot' });
  f.contexts[0].clipboardText = 'OLD SESSION TEXT';
  f.actors.list = [{ ...sender, nativeId: 'replacement' }];
  assert.equal(f.controller.retireIdle(), 1, 'No five-minute wait');
  assert.equal(f.controller.kept.size, 0);
  f.actors.list = [sender];
  await f.controller.call(binding(), { action: 'snapshot' });
  assert.equal(f.contexts[1].clipboardText, undefined);
});

test('a window stays when it cannot be handed on or its connection refuses to close', async t => {
  const f = setup(t, new Map([['initial', () => ({})]]));
  t.after(() => f.controller.close());
  await f.controller.call(binding(), { action: 'snapshot' });
  const c = f.contexts[0];
  f.clock.now += 10 * MINUTE;
  c.held = true;
  assert.equal(f.controller.retireIdle(), 0, 'A file being chosen or saved');
  c.held = false; c.retireRefused = true;
  assert.equal(f.controller.retireIdle(), 0, 'The client said it is still needed');
  assert.equal(c.win.destroyed, false);
  assert.equal(f.controller.contexts.size, 1);
  await f.controller.call(binding(), { action: 'snapshot' });
  assert.equal(f.contexts.length, 1, 'The same window goes on serving');
});

test('a window that failed to open is tried again on the next call, with what was kept', async t => {
  const f = setup(t, new Map([['initial', () => ({})]]));
  t.after(() => f.controller.close());
  await f.controller.call(binding(), { action: 'snapshot' });
  f.contexts[0].clipboardText = 'KEPT';
  f.clock.now += 6 * MINUTE;
  assert.equal(f.controller.retireIdle(), 1);
  const open = f.controller.context;
  let failures = 1;
  f.controller.context = (...args) => failures-- > 0 ? Promise.reject(Error('backend updating')) : open(...args);
  await assert.rejects(f.controller.call(binding(), { action: 'snapshot' }), /backend updating/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.controller.call(binding(), { action: 'snapshot' })).state, 'complete', 'Not cached as failed');
  assert.equal(f.contexts.at(-1).clipboardText, 'KEPT');
});

function clients() {
  const scope = Symbol();
  const real = { owner: 'view', capabilities: [], sessions: [{ id: 'one', nativeId: 'n1', provider: 'claude', state: 'idle' }], room: { revision: 0, messages: [], run: null } };
  const open = () => {
    const client = new EventEmitter(); client.call = async method => method === 'initial' ? structuredClone(real) : true;
    client.close = () => client.emit('closed');
    return new WorkspaceClient([{ key: 'one', client, state: structuredClone(real) }], 'one', scope);
  };
  return { open, real };
}

test('retiring a view leaves the manual authority other views hold; closing one does not', () => {
  const { open } = clients();
  const human = open(), agent = open(), epoch = human.control.manualEpoch;
  const guard = human.manualGuard('one');
  assert.equal(agent.retire(), true);
  assert.equal(agent.entries[0].closed, true, 'Its backend connection closed');
  assert.equal(human.control.manualEpoch, epoch); assert.equal(guard(), true);
  assert.equal(human.control.clients, 1); assert.equal(human.control.views.has(agent), false);
  // For comparison, the ordinary close counts as a change of control everywhere.
  const another = open(); another.close();
  assert.equal(guard(), false);
  human.close();
});

test('a view is not retired while it is the last one, a run or discussion is running, a pause points at it, a backend is updating or a reader reads through it', () => {
  const { open } = clients();
  const only = open();
  assert.equal(only.retire(), false, 'The native input bridge would close with the last view');
  assert.equal(only.closing, false);
  const human = open();
  only.entries[0].state.room.run = { id: 'run', status: 'running' };
  assert.equal(only.retire(), false);
  only.entries[0].state.room.run = null; only.entries[0].state.peerLeases = [{ id: 'lease', status: 'running' }];
  assert.equal(only.retire(), false);
  only.entries[0].state.peerLeases = [{ id: 'lease', status: 'paused' }];
  only.control.armed.set('one', { entry: only.entries[0], roomId: 'shared' });
  assert.equal(only.retire(), false);
  only.control.armed.clear();
  only.control.maintenance.add('one');
  assert.equal(only.retire(), false, 'A backend update hands new sockets to every view');
  only.control.maintenance.clear();
  only.control.legacyInput = { targets: new Map([['one', { readsThrough: only.entries[0] }]]), close() {} };
  assert.equal(only.retire(), false, 'A retained Claude reader reads through this view');
  only.control.legacyInput.targets.set('one', { readsThrough: human.entries[0] });
  assert.equal(only.retire(), true);
  human.close();
});
