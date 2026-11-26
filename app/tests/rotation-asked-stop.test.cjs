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
      if (method === 'invalidateRotation') {
        if (f.lose === 'answer' && args[3]) w.invalidateRotation(...args);
        if (f.lose && args[3]) throw Error('connection lost');
        return w.invalidateRotation(...args);
      }
      if (method === 'completeRotation') return w.completeRotation(...args);
      if (method === 'dispatch') return w.send(args[0], args[1], 'naw-dispatcher', null, null, null, null, null, null, null, { itemId: args[3], control: args[4] });
      throw Error('Unexpected call: ' + method);
    } });
  const f = { dir, w, s, runtime, writes, notices, client, clock: Date.now() };
  f.make = () => new rules.QueueDispatcher({ dataDir: dir, roomState: f.room, clients: () => client, now: () => f.clock, settleMs: 0, tickMs: 3600000,
    sampleProcesses: async () => '', samplePressure: async () => '1\n', notify: kind => notices.push(kind), steward: () => f.butler ? { sessionId: 'a', nativeId: 'native-a', duty: 'D' } : null });
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
  f.takeover = () => { f.dispatcher.noteHuman('a', 'claim', 'chat', 'window-2'); w.claim('a', 'window-2', 'chat'); };
  f.asButler = () => { f.butler = true; s.roomId = null; s.roomIds = []; };
  // What happens while the request is on its way; the real guard of the send then decides.
  f.sending = async (by, act) => {
    const send = runtime.send;
    runtime.send = async (...args) => { runtime.send = send; await act(); return send(...args); };
    if (by) await f.dispatcher.requestRotation('a', by);
    await f.dispatcher.schedule();
    assert.equal(runtime.send, send, 'it was being sent');
  };
  f.stored = () => JSON.parse(fs.readFileSync(f.dispatcher.file, 'utf8'));
  f.said = () => (f.room.value.events || []).map(e => e.uiMessage?.key).filter(key => /rotation\.(withdrawn|deferred|failed)$/.test(key));
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
    assert.deepEqual(f.said(), s.roomIds.length ? ['notice.rotation.withdrawn'] : [], 'its space is not told it will be tried again');
    await f.free();
  };
  f.free = async () => {
    // Claude's next turn end reports its background work, as after any Esc.
    s.backgroundStale = false;
    const ready = rules.sessionReady(w.snapshot().sessions[0], { enabled: true });
    assert.deepEqual([ready.ready, ready.reason], [true, ''], 'the next input, a wake included, is not held');
    await f.pass(60 * 60 * 1000);
    assert.equal(f.writes.length, 1, 'not asked again by itself');
  };
  // Cut off with no stop known here: let go as well, told as not finished, and no withdrawal of the person's.
  f.interrupted = async () => {
    await f.pass(); await f.pass();
    assert.deepEqual([f.dispatcher.rotations, f.dispatcher.requests, f.dispatcher.withdrawals], [{}, {}, {}]);
    assert.equal(s.rotationEpisode.state, 'released');
    assert.deepEqual(f.notices, ['failed'], 'the person is told, in no space too');
    assert.deepEqual(f.log().filter(e => e.event === 'failed').map(e => e.reason), ['handoff-interrupted']);
    assert.deepEqual(f.said(), s.roomIds.length ? ['notice.rotation.failed'] : []);
    assert.equal(rules.rotationCause({ reason: 'handoff-interrupted' }).uiMessage.key, 'notice.rotation.cause.handoffInterrupted');
    await f.free();
    assert.deepEqual(f.notices, ['failed'], 'once');
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

for (const provider of ['claude', 'codex']) {
  for (const [name, act] of [['Esc', f => f.esc()], ['a takeover from another window', f => f.takeover()]]) {
    for (const by of ['person', 'steward']) {
      test(`R207: ${name} while ${provider} is being sent the request of the ${by}: stopped, not asked for again, and the butler may not`, async t => {
        const f = await fixture(t, provider);
        if (by === 'steward') f.asButler();
        await f.sending(by, () => {
          assert.deepEqual([f.dispatcher.rotations.a.phase, f.dispatcher.rotations.a.tag], ['requested', null]);
          act(f);
          assert.equal(f.stored().withdrawals.a.by, 'person', 'saved at the key, not when the record is settled');
        });
        assert.deepEqual([f.dispatcher.rotations, f.dispatcher.requests, f.writes, f.notices], [{}, {}, [], []]);
        assert.deepEqual(f.said(), by === 'person' ? ['notice.rotation.withdrawn'] : []);
        assert.deepEqual([f.log().at(-1).event, f.log().at(-1).reason], ['waiting', 'person-active']);
        await f.pass(60 * 60 * 1000); await f.pass(WEEK);
        assert.deepEqual([f.writes, f.dispatcher.rotations], [[], {}], 'not asked again by itself');
        f.asButler();
        const refused = error => error?.uiMessage?.key === 'error.rotation.personFirst';
        await assert.rejects(f.dispatcher.requestRotation('a', 'steward'), refused);
        f.dispatcher.close();
        f.dispatcher = f.make();
        await f.dispatcher.start();
        await assert.rejects(f.dispatcher.requestRotation('a', 'steward'), refused, 'after a restart too');
        await f.dispatcher.requestRotation('a', 'person');
        assert.deepEqual([f.dispatcher.requests.a.by, f.dispatcher.withdrawals], ['person', {}], 'their own click is the later word');
      });
    }
  }
}

test('R207: not sent with no stop: asked for again; a click after the Esc keeps it, as theirs', async t => {
  const f = await fixture(t);
  f.asButler();
  await f.sending('steward', () => { throw Object.assign(Error('not-sent'), { notSent: true }); });
  assert.deepEqual([f.dispatcher.requests.a.by, f.dispatcher.withdrawals, f.dispatcher.rotations], ['steward', {}, {}]);
  f.clock += 60 * 60 * 1000;
  f.dispatcher.dirty = true;
  await f.sending(null, async () => {
    f.esc();
    await f.dispatcher.requestRotation('a', 'person');
  });
  assert.deepEqual([f.dispatcher.requests.a?.by, f.dispatcher.withdrawals, f.writes], ['person', {}, []]);
});

test('R207: a stop outlives its record: a release the butler makes does not let it ask again', async t => {
  const f = await fixture(t, 'claude');
  f.asButler();
  await f.ask('steward');
  f.esc();
  f.lose = true;
  f.cut();
  await f.pass();
  assert.deepEqual([f.dispatcher.rotations.a.phase, f.s.rotationEpisode.state], ['failed', 'invalid'], 'its release did not go through');
  const { epoch, tag } = f.s.rotationEpisode;
  f.w.releaseRotation('a', 'native-a', epoch, tag, { kind: 'steward', id: 'a' }, 'released');
  f.lose = false;
  delete f.dispatcher.rotations.a;
  await assert.rejects(f.dispatcher.requestRotation('a', 'steward'), error => error?.uiMessage?.key === 'error.rotation.personFirst');
});

for (const provider of ['claude', 'codex']) {
  for (const text of ['', 'half']) {
    test(`R207: ${provider}'s handoff turn interrupted ${text ? 'half written ' : ''}with no stop seen here (native CLI, an agent, a restart): let go, told, nobody's withdrawal`, async t => {
      for (const by of ['person', 'steward']) {
        const f = await fixture(t, provider);
        if (by === 'steward') f.asButler();
        await f.ask(by);
        f.cut(text);
        await f.interrupted();
        if (by === 'steward') assert.ok(await f.dispatcher.requestRotation('a', 'steward'), 'the person took nothing back');
        else assert.deepEqual([await f.dispatcher.requestRotation('a', 'person').then(() => f.dispatcher.requests.a.by)], ['person']);
      }
    });
  }
}

test('R207: an interrupted turn whose release is not confirmed is told at once, kept, and told once', async t => {
  for (const restart of [false, true]) {
    const f = await fixture(t);
    await f.ask('person');
    f.lose = true;
    f.cut();
    await f.pass(); await f.pass();
    assert.deepEqual([f.dispatcher.rotations.a.phase, f.dispatcher.rotations.a.reason, f.notices], ['failed', 'handoff-interrupted', ['failed']]);
    if (restart) {
      f.dispatcher.close();
      f.dispatcher = f.make();
      await f.dispatcher.start();
    }
    f.lose = false;
    await f.pass(61000);
    await f.interrupted();
  }
});

test('R207: released with its answer lost: their later click still stands, a stop still stands, an interruption is told once', async t => {
  for (const [act, after] of [
    ['click', f => assert.deepEqual([f.dispatcher.requests.a?.by, f.notices], ['person', []])],
    ['stop', f => assert.deepEqual([f.dispatcher.requests, f.dispatcher.withdrawals.a?.by, f.notices], [{}, 'person', []])],
    ['none', f => assert.deepEqual([f.dispatcher.requests, f.dispatcher.withdrawals, f.notices], [{}, {}, ['failed']])],
  ]) {
    const f = await fixture(t);
    await f.ask('person');
    if (act !== 'none') f.esc();
    f.clock += 5000;
    if (act === 'click') await f.dispatcher.requestRotation('a', 'person');
    f.cut();
    if (act === 'click') f.s.messages.findLast(m => m.kind === 'turn').time = f.clock - 1000;
    f.lose = 'answer';
    await f.pass();
    assert.deepEqual([f.dispatcher.rotations.a.phase, f.s.rotationEpisode.state], ['failed', 'released'], act);
    f.lose = false;
    f.s.state = 'working';
    await f.pass(61000);
    assert.deepEqual(f.dispatcher.rotations, {}, act);
    after(f);
  }
});

test('R207: what the person releases by hand does not come back as their request', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.esc();
  f.clock += 5000;
  await f.dispatcher.requestRotation('a', 'person');
  f.cut();
  f.s.messages.findLast(m => m.kind === 'turn').time = f.clock - 1000;
  f.lose = true;
  await f.pass();
  const { epoch, tag } = f.s.rotationEpisode;
  f.w.releaseRotation('a', 'native-a', epoch, tag, { kind: 'person', id: 'person' }, 'released');
  f.lose = false;
  await f.pass(61000);
  assert.deepEqual([f.dispatcher.rotations, f.dispatcher.requests], [{}, {}]);
});

