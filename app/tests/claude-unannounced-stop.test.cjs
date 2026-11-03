// T-138 (measured on Claude Code 2.1.316 and 2.1.317): a queued prompt's own turn, and a `!` turn,
// stop under a prompt id no UserPromptSubmit announced. That turn's own end, by turn id, settles the
// session to idle without attributing or sharing any reply; a late Stop of an announced prompt does not.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Claude } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-claude-unannounced-')), r = Object.create(Claude.prototype); EventEmitter.call(r);
  r.record = { id: 'session', nativeId: randomUUID(), provider: 'claude', messages: [], state: 'idle', owner: 'window', controlRevision: 0, memberRevision: 0, connectionRevision: 0 };
  r.terminal = { alive: true }; r.submission = new SubmissionChannel(); r.ready = true;
  const w = new Workspace({ binaries: {}, close() {} }, dir); w.sessions.set(r.record.id, r.record); w.runtimes.set(r.record.id, r); w.bind(r.record, r);
  t.after(() => { try { w.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true });
  const emit = value => r.observeRoot({ block: true, sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: (r.rootObservation?.sequence || 0) + 1, ...value });
  const hook = (name, extra = {}) => r.hook({ hook_event_name: name, session_id: r.record.nativeId, ...extra });
  const stop = promptId => hook('Stop', { prompt_id: promptId, last_assistant_message: 'reply', background_tasks: [], session_crons: [], stop_hook_active: false });
  const start = (turnId, promptId) => emit({ id: 'control:turn-start', kind: 'control', turnId, promptId, status: 'running' });
  const end = turnId => emit({ id: `turn:${turnId}`, kind: 'turn', turnId, status: 'complete', text: '' });
  const typed = (promptId, prompt) => hook('UserPromptSubmit', { prompt_id: promptId, prompt });
  const tool = () => hook('PreToolUse', { tool_name: 'Bash', prompt_id: undefined });
  return { r, w, stop, start, end, typed, tool, state: () => w.sessions.get('session').state };
}
// First turn, a prompt typed while it runs (same id), then that prompt's own turn running a tool.
function queued(f) {
  const first = randomUUID();
  f.typed(first, 'Look at the board.'); f.start('first-turn', first); f.stop(first); f.end('first-turn');
  assert.equal(f.state(), 'idle');
  f.typed(first, 'And then this.');
  f.start('queued-turn', first); f.tool();
  assert.equal(f.state(), 'working');
  return first;
}
for (const order of ['end-then-stop', 'stop-then-end']) test(`a queued prompt's own turn settles to idle once it ends (${order}) (T-138)`, t => {
  const f = fixture(t); queued(f);
  const unannounced = randomUUID(), completes = []; f.r.on('complete', info => completes.push(info));
  if (order === 'end-then-stop') { f.end('queued-turn'); assert.equal(f.state(), 'working', 'no Stop yet'); f.stop(unannounced); }
  else { f.stop(unannounced); assert.equal(f.state(), 'working', 'the turn has not ended'); f.end('queued-turn'); }
  assert.equal(f.state(), 'idle');
  assert.equal(completes.length, 1);
  assert.deepEqual([completes[0].text, completes[0].tag, completes[0].messageId], ['', undefined, undefined], 'idle only: no reply text, tag or message is attributed');
});
test('a late Stop of an announced prompt cannot settle the newer turn (T-138)', t => {
  const f = fixture(t), first = randomUUID(), second = randomUUID();
  f.typed(first, 'Look at the board.'); f.start('first-turn', first); f.end('first-turn');
  f.typed(second, 'Next task.'); f.start('second-turn', second); f.tool();
  f.stop(first); // late, and announced
  f.end('second-turn');
  assert.equal(f.state(), 'working', 'still waiting for the second prompt\'s own Stop');
  f.stop(second);
  assert.equal(f.state(), 'idle');
});
test('an unannounced Stop never settles a turn that has not ended, nor another turn (T-138)', t => {
  const f = fixture(t); queued(f);
  f.stop(randomUUID());
  f.end('some-other-turn');
  assert.equal(f.state(), 'working');
});

for (const order of ['end-then-stop', 'stop-then-end']) test(`a queued turn that asked a native permission still settles (${order}) (T-138)`, t => {
  // control:permission clears rootTurn (sharing authority); settling uses the started turn instead.
  const f = fixture(t); queued(f);
  const emit = value => f.r.observeRoot({ block: true, sessionId: f.r.record.nativeId, lease: f.r.rootLease, epoch: f.r.observationEpoch, sequence: (f.r.rootObservation?.sequence || 0) + 1, ...value });
  emit({ id: 'control:permission', kind: 'control', turnId: 'queued-turn', permissionId: 'permission:ask-1', title: 'Bash', input: '{"command":"ls"}', status: 'complete' });
  assert.equal(f.r.rootTurn, null);
  emit({ id: 'control:permission-end', kind: 'control', turnId: 'queued-turn', permissionId: 'permission:ask-1', status: 'complete' });
  assert.equal(f.state(), 'working');
  if (order === 'end-then-stop') { f.end('queued-turn'); f.stop(randomUUID()); } else { f.stop(randomUUID()); f.end('queued-turn'); }
  assert.equal(f.state(), 'idle');
});
test('a prompt announced after the queued turn started leaves settling to that prompt (T-138)', t => {
  const f = fixture(t); queued(f);
  f.typed(randomUUID(), 'Typed while the queued turn runs.');
  f.stop(randomUUID()); f.end('queued-turn');
  assert.equal(f.state(), 'working');
});
test('a turn whose authority an input boundary took still reports its end, once, as a boundary (T-141)', t => {
  const f = fixture(t), first = randomUUID(), ends = []; f.r.on('nativeTurnEnd', info => ends.push([info.turnId, info.status]));
  const emit = value => f.r.observeRoot({ block: true, sessionId: f.r.record.nativeId, lease: f.r.rootLease, epoch: f.r.observationEpoch, sequence: (f.r.rootObservation?.sequence || 0) + 1, ...value });
  f.typed(first, 'Look at the board.'); f.start('first-turn', first);
  emit({ id: 'control:input', kind: 'control', status: 'complete' });
  assert.equal(f.r.rootTurn, null, 'the boundary took the turn\'s sharing authority');
  f.end('first-turn'); f.end('first-turn');
  assert.deepEqual(ends, [['first-turn', 'boundary']]);
  // A turn with no boundary reports only its normal end.
  const second = randomUUID(); f.typed(second, 'Next.'); f.start('second-turn', second); f.stop(second); f.end('second-turn');
  assert.deepEqual(ends, [['first-turn', 'boundary'], ['second-turn', 'completed']]);
});
test('a turn that already reported its end never gets a second, boundary end (T-141)', t => {
  const f = fixture(t), first = randomUUID(), ends = []; f.r.on('nativeTurnEnd', info => ends.push([info.turnId, info.status]));
  f.typed(first, 'Look at the board.'); f.start('first-turn', first); f.stop(first); f.end('first-turn');
  f.r.rootTurn = null; // e.g. a later reset or a mismatched StopFailure clears it before a re-sent block
  f.end('first-turn');
  assert.deepEqual(ends, [['first-turn', 'completed']]);
});
