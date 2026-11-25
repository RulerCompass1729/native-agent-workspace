// R207: the person's stop while the handoff asked for by hand is written, against the real Workspace episode rules.
// Synthetic sessions; nothing native runs.
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs'), { RoomState } = require('../room-state.cjs');
const rules = require('../queue-dispatch.cjs');
const CAPABILITIES = [rules.CAPABILITY, rules.ROTATION_CAPABILITY, 'createSettingsV1'];
const WEEK = 7 * 24 * 60 * 60 * 1000;

async function fixture(t, provider = 'codex') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-rotation-stop-')), writes = [], notices = [];
  const host = { binaries: {}, close() {}, rpc: {} }, w = new Workspace(host, dir);
  const s = { id: 'a', nativeId: 'native-a', provider, model: provider === 'codex' ? 'model-a' : 'claude-opus-5', view: 'chat', cwd: dir, owner: 'window', state: 'idle', createdAt: Date.now() - 10000,
    messages: [], fleet: [], roomId: 'shared', roomIds: ['shared'], controlRevision: 0, memberRevision: 0, draftRevision: 0, serviceCapabilities: CAPABILITIES, permissionMode: 'manual',
    ...(provider === 'codex' ? { collaborationMode: 'default' } : {}) };
  const runtime = new EventEmitter();
  Object.assign(runtime, { host, chatAvailable: true, terminal: { alive: true, input() {} }, interrupt: async () => ({ interrupted: true }) });
  runtime.send = async (text, tag, guard) => {
    if (!guard()) throw Object.assign(Error('not-sent'), { notSent: true });
    writes.push({ text, tag });
    runtime.emit('submitted', tag);
  };
  w.sessions.set(s.id, s); w.runtimes.set(s.id, runtime); w.bind(s, runtime);
  s.background = 0; s.scheduled = 0;
  const client = new EventEmitter();
  Object.assign(client, {
    snapshot: () => ({ ...w.snapshot(), capabilities: CAPABILITIES }), refresh: async () => client.snapshot(), close() {},
    route: () => ({ client, state: { capabilities: CAPABILITIES } }),
    call: async (method, ...args) => {
      if (method === 'initial') return w.snapshot();
      if (method === 'invalidateRotation') return w.invalidateRotation(...args);
      if (method === 'completeRotation') return w.completeRotation(...args);
      if (method === 'dispatch') return w.send(args[0], args[1], 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: args[3], control: args[4] });
      throw Error('Unexpected call: ' + method);
    } });
  const f = { dir, w, s, runtime, writes, notices, client, clock: Date.now() };
  f.make = () => new rules.QueueDispatcher({ dataDir: dir, roomState: f.room, clients: () => client, now: () => f.clock, settleMs: 0, tickMs: 3600000,
    notify: kind => notices.push(kind), steward: () => f.butler ? { sessionId: 'a', nativeId: 'native-a', duty: 'D' } : null });
  f.room = new RoomState(dir);
  f.dispatcher = f.make();
  t.after(() => { f.dispatcher.close(); w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await f.dispatcher.start();
  f.pass = async (ms = 1000) => { f.clock += ms; f.dispatcher.dirty = true; await f.dispatcher.schedule(); };
  f.ask = async by => {
    await f.dispatcher.requestRotation('a', by);
    await f.dispatcher.schedule();
    assert.equal(f.dispatcher.rotations.a?.phase, 'requested', JSON.stringify([f.dispatcher.rotationRows, f.dispatcher.rotationGates, [...f.dispatcher.requestGates], f.dispatcher.lastError?.message, w.snapshot().wakePolicy, w.snapshot().capabilities]));
    f.tag = f.dispatcher.rotations.a.tag;
    runtime.emit('replyBound', { tag: f.tag, nativeId: 'native-a', turnId: 'turn-1' });
    runtime.emit('state', 'working');
    assert.equal(s.rotationEpisode.state, 'open');
  };
  // What the window's calls do here: main.cjs tells the dispatcher, then the service acts.
  f.esc = () => { f.dispatcher.noteHuman('a', 'input', '\x1b', 'window'); w.input('a', '\x1b', 'window'); };
  f.interrupt = async () => { f.dispatcher.noteHuman('a', 'interrupt', undefined, 'window'); await w.interrupt('a', 'window'); };
  // As the adapters report it: Claude's `interrupted` (adapters.cjs finishInterrupted), Codex's failed turn (finishTurn).
  f.cut = (text = '') => {
    if (text) runtime.emit('nativeBlock', { id: 'response-1', kind: 'response', nativeId: 'native-a', turnId: 'turn-1', status: 'complete', text });
    runtime.emit('nativeBlock', { id: 'turn:turn-1', kind: 'turn', nativeId: 'native-a', turnId: 'turn-1', status: 'interrupted', text: '' });
    if (provider === 'claude') { runtime.emit('interrupted', { turnId: 'turn-1', tag: f.tag }); runtime.emit('state', 'idle'); }
    else { runtime.emit('state', 'idle'); runtime.emit('failed', 'stopped', { tag: f.tag }); }
  };
  f.written = (text = 'Synthetic handoff') => {
    runtime.emit('nativeBlock', { id: 'response-1', kind: 'response', nativeId: 'native-a', turnId: 'turn-1', status: 'complete', text });
    runtime.emit('nativeBlock', { id: 'turn:turn-1', kind: 'turn', nativeId: 'native-a', turnId: 'turn-1', status: 'complete', text: '' });
    runtime.emit('complete', { tag: f.tag, text: '' });
    runtime.emit('state', 'idle');
  };
  f.log = () => fs.readFileSync(path.join(dir, 'rotation-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  // Stopped as the rotation of before R207 stopped: released, nothing failed, nothing resting, nothing asked for again.
  f.stopped = async () => {
    await f.pass(); await f.pass();
    assert.equal(s.pendingTag, null);
    assert.deepEqual([f.dispatcher.rotations, f.dispatcher.requests, f.writes.length], [{}, {}, 1]);
    assert.equal(s.rotationEpisode.state, 'released');
    assert.deepEqual([f.notices, f.log().filter(e => e.event === 'failed')], [[], []]);
    assert.equal(f.log().findLast(e => e.event === 'waiting').reason, 'person-active');
    const said = (f.room.value.events || []).map(e => e.uiMessage?.key).filter(key => /rotation\.(withdrawn|deferred|failed)$/.test(key));
    assert.deepEqual(said, s.roomIds.length ? ['notice.rotation.withdrawn'] : [], 'its space is not told it will be tried again');
    // Claude's next turn end reports its background work, as after any Esc.
    s.backgroundStale = false;
    const ready = rules.sessionReady(w.snapshot().sessions[0], { enabled: true });
    assert.deepEqual([ready.ready, ready.reason], [true, ''], 'the next input, a wake included, is not held');
    await f.pass(60 * 60 * 1000);
    assert.equal(f.writes.length, 1, 'not asked again by itself');
  };
  return f;
}

for (const provider of ['claude', 'codex']) {
  for (const [name, act] of [['Esc in the terminal', f => f.esc()], ['the interrupt button', f => f.interrupt()]]) {
    for (const text of ['', 'half a handoff']) {
      test(`R207: ${name} while ${provider} writes the handoff${text ? ', some of it written,' : ''} stops the rotation and releases the session`, async t => {
        const f = await fixture(t, provider);
        await f.ask('person');
        await act(f);
        assert.equal(f.dispatcher.rotations.a.stopped?.by, 'person');
        f.cut(text);
        await f.stopped();
      });
    }
  }
}

test('R207: Esc, then the person\'s message and its answer: still stopped, not asked for again', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.esc();
  f.cut('half');
  f.runtime.emit('nativeBlock', { id: 'input-2', kind: 'input', nativeId: 'native-a', turnId: 'turn-2', status: 'complete', text: 'do this instead' });
  f.runtime.emit('nativeBlock', { id: 'response-2', kind: 'response', nativeId: 'native-a', turnId: 'turn-2', status: 'complete', text: 'done' });
  await f.stopped();
});

test('R207: an Esc that leaves the turn running ends the rotation when the handoff is there; a restart remembers it', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.esc();
  await f.pass();
  assert.deepEqual([f.dispatcher.rotations.a.phase, f.dispatcher.rotationRows.a], ['requested', undefined], 'the turn is not cut by NAW; nothing to undo is shown');
  f.dispatcher.close();
  f.dispatcher = f.make();
  await f.dispatcher.start();
  f.written();
  await f.stopped();
});

test('R207: taking the session over from another window while the handoff is written stops it; looking at it does not', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.dispatcher.noteHuman('a', 'claim', 'terminal', 'window');
  f.w.claim('a', 'window', 'terminal');
  assert.equal(f.dispatcher.rotations.a.stopped, undefined, 'the same window shows its other side');
  f.dispatcher.noteHuman('a', 'claim', 'chat');
  f.s.owner = null;
  f.dispatcher.noteHuman('a', 'claim', 'chat', 'window-2');
  f.s.owner = 'window';
  assert.equal(f.dispatcher.rotations.a.stopped, undefined, 'no window known, or nobody had it');
  f.dispatcher.noteHuman('a', 'claim', 'chat', 'window-2');
  f.w.claim('a', 'window-2', 'chat');
  assert.equal(f.dispatcher.rotations.a.stopped.by, 'person');
  f.written();
  await f.stopped();
});

