const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Workspace } = require('../workspace.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-stream-test-')), runtimes = [], sent = [];
  const w = new Workspace({ binaries: {}, close() {}, create(s) {
    const r = new EventEmitter(); s.nativeId = `native-${s.id}`; r.nativeBlocks = true;
    r.start = async () => r.emit('state', 'idle'); r.interrupt = async () => {};
    r.send = async (text, tag) => { sent.push({ id: s.id, text, tag }); r.emit('submitted', tag); };
    runtimes.push(r); return r;
  } }, directory);
  t.after(() => { w.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const ids = [await w.create('claude', directory, 'owner', 'A'), await w.create('codex', directory, 'owner', 'B')];
  ids.forEach(id => w.join(id, true));
  function bind(i, turnId = `turn-${i}`, promptId = `prompt-${i}`) {
    const tag = sent.findLast(x => x.id === ids[i]).tag;
    runtimes[i].emit('replyBound', { tag, nativeId: w.get(ids[i]).nativeId, turnId, promptId }); return tag;
  }
  function block(i, value) { runtimes[i].emit('nativeBlock', { nativeId: w.get(ids[i]).nativeId, turnId: `turn-${i}`, promptId: `prompt-${i}`, ...value }); }
  return { w, directory, runtimes, sent, ids, bind, block };
}
test('ACK identity gates early content; parallel turns update stable blocks without dispatching or leaking private output', async t => {
  const { w, runtimes: [a, b], ids, sent, bind, block } = await fixture(t);
  await w.forward(ids[0], 'A task', 'owner');
  block(0, { id: 'display:answer', kind: 'response', text: 'same', status: 'streaming' });
  block(0, { id: 'display:foreign', turnId: 'private-turn', kind: 'response', text: 'PRIVATE TURN', status: 'streaming' });
  block(0, { id: 'display:foreign-prompt', promptId: 'private-prompt', kind: 'response', text: 'PRIVATE PROMPT', status: 'streaming' });
  assert.equal(w.room.messages.filter(m => m.role === 'assistant').length, 0);
  bind(0); const first = w.room.messages.find(m => m.role === 'assistant');
  assert.equal(first.text, 'same'); assert.equal(first.replyTo, sent[0].tag);
  await w.forward(ids[1], 'B task', 'owner'); bind(1);
  b.emit('delta', { id: 'answer', turnId: 'turn-1', text: 'same' });
  block(0, { id: 'display:answer', kind: 'response', text: 'same plus more', status: 'streaming' });
  assert.equal(w.room.messages.find(m => m.id === first.id).text, 'same plus more');
  assert.equal(w.room.messages.filter(m => m.role === 'assistant').length, 2);
  assert.equal(w.room.messages.find(m => m.sessionId === ids[1] && m.role === 'assistant').text, 'same');
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE')); assert.equal(sent.length, 2);
  b.emit('messageItem', { id: 'answer', turnId: 'turn-1', text: 'same final' });
  b.emit('complete', { tag: sent[1].tag, messageId: 'answer', text: 'same final' });
  a.emit('complete', { tag: sent[0].tag, messageId: first.nativeMessageId, text: 'same plus more' });
  assert.equal(w.room.messages.filter(m => m.role === 'assistant').length, 2);
  assert.equal(first.finalReply, true); assert.equal(first.status, 'complete');
});
test('human thread association survives unconfirmed acceptance without adding parent text to native input', async t => {
  const { w, runtimes, ids, sent, directory } = await fixture(t);
  const parent = await w.forward(ids[0], 'PARENT MATERIAL', 'owner');
  runtimes[1].send = async (text, tag) => { sent.push({ text, tag }); throw Error('Unknown ACK'); };
  await assert.rejects(w.forward(ids[1], 'Explicit reply only', 'owner', parent), /Unknown ACK/);
  const row = w.room.messages.find(m => m.text === 'Explicit reply only');
  assert.equal(row.replyTo, parent); assert.equal(row.status, 'unconfirmed');
  assert.equal(sent[1].text, 'Explicit reply only');
  w.persist();
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'))).room.messages.find(m => m.id === row.id).replyTo, parent);
});
test('current shared queue keeps already public output live without adopting unrelated private work', async t => {
  const { w, runtimes: [a], ids, bind, block } = await fixture(t);
  const oldTag = await w.forward(ids[0], 'original task', 'owner'); bind(0);
  block(0, { id: 'display:old', kind: 'response', text: 'Public prefix', status: 'streaming' });
  const old = w.room.messages.find(m => m.role === 'assistant');
  w.get(ids[0]).state = 'working'; a.queueAvailable = true;
  let accept, nextTag;
  a.queue = (_text, tag) => { nextTag = tag; return new Promise(resolve => { accept = resolve; }); };
  const done = w.queue(ids[0], 'next task', 'owner', {});
  block(0, { id: 'display:old', kind: 'response', text: 'Public prefix with live tail', status: 'streaming' });
  block(0, { id: 'display:foreign', kind: 'response', turnId: 'foreign', promptId: 'foreign', text: 'PRIVATE FOREIGN', status: 'complete' });
  assert.equal(old.text, 'Public prefix with live tail'); assert.equal(old.status, 'streaming');
  a.emit('complete', { tag: oldTag, messageId: old.nativeMessageId, text: old.text });
  assert.equal(old.finalReply, true); assert.equal(old.sharingStopped, undefined);
  a.emit('submitted', nextTag); a.emit('replyBound', { tag: nextTag, nativeId: w.get(ids[0]).nativeId, turnId: 'next', promptId: 'next' });
  block(0, { id: 'display:next', kind: 'response', turnId: 'next', promptId: 'next', text: 'Next reply', status: 'complete' });
  accept(); await done;
  assert.equal(w.room.messages.find(m => m.text === 'Next reply').replyTo, nextTag);
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE')); assert.equal(w.versions.dispatches, 2);
});
for (const reason of ['leave', 'takeover', 'disconnect', 'interrupt', 'gap', 'permission']) test(`${reason} freezes shared content; late native boundary is distinct from requesting a stop`, async t => {
  const { w, runtimes: [a], ids, sent, bind, block } = await fixture(t);
  await w.forward(ids[0], 'task', 'owner'); bind(0);
  block(0, { id: 'display:answer', kind: 'response', text: 'visible prefix', status: 'streaming' });
  const row = w.room.messages.find(m => m.role === 'assistant');
  if (reason === 'leave') { w.join(ids[0], false); w.join(ids[0], true); }
  if (reason === 'takeover') w.claim(ids[0], 'another-window', 'chat');
  if (reason === 'disconnect') { a.emit('state', 'disconnected'); a.emit('state', 'idle'); }
  if (reason === 'interrupt') await w.interrupt(ids[0], 'owner');
  if (reason === 'gap') block(0, { id: 'gap:one', kind: 'gap', text: 'missing output' });
  if (reason === 'permission') {
    a.record = w.get(ids[0]);
    require('../adapters.cjs').Claude.prototype.hook.call(a, { session_id: a.record.nativeId, hook_event_name: 'PermissionRequest' });
    a.emit('state', 'working');
  }
  assert.equal(row.status, 'unconfirmed'); assert.ok(row.sharingStopped);
  block(0, { id: 'display:answer', kind: 'response', text: 'visible prefix PRIVATE LATER', status: 'streaming' });
  assert.equal(row.text, 'visible prefix');
  block(0, { id: 'turn:end', kind: 'turn', status: 'interrupted', text: 'native interrupted' });
  assert.equal(row.status, 'interrupted');
  a.emit('complete', { tag: sent[0].tag, messageId: row.nativeMessageId, text: 'PRIVATE FINAL' }); await tick();
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE')); assert.equal(sent.length, 1);
});
test('evicting a revoked grant cannot authorize a late final through an old forward entry', async t => {
  const { w, ids, sent, runtimes: [a], bind, block } = await fixture(t);
  await w.forward(ids[0], 'task', 'owner'); bind(0);
  block(0, { id: 'gap:one', kind: 'gap', text: 'missing output' });
  for (let i = 0; i < 70; i++) {
    w.sharedReplies.authorize(w.get(ids[0]), a, `synthetic-${i}`, { id: `source-${i}` });
    w.sharedReplies.close(`synthetic-${i}`);
  }
  assert.equal(w.sharedReplies.grants.has(sent[0].tag), false);
  a.emit('complete', { tag: sent[0].tag, text: 'MUST STAY PRIVATE' }); await tick();
  assert.ok(!JSON.stringify(w.room.messages).includes('MUST STAY PRIVATE'));
  assert.equal(w.room.messages.find(m => m.id === sent[0].tag).status, 'reply-private');
});
test('pause during bounded exchange retains text but sends no partial or late final to the next agent', async t => {
  const { w, ids, runtimes: [a], sent, bind, block } = await fixture(t);
  await w.startRun(ids, 'goal', 2, 'replies'); bind(0);
  block(0, { id: 'display:answer', kind: 'response', text: 'partial', status: 'streaming' });
  assert.equal(sent.length, 1); w.pause('human paused');
  block(0, { id: 'display:answer', kind: 'response', text: 'late final', status: 'complete' });
  a.emit('complete', { tag: sent[0].tag, text: 'late final' }); await tick();
  assert.equal(sent.length, 1); assert.equal(w.room.run.steps, 0);
  assert.equal(w.room.messages.find(m => m.role === 'assistant').text, 'partial');
});
test('only the native final block is delivered; progress is visible but absent from outbound context', async t => {
  const { w, ids, runtimes: [a], sent, bind, block } = await fixture(t);
  await w.startRun(ids, 'goal', 2, 'replies'); bind(0);
  block(0, { id: 'display:thinking', kind: 'response', text: 'intermediate', status: 'complete' });
  block(0, { id: 'tool:one', kind: 'tool', input: 'tool input', text: 'TOOL BODY', status: 'complete' });
  block(0, { id: 'display:final', kind: 'response', text: 'answer', status: 'complete' });
  const row = w.room.messages.find(m => m.text === 'answer');
  assert.equal(sent.length, 1);
  a.emit('complete', { tag: sent[0].tag, messageId: row.nativeMessageId, text: 'answer' }); await tick();
  assert.equal(sent.length, 2); assert.equal(w.room.messages.filter(m => m.text === 'answer').length, 1);
  assert.equal(row.deliveries[0].recipientId, ids[1]); assert.equal(row.deliveries[0].text, sent[1].text);
  assert.ok(!sent[1].text.includes('intermediate')); assert.ok(!sent[1].text.includes('TOOL BODY'));
  assert.equal(w.room.messages.find(m => m.text === 'intermediate').deliveries, undefined);
});
test('bounded native tool history survives restart without replaying any input', async t => {
  const { w, directory, ids, sent, bind, block } = await fixture(t);
  await w.forward(ids[0], 'task', 'owner'); bind(0);
  block(0, { id: 'display:partial', kind: 'response', text: 'retained partial', status: 'streaming' });
  for (let n = 0; n < 220; n++) block(0, { id: `tool:${n}`, kind: 'tool', input: 'VOLATILE INPUT', text: 'VOLATILE BODY'.repeat(700), status: 'running' });
  const volatile = w.room.messages.filter(m => m.volatile);
  assert.ok(volatile.length <= 200); assert.ok(Buffer.byteLength(JSON.stringify(volatile)) < 1024 * 1024);
  assert.ok(volatile.some(m => m.kind === 'gap'));
  w.persist(); const stored = fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8');
  assert.ok(stored.includes('VOLATILE BODY'));
  assert.equal(fs.statSync(path.join(directory, 'workspace.json')).mode & 0o777, 0o600);
  const cold = new Workspace({ binaries: {}, close() {} }, directory); t.after(() => cold.close());
  const restored = cold.room.messages.find(m => m.text === 'retained partial');
  assert.equal(restored.status, 'unconfirmed'); assert.ok(restored.sharingStopped);
  assert.ok(cold.room.messages.some(m => m.role === 'tool' && m.text.includes('VOLATILE BODY') && m.status === 'unconfirmed'));
  assert.ok(cold.get(ids[0]).messages.some(m => m.role === 'tool' && m.status === 'unconfirmed'));
  assert.ok(cold.room.messages.some(m => m.kind === 'gap'));
  assert.equal(cold.sharedReplies.grants.size, 0); assert.equal(cold.versions.dispatches, 0); assert.equal(sent.length, 1);
});

test('sharing closure between completed items remains visible without calling a completed tool interrupted', () => {
  const { SharedReplies } = require('../shared-replies.cjs');
  const s = { id: 's', nativeId: 'n', provider: 'codex', roomId: 'shared', state: 'idle', messages: [] };
  const runtime = {}, w = { sessions: new Map([['s', s]]), runtimes: new Map([['s', runtime]]), room: { messages: [] } };
  const sharing = new SharedReplies(w); sharing.authorize(s, runtime, 'task', { id: 'human' });
  sharing.bind(s, 'task', { nativeId: 'n', turnId: 'turn' });
  sharing.record(s, { id: 'tool', role: 'tool', nativeId: 'n', turnId: 'turn', text: 'done', status: 'complete' });
  sharing.close('task', 'Native permission pending');
  assert.equal(w.room.messages[0].status, 'complete'); assert.equal(w.room.messages[0].sharingStopped, 'Native permission pending');
  sharing.record(s, { id: 'late', role: 'assistant', nativeId: 'n', turnId: 'turn', text: 'PRIVATE', status: 'complete' });
  assert.equal(w.room.messages.length, 1);
  sharing.authorize(s, runtime, 'next', { id: 'next-human' }); sharing.bind(s, 'next', { nativeId: 'n', turnId: 'next-turn' });
  sharing.record(s, { id: 'final', role: 'assistant', nativeId: 'n', turnId: 'next-turn', text: 'final', status: 'complete' });
  sharing.final(s, { tag: 'next', messageId: 'final', text: 'final' });
  assert.equal(w.room.messages.at(-1).sharingStopped, undefined, 'Normal final does not show an interrupted-sharing warning');
});


test('native failure details require the exact live grant and never advance an exchange', async t => {
  const { w, ids, sent, bind, block, runtimes: [a] } = await fixture(t);
  await w.startRun(ids, 'one bounded task', 2, 'replies'); bind(0);
  block(0, { id: 'turn:private', kind: 'turn', turnId: 'private-turn', text: 'PRIVATE ERROR', status: 'failed' });
  block(0, { id: 'turn:end', kind: 'turn', text: 'Visible failure', status: 'failed' });
  assert.ok(w.room.messages.some(m => m.text === 'Visible failure' && m.role === 'system'));
  assert.ok(!w.room.messages.some(m => m.finalReply)); assert.equal(sent.length, 1); assert.equal(w.room.run.steps, 0);
  a.emit('state', 'error');
  block(0, { id: 'turn:end', kind: 'turn', text: 'PRIVATE LATE ERROR', status: 'failed' });
  a.emit('state', 'idle'); bind(0);
  block(0, { id: 'turn:end', kind: 'turn', text: 'PRIVATE REPLAY', status: 'failed' });
  assert.ok(!JSON.stringify(w.room.messages).includes('PRIVATE'));
  assert.equal(sent.length, 1); assert.equal(w.room.run.steps, 0);
});
