// Exercise the real recovery entry point without a provider or model process.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Codex } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

function fixture(reply, pages = () => ({ data: [] })) {
  const record = { nativeId: 'saved-thread', cwd: '/synthetic', recovering: true, view: 'terminal' };
  const calls = [], states = [], histories = [], capabilities = [];
  const host = { startCodex: async () => {}, codexTargets: new Map(), codexProcess: { pid: 123 }, rpc: { call: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/resume') return reply(r);
    if (method === 'thread/items/list') return pages(params, r);
    if (method === 'turn/interrupt') return {};
    throw Error('Unexpected RPC ' + method);
  } } };
  const r = new Codex(record, host);
  r.openTerminal = async () => { calls.push({ method: 'openTerminal' }); r.terminal = { alive: true }; return r.terminal; };
  r.on('state', s => states.push(s)); r.on('history', h => histories.push(h)); r.on('capability', () => capabilities.push(r.chatAvailable));
  return { r, host, calls, states, histories, capabilities };
}
const idle = r => ({ thread: { id: r.record.nativeId, status: { type: 'idle' } } });
const item = n => ({ turnId: 'saved-turn', item: { id: 'message-' + n, type: 'userMessage', content: [{ type: 'text', text: String(n) }] } });

for (const cached of [false, true]) test('history without a native turn ID is complete, never inferred streaming: ' + cached, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-history-state-'));
  const f = fixture(idle); Object.assign(f.host, { binaries: {}, close() {} });
  const w = new Workspace(f.host, dir), s = { id: 'local', provider: 'codex', recovering: true, messages: cached ? [{ id: 'answer', role: 'assistant', text: 'partial', status: 'streaming' }] : [] };
  w.sessions.set(s.id, s); w.bind(s, f.r);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  f.r.emit('history', [{ id: 'answer', type: 'agentMessage', turnId: null, text: 'Saved answer' }]);
  assert.equal(s.messages[0].status, 'complete'); assert.equal(s.messages[0].text, 'Saved answer');
  f.r.turnId = 'actual-active';
  f.r.emit('history', [{ id: 'live-answer', type: 'agentMessage', turnId: 'actual-active', text: 'Still working' }]);
  assert.equal(s.messages.find(m => m.id === 'live-answer').status, 'streaming');
  assert.equal(w.versions.dispatches, 0);
});

