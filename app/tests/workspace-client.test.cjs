const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WorkspaceClient } = require('../workspace-client.cjs');
const { assertSubmission, assertNativeCreation, submissionState } = require('../submission-policy.cjs');
const current = ['claudePromptIdentity', 'resume', 'forget', 'clearSharedHistory', 'structuredClaudeSubmit', 'verifiedHandoffs', 'nativePermissionDefaults', 'nativeInputIsolation'];
test('a delayed initial response cannot reverse newer membership, messages or permission state', async () => {
  const { ServiceClient } = require('../service-client.cjs');
  for (const newerRead of [false, true]) {
    const socket = new EventEmitter(), writes = [];
    socket.setEncoding = () => {}; socket.write = text => writes.push(JSON.parse(text));
    socket.end = () => socket.emit('close');
    const client = new ServiceClient(socket);
    const initial = { owner: 'view', capabilities: [], sessions: [{ id: 'one', provider: 'claude', state: 'idle' }], room: { messages: [] } };
    const entry = { key: 'one', client, state: initial }, c = new WorkspaceClient([entry], 'one');
    const pending = c.refresh();
    const fresh = structuredClone(initial);
    Object.assign(fresh.sessions[0], { roomId: 'shared', memberRevision: 2, state: 'approval',
      approval: { requestId: 'current' }, messages: [{ id: 'new-message', text: 'Current native result' }] });
    const reply = { id: writes[0].id, ok: true, value: newerRead ? fresh : initial };
    const event = { event: 'state', data: newerRead ? initial : fresh };
    // Both lines arrive before the resolved promise resumes. Verify both orders:
    // a later event wins, and a later read is not dropped merely due to an event.
    socket.emit('data', (newerRead ? [event, reply] : [reply, event]).map(JSON.stringify).join('\n') + '\n');
    await pending;
    assert.deepEqual(entry.state.sessions, fresh.sessions);
    c.close();
  }
});
test('late initial replies cannot overwrite a replaced connection or carry queued creation across it', async () => {
  for (const method of ['initial', 'create']) {
    const { c, next } = fixture(); let release;
    const original = next.client, call = original.call;
    original.call = async (...args) => {
      const result = await call(...args);
      if (args[0] === 'initial') await new Promise(resolve => { release = resolve; });
      return result;
    };
    const pending = c.call(method, { provider: 'claude' });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const finish = c.maintainService('next'), replacement = new EventEmitter();
    const fresh = { ...next.state, runtimeVersion: 'replacement' };
    replacement.call = async () => fresh; replacement.close = () => replacement.emit('closed');
    c.replaceService('next', replacement, fresh); finish(); release();
    if (method === 'create') await assert.rejects(pending, /连接已变化/); else await pending;
    assert.equal(next.state.runtimeVersion, 'replacement'); assert.equal(next.calls.some(([m]) => m === 'create'), false);
    c.close();
  }
});
test('queued native intents never cross maintenance or silently use a replacement socket', async () => {
  for (const method of ['input', 'send', 'resume', 'claim']) {
    const { c, next } = fixture(); let release, calls = 0;
    c.pauseExcept = async () => new Promise(resolve => { release = resolve; });
    const pending = c.call(method, 'new', 'Old intent');
    assert.equal(typeof release, 'function');
    const finish = c.maintainService('next'), replacement = new EventEmitter();
    replacement.call = async () => { calls++; }; replacement.close = () => replacement.emit('closed');
    c.replaceService('next', replacement, next.state); finish(); release();
    await assert.rejects(pending, /连接已变化/); assert.equal(calls, 0); assert.equal(next.calls.length, 0);
    c.close();
  }
});
test('ended-service maintenance isolates socket loss across windows and fails closed if replacement fails', async () => {
  const first = fixture(), second = first.openWindow();
  first.old.real.sessions.forEach(s => { s.state = 'ended'; });
  await first.c.refresh(); await second.c.refresh();
  let disconnects = 0;
  first.c.on('closed', () => disconnects++); second.c.on('closed', () => disconnects++);
  const finish = first.c.maintainService('old');
  assert.throws(() => second.c.maintainService('old'), /已在更新/);
  first.old.client.emit('closed'); second.old.client.emit('closed');
  assert.equal(disconnects, 0); assert.equal(second.c.socket.destroyed, false);
  await second.c.call('initial'); await second.c.call('draft', 'new', 'Unrelated preedit draft');
  assert.equal(first.next.real.sessions[0].liveDraft, 'Unrelated preedit draft');
  await assert.rejects(second.c.call('resume', 'old'), /正在更新/);
  const legacyOnly = first.openWindow(false);
  await assert.rejects(legacyOnly.c.call('create', { provider: 'claude' }), /正在更新/);
  legacyOnly.c.close();
  const replacement = new EventEmitter(); replacement.call = async () => first.old.state; replacement.close = () => replacement.emit('closed');
  first.c.replaceService('old', replacement, first.old.state);
  finish();
  assert.equal(first.c.socket.destroyed, false); assert.equal(second.c.socket.destroyed, true);
  assert.equal(disconnects, 1, 'Only the view whose replacement failed disconnects');
  first.c.close(); second.c.close();
});
test('replacing an ended backend ignores stale events and leaves unrelated live transports connected', async () => {
  const { c, old, next } = fixture(), seen = [];
  c.on('terminal', e => seen.push(e)); c.on('progress', e => seen.push(e));
  const replacement = new EventEmitter(), fresh = { ...old.state, runtimeVersion: 'new-connection' };
  replacement.call = async () => fresh; replacement.close = () => replacement.emit('closed');
  const original = old.client;
  original.emit('closed'); assert.equal(c.socket.destroyed, true);
  let unrelatedClosed = false; next.client.on('closed', () => { unrelatedClosed = true; });
  c.replaceService('old', replacement, fresh);
  original.emit('state', { ...fresh, runtimeVersion: 'stale' }); original.emit('terminal', { text: 'stale' }); original.emit('progress', { text: 'stale' }); original.emit('closed');
  assert.equal(c.socket.destroyed, false); assert.equal(old.state.runtimeVersion, 'new-connection'); assert.deepEqual(seen, []); assert.equal(unrelatedClosed, false);
  replacement.emit('terminal', { text: 'current' }); assert.deepEqual(seen, [{ text: 'current' }]);
  await c.call('draft', 'new', 'Still typing'); assert.equal(next.real.sessions[0].liveDraft, 'Still typing');
  c.close();
});
test('portal archive authorization is checked again after a delayed pause for already queued input and sharing', async () => {
  for (const method of ['input', 'send', 'forward']) {
    const { c, next } = fixture(); let archived = false, release;
    c.authorizeOperation = () => { if (archived) throw Error('Archived'); };
    c.pauseExcept = async () => new Promise(resolve => { release = resolve; });
    const pending = c.call(method, 'new', 'older queued action'); archived = true; release();
    await assert.rejects(pending, /Archived/); assert.equal(next.calls.some(([m]) => m === method), false); c.close();
  }
});
function fixture() {
  const scope = Symbol();
  const make = (key, capabilities, sessions) => {
    const real = { owner: 'view', runtimeVersion: key, capabilities, sessions, diagnostics: { dispatches: 0, shellModelCalls: 0 }, room: { revision: 0, messages: [], run: null } };
    let sequence = 0;
    return () => {
      const client = new EventEmitter(), calls = [];
      const e = { key, client, state: structuredClone(real), real, calls };
      client.call = async (method, ...args) => {
        calls.push([method, ...args]);
        if (method === 'initial') return structuredClone(real);
        if (method === 'create') { const id = `new-${real.sessions.length}`; real.sessions.push({ id, provider: 'claude', state: 'idle' }); return id; }
        if (method === 'run') real.room.run = { id: `run-${++sequence}`, status: 'running', ids: args[0] };
        if (method === 'pause' && real.room.run) real.room.run.status = 'paused';
        if (method === 'join') real.sessions.find(s => s.id === args[0]).roomId = args[1] ? 'shared' : null;
        if (method === 'draft') real.sessions.find(s => s.id === args[0]).liveDraft = args[1];
        if (method === 'forward') { real.diagnostics.dispatches++; real.room.messages.push({ id: `shared-${key}`, text: args[1], time: 2 }); }
        return true;
      };
      client.close = () => { client.emit('closed'); };
      return e;
    };
  };
  const oldView = make('old', ['resume', 'forget', 'clearSharedHistory'], [{ id: 'old', nativeId: 'same-native', pid: 321, provider: 'claude', state: 'idle', liveDraft: 'private draft', messages: [{ text: 'PRIVATE' }] }, { id: 'old-codex', provider: 'codex', state: 'idle' }]);
  const nextView = make('next', current, [{ id: 'new', provider: 'claude', state: 'idle' }]);
  const openWindow = (includeNext = true) => { const old = oldView(), next = nextView(); return { old, next, c: new WorkspaceClient(includeNext ? [old, next] : [old], includeNext ? 'next' : 'old', scope) }; };
  return { ...openWindow(), openWindow };
}
test('approval synchronization is a per-session backend capability, including retained alpha.31', async () => {
  const { old, next, c } = fixture();
  old.real.runtimeVersion = '0.1.0-alpha.31';
  next.real.capabilities.push('nativeApprovalSync');
  for (const s of [old.real.sessions[1], next.real.sessions[0]]) Object.assign(s, {
    provider: 'codex', state: 'approval', owner: 'view',
    approval: { requestId: 'opaque-request', method: 'item/commandExecution/requestApproval', params: { command: 'synthetic', cwd: '/synthetic' } },
  });
  await c.refresh();
  const oldSession = c.snapshot().sessions.find(s => s.id === 'old-codex');
  assert.equal(oldSession.approvalDecisionAvailable, false);
  assert.match(oldSession.approvalNotice, /旧连接/);
  assert.equal(c.snapshot().sessions.find(s => s.id === 'new').approvalDecisionAvailable, true);
  for (const decision of ['accept', 'decline']) await assert.rejects(c.call('approve', 'old-codex', 'opaque-request', decision), /旧连接/);
  assert.equal(old.calls.some(([method]) => method === 'approve'), false);
  await c.call('approve', 'new', 'opaque-request', 'decline');
  assert.equal(next.calls.filter(([method]) => method === 'approve').length, 1);
  assert.equal(old.real.sessions[1].state, 'approval');
  c.close();
});
test('retained approval synchronization does not imply support for local approval or native cancel', async () => {
  const { next, c } = fixture(); next.real.capabilities.push('nativeApprovalSync');
  const s = next.real.sessions[0]; Object.assign(s, { provider: 'codex', state: 'approval',
    approval: { requestId: 'native-key', method: 'item/commandExecution/requestApproval', params: {
      kind: 'command', environmentId: 'local', command: 'synthetic', cwd: '/synthetic', availableDecisions: ['accept', 'cancel'],
    } } });
  await c.refresh();
  assert.deepEqual(c.snapshot().sessions.find(r => r.id === 'new').approvalDecisions, []);
  for (const decision of ['accept', 'cancel']) await assert.rejects(c.call('approve', 'new', 'native-key', decision), /旧后台/);
  assert.equal(next.calls.some(([method]) => method === 'approve'), false);
  next.real.capabilities.push('nativeApprovalLocalDecisions'); await c.refresh();
  assert.deepEqual(c.snapshot().sessions.find(r => r.id === 'new').approvalDecisions, ['accept', 'cancel']);
  await c.call('approve', 'new', 'native-key', 'cancel');
  assert.deepEqual(next.calls.filter(([method]) => method === 'approve'), [['approve', 'new', 'native-key', 'cancel']]);
  c.close();
});
test('save retry targets only supported failed writers and preserves unrelated warnings and native work', async () => {
  const { old, next, c } = fixture();
  old.real.storageWarning = 'Unread original';
  next.real.storageWarning = 'Write failed'; next.real.storageRetryable = true; next.real.capabilities.push('retrySave');
  const call = next.client.call;
  next.client.call = async (method, ...args) => {
    if (method === 'retrySave') { next.real.storageWarning = null; next.real.storageRetryable = false; }
    return call(method, ...args);
  };
  await c.refresh(); const sessions = structuredClone(c.snapshot().sessions);
  assert.equal(c.snapshot().storageRetryable, true);
  await c.call('retrySave');
  assert.equal(c.snapshot().storageRetryable, false);
  assert.equal(c.snapshot().storageWarning, 'Unread original');
  assert.equal(old.calls.some(([method]) => method !== 'initial'), false);
  assert.deepEqual(next.calls.filter(([method]) => method !== 'initial'), [['retrySave']]);
  assert.deepEqual(c.snapshot().sessions, sessions);
  assert.equal(c.snapshot().diagnostics.dispatches, 0);
  await assert.rejects(c.call('retrySave'), /没有支持重试/); c.close();
});
test('a queued save retry never moves to a replacement backend after another write finishes', async () => {
  const { old, next, c } = fixture(); let finishFirst;
  for (const entry of [old, next]) {
    entry.real.storageWarning = 'Write failed'; entry.real.storageRetryable = true; entry.real.capabilities.push('retrySave');
  }
  const oldCall = old.client.call;
  old.client.call = async (method, ...args) => {
    if (method === 'retrySave') await new Promise(resolve => { finishFirst = resolve; });
    return oldCall(method, ...args);
  };
  await c.refresh(); const pending = c.call('retrySave'), rejected = assert.rejects(pending, /部分记录仍未保存/);
  while (!finishFirst) await new Promise(resolve => setImmediate(resolve));
  const end = c.maintainService('next'); end(); finishFirst(); await rejected;
  assert.equal(next.calls.some(([method]) => method === 'retrySave'), false);
  assert.equal(c.snapshot().storageRetryable, true);
  assert.equal(c.snapshot().diagnostics.dispatches, 0); c.close();
});
test('new sessions use the current service while legacy terminal writes and drafts keep their identity', async () => {
  const { old, next, c } = fixture();
  const before = structuredClone(old.real.sessions[0]);
  await c.call('create', { provider: 'claude' });
  await c.call('input', 'old', 'x');
  await c.call('draft', 'old', 'private draft');
  assert.equal(old.calls.filter(x => x[0] === 'create').length, 0);
  assert.equal(next.calls.filter(x => x[0] === 'input').length, 0);
  assert.deepEqual(old.real.sessions[0], before);
  assert.equal(c.snapshot().sessions.length, 4);
  assert.equal(c.snapshot().diagnostics.dispatches, 0);
});
test('current global capabilities never enable legacy Claude send or legacy recovery', async () => {
  const { old, c } = fixture(); const state = c.snapshot();
  assert.equal(submissionState(state, true).sessions[0].chatAvailable, false);
  assert.throws(() => assertSubmission(state, ['old']), /旧版会话/);
  assert.throws(() => assertNativeCreation(state, 'old'), /旧版会话/);
  assert.doesNotThrow(() => assertNativeCreation(state));
  for (const method of ['send', 'forward', 'resume']) await assert.rejects(c.call(method, 'old', 'do not dispatch'), /旧版会话/);
  assert.equal(old.calls.length, 0);
  await c.call('send', 'new', 'explicit selected text');
});
test('old Codex GUI and old sharing stay blocked while native input and safe Claude solo sends remain usable', async () => {
  const { old, next, c } = fixture();
  old.state.capabilities.push('structuredClaudeSubmit', 'verifiedHandoffs');
  old.real.capabilities = [...old.state.capabilities];
  for (const method of ['send', 'forward']) await assert.rejects(c.call(method, 'old-codex', 'keep draft'), /旧版会话/);
  await assert.rejects(c.call('forward', 'old', 'keep draft'), /旧版会话/);
  assert.equal(old.calls.length, 0);
  await c.call('send', 'old', 'safe solo input');
  await c.call('input', 'old-codex', 'native typing');
  await c.call('forward', 'new', 'explicit text from old session');
  const view = c.snapshot();
  assert.equal(view.sessions.find(s => s.id === 'old-codex').chatAvailable, false);
  assert.equal(view.sessions.find(s => s.id === 'old').shareAvailable, false);
  assert.equal(view.sessions.find(s => s.id === 'new').shareAvailable, true);
  assert.equal(next.calls.filter(c => c[0] === 'forward').length, 1);
  old.real.sessions.forEach(s => { s.roomId = 'shared'; });
  await c.call('initial');
  assert.equal(c.snapshot().capabilities.includes('verifiedHandoffs'), false);
  await assert.rejects(c.call('run', ['old', 'old-codex'], 'no old run', 2), /旧版后台/);
  assert.equal(old.calls.filter(c => c[0] === 'run').length, 0);
  c.close();
});
test('cross-version membership and explicit sharing keep one view without copying private history', async () => {
  const { old, next, c } = fixture();
  old.real.room.messages.push({ id: 'previous-shared', time: 1, text: 'already shared' });
  await c.call('join', 'old-codex', true); await c.call('join', 'new', true);
  await c.call('forward', 'new', 'selected text only');
  let state = await c.call('initial');
  assert.equal(state.room.messages.length, 2);
  assert.ok(!JSON.stringify(state.room.messages).includes('PRIVATE'));
  assert.equal(next.calls.find(x => x[0] === 'forward')[2], 'selected text only');
  assert.equal(state.capabilities.includes('verifiedHandoffs'), false);
  await assert.rejects(c.call('run', ['old-codex', 'new'], 'no automatic send', 3), /跨版本/);
  assert.equal([...old.calls, ...next.calls].filter(x => x[0] === 'run').length, 0);
  await c.call('join', 'old-codex', false); await c.call('initial');
  assert.equal(c.snapshot().sessions.find(s => s.id === 'old-codex').roomId, null);
  assert.equal(c.snapshot().capabilities.includes('verifiedHandoffs'), true);
});
test('terminal replies do not pause another service; human input does and takes the direct route', async () => {
  const { old, next, c } = fixture();
  next.real.room.run = { status: 'running' }; await c.call('initial'); old.calls.length = 0; next.calls.length = 0;
  await c.call('input', 'old', '\x1b[1;1R');
  assert.equal(next.calls.length, 0);
  await c.call('input', 'old', 'human-key');
  assert.equal(next.real.room.run.status, 'paused');
  assert.deepEqual(old.calls.map(x => x[0]), ['input', 'input']);
  assert.equal(old.calls.some(x => x[0] === 'initial'), false);
});
test('disconnect never retries input or removes the retained records; live sessions block shutdown', async () => {
  const { old, next, c } = fixture();
  await assert.rejects(c.call('shutdown'), /先结束/);
  assert.equal([...old.calls, ...next.calls].some(x => x[0] === 'shutdown'), false);
  let closed = 0; c.on('closed', () => closed++); old.client.emit('closed');
  await assert.rejects(c.call('input', 'old', 'must not retry'), /未连接/);
  assert.equal(closed, 1); assert.equal(c.snapshot().sessions.length, 3);
  assert.equal(old.calls.some(x => x[0] === 'input'), false);
  c.close();
});
test('creation limit spans versions and concurrent requests; duplicate session ownership fails closed', async () => {
  const { old, next, c } = fixture();
  next.real.sessions.push({ id: 'four', state: 'idle' }, { id: 'five', state: 'idle' });
  const results = await Promise.allSettled([c.call('create', {}), c.call('create', {})]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(c.snapshot().sessions.length, 6);
  next.real.sessions.push({ ...old.real.sessions[0] });
  await assert.rejects(c.call('initial'), /归属冲突/);
  assert.throws(() => c.snapshot(), /归属冲突/);
  await assert.rejects(c.call('input', 'old', 'unsafe'), /唯一/);
});
test('a completed run RPC is paused before peer input even before any display update arrives', async () => {
  const { old, next, c } = fixture();
  next.real.sessions.push({ id: 'second', provider: 'codex', state: 'idle' });
  next.real.sessions.forEach(s => { s.roomId = 'shared'; });
  await c.call('run', ['new', 'second'], 'synthetic goal', 3);
  assert.equal(next.state.room.run, null); // No state broadcast, as during the daemon's 35ms batch.
  assert.equal(next.real.room.run.status, 'running');
  await c.call('input', 'old', 'first'); await c.call('input', 'old', 'second');
  assert.equal(next.real.room.run.status, 'paused');
  assert.deepEqual(next.calls.map(call => call[0]), ['initial', 'run', 'pause']);
  assert.deepEqual(old.calls.map(call => call[0]), ['initial', 'input', 'input']);
  c.close();
});
test('input in another window invalidates a run still waiting for its initial snapshot', async () => {
  const first = fixture();
  first.next.real.sessions.push({ id: 'second', provider: 'codex', state: 'idle' });
  first.next.real.sessions.forEach(s => { s.roomId = 'shared'; });
  const second = first.openWindow();
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const original = first.next.client.call;
  first.next.client.call = async (method, ...args) => {
    const result = await original(method, ...args);
    if (method === 'initial') { entered(); await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const pending = first.c.call('run', ['new', 'second'], 'stale queued goal', 3);
  await waiting; await second.c.call('input', 'old', 'human input'); release();
  await assert.rejects(pending, /真人操作.*失效/);
  assert.equal(first.next.real.room.run, null);
  assert.equal(first.next.calls.some(call => call[0] === 'run'), false);
  first.c.close(); second.c.close();
});
test('cross-window pause uses the run connection and invalidates a native submission before acceptance', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Workspace } = require('../workspace.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'route-control-test-'));
  const runtimes = [], writes = [], scope = Symbol();
  const host = { binaries: {}, close() {}, create() { const r = new EventEmitter(); r.start = async () => r.emit('state', 'idle'); runtimes.push(r); return r; } };
  const w = new Workspace(host, directory);
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = [await w.create('claude', directory, 'view'), await w.create('codex', directory, 'view')]; ids.forEach(id => w.join(id, true));
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  runtimes[0].send = async (text, _tag, guard) => {
    entered(); await new Promise(resolve => { release = resolve; });
    if (!guard()) throw new Error('Canceled before native acceptance');
    writes.push(text);
  };
  const nativeSnapshot = () => structuredClone({ ...w.snapshot(), capabilities: current, runtimeVersion: 'next' });
  const makeWindow = () => {
    const old = { key: 'old', client: new EventEmitter(), state: { sessions: [{ id: 'old' }], capabilities: current, room: { messages: [], run: null } } };
    old.client.call = async method => method === 'initial' ? structuredClone(old.state) : true; old.client.close = () => {};
    const next = { key: 'next', client: new EventEmitter(), state: nativeSnapshot(), calls: [] };
    next.client.call = (method, ...args) => {
      next.calls.push(method);
      if (method === 'initial') return Promise.resolve(nativeSnapshot());
      if (method === 'run') return w.startRun(...args);
      if (method === 'pause') return Promise.resolve(w.pause('Human intervened in another window'));
      throw new Error(`Unexpected ${method}`);
    };
    next.client.close = () => {};
    return { next, c: new WorkspaceClient([old, next], 'next', scope) };
  };
  const first = makeWindow(), second = makeWindow();
  const pending = first.c.call('run', ids, 'synthetic goal', 3);
  const rejected = assert.rejects(pending, /Canceled before native acceptance/);
  await waiting; await second.c.call('input', 'old', 'human key');
  assert.equal(w.room.run.status, 'paused');
  assert.deepEqual(first.next.calls, ['initial', 'run', 'pause']);
  assert.deepEqual(second.next.calls, []);
  release(); await rejected; assert.deepEqual(writes, []);
  first.c.close(); second.c.close();
});
test('an unacknowledged peer pause blocks input rather than claiming cancellation', async () => {
  const { old, next, c } = fixture();
  next.real.sessions.push({ id: 'second', provider: 'codex', state: 'idle' });
  next.real.sessions.forEach(s => { s.roomId = 'shared'; });
  await c.call('run', ['new', 'second'], 'synthetic goal', 3);
  const original = next.client.call;
  next.client.call = (method, ...args) => method === 'pause' ? Promise.reject(new Error('Pause acknowledgement lost')) : original(method, ...args);
  await assert.rejects(c.call('input', 'old', 'must not be written'), /acknowledgement lost/);
  assert.equal(old.calls.some(call => call[0] === 'input'), false);
  assert.equal(next.real.room.run.status, 'running');
  c.close();
});
test('closing the run window preserves work and another window can acknowledge its pause', async () => {
  const first = fixture();
  first.next.real.sessions.push({ id: 'second', provider: 'codex', state: 'idle' });
  first.next.real.sessions.forEach(s => { s.roomId = 'shared'; });
  const second = first.openWindow();
  await first.c.call('run', ['new', 'second'], 'synthetic goal', 3);
  first.c.close();
  assert.equal(first.c.socket.destroyed, true);
  assert.equal(first.next.real.room.run.status, 'running');
  await second.c.call('input', 'old', 'human key');
  assert.equal(first.next.real.room.run.status, 'paused');
  assert.equal(first.next.calls.filter(call => call[0] === 'pause').length, 0);
  assert.equal(second.next.calls.filter(call => call[0] === 'pause').length, 1);
  second.c.close();
});
test('viewing a session already owned by this window does not pause its run', async () => {
  const { next, c } = fixture();
  next.real.sessions.push({ id: 'second', provider: 'codex', state: 'idle' });
  next.real.sessions.forEach(s => { s.roomId = 'shared'; s.owner = 'view'; });
  await c.call('run', ['new', 'second'], 'synthetic goal', 3);
  await c.call('claim', 'new', 'terminal'); await c.call('terminal', 'new');
  assert.equal(next.real.room.run.status, 'running');
  assert.equal(next.calls.some(call => call[0] === 'pause'), false);
  c.close();
});
test('a retained window pauses a peer run discovered by a newer window in the same profile', async () => {
  const first = fixture();
  first.next.real.sessions.push({ id: 'second', provider: 'codex', state: 'idle' });
  first.next.real.sessions.forEach(s => { s.roomId = 'shared'; });
  const retained = first.openWindow(false);
  await first.c.call('run', ['new', 'second'], 'synthetic goal', 3);
  await retained.c.call('input', 'old', 'human key');
  assert.equal(first.next.real.room.run.status, 'paused');
  assert.equal(first.next.calls.filter(call => call[0] === 'pause').length, 1);
  first.c.close(); retained.c.close();
});
test('the registered desktop IPC run handler records intent before its first awaited snapshot', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-order-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const handlers = new Map(), mainFile = path.join(__dirname, '..', 'main.cjs'), nativeRequire = createRequire(mainFile);
  const noop = () => {};
  const electron = {
    app: { setName: noop, getVersion: () => 'ipc-fixture', commandLine: { appendSwitch: noop }, requestSingleInstanceLock: () => false, quit: noop, on: noop, getPath: () => directory },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    session: { defaultSession: { setPermissionRequestHandler: noop, setPermissionCheckHandler: noop, webRequest: { onBeforeRequest: noop } } },
    Menu: { setApplicationMenu: noop, buildFromTemplate: value => value },
  };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './service-client.cjs' ? { ensureService: async () => {}, connect: () => { throw new Error('No window should boot in this IPC ordering fixture'); } } : name === './dsh-host.cjs' ? { startDsh: async () => ({ origin: 'http://127.0.0.1:10101', url: 'http://127.0.0.1:10101/', stop: noop }) } : nativeRequire(name),
    __dirname: path.dirname(mainFile), process: { env: {}, execPath: process.execPath }, URL, setTimeout, clearTimeout,
  });
  vm.runInContext(fs.readFileSync(mainFile, 'utf8'), context, { filename: mainFile });
  // Exercise the real registered handlers and their trust check, with only
  // Electron's window/transport and service startup replaced by inert fixtures.
  vm.runInContext('openWindow = async () => {};', context); await vm.runInContext('boot()', context);
  const first = fixture();
  first.next.real.sessions.push({ id: 'second', provider: 'codex', state: 'idle' });
  first.next.real.sessions.forEach(s => { s.roomId = 'shared'; });
  const second = first.openWindow();
  t.after(() => { first.c.close(); second.c.close(); });
  context.first = { client: first.c }; context.second = { client: second.c };
  vm.runInContext('windows.set(1, first); windows.set(2, second);', context);
  const event = id => { const frame = { url: 'http://127.0.0.1:10101/' }; return { sender: { id, mainFrame: frame }, senderFrame: frame }; };
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const original = first.next.client.call;
  first.next.client.call = async (method, ...args) => {
    const result = await original(method, ...args);
    if (method === 'initial') { entered(); await new Promise(resolve => { release = resolve; }); }
    return result;
  };
  const pending = handlers.get('workspace:run')(event(1), ['new', 'second'], 'older click', 3);
  await waiting;
  const human = await handlers.get('workspace:input')(event(2), 'old', 'newer human input'); assert.equal(human.ok, true);
  release(); const result = await pending;
  assert.equal(result.ok, false); assert.match(result.error, /真人操作.*失效/);
  assert.equal(first.next.calls.some(call => call[0] === 'run'), false);
  assert.equal(first.next.real.room.run, null);
});

