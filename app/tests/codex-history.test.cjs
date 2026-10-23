// Real adapter/workspace with synthetic protocol pages. No native/model process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Codex } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const entry = (id, type = 'userMessage', text = id, extra = {}) => ({ turnId: 'old-turn', item: { id, type, ...(type === 'userMessage' ? { content: [{ type: 'text', text }] } : { text }), ...extra } });
async function fixture(t, pages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-history-'));
  const host = { binaries: { codex: 'fixture' }, codexTargets: new Map(), close() {} }, calls = [];
  host.create = record => { const r = new Codex(record, host); r.start = async () => {}; return r; };
  const w = new Workspace(host, dir); const id = await w.create('codex', dir, 'owner', 'History fixture', 'terminal');
  const r = w.runtime(id), s = w.get(id); s.nativeId = 'history-thread';
  const notify = (method, params = {}) => r.event({ method, params: { threadId: s.nativeId, ...params } });
  host.rpc = { call: async (method, params) => { calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: s.nativeId, preview: 'saved history', status: { type: 'idle' } } };
    if (method === 'thread/resume') return { thread: { id: s.nativeId } };
    if (method === 'thread/items/list') return pages(params, { r, s, w, notify });
    throw Error('Unexpected RPC: ' + method);
  } };
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { w, r, s, id, calls, notify };
}
test('native turn metadata pages restore exact boundaries without sharing history or replaying work', async t => {
  const items = [entry('a', 'agentMessage', 'first'), { ...entry('b', 'agentMessage', 'second'), turnId: 'second-turn' }];
  const f = await fixture(t, () => ({ data: items }));
  const rpc = f.r.host.rpc, call = rpc.call; rpc.nativeVersion = '0.163.0';
  rpc.call = async (method, params) => {
    if (method !== 'thread/turns/list') return call(method, params);
    f.calls.push({ method, params });
    assert.equal(params.itemsView, 'notLoaded'); assert.equal(params.sortDirection, 'asc');
    return params.cursor ? { data: [{ id: 'second-turn', status: 'interrupted', completedAt: 1700000100, durationMs: 800 }], nextCursor: null }
      : { data: [{ id: 'old-turn', status: 'completed', startedAt: 1700000000, completedAt: 1700000002, durationMs: 2300 }], nextCursor: 'older-page' };
  };
  f.w.join(f.id, true); const room = JSON.stringify(f.w.room), revision = f.s.controlRevision;
  await f.r.hydrateHistory(f.s.nativeId);
  await f.r.turnMetadataHydration;
  assert.deepEqual(f.s.messages.map(m => m.kind || m.id), ['a', 'turn', 'b', 'turn']);
  const [first, second] = f.s.messages.filter(m => m.kind === 'turn');
  assert.equal(first.nativeCompletedAt, 1700000002000); assert.equal(first.nativeDurationMs, 2300);
  assert.equal(second.nativeCompletedAt, 1700000100000); assert.equal(second.nativeDurationMs, 800); assert.equal(second.status, 'interrupted');
  assert.equal(first.turnId, 'old-turn'); assert.equal(second.turnId, 'second-turn');
  assert.equal(JSON.stringify(f.w.room), room); assert.equal(f.s.controlRevision, revision); assert.equal(f.w.versions.dispatches, 0);
  f.w.persist(); const stored = JSON.parse(fs.readFileSync(path.join(f.w.dataDir, 'workspace.json')));
  assert.deepEqual(stored.sessions.find(s => s.id === f.id).messages.filter(m => m.kind === 'turn'), [first, second]);
  await f.r.hydrateHistory(f.s.nativeId); await f.r.turnMetadataHydration; assert.equal(f.s.messages.filter(m => m.kind === 'turn').length, 2);
});
test('late history cannot replace a live interruption or stop a different active turn', async t => {
  const f = await fixture(t, () => ({ data: [entry('a', 'agentMessage', 'historical final')] }));
  const rpc = f.r.host.rpc, call = rpc.call; rpc.nativeVersion = '0.163.0';
  rpc.call = async (method, params) => {
    if (method !== 'thread/turns/list') return call(method, params);
    f.notify('turn/completed', { turn: { id: 'old-turn', status: 'interrupted', completedAt: 1700000001, durationMs: 1500 } });
    f.notify('turn/started', { turn: { id: 'new-turn', startedAt: 1700000005 } });
    return { data: [{ id: 'old-turn', status: 'completed', completedAt: 1700000099, durationMs: 99000 }] };
  };
  await f.r.hydrateHistory(f.s.nativeId);
  await f.r.turnMetadataHydration;
  const boundary = f.s.messages.find(m => m.kind === 'turn');
  assert.equal(boundary.status, 'interrupted'); assert.equal(boundary.nativeCompletedAt, 1700000001000); assert.equal(boundary.nativeDurationMs, 1500);
  assert.equal(f.r.turnId, 'new-turn'); assert.equal(f.s.state, 'working');
});
test('optional native timing failure preserves readable history and input, retry removes the notice', async t => {
  const f = await fixture(t, () => ({ data: [entry('a', 'agentMessage', 'retained answer')] }));
  const rpc = f.r.host.rpc, call = rpc.call; rpc.nativeVersion = '0.163.0'; let fail = true;
  rpc.call = async (method, params) => { if (method !== 'thread/turns/list') return call(method, params); if (fail) throw Error('Disconnected metadata read'); return { data: [] }; };
  await f.r.observeFirstTurn();
  await f.r.turnMetadataHydration;
  assert.equal(f.r.chatAvailable, true); assert.equal(f.s.messages[0].text, 'retained answer');
  assert.equal(f.s.messages.filter(m => m.kind === 'notice').length, 1);
  fail = false; await f.r.hydrateHistory(f.s.nativeId); await f.r.turnMetadataHydration;
  assert.equal(f.s.messages.filter(m => m.kind === 'notice').length, 0); assert.equal(f.s.messages[0].nativeCompletedAt, undefined);
});
test('held timing request does not delay readable history/input or overwrite later native text', async t => {
  const f = await fixture(t, () => ({ data: [entry('a', 'agentMessage', 'saved answer')] }));
  const rpc = f.r.host.rpc, call = rpc.call; rpc.nativeVersion = '0.163.0'; let release;
  rpc.call = (method, params) => method === 'thread/turns/list' ? new Promise(resolve => { release = resolve; }) : call(method, params);
  await f.r.observeFirstTurn();
  assert.equal(typeof release, 'function'); assert.equal(f.r.chatAvailable, true); assert.equal(f.s.messages[0].text, 'saved answer');
  f.notify('item/completed', { turnId: 'old-turn', item: { id: 'a', type: 'agentMessage', text: 'new authoritative answer' } });
  release({ data: [{ id: 'old-turn', status: 'completed', completedAt: 1700000000, durationMs: 2400 }] }); await f.r.turnMetadataHydration;
  assert.equal(f.s.messages.find(m => m.id === 'a').text, 'new authoritative answer');
  assert.equal(f.s.messages.find(m => m.kind === 'turn').nativeDurationMs, 2400);
});
test('metadata held across a lifecycle change cannot enrich another native identity', async t => {
  const f = await fixture(t, () => ({ data: [entry('a', 'agentMessage', 'saved answer')] }));
  const rpc = f.r.host.rpc, call = rpc.call; rpc.nativeVersion = '0.163.0'; let release;
  rpc.call = (method, params) => method === 'thread/turns/list' ? new Promise(resolve => { release = resolve; }) : call(method, params);
  await f.r.hydrateHistory(f.s.nativeId); await Promise.resolve();
  f.r.lifecycleRevision++; f.s.nativeId = 'new-native';
  release({ data: [{ id: 'old-turn', status: 'completed', completedAt: 1700000000, durationMs: 2400 }] }); await f.r.turnMetadataHydration;
  assert.equal(f.s.messages.some(m => m.kind === 'turn'), false);
});
test('first terminal attachment imports every page in order without impersonating live input', async t => {
  const all = Array.from({ length: 105 }, (_, i) => entry('item-' + i, i % 2 ? 'agentMessage' : 'userMessage', 'text-' + i));
  const f = await fixture(t, p => p.cursor ? { data: all.slice(100), nextCursor: null } : { data: all.slice(0, 100), nextCursor: 'page-2' });
  f.w.join(f.id, true); const revision = f.s.controlRevision; const room = JSON.stringify(f.w.room);
  await f.r.observeFirstTurn();
  assert.equal(f.s.messages.length, 105, 'History after the first 100 items must be retained');
  assert.deepEqual(f.s.messages.map(m => m.text), all.map(x => x.item.text || x.item.content[0].text));
  assert.equal(f.s.controlRevision, revision); assert.equal(JSON.stringify(f.w.room), room);
  assert.equal(f.w.versions.dispatches, 0); assert.equal(f.r.chatAvailable, true);
  assert.deepEqual(f.calls.filter(c => c.method === 'thread/items/list').map(c => c.params.cursor), [undefined, 'page-2']);
});
test('live items overlap history once; newer completion and working state win', async t => {
  const f = await fixture(t, (_p, { notify }) => {
    notify('turn/started', { turn: { id: 'active-turn' } });
    notify('item/completed', { turnId: 'active-turn', item: entry('live-user').item });
    notify('item/agentMessage/delta', { turnId: 'active-turn', itemId: 'live-answer', delta: 'new ' });
    notify('item/completed', { turnId: 'active-turn', item: entry('live-answer', 'agentMessage', 'new answer').item });
    return { data: [entry('old-user'), entry('live-user'), entry('live-answer', 'agentMessage', 'stale answer')], nextCursor: null };
  });
  await f.r.observeFirstTurn();
  assert.deepEqual(f.s.messages.map(m => [m.id, m.text]), [['old-user', 'old-user'], ['live-user', 'live-user'], ['live-answer', 'new answer']]);
  assert.equal(f.s.controlRevision, 1); assert.equal(f.s.state, 'working');
  f.notify('item/completed', { item: entry('live-user').item });
  f.notify('item/completed', { item: entry('old-user').item });
  assert.equal(f.s.messages.length, 3); assert.equal(f.s.controlRevision, 2);
});
test('history before a live human notification cannot swallow takeover; repeated live notification is idempotent', async t => {
  const f = await fixture(t, () => ({ data: [entry('human-input')] }));
  await f.r.observeFirstTurn(); assert.equal(f.s.controlRevision, 0);
  f.w.room.run = { status: 'running', deadline: Date.now() + 10000 };
  f.notify('item/completed', { item: entry('human-input').item });
  assert.equal(f.w.room.run.status, 'paused'); assert.equal(f.s.controlRevision, 1); assert.equal(f.s.messages.length, 1);
  f.notify('item/completed', { item: entry('human-input').item });
  assert.equal(f.s.controlRevision, 1); assert.equal(f.s.messages.length, 1);
});
test('same text with different item IDs is retained; matching GUI client ID is a single message', async t => {
  const f = await fixture(t, () => ({ data: [entry('u1', 'userMessage', 'same'), entry('u2', 'userMessage', 'same'), entry('native-gui', 'userMessage', 'gui', { clientId: 'gui-tag' })] }));
  f.s.messages.push({ id: 'gui-tag', role: 'user', text: 'gui', status: 'submitted', origin: 'human' });
  f.r.ownInputs.add('gui-tag'); await f.r.observeFirstTurn();
  assert.deepEqual(f.s.messages.map(m => m.text), ['same', 'same', 'gui']); assert.equal(f.s.messages.at(-1).id, 'gui-tag');
  f.notify('item/completed', { item: entry('native-gui', 'userMessage', 'gui', { clientId: 'gui-tag' }).item });
  assert.equal(f.s.messages.length, 3); assert.equal(f.s.controlRevision, 0);
});
test('historical text is not appended to overlapping streamed text; final native item stays authoritative', async t => {
  const f = await fixture(t, (_p, { notify }) => { notify('item/agentMessage/delta', { itemId: 'a', delta: 'partial' }); return { data: [entry('u'), entry('a', 'agentMessage', 'partial')] }; });
  await f.r.observeFirstTurn(); f.notify('item/agentMessage/delta', { itemId: 'a', delta: ' answer' });
  assert.equal(f.s.messages.find(m => m.id === 'a').text, 'partial answer');
  f.notify('item/completed', { turnId: 't', item: entry('a', 'agentMessage', 'complete authoritative answer').item });
  assert.equal(f.s.messages.find(m => m.id === 'a').text, 'complete authoritative answer');
});
test('snapshot without a live delta watermark waits for completion instead of duplicating delayed deltas', async t => {
  const f = await fixture(t, (_p, { notify }) => { notify('turn/started', { turn: { id: 'old-turn' } }); return { data: [entry('a', 'agentMessage', 'snapshot prefix')] }; });
  await f.r.observeFirstTurn(); f.notify('item/agentMessage/delta', { itemId: 'a', delta: 'snapshot prefix' });
  assert.equal(f.s.messages[0].text, 'snapshot prefix'); assert.equal(f.s.messages[0].status, 'streaming');
  f.notify('item/completed', { turnId: 'old-turn', item: entry('a', 'agentMessage', 'final answer').item });
  assert.equal(f.s.messages[0].text, 'final answer'); assert.equal(f.s.messages[0].status, 'complete');
});
test('overlapping pages retain known tool bodies once and never import hidden reasoning or share history', async t => {
  const tools = Array.from({ length: 100 }, (_, i) => entry('tool-' + i, i % 2 ? 'reasoning' : 'commandExecution', 'PRIVATE reasoning',
    i % 2 ? {} : { command: 'read sample', aggregatedOutput: 'visible-' + i, status: 'completed' }));
  const f = await fixture(t, p => p.cursor ? { data: [tools[0], entry('u'), entry('a', 'agentMessage')] } : { data: [...tools, entry('u')], nextCursor: 'p2' });
  await f.r.observeFirstTurn();
  assert.equal(f.s.messages.length, 52); assert.equal(f.s.messages[0].text, 'visible-0');
  assert.equal(f.s.messages[0].status, 'complete'); assert.equal(f.s.messages[0].inputTag, undefined);
  assert.deepEqual(f.s.messages.slice(-2).map(m => m.id), ['u', 'a']); assert.deepEqual(f.w.room.messages, []);
  assert.ok(!JSON.stringify(f.s.messages).includes('PRIVATE reasoning'));
  assert.equal(f.w.versions.shellModelCalls, 0); assert.equal(f.w.versions.dispatches, 0);
});
test('tool history preserves live results; snapshots without watermarks wait for authoritative output', async t => {
  const f = await fixture(t, (_p, { notify }) => {
    notify('item/completed', { turnId: 'old-turn', item: { id: 'live', type: 'commandExecution', command: 'read', aggregatedOutput: 'new output', status: 'completed' } });
    return { data: [entry('live', 'commandExecution', '', { command: 'read', aggregatedOutput: 'old output', status: 'inProgress' }),
      entry('snapshot', 'commandExecution', '', { command: 'read', aggregatedOutput: 'prefix', status: 'inProgress' })] };
  });
  await f.r.observeFirstTurn(); assert.equal(f.s.messages[0].text, 'new output');
  f.notify('item/commandExecution/outputDelta', { turnId: 'old-turn', itemId: 'snapshot', delta: 'prefix' });
  assert.equal(f.s.messages[1].text, 'prefix');
  f.notify('item/completed', { turnId: 'old-turn', item: { id: 'snapshot', type: 'commandExecution', command: 'read', aggregatedOutput: 'prefix + final', status: 'completed' } });
  assert.equal(f.s.messages[1].text, 'prefix + final'); assert.equal(f.s.messages.length, 2);
  assert.deepEqual(f.w.room.messages, []);
});
test('hydrated tools obey the existing volatile cache bound and mark omitted rows', async t => {
  const f = await fixture(t, () => ({ data: Array.from({ length: 240 }, (_, i) => entry('tool-' + i, 'functionCallOutput', '', { output: 'body-' + i, name: 'read' })) }));
  await f.r.observeFirstTurn();
  assert.ok(f.s.messages.length <= 200); assert.equal(f.s.messages.filter(m => m.kind === 'gap').length, 1);
  assert.ok(f.s.messages.some(m => m.text === 'body-239')); assert.ok(!f.s.messages.some(m => m.text === 'body-0'));
  assert.deepEqual(f.w.room.messages, []);
});
for (const event of ['turn', 'approval']) test('late thread/read cannot overwrite a newer ' + event, async t => {
  const f = await fixture(t, () => ({ data: [entry('u')] }));
  const call = f.r.host.rpc.call;
  f.r.host.rpc.call = async (method, params) => {
    if (method === 'thread/read') {
      if (event === 'turn') f.notify('turn/started', { turn: { id: 'new-turn' } });
      else f.r.event({ id: 1, method: 'item/commandExecution/requestApproval', params: {} });
    }
    return call(method, params);
  };
  await f.r.observeFirstTurn(); assert.equal(f.s.state, event === 'turn' ? 'working' : 'approval');
  await assert.rejects(f.w.send(f.id, 'must not dispatch', 'owner'), /尚未就绪/); assert.equal(f.w.versions.dispatches, 0);
});
for (const kind of ['approval', 'closed', 'stop', 'failure', 'cursor-loop', 'malformed']) test('hydration preserves safety on ' + kind, async t => {
  let n = 0;
  const f = await fixture(t, (_p, { r, notify }) => {
    if (++n === 1) return { data: [entry('page-one')], nextCursor: 'next' };
    if (kind === 'failure') throw Error('Synthetic read failure');
    if (kind === 'cursor-loop') return { data: [entry('duplicate-page')], nextCursor: 'next' };
    if (kind === 'malformed') return { data: null };
    if (kind === 'closed') notify('thread/closed');
    if (kind === 'stop') r.stopped = true;
    if (kind === 'approval') r.event({ id: 4, method: 'item/commandExecution/requestApproval', params: { threadId: r.record.nativeId } });
    return { data: [entry('page-two')], nextCursor: null };
  });
  if (['failure', 'cursor-loop', 'malformed'].includes(kind)) await assert.rejects(f.r.observeFirstTurn()); else await f.r.observeFirstTurn();
  if (kind === 'approval') { assert.equal(f.s.state, 'approval'); assert.equal(f.s.messages.length, 2); assert.ok(f.s.approval); }
  else { assert.equal(f.s.messages.length, 0); assert.equal(f.r.chatAvailable, false); }
  if (kind === 'closed') assert.equal(f.s.state, 'ended');
  assert.equal(f.calls.filter(c => c.method === 'thread/items/list').length, 2); assert.equal(f.w.versions.dispatches, 0);
});