test('R207: keys and messages alone do not stop it: the handoff is taken', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.dispatcher.noteHuman('a', 'input', 'half a word', 'window');
  f.w.input('a', 'half a word', 'window');
  f.dispatcher.noteHuman('a', 'draft', 'x', 'window');
  f.dispatcher.noteHuman('a', 'send', 'x', 'window');
  f.written();
  await f.pass();
  assert.deepEqual([f.dispatcher.rotations.a.phase !== 'requested' || f.dispatcher.rotations.a.phase, f.s.rotationEpisode.state, f.dispatcher.rotations.a.handoff], [true, 'complete', 'Synthetic handoff']);
});

test('R207: cut off where this NAW saw no key (a phone, the native CLI): the interrupted turn says so', async t => {
  for (const text of ['', 'half']) {
    const f = await fixture(t);
    await f.ask('person');
    f.cut(text);
    await f.stopped();
  }
});

test('R207: a turn that ended with no handoff and no stop is still a failure, and one the provider failed is not the person\'s', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.written('');
  await f.pass();
  assert.deepEqual([f.dispatcher.rotations.a.phase, f.dispatcher.rotations.a.reason, f.s.rotationEpisode.state], ['failed', 'handoff-missing', 'invalid']);
});

test('R207: asked for again after the Esc, in the same turn: the click is the later word', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.esc();
  f.clock += 5000;
  await f.dispatcher.requestRotation('a', 'person');
  assert.equal(f.dispatcher.rotations.a.stopped, undefined);
  f.cut();
  f.s.messages.findLast(m => m.kind === 'turn').time = f.clock - 1000;
  await f.pass(); await f.pass(30000); await f.pass();
  assert.equal(f.writes.length, 2, 'asked again');
  assert.deepEqual([f.notices, f.log().filter(e => e.event === 'failed')], [[], []]);
});