test('previous handoff capabilities without Claude prompt identity cannot forward or run',async()=>{
 const {old,next,c}=fixture();next.real.capabilities=next.real.capabilities.filter(v=>v!=='claudePromptIdentity');
 next.real.sessions.push({...next.real.sessions[0],id:'second',provider:'codex'});
 for(const s of next.real.sessions)s.roomId='shared';await c.call('initial');
 assert.equal(c.snapshot().sessions.find(s=>s.id==='new').shareAvailable,false);
 for(const op of [()=>c.call('forward','new','material'),()=>c.call('run',['new','second'],'task',2)]) await assert.rejects(op());
 assert.equal(next.calls.filter(([method])=>['forward','run'].includes(method)).length,0);c.close();
});

test('selected same-service subset may run beside an old member; three-party capability and all service routes are checked', async () => {
  const { old, next, c } = fixture();
  old.real.sessions[0].roomId = 'shared';
  next.real.sessions.push({ id: 'second', provider: 'codex', state: 'idle', roomId: 'shared' }, { id: 'third', provider: 'claude', state: 'idle', roomId: 'shared' });
  next.real.sessions[0].roomId = 'shared'; next.real.capabilities = [...current, 'boundedReplyHandoffs'];
  await c.refresh(); assert.equal(c.snapshot().capabilities.includes('boundedReplyHandoffs'), false);
  await c.call('run', ['new', 'second'], 'selected pair', 2, 'replies'); await c.call('pause');
  await assert.rejects(c.call('run', ['new', 'second', 'third'], 'unsupported three', 3, 'replies'), /后台|交接/);
  next.real.capabilities.push('multiSessionHandoffs');
  await c.call('run', ['third', 'new', 'second'], 'selected three', 3, 'replies'); await c.call('pause');
  await assert.rejects(c.call('run', ['new', 'second', 'old'], 'mixed backend', 3, 'replies'), /跨版本/);
  assert.deepEqual(next.calls.filter(c => c[0] === 'run').map(c => c[1]), [['new', 'second'], ['third', 'new', 'second']]);
  assert.equal(old.calls.some(c => c[0] === 'run'), false); c.close();
});

