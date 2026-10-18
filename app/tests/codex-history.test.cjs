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
test('overlapping pages and tool items neither duplicate text nor enter shared records', async t => {
  const tools = Array.from({ length: 100 }, (_, i) => entry('tool-' + i, i % 2 ? 'reasoning' : 'commandExecution'));
  const f = await fixture(t, p => p.cursor ? { data: [entry('u'), entry('a', 'agentMessage')] } : { data: [...tools, entry('u')], nextCursor: 'p2' });
  await f.r.observeFirstTurn(); assert.deepEqual(f.s.messages.map(m => m.id), ['u', 'a']); assert.deepEqual(f.w.room.messages, []);
  assert.equal(f.w.versions.shellModelCalls, 0); assert.equal(f.w.versions.dispatches, 0);
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