// 11-25: no longer as before (failed, resting): a cut turn is half a handoff whichever way it was asked for.
test('R207: one that came due by itself, its handoff turn interrupted, is let go and told, then asked again once quiet', async t => {
  const f = await fixture(t);
  await f.ask('person');
  delete f.dispatcher.rotations.a.person;
  f.cut();
  await f.pass(); await f.pass(61000);
  assert.deepEqual([f.dispatcher.rotations, f.s.rotationEpisode.state, f.notices], [{}, 'released', ['failed']]);
  assert.deepEqual(f.log().filter(e => e.event === 'failed').map(e => e.reason), ['handoff-interrupted']);
  assert.ok(f.dispatcher.deferredAt.has('a'), 'asked again once quiet');
});

test('R207: a turn interrupted after the person took the rotation back, or after their Esc, is theirs and not a failure', async t => {
  const f = await fixture(t);
  await f.ask('person');
  await f.dispatcher.withdrawRotation('a');
  f.cut();
  await f.pass(); await f.pass();
  assert.deepEqual([f.dispatcher.rotations, f.dispatcher.requests, f.notices], [{}, {}, []]);
  assert.deepEqual(f.said(), ['notice.rotation.withdrawn']);
});

test('R207: the person\'s own key is not stopped by a state that cannot be read', async t => {
  const f = await fixture(t);
  await f.ask('person');
  const snapshot = f.client.snapshot;
  f.client.snapshot = () => { throw Error('not now'); };
  f.dispatcher.noteHuman('a', 'input', 'k', 'window');
  f.dispatcher.noteHuman('a', 'claim', 'chat', 'window-2');
  assert.deepEqual([f.dispatcher.typed.a.at, f.dispatcher.rotations.a.stopped], [f.clock, undefined]);
  f.dispatcher.noteHuman('a', 'input', '\x1b', 'window');
  assert.equal(f.dispatcher.rotations.a.stopped.by, 'person', 'an Esc needs no state');
  f.client.snapshot = snapshot;
});