test('reconnection refreshes cached partial tools while preserving tools observed on the new connection', async t => {
  const f = await fixture(t, (_p, { r, notify }) => {
    notify('item/completed', { turnId: 'old-turn', item: { id: 'fresh', type: 'commandExecution', command: 'read', aggregatedOutput: 'new live', status: 'completed' } });
    return { data: [entry('cached', 'commandExecution', '', { command: 'read', aggregatedOutput: 'native complete', status: 'completed' }),
      entry('fresh', 'commandExecution', '', { command: 'read', aggregatedOutput: 'old snapshot', status: 'inProgress' })] };
  });
  f.s.recovering = true;
  f.s.messages.push({ id: 'native:history-thread:tool:cached', role: 'tool', kind: 'tool', volatile: true, text: 'cached partial', status: 'unconfirmed', inputTag: 'old-private-tag' });
  await f.r.observeFirstTurn();
  assert.equal(f.s.messages[0].text, 'native complete'); assert.equal(f.s.messages[0].status, 'complete'); assert.equal(f.s.messages[0].inputTag, undefined);
  assert.equal(f.s.messages[1].text, 'new live');
  f.notify('item/commandExecution/outputDelta', { turnId: 'old-turn', itemId: 'cached', delta: 'native complete' });
  assert.equal(f.s.messages[0].text, 'native complete'); assert.deepEqual(f.w.room.messages, []);
});