test('cold resume imports paginated history before enabling graphical sends, without a model task', async () => {
  const f = fixture(idle, (p, r) => {
    assert.equal(r.chatAvailable, false);
    return p.cursor ? { data: [item(100)] } : { data: Array.from({ length: 100 }, (_, i) => item(i)), nextCursor: 'next' };
  });
  await f.r.start();
  assert.equal(f.histories.length, 1); assert.equal(f.histories[0].length, 101);
  assert.equal(f.r.chatAvailable, true); assert.equal(f.r.record.nativeId, 'saved-thread');
  assert.deepEqual(f.calls.map(c => c.method), ['thread/resume', 'openTerminal', 'thread/items/list', 'thread/items/list']);
});
for (const kind of ['working', 'approval']) test('cold resume does not lose or overwrite early ' + kind + ' notification', async () => {
  const f = fixture(r => {
    const observed = r.host.codexTargets.get(r.record.nativeId);
    if (kind === 'working') observed?.event({ method: 'turn/started', params: { turn: { id: 'active-turn' } } });
    else observed?.event({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: r.record.nativeId } });
    return idle(r);
  });
  await f.r.start();
  assert.equal(f.states.at(-1), kind);
  if (kind === 'working') assert.equal(f.r.turnId, 'active-turn');
});
for (const [status, expected] of [
  [{ type: 'active', activeFlags: [] }, 'working'],
  [{ type: 'active', activeFlags: ['waitingOnApproval'] }, 'approval'],
  [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, 'approval'],
  [{ type: 'systemError' }, 'error'], [{ type: 'notLoaded' }, 'starting'], [undefined, 'starting'],
]) test('recovery respects native status ' + JSON.stringify(status), async () => {
  const f = fixture(r => ({ thread: { id: r.record.nativeId, status } }));
  await f.r.start(); assert.equal(f.states.at(-1), expected);
  f.r.event({ method: 'thread/status/changed', params: { status: { type: 'idle' } } });
  assert.equal(f.states.at(-1), 'idle');
});
test('recovered active work cannot claim an interrupt without a confirmed turn identity', async () => {
  const f = fixture(r => ({ thread: { id: r.record.nativeId, status: { type: 'active', activeFlags: [] } } }));
  await f.r.start(); await assert.rejects(f.r.interrupt(), /原生终端中断/);
  assert.equal(f.calls.some(c => c.method === 'turn/interrupt'), false);
  f.r.event({ method: 'turn/started', params: { turn: { id: 'confirmed-turn' } } });
  await f.r.interrupt(); assert.deepEqual(f.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'saved-thread', turnId: 'confirmed-turn' } });
});
test('late history does not overwrite approval received while reading pages', async () => {
  const f = fixture(idle, (_p, r) => { r.event({ id: 9, method: 'item/commandExecution/requestApproval', params: {} }); return { data: [item(1)] }; });
  await f.r.start(); assert.equal(f.states.at(-1), 'approval');
});
test('failed history stays atomic and preserves native terminal access', async () => {
  const f = fixture(idle, p => { if (p.cursor) throw Error('synthetic failure'); return { data: [item(1)], nextCursor: 'next' }; });
  const activities = []; f.r.on('activity', x => activities.push(x));
  await f.r.start(); assert.equal(f.histories.length, 0); assert.equal(f.r.chatAvailable, false);
  assert.equal(f.r.terminal.alive, true); assert.match(activities.at(-1), /同步未完成/);
  assert.equal(f.host.codexTargets.get('saved-thread'), f.r);
});
test('closed notification before resume ACK cannot resurrect or open a terminal', async () => {
  const f = fixture(r => { r.event({ method: 'thread/closed' }); return idle(r); });
  await f.r.start(); assert.equal(f.states.at(-1), 'ended'); assert.equal(f.r.terminal, null); assert.equal(f.r.chatAvailable, false);
  assert.equal(f.host.codexTargets.size, 0); assert.equal(f.calls.length, 1);
});
test('rejected resume and mismatched identity remove provisional event target without sending', async () => {
  for (const reply of [() => { throw Error('rejected'); }, () => ({ thread: { id: 'another-thread' } })]) {
    const f = fixture(reply); await assert.rejects(f.r.start());
    assert.equal(f.r.record.nativeId, 'saved-thread'); assert.equal(f.host.codexTargets.size, 0);
    assert.equal(f.r.terminal, null); assert.equal(f.r.chatAvailable, false); assert.equal(f.calls.length, 1);
  }
});
for (const live of [false, true]) test('cold history refreshes saved partial text while preserving newer live text: ' + live, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-resume-history-'));
  const f = fixture(idle, (_p, r) => {
    if (live) r.event({ method: 'item/completed', params: { turnId: 'new-turn', item: { id: 'answer', type: 'agentMessage', text: 'new live answer' } } });
    return { data: [{ turnId: 'old-turn', item: { id: 'answer', type: 'agentMessage', text: 'complete saved answer' } }] };
  });
  Object.assign(f.host, { binaries: {}, close() {}, create: s => { f.r.record = s; return f.r; } });
  const w = new Workspace(f.host, dir);
  const s = { ...f.r.record, id: 'local-id', provider: 'codex', cwd: dir, state: 'recoverable', controlRevision: 0, messages: [{ id: 'answer', role: 'assistant', text: 'partial', status: 'streaming' }] };
  w.sessions.set(s.id, s); w.setDraft(s.id, 'UNSENT');
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await w.resume(s.id, 'owner');
  assert.equal(s.messages.length, 1); assert.equal(s.messages[0].text, live ? 'new live answer' : 'complete saved answer');
  assert.equal(s.messages[0].status, 'complete'); assert.equal(w.snapshot().sessions[0].liveDraft, 'UNSENT');
  assert.equal(s.nativeId, 'saved-thread'); assert.equal(w.versions.dispatches, 0);
});
test('persisted partial reply ignores overlapping deltas until native completion', async () => {
  const f = fixture(idle, (_p, r) => { r.event({ method: 'item/agentMessage/delta', params: { itemId: 'old-answer', delta: 'partial again' } }); return { data: [] }; });
  f.r.record.messages = [{ id: 'old-answer', role: 'assistant', text: 'partial', status: 'streaming' }];
  const deltas = [], items = []; f.r.on('delta', x => deltas.push(x)); f.r.on('messageItem', x => items.push(x));
  await f.r.start(); assert.equal(deltas.length, 0);
  f.r.event({ method: 'item/completed', params: { turnId: 'old-turn', item: { id: 'old-answer', type: 'agentMessage', text: 'complete' } } });
  assert.equal(items[0].text, 'complete');
});
for (const kind of ['delta', 'user']) test('message before resume ACK cannot turn uncertain live state into idle: ' + kind, async () => {
  const f = fixture(r => {
    if (kind === 'delta') r.event({ method: 'item/agentMessage/delta', params: { itemId: 'live', delta: 'working' } });
    else r.event({ method: 'item/completed', params: { item: item(2).item } });
    return idle(r);
  });
  await f.r.start(); assert.ok(!f.states.includes('idle')); assert.equal(f.r.terminal.alive, true);
  f.r.event({ method: 'thread/status/changed', params: { status: { type: 'idle' } } }); assert.equal(f.states.at(-1), 'idle');
});
test('native history confirms a saved uncertain submission without replaying it', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-resume-status-'));
  const f = fixture(idle, () => ({ data: [{ turnId: 'old', item: { ...item(1).item, clientId: 'gui-tag' } }] }));
  Object.assign(f.host, { binaries: {}, close() {}, create: s => { f.r.record = s; return f.r; } });
  const w = new Workspace(f.host, dir);
  const s = { ...f.r.record, id: 'local-id', provider: 'codex', cwd: dir, state: 'recoverable', controlRevision: 0, messages: [{ id: 'gui-tag', role: 'user', text: '1', status: 'unconfirmed' }] };
  w.sessions.set(s.id, s); t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await w.resume(s.id, 'owner'); assert.equal(s.messages.length, 1); assert.equal(s.messages[0].id, 'gui-tag'); assert.equal(s.messages[0].status, 'submitted'); assert.equal(w.versions.dispatches, 0);
});
for (const scenario of ['two-each', 'extra-cache', 'gui-exact', 'mixed-content', 'live-input']) {
  test('old random native display IDs reconcile one-for-one: ' + scenario, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-resume-legacy-'));
    const user = (id, extra = {}) => ({ id, type: 'userMessage', content: [{ type: 'text', text: 'same' }], ...extra });
    const count = scenario === 'two-each' ? 2 : 1;
    const f = fixture(idle, (_p, r) => {
      if (scenario === 'live-input') r.event({ method: 'item/completed', params: { item: user('new-live') } });
      return { data: Array.from({ length: count }, (_, i) => ({ item: user('native-' + i,
        scenario === 'gui-exact' ? { clientId: 'gui' } : scenario === 'mixed-content'
          ? { content: [{ type: 'text', text: 'same' }, { type: 'image', url: 'synthetic' }] } : {}) })) };
    });
    Object.assign(f.host, { binaries: {}, close() {}, create: s => { f.r.record = s; return f.r; } });
    const w = new Workspace(f.host, dir);
    const cached = id => ({ id, role: 'user', text: 'same', status: 'submitted', origin: 'native' });
    const s = { ...f.r.record, id: 'local', provider: 'codex', cwd: dir, state: 'recoverable',
      controlRevision: 0, messages: [cached('old-1'), ...(['two-each', 'extra-cache'].includes(scenario) ? [cached('old-2')] : []),
        ...(scenario === 'gui-exact' ? [{ ...cached('gui'), origin: 'human' }] : [])] };
    w.sessions.set(s.id, s);
    t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await w.resume(s.id, 'owner');
    const expected = { 'two-each': ['native-0', 'native-1'], 'extra-cache': ['native-0', 'old-2'],
      'gui-exact': ['gui', 'old-1'], 'mixed-content': ['native-0', 'old-1'], 'live-input': ['native-0', 'new-live'] };
    assert.deepEqual(s.messages.map(m => m.id), expected[scenario]);
    assert.equal(w.versions.dispatches, 0); assert.deepEqual(w.room.messages, []);
    assert.equal(s.controlRevision, scenario === 'live-input' ? 2 : 1);
  });
}
test('a failed terminal launch after native resume keeps the owned runtime for retry', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-resume-terminal-'));
  const f = fixture(idle); const open = f.r.openTerminal; f.r.openTerminal = async () => { throw Error('synthetic terminal failure'); };
  Object.assign(f.host, { binaries: {}, close() {}, create: s => { f.r.record = s; return f.r; } });
  const w = new Workspace(f.host, dir), s = { ...f.r.record, id: 'local-id', provider: 'codex', cwd: dir, state: 'recoverable', controlRevision: 0, messages: [] };
  w.sessions.set(s.id, s); t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(w.resume(s.id, 'owner'), /terminal failure/);
  assert.equal(w.runtime(s.id), f.r); assert.equal(f.host.codexTargets.get(s.nativeId), f.r);
  await assert.rejects(w.resume(s.id, 'owner'), /仍有运行连接/);
  f.r.openTerminal = open; await f.r.openTerminal(); assert.equal(f.r.terminal.alive, true);
});
test('saved GUI client IDs suppress their echo across recovery but not new terminal input', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-resume-echo-'));
  const echo = { ...item(1).item, clientId: 'gui-tag' };
  const f = fixture(r => { r.event({ method: 'item/completed', params: { item: echo } }); return idle(r); }, () => ({ data: [{ item: echo, turnId: 'old' }] }));
  Object.assign(f.host, { binaries: {}, close() {}, create: s => { f.r.record = s; return f.r; } });
  const w = new Workspace(f.host, dir), s = { ...f.r.record, id: 'local-id', provider: 'codex', cwd: dir, state: 'recoverable', controlRevision: 0, messages: [{ id: 'gui-tag', role: 'user', origin: 'human', text: '1', status: 'unconfirmed' }] };
  w.sessions.set(s.id, s); t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await w.resume(s.id, 'owner'); assert.equal(s.messages.length, 1); assert.equal(s.controlRevision, 1);
  f.r.event({ method: 'item/completed', params: { item: echo } }); assert.equal(s.messages.length, 1); assert.equal(s.controlRevision, 1);
  f.r.event({ method: 'item/completed', params: { item: { ...echo, id: 'terminal-item', clientId: 'new-terminal-tag' } } });
  assert.equal(s.messages.length, 2); assert.equal(s.controlRevision, 2); assert.equal(s.messages[1].text, '1');
});
for (const succeeds of [true, false]) test('early terminal attachment waits for resume instead of asking for a new model turn: ' + succeeds, async () => {
  let release; const ack = new Promise(resolve => { release = resolve; });
  const f = fixture(async r => { await ack; if (!succeeds) throw Error('resume failed'); return idle(r); });
  f.r.openTerminal = Codex.prototype.openTerminal;
  let created = 0; f.r.makeTerminal = () => { created++; return (f.r.terminal = { alive: true }); };
  f.host.binaries = { codex: 'synthetic' };
  const starting = f.r.start(); let settled = false;
  const attachment = f.r.openTerminal().finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false); assert.equal(created, 0);
  if (succeeds) { release(); await starting; await attachment; assert.equal(created, 1); }
  else { const outcomes = Promise.allSettled([starting, attachment]); release(); assert.deepEqual((await outcomes).map(x => x.status), ['rejected', 'rejected']); assert.equal(created, 0); }
});
