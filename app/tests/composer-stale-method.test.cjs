const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
// NAW_STALE_METHOD_SOURCE: a mutated copy, to check that these tests fail on it.
const text = fs.readFileSync(process.env.NAW_STALE_METHOD_SOURCE || path.join(__dirname, '../renderer/renderer.js'), 'utf8');
// Pure page decisions with a fake api. The refusals themselves are thrown by the
// service before native is written; the GUI check covers the real IPC path.
const shared = text.slice(text.indexOf('// Refused before anything reached native'), text.indexOf('function sessionInputMethod('));
const session = text.slice(text.indexOf('// Refused before anything reached native'), text.indexOf('async function sessionComposerAction('));
const room = text.slice(text.indexOf('async function submitRoom('), text.indexOf("$('room-composer').onsubmit")) +
  text.slice(text.indexOf('function roomSteerAvailable('), text.indexOf('function handoffCandidates('));
const refusal = key => Object.assign(new Error(key), { uiMessage: { version: 1, key } });
const tick = () => new Promise(resolve => setImmediate(resolve));

function sessionFixture(record, replies = []) {
  const input = { value: 'hello', focus() {} };
  const binding = { id: 's1', column: false, ui: { input, send: { disabled: false }, composing: false, setValue(value) { input.value = value; return true; } } };
  const calls = [];
  const api = {};
  for (const method of ['queue', 'steer', 'send']) api[method] = async (...args) => { calls.push([method, ...args]); const reply = replies.shift(); return reply ? reply() : { ok: true }; };
  const context = vm.createContext({ state: { sessions: [{ id: 's1', nativeId: 'n1', owner: 'me', messages: [], ...record }] }, owner: 'me', mode: 'chat', api,
    soloAction: s => ({ kind: s.owner === 'me' ? 'send' : 'claim' }), composerCurrent: () => true, inputFocusAllowed: () => false,
    draftRevisions: new Map([['s1', 3]]), queuedInputs: new Map(), setTimeout, clearTimeout, Date });
  vm.runInContext(session, context);
  const arrive = patch => { context.state.sessions = [{ ...context.state.sessions[0], ...patch }]; vm.runInContext('stateArrived()', context); };
  return { context, binding, input, calls, arrive };
}