// Public summaries are display records, not an alternate final answer.
test('summary sections stream in one native block; final snapshot replaces them without exposing raw reasoning', async t => {
  const f = await fixture(t, () => ({data: []}));
  f.notify('turn/started', {turn: {id: 'turn'}});
  f.notify('item/started', {turnId: 'turn', item: {id: 'summary', type: 'reasoning', summary: [], content: ['SECRET RAW']}});
  const delta = (summaryIndex, delta) => f.notify('item/reasoning/summaryTextDelta', {turnId: 'turn', itemId: 'summary', summaryIndex, delta});
  delta(0, 'First '); delta(0, 'section'); delta(1, 'Second section');
  f.notify('item/reasoning/textDelta', {turnId: 'turn', itemId: 'summary', delta: 'SECRET RAW DELTA'});
  assert.equal(f.s.messages.length, 1); assert.equal(f.s.messages[0].text, 'First section\n\nSecond section');
  assert.equal(f.s.messages[0].role, 'assistant'); assert.equal(f.s.messages[0].status, 'streaming');
  f.notify('item/completed', {turnId: 'turn', item: {id: 'summary', type: 'reasoning', summary: ['Final public summary'], content: ['SECRET RAW']}});
  delta(0, 'LATE');
  assert.equal(f.s.messages.length, 1); assert.equal(f.s.messages[0].text, 'Final public summary'); assert.equal(f.s.messages[0].status, 'complete');
  assert.equal(f.r.turn('turn').text, ''); assert.ok(!JSON.stringify(f.s).includes('SECRET RAW'));
  assert.equal(f.w.room.messages.length, 0);
});
test('summary history hydration preserves live text; unknown-watermark deltas wait for final snapshot', async t => {
  const f = await fixture(t, () => ({data: [entry('summary', 'reasoning', '', {summary: ['History'], content: ['SECRET RAW']})]}));
  await f.r.hydrateHistory(f.s.nativeId);
  assert.equal(f.s.messages[0].text, 'History');
  f.notify('item/reasoning/summaryTextDelta', {turnId: 'old-turn', itemId: 'summary', summaryIndex: 0, delta: 'OVERLAP'});
  assert.equal(f.s.messages[0].text, 'History');
  f.notify('item/completed', {turnId: 'old-turn', item: {id: 'summary', type: 'reasoning', summary: ['Complete'], content: ['SECRET RAW']}});
  assert.equal(f.s.messages.length, 1); assert.equal(f.s.messages[0].text, 'Complete');
  await f.r.hydrateHistory(f.s.nativeId); assert.equal(f.s.messages[0].text, 'Complete');
  assert.ok(!JSON.stringify(f.s).includes('SECRET RAW'));
});
test('interrupted summaries keep native cut and cold history never silently removes observed tail', async t => {
  const f = await fixture(t, () => ({data: [entry('summary', 'reasoning', '', {summary: ['Partial']})]}));
  f.notify('turn/started', {turn: {id: 'old-turn'}});
  f.notify('item/reasoning/summaryTextDelta', {turnId: 'old-turn', itemId: 'summary', summaryIndex: 0, delta: 'Partial preserved tail'});
  f.notify('turn/completed', {turn: {id: 'old-turn', status: 'interrupted'}});
  assert.equal(f.s.messages[0].status, 'interrupted');
  f.s.recovering = true; f.r.nativeTextParts.clear(); f.r.liveTextItems.clear();
  await f.r.hydrateHistory(f.s.nativeId);
  assert.equal(f.s.messages[0].text, 'Partial preserved tail'); assert.equal(f.s.messages[0].status, 'interrupted');
});