test('outside history deduplicates across retained services including archived and ended records', async () => {
  const { c, old, next } = fixture();
  next.real.capabilities.push('nativeHistory');
  const nativeId = '00000000-0000-4000-8000-000000000001';
  const existing = old.real.sessions.find(s => s.id === 'old-codex');
  Object.assign(existing, { nativeId, state: 'ended', archived: true });
  assert.equal(await c.call('importHistory', nativeId), existing.id);
  assert.equal(next.calls.some(([method]) => method === 'importHistory'), false);
  assert.equal(old.calls.some(([method]) => method === 'resume'), false);
  next.real.sessions.push({ ...existing, id: 'duplicate' });
  await assert.rejects(c.call('importHistory', nativeId), /归属冲突/); c.close();
});

test('queued private, shared and automatic sends cannot cross a native context change', async () => {
  for (const method of ['send', 'forward', 'run']) {
    const { c, next } = fixture(); let release;
    next.real.capabilities=[...next.real.capabilities,'nativeContextTransitions'];
    next.real.sessions.push({ id:'new2',provider:'codex',state:'idle',roomId:'shared' });
    next.real.sessions[0].roomId='shared';await c.refresh();next.calls.length=0;
    c.pauseExcept = async () => new Promise(resolve => { release = resolve; });
    const pending = method === 'run' ? c.call(method, ['new', 'new2'], 'Review', 2) : c.call(method, 'new', 'Review');
    const checked = assert.rejects(pending, /上下文已变化/);
    for(let i=0;i<20&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(typeof release,'function');next.state.sessions.find(s=>s.id==='new').nativeId='new-context';release();
    await checked; assert.equal(next.calls.some(([m])=>m===method),false);c.close();
  }
});

test('old run transports keep five arguments while the new context guard keeps visible identity',async()=>{
 const {c,next}=fixture();Object.assign(next.real.sessions[0],{nativeId:'a',roomId:'shared'});next.real.sessions.push({id:'second',nativeId:'b',provider:'codex',state:'idle',roomId:'shared'});await c.refresh();
 await c.call('run',['new','second'],'Old protocol',2,'strict',{}, {new:'a',second:'b'});
 const request=next.calls.find(([method])=>method==='run');assert.equal(request.length,6,'Method plus five old-protocol arguments');
 await c.call('pause');await assert.rejects(c.call('run',['new','second'],'Stale preview',2,'strict',{}, {new:'wrong',second:'b'}),/上下文已变化/);c.close();
});