test('R207 甲: the butler\'s rotation stopped by the person is not asked for again by the butler, in that turn or after it', async t => {
  const f = await fixture(t, 'claude');
  f.butler = true;
  f.s.roomId = null; f.s.roomIds = [];
  await f.ask('steward');
  f.esc();
  const refused = error => error?.uiMessage?.key === 'error.rotation.personFirst';
  await assert.rejects(f.dispatcher.requestRotation('a', 'steward'), refused);
  f.cut('half');
  await f.stopped();
  await assert.rejects(f.dispatcher.requestRotation('a', 'steward'), refused);
  f.s.messages.push({ id: 'said', role: 'user', text: 'go on', origin: 'gui', status: 'submitted', time: f.clock + 1 });
  assert.ok(await f.dispatcher.requestRotation('a', 'steward'));
});

test('R207: the native turn end leaves a pending request of its own in place when it does not name it', async t => {
  const f = await fixture(t, 'claude');
  await f.ask('person');
  f.esc();
  f.runtime.emit('interrupted', { turnId: 'turn-1', tag: undefined });
  f.runtime.emit('state', 'idle');
  await f.pass(); await f.pass(WEEK);
  assert.deepEqual([f.s.pendingTag, f.dispatcher.rotations.a.phase, f.dispatcher.rotations.a.stopped.by, f.notices], [f.tag, 'requested', 'person', []],
    'waits, with no failure and no expiry, until the native side accounts for that input');
  f.runtime.emit('interrupted', { turnId: 'turn-1', tag: f.tag });
  await f.stopped();
});

test('R207: a stop does not wait for the session to stay idle: the person may be about to use it', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.dispatcher.settleMs = 60000;
  // Seen working, so its idle time starts after the cut.
  await f.pass();
  f.esc();
  f.cut();
  await f.pass();
  assert.deepEqual([f.dispatcher.rotations, f.s.rotationEpisode.state], [{}, 'released']);
});

test('R207: a damaged mark of a stop is dropped on reading; the cut turn still ends it', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.dispatcher.close();
  const stored = JSON.parse(fs.readFileSync(f.dispatcher.file, 'utf8'));
  stored.rotations.a.stopped = { at: 'x', by: 'person' };
  fs.writeFileSync(f.dispatcher.file, JSON.stringify(stored));
  f.dispatcher = f.make();
  assert.equal(f.dispatcher.rotations.a.stopped, undefined);
  await f.dispatcher.start();
  f.cut();
  await f.stopped();
});