test('native interrupted summary rejects late deltas, completed snapshots and cold-history replacements', async t => {
  const f = await fixture(t, () => ({data: [entry('summary', 'reasoning', '', {summary: ['LATE HISTORY REPLACEMENT']})]}));
  f.notify('turn/started', {turn: {id: 'old-turn'}});
  f.notify('item/reasoning/summaryTextDelta', {turnId:'old-turn',itemId:'summary',summaryIndex:0,delta:'VISIBLE CUT'});
  f.notify('turn/completed', {turn: {id:'old-turn',status:'interrupted'}});
  f.notify('item/reasoning/summaryTextDelta', {turnId:'old-turn',itemId:'summary',summaryIndex:0,delta:' LATE TAIL'});
  f.notify('item/completed', {turnId:'old-turn',item:{id:'summary',type:'reasoning',summary:['LATE COMPLETED SNAPSHOT']}});
  assert.equal(f.s.messages[0].text,'VISIBLE CUT'); assert.equal(f.s.messages[0].status,'interrupted');
  f.s.recovering=true; f.r.liveTextItems.clear(); await f.r.hydrateHistory(f.s.nativeId);
  assert.equal(f.s.messages[0].text,'VISIBLE CUT'); assert.equal(f.s.messages[0].status,'interrupted');
});