test('R207: a turn that ended with no handoff and no stop is still a failure, and one the provider failed is not the person\'s', async t => {
  const f = await fixture(t);
  await f.ask('person');
  f.written('');
  await f.pass();
  assert.deepEqual([f.dispatcher.rotations.a.phase, f.dispatcher.rotations.a.reason, f.s.rotationEpisode.state], ['failed', 'handoff-missing', 'invalid']);
  for (const text of ['', 'half']) {
    const g = await fixture(t);
    await g.ask('person');
    if (text) g.runtime.emit('nativeBlock', { id: 'response-1', kind: 'response', nativeId: 'native-a', turnId: 'turn-1', status: 'complete', text });
    g.runtime.emit('nativeBlock', { id: 'turn:turn-1', kind: 'turn', nativeId: 'native-a', turnId: 'turn-1', status: 'failed', text: '' });
    g.runtime.emit('state', 'idle');
    g.runtime.emit('failed', 'the provider failed', { tag: g.tag });
    await g.pass();
    const record = g.dispatcher.rotations.a;
    assert.deepEqual([record.phase, record.stopped, g.dispatcher.withdrawals, g.s.rotationEpisode.state, g.notices], ['failed', undefined, {}, 'invalid', ['failed']], text);
    assert.equal(record.handoff, undefined, 'half a handoff is not one');
  }
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
  await f.interrupted();
});