test('a queue refused on stale working state is sent once as new input when the turn has ended', async () => {
  const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  const sending = f.context.submitSession(f.binding); await tick();
  assert.equal(f.calls.length, 1); f.arrive({ state: 'idle', queueAvailable: false });
  await sending;
  assert.deepEqual(f.calls.map(c => c[0]), ['queue', 'send']); assert.deepEqual(f.calls[1], ['send', 's1', 'hello', 'n1']);
  assert.equal(f.input.value, ''); assert.equal(f.context.queuedInputs.size, 0);
});
test('the client-layer queue refusal is retried the same way', async () => {
  const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.client.currentNativeSessionOrControlChanged'); }]);
  const sending = f.context.submitSession(f.binding); await tick(); f.arrive({ state: 'idle' }); await sending;
  assert.deepEqual(f.calls.map(c => c[0]), ['queue', 'send']);
});
test('a refused steer becomes a send, or a steer to the new turn', async () => {
  for (const [patch, expected] of [[{ state: 'idle' }, ['send', 's1', 'hello', 'n1']], [{ activeTurnId: 't2' }, ['steer', 's1', 'hello', 'n1', 't2']]]) {
    const f = sessionFixture({ state: 'working', steerAvailable: true, activeTurnId: 't1' }, [() => { throw refusal('error.client.currentTurnOrControlChanged'); }]);
    const sending = f.context.submitSession(f.binding); await tick(); f.arrive(patch); await sending;
    assert.deepEqual(f.calls[0], ['steer', 's1', 'hello', 'n1', 't1']); assert.deepEqual(f.calls[1], expected); assert.equal(f.calls.length, 2);
  }
});
test('a send refused because a turn just started is queued into it', async () => {
  const f = sessionFixture({ state: 'idle' }, [() => { throw refusal('error.workspace.sessionNotReady'); }]);
  const sending = f.context.submitSession(f.binding); await tick(); f.arrive({ state: 'working', queueAvailable: true }); await sending;
  assert.deepEqual(f.calls.map(c => c[0]), ['send', 'queue']); assert.equal(f.input.value, '');
});
test('the same pick on newer state waits for another state, then reports the original refusal', async () => {
  const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  const started = Date.now(), sending = f.context.submitSession(f.binding); await tick(); f.arrive({ name: 'unrelated change' });
  await assert.rejects(sending, error => error.uiMessage.key === 'error.workspace.nativeWaitingInputUnavailable');
  assert.equal(f.calls.length, 1); assert.ok(Date.now() - started >= 950, 'waited for the bound'); assert.equal(f.input.value, 'hello');
});
test('a later state inside the bound still gets the retry', async () => {
  const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  const sending = f.context.submitSession(f.binding); await tick(); f.arrive({ name: 'unrelated change' });
  await new Promise(resolve => setTimeout(resolve, 200)); f.arrive({ state: 'idle' }); await sending;
  assert.deepEqual(f.calls.map(c => c[0]), ['queue', 'send']);
});
test('no newer state inside 1000 ms reports the original refusal', async () => {
  const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  const started = Date.now();
  await assert.rejects(f.context.submitSession(f.binding), error => error.uiMessage.key === 'error.workspace.nativeWaitingInputUnavailable');
  assert.ok(Date.now() - started < 1500); assert.equal(f.calls.length, 1);
});
test('an edited draft, a new draft revision, a native change or a lost owner is never resent', async () => {
  for (const change of ['text', 'revision', 'native', 'owner', 'disabled', 'composing', 'context']) {
    const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
    const sending = f.context.submitSession(f.binding); await tick();
    if (change === 'text') f.input.value = 'hello!';
    if (change === 'revision') f.context.draftRevisions.set('s1', 4);
    if (change === 'disabled') f.binding.ui.send.disabled = true;
    if (change === 'composing') f.binding.ui.composing = true;
    f.arrive({ state: 'idle', ...(change === 'native' ? { nativeId: 'n2' } : {}), ...(change === 'owner' ? { owner: 'other' } : {}), ...(change === 'context' ? { nativeContextPending: { reason: 'restart' } } : {}) });
    await assert.rejects(sending, error => error.uiMessage.key === 'error.workspace.nativeWaitingInputUnavailable', change);
    assert.equal(f.calls.length, 1, change);
  }
});
test('any other failure is reported at once and never resent', async () => {
  for (const error of [refusal('error.client.nativeStateChanged'), new Error('plain')]) {
    const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => { throw error; }]);
    const started = Date.now(); await assert.rejects(f.context.submitSession(f.binding), thrown => thrown === error);
    assert.ok(Date.now() - started < 200); assert.equal(f.calls.length, 1);
  }
});
test('a refused retry is reported and there is no third try', async () => {
  const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }, () => { throw refusal('error.workspace.sessionNotReady'); }]);
  const sending = f.context.submitSession(f.binding); await tick(); f.arrive({ state: 'idle' });
  await assert.rejects(sending, error => error.uiMessage.key === 'error.workspace.sessionNotReady');
  await new Promise(resolve => setTimeout(resolve, 50)); f.arrive({ state: 'working', queueAvailable: true }); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.input.value, 'hello');
});
test('newer state that arrived before the refusal is used without waiting', async () => {
  let f;
  f = sessionFixture({ state: 'working', queueAvailable: true }, [() => { f.arrive({ state: 'idle' }); throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  const started = Date.now(); await f.context.submitSession(f.binding);
  assert.ok(Date.now() - started < 200); assert.deepEqual(f.calls.map(c => c[0]), ['queue', 'send']);
});
test('a second Enter during the wait takes over: the text is delivered once and the first press stays quiet', async () => {
  const f = sessionFixture({ state: 'idle' }, [() => { throw refusal('error.workspace.sessionNotReady'); }, () => { throw refusal('error.workspace.sessionNotReady'); }]);
  const first = f.context.submitSession(f.binding); await tick();
  const second = f.context.submitSession(f.binding); await tick();
  f.arrive({ state: 'working', queueAvailable: true });
  await first; await second;
  assert.deepEqual(f.calls.map(c => c[0]), ['send', 'send', 'queue']); assert.equal(f.input.value, '');
});
test('two quick Enters refused in order: the text is delivered once, and the first press stays quiet', async () => {
  const refuse = [];
  const held = () => new Promise((_resolve, reject) => { refuse.push(() => reject(refusal('error.workspace.nativeWaitingInputUnavailable'))); });
  const f = sessionFixture({ state: 'working', queueAvailable: true }, [held, held]);
  const first = f.context.submitSession(f.binding).then(() => null, error => error); await tick();
  const second = f.context.submitSession(f.binding); await tick();
  // The first refusal comes back while the second call is still on its way.
  refuse[0](); assert.equal(await first, null, 'the first press reports nothing');
  refuse[1](); await tick();
  f.arrive({ state: 'idle' }); await second;
  assert.deepEqual(f.calls.map(c => c[0]), ['queue', 'queue', 'send']); assert.equal(f.input.value, '');
});
test('while an earlier call is still open (a Claude queue waits for its turn), a refusal is not resent', async () => {
  const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => new Promise(() => {}), () => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  f.context.submitSession(f.binding); await tick();
  f.input.value = 'next'; const second = f.context.submitSession(f.binding).then(() => null, error => error); await tick();
  f.arrive({ state: 'idle' });
  assert.equal((await second)?.uiMessage?.key, 'error.workspace.nativeWaitingInputUnavailable');
  assert.equal(f.calls.length, 2);
});
test('a refusal that arrives while an earlier call is open is not resent, even if that call closes during the wait and leaves the same text', async () => {
  let closeFirst;
  const f = sessionFixture({ state: 'working', queueAvailable: true }, [() => new Promise(resolve => { closeFirst = resolve; }), () => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  const first = f.context.submitSession(f.binding); await tick();
  const second = f.context.submitSession(f.binding).then(() => null, error => error); await tick();
  // The first call reports a context change, so the page leaves "hello" in the box on purpose.
  closeFirst({ ok: true, contextChanged: true }); await first;
  f.arrive({ state: 'idle' });
  assert.equal((await second)?.uiMessage?.key, 'error.workspace.nativeWaitingInputUnavailable');
  assert.equal(f.calls.length, 2); assert.equal(f.input.value, 'hello');
});
test('the wait helper resolves on the next state or at the bound, and keeps no waiter behind', async () => {
  const context = vm.createContext({ setTimeout, clearTimeout, Date }); vm.runInContext(shared, context);
  const waiting = context.nextStateArrival(0, Date.now() + 5000); vm.runInContext('stateArrived()', context); await waiting;
  assert.equal(vm.runInContext('stateArrivalWaiters.size', context), 0);
  const started = Date.now(); await context.nextStateArrival(1, Date.now() + 60); assert.ok(Date.now() - started >= 50);
  assert.equal(vm.runInContext('stateArrivalWaiters.size', context), 0);
  await context.nextStateArrival(0, Date.now() + 5000);
});

function roomFixture(record, replies = []) {
  const input = { value: 'hello room', readOnly: false, focus() {} };
  const nodes = { 'shared-input': input, 'forward-button': { disabled: false }, recipient: { value: 'r1' } };
  const view = { roomImages: [], sharedDraft: input.value, roomRecipient: 'r1', roomMention: null, draftRevision: 7 };
  const calls = [];
  const context = vm.createContext({ spaceId: 'shared', roomViews: { shared: view }, roomDraftRevision: 7, roomMention: null, roomReplyTo: '', roomSubmitting: null, disconnected: false,
    roomPendingRecipients: new Map(), queuedRoomInputs: new Map(), uiError: refusal, roomRecipient: () => 'r1', roomImageRefs: () => [], $: id => nodes[id], interruptPending: () => false,
    nativeWorkspaceMentions: { body: (_mention, raw) => raw }, nativeUsable: () => true, participantLabel: s => s.id,
    captureRoomView: () => Object.assign(view, { sharedDraft: input.value, draftRevision: context.roomDraftRevision }),
    render() {}, persistView: async () => {}, writeRoomDraft: (id, next) => { if (id === context.spaceId) input.value = next.sharedDraft; },
    state: { room: { messages: [] }, sessions: [{ id: 'r1', nativeId: 'n1', serviceCapabilities: ['nativeSharedQueue', 'nativeSharedSteer'], ...record }] },
    api: { spaceAction: async (...args) => { calls.push(args); const reply = replies.shift(); return reply ? reply() : { ok: true }; } }, setTimeout, clearTimeout, Date });
  context.members = () => context.state.sessions;
  vm.runInContext(shared + room, context);
  const arrive = patch => { context.state.sessions = [{ ...context.state.sessions[0], ...patch }]; vm.runInContext('stateArrived()', context); };
  return { context, input, calls, arrive };
}
test('space input: a forward refused because the member just started working is queued into that turn', async () => {
  let marked;
  const f = roomFixture({ state: 'idle' }, [() => { throw refusal('error.workspace.sessionNotReady'); }, () => { marked = f.context.queuedRoomInputs.get('r1'); return { ok: true }; }]);
  const sending = f.context.submitRoom(false); await tick();
  assert.equal(f.context.roomPendingRecipients.size, 1); f.arrive({ state: 'working', queueAvailable: true }); await sending;
  assert.deepEqual(f.calls.map(c => c[1]), ['forward', 'queueShared']); assert.deepEqual([f.calls[1][0], f.calls[1][1], [...f.calls[1][2]]], ['shared', 'queueShared', ['r1', 'hello room', 'n1', undefined]]);
  assert.equal(marked?.raw, 'hello room', 'the retried queue is followed like a first queue'); assert.equal(f.input.value, '');
  assert.equal(f.context.roomPendingRecipients.size, 0);
});
test('space input: a queue refused after the turn ended is forwarded once; edits or other failures are not resent', async () => {
  const f = roomFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  const sending = f.context.submitRoom(false); await tick(); f.arrive({ state: 'idle', queueAvailable: false }); await sending;
  assert.deepEqual(f.calls.map(c => c[1]), ['queueShared', 'forward']); assert.equal(f.context.queuedRoomInputs.size, 0);
  const edited = roomFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  const editing = edited.context.submitRoom(false); await tick(); edited.input.value = 'hello room!'; edited.context.roomDraftRevision++; edited.arrive({ state: 'idle' });
  await assert.rejects(editing); assert.equal(edited.calls.length, 1); assert.equal(edited.input.value, 'hello room!');
  const other = roomFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.client.nativeStateChanged'); }]);
  const started = Date.now(); await assert.rejects(other.context.submitRoom(false)); assert.ok(Date.now() - started < 200); assert.equal(other.calls.length, 1);
  const busy = roomFixture({ state: 'working', queueAvailable: true }, [() => { throw refusal('error.workspace.nativeWaitingInputUnavailable'); }]);
  const stillBusy = busy.context.submitRoom(false); await tick(); busy.arrive({ queueAvailable: false });
  await assert.rejects(stillBusy, error => error.uiMessage.key === 'error.workspace.nativeWaitingInputUnavailable'); assert.equal(busy.calls.length, 1, 'a forward to a working member is not tried');
});