// Native proposed plans are streamed display items, not tools or approvals.
test('plan text streams in one message, uses authoritative final text and survives history overlap', async t => {
  const f = await fixture(t, () => ({data: [entry('plan-item', 'plan', 'OLD HISTORY')]}));
  f.notify('turn/started', {turn: {id:'old-turn'}});
  f.notify('item/started', {turnId:'old-turn',item:{id:'plan-item',type:'plan',text:''}});
  f.notify('item/plan/delta', {turnId:'old-turn',itemId:'plan-item',delta:'1. Read'});
  f.notify('item/plan/delta', {turnId:'old-turn',itemId:'plan-item',delta:' the material.'});
  assert.equal(f.s.messages.length,1); assert.equal(f.s.messages[0].role,'assistant');
  assert.equal(f.s.messages[0].kind,'plan'); assert.equal(f.s.messages[0].text,'1. Read the material.');
  assert.equal(f.s.messages[0].status,'streaming');
  await f.r.hydrateHistory(f.s.nativeId); assert.equal(f.s.messages[0].text,'1. Read the material.');
  f.notify('item/completed',{turnId:'old-turn',item:{id:'plan-item',type:'plan',text:'1. Check the final plan.'}});
  f.notify('item/plan/delta', {turnId:'old-turn',itemId:'plan-item',delta:' LATE'});
  assert.equal(f.s.messages.length,1); assert.equal(f.s.messages[0].text,'1. Check the final plan.');
  assert.equal(f.s.messages[0].status,'complete'); assert.equal(f.r.turn('old-turn').text,'');
  assert.equal(f.w.versions.dispatches,0); assert.equal(f.w.room.messages.length,0);
});
test('plan history has no delta watermark and interruption freezes the observed native cut', async t => {
  const f = await fixture(t, () => ({data:[entry('plan-item','plan','OLD HISTORY')]}));
  await f.r.hydrateHistory(f.s.nativeId);
  f.notify('item/plan/delta',{turnId:'old-turn',itemId:'plan-item',delta:'OVERLAP'});
  assert.equal(f.s.messages[0].text,'OLD HISTORY');
  f.notify('item/completed',{turnId:'old-turn',item:{id:'plan-item',type:'plan',text:'Completed history'}});
  assert.equal(f.s.messages[0].text,'Completed history');
  f.notify('turn/started',{turn:{id:'current'}});
  f.notify('item/started',{turnId:'current',item:{id:'current-plan',type:'plan',text:''}});
  f.notify('item/plan/delta',{turnId:'current',itemId:'current-plan',delta:'VISIBLE CUT'});
  f.notify('turn/completed',{turn:{id:'current',status:'interrupted'}});
  f.notify('item/plan/delta',{turnId:'current',itemId:'current-plan',delta:' LATE TAIL'});
  f.notify('item/completed',{turnId:'current',item:{id:'current-plan',type:'plan',text:'WRONG FINAL'}});
  const row=f.s.messages.find(m=>m.kind==='plan'&&m.turnId==='current');
  assert.equal(row.text,'VISIBLE CUT'); assert.equal(row.status,'interrupted');
});
