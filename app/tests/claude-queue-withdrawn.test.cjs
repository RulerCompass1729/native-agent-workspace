// A prompt typed during a turn waits in native's queue. When the person takes it back unsent (↑ to edit it, then
// delete or change it; or cancelling), the native terminal stops showing it, and so does the conversation
// (the person, 11-15: 「这个应该是个 bug」, an edited queued prompt showed twice). The journal rows here are
// hand-written in the shape native 2.1.323 writes (measured 11-15 in a test session), with made-up text.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Claude, promptTextTag } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');

function fixture(t, { journal = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-queue-withdrawn-')), r = Object.create(Claude.prototype); EventEmitter.call(r);
  const w = new Workspace({ binaries: {}, close() {} }, dir), nativeId = randomUUID();
  r.record = { id: 'session', nativeId, provider: 'claude', messages: [], state: 'idle', owner: 'window', controlRevision: 0, memberRevision: 0, connectionRevision: 0 };
  r.terminal = { alive: true }; r.submission = new SubmissionChannel(); r.ready = true;
  w.sessions.set(r.record.id, r.record); w.runtimes.set(r.record.id, r); w.bind(r.record, r);
  t.after(() => { try { w.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  r.bindRoot({ sessionId: nativeId, nativeBlocks: true, nativeTurnRecords: true, nativeMedia: true });
  const transcript = path.join(dir, `${nativeId}.jsonl`);
  const write = row => fs.appendFileSync(transcript, JSON.stringify({ timestamp: new Date().toISOString(), sessionId: nativeId, ...row }) + '\n');
  const queue = (operation, content, extra = {}) => write({ type: 'queue-operation', operation, ...(content === undefined ? {} : { content }), ...extra });
  const hook = (name, extra = {}) => r.hook({ hook_event_name: name, session_id: nativeId, ...(journal ? { transcript_path: transcript } : {}), ...extra });
  // Native records the prompt's own row after its hook; a prompt typed during the turn only joins the queue.
  const prompt = (promptId, text) => { hook('UserPromptSubmit', { prompt_id: promptId, prompt: text }); write({ type: 'user', promptId, isSidechain: false, uuid: randomUUID(), message: { role: 'user', content: text } }); };
  const typed = (promptId, text) => hook('UserPromptSubmit', { prompt_id: promptId, prompt: text });
  const stop = promptId => hook('Stop', { prompt_id: promptId, last_assistant_message: 'reply', background_tasks: [], session_crons: [], stop_hook_active: false });
  const shown = () => w.sessions.get('session').messages.filter(m => m.role === 'user').map(m => m.text);
  return { r, w, nativeId, write, queue, prompt, typed, stop, shown };
}

test('a queued prompt edited with ↑ shows only as it was sent again', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始第一件');
  f.typed(first, '方案 A'); f.queue('enqueue', '方案 A');
  f.queue('popAll', '方案 A'); // ↑ moves it into the editor; the person changes A to B and sends it
  f.queue('enqueue', '方案 B'); f.typed(first, '方案 B');
  assert.deepEqual(f.shown(), ['开始第一件', '方案 B']);
  f.queue('remove', '方案 B', { reason: 'absorbed_mid_turn' }); f.stop(first);
  assert.deepEqual(f.shown(), ['开始第一件', '方案 B']);
});
test('a queued prompt taken back and deleted is gone once its turn ends', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始第三件');
  f.typed(first, '方案 D'); f.queue('enqueue', '方案 D');
  f.queue('popAll', '方案 D'); // ↑, then the person deletes the text
  assert.deepEqual(f.shown(), ['开始第三件', '方案 D'], 'nothing has said so yet');
  f.stop(first);
  assert.deepEqual(f.shown(), ['开始第三件']);
});
test('picking one queued prompt to edit takes back only that one', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 E'); f.queue('enqueue', '方案 E');
  f.typed(first, '方案 F'); f.queue('enqueue', '方案 F');
  f.queue('popOne', '方案 F'); f.queue('enqueue', '方案 G'); f.typed(first, '方案 G');
  f.queue('remove', '方案 E', { reason: 'absorbed_mid_turn' }); f.queue('remove', '方案 G', { reason: 'absorbed_mid_turn' }); f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '方案 E', '方案 G']);
});
test('queued prompts cleared on cancel are not shown as sent', t => {
  const f = fixture(t), first = randomUUID(), second = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 H'); f.queue('enqueue', '方案 H');
  f.queue('remove', '方案 H', { reason: 'cleared_on_cancel' });
  f.prompt(second, '下一件');
  assert.deepEqual(f.shown(), ['开始', '下一件']);
});
test('a queued prompt sent unchanged after ↑ stays, once', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 A'); f.queue('enqueue', '方案 A');
  f.queue('popAll', '方案 A');
  f.typed(first, '方案 A'); // its hook can come before its new enqueue row is written
  assert.deepEqual(f.shown(), ['开始', '方案 A']);
  f.queue('enqueue', '方案 A'); f.queue('remove', '方案 A', { reason: 'absorbed_mid_turn' }); f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '方案 A']);
});
test('read, delivered or still waiting queued prompts all stay', t => {
  const f = fixture(t), first = randomUUID(), second = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 C'); f.queue('enqueue', '方案 C');
  f.typed(first, '方案 C'); f.queue('enqueue', '方案 C'); // the same text twice keeps one row (claude-unannounced-stop)
  f.typed(first, '方案 J'); f.queue('enqueue', '方案 J');
  f.typed(first, '方案 K'); f.queue('enqueue', '方案 K');
  f.queue('remove', '方案 C', { reason: 'absorbed_mid_turn' }); f.queue('popOne', '方案 C'); // one of the two taken back
  f.queue('remove', '方案 K', { reason: 'dropped_by_hook' }); // native writes no text for this one
  f.stop(first);
  f.queue('dequeue'); f.prompt(second, '方案 J'); // J waits, then heads a turn of its own
  assert.deepEqual(f.shown(), ['开始', '方案 C', '方案 J', '方案 K', '方案 J']);
});
test('only this prompt window, this session and exact text count', t => {
  const f = fixture(t), earlier = randomUUID(), first = randomUUID();
  f.prompt(earlier, '更早');
  f.queue('enqueue', '方案 L'); f.queue('remove', '方案 L', { reason: 'absorbed_mid_turn' }); // read in an earlier turn
  f.prompt(first, '开始');
  f.typed(first, '方案 L'); f.queue('enqueue', '方案 L'); f.queue('popAll', '方案 L'); // this one is taken back
  f.typed(first, '方案 M'); f.queue('enqueue', '方案 M');
  f.write({ type: 'queue-operation', operation: 'popAll', content: '方案 M', sessionId: randomUUID() }); // another session's row
  f.queue('popAll', '方案 M '); // other text
  f.stop(first);
  assert.deepEqual(f.shown(), ['更早', '开始', '方案 M']);
});
test('without the turn\'s journal window nothing is removed', t => {
  // No transcript path (a hook without it) or an adapter that did not see the turn begin: no proof, no removal.
  const f = fixture(t, { journal: false }), first = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 A'); f.queue('enqueue', '方案 A'); f.queue('popAll', '方案 A');
  f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '方案 A']);
  const g = fixture(t), second = randomUUID();
  g.prompt(second, '开始');
  g.r.queueWindows?.clear(); // a restarted adapter
  g.typed(second, '方案 A'); g.queue('enqueue', '方案 A'); g.queue('popAll', '方案 A');
  g.stop(second);
  assert.deepEqual(g.shown(), ['开始', '方案 A']);
});
test('a typed prompt that heads its own turn is never removed', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始');
  f.typed(first, '方案 N'); f.queue('enqueue', '方案 N');
  const row = f.w.sessions.get('session').messages.find(m => m.id === `claude-prompt-${first}-q${promptTextTag('方案 N')}`);
  row.turnId = 'queued-turn'; // its own turn began (T-138 trigger link)
  f.queue('popAll', '方案 N'); f.stop(first);
  assert.deepEqual(f.shown(), ['开始', '方案 N']);
});
test('another session\'s withdrawal and other row shapes are ignored', t => {
  const f = fixture(t), first = randomUUID();
  f.prompt(first, '开始');
  f.r.emit('nativeInputWithdrawn', { id: `claude-prompt-${first}`, nativeId: f.nativeId });
  f.typed(first, '方案 P'); const id = `claude-prompt-${first}-q${promptTextTag('方案 P')}`;
  f.r.emit('nativeInputWithdrawn', { id, nativeId: randomUUID() });
  assert.deepEqual(f.shown(), ['开始', '方案 P']);
});
