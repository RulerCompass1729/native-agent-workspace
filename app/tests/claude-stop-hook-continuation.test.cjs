// A user Stop hook that blocks (2026-11-23 21:32:31Z) continues the same native turn: NAW
// sees Stop(P), then the continuation's tools, then Stop(P) again with stop_hook_active. Every turn end, and
// the next deliveries by send and by queue, leave the session idle; with and without compaction, an
// observation gap, a mid-turn message held across the blocked Stop, and a backgrounded command then TaskStop.
// Synthetic hooks and rows only; no provider process or model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events'), { randomUUID } = require('node:crypto');
const { Claude } = require('../adapters.cjs'), { Workspace } = require('../workspace.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');

function fixture(t, turnContinue) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-stop-hook-continue-')), r = Object.create(Claude.prototype); EventEmitter.call(r);
  const w = new Workspace({ binaries: {}, close() {} }, dir);
  r.record = { id: 'session', nativeId: randomUUID(), provider: 'claude', messages: [], state: 'idle', owner: 'window', controlRevision: 0, memberRevision: 0, connectionRevision: 0 };
  r.terminal = { alive: true, input() {} }; r.submission = new SubmissionChannel(); r.ready = true;
  w.sessions.set(r.record.id, r.record); w.runtimes.set(r.record.id, r); w.bind(r.record, r);
  t.after(() => { try { w.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true, nativeTurnRecords: true, nativeMedia: true, ...(turnContinue ? { nativeTurnContinue: true } : {}) });
  const emit = value => r.observeRoot({ block: true, sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: (r.rootObservation?.sequence || 0) + 1, ...value });
  const hook = (name, extra = {}) => r.hook({ hook_event_name: name, session_id: r.record.nativeId, ...extra });
  const stop = (promptId, active, background = []) => hook('Stop', { prompt_id: promptId, last_assistant_message: 'reply', background_tasks: background, session_crons: [], stop_hook_active: active });
  return {
    r, w, emit, hook, stop,
    start: (turnId, promptId) => emit({ id: 'control:turn-start', kind: 'control', turnId, promptId, status: 'running' }),
    end: turnId => emit({ id: `turn:${turnId}`, kind: 'turn', turnId, status: 'complete', text: '' }),
    typed: (promptId, prompt) => hook('UserPromptSubmit', { prompt_id: promptId, prompt }),
    tool: (name = 'Bash') => hook('PreToolUse', { tool_name: name, prompt_id: undefined }),
    state: () => w.sessions.get('session').state,
  };
}

const CASES = [];
for (const compact of [false, true]) for (const gap of [false, true]) for (const midturn of [false, true]) for (const background of [false, true]) {
  CASES.push({ compact, gap, midturn, background });
}

for (const c of CASES) {
  const name = Object.entries(c).filter(([, on]) => on).map(([key]) => key).join('+') || 'plain';
  for (const turnContinue of c.compact ? [false, true] : [false]) test(`a turn continued after a blocked Stop settles idle, and so do the next sends and queues (${name}${turnContinue ? ', turn-continue' : ''})`, async t => {
    const f = fixture(t, turnContinue), P = randomUUID();
    f.typed(P, 'Typed natively.'); f.start('t1', P); f.tool();
    assert.equal(f.state(), 'working');
    let append, held;
    if (c.midturn) {
      Object.assign(f.r, { nativeQueue: true, nativeMidturnAppend: true, rootLease: f.r.rootLease, chatAvailable: true });
      f.r.submission.request = () => new Promise(resolve => { append = resolve; });
      held = f.r.queue('wake', 'wake-tag', () => true, '[frame]\nwake');
    }
    // NAW's own Stop hook runs; another user hook blocks, so native continues the same turn.
    f.stop(P, false, c.background ? [{ id: 'bg1', type: 'shell' }] : []);
    f.tool();
    assert.equal(f.state(), 'working', 'the continuation is working');
    if (c.midturn) {
      append({ mode: 'append', uuid: randomUUID(), turnId: 't1', promptId: null });
      await held;
      assert.ok(!f.r.queued);
    }
    if (c.compact) {
      f.emit({ id: 'control:compact', kind: 'control', status: 'complete' });
      f.hook('SessionStart', { source: 'compact', naw_compaction: `${f.r.observationEpoch}:${f.r.rootObservation.sequence}` });
      if (turnContinue) f.emit({ id: 'control:turn-continue', kind: 'control', status: 'running', turnId: 't1', promptId: P });
      f.tool();
    }
    if (c.gap) {
      f.r.observeRootGap({ sessionId: f.r.record.nativeId, lease: f.r.rootLease, epoch: f.r.observationEpoch, gapThrough: f.r.rootObservation.sequence });
      f.tool();
    }
    if (c.background) { f.tool('TaskStop'); }
    f.stop(P, true, []);
    f.end('t1');
    assert.equal(f.state(), 'idle', 'the continued turn ends idle');
    assert.ok(!f.r.pending && !f.r.queued);

    // A NAW delivery by send: its own prompt and turn.
    const Q = randomUUID();
    f.r.submission.request = () => Promise.resolve({ promptId: Q, turnId: 't2' });
    const sent = f.r.send('Next by send.', 'send-tag', () => true);
    f.typed(Q, 'Next by send.'); await sent;
    f.start('t2', Q); f.tool(); f.stop(Q, false); f.end('t2');
    assert.equal(f.state(), 'idle', 'the sent turn ends idle');
    assert.ok(!f.r.pending);

    // A NAW delivery by queue while a native turn runs, read as its own turn after it.
    const R = randomUUID(), Q2 = randomUUID();
    f.typed(R, 'Typed natively again.'); f.start('t3', R); f.tool();
    Object.assign(f.r, { nativeQueue: true, nativeMidturnAppend: false, chatAvailable: true });
    let receipt; f.r.submission.request = () => new Promise(resolve => { receipt = resolve; });
    const queued = f.r.queue('Next by queue.', 'queue-tag', () => true);
    f.stop(R, false); f.end('t3');
    f.typed(Q2, 'Next by queue.');
    receipt({ promptId: Q2, turnId: 't4' }); await queued;
    f.start('t4', Q2); f.tool(); f.stop(Q2, false); f.end('t4');
    assert.equal(f.state(), 'idle', 'the queued turn ends idle');
    assert.ok(!f.r.pending && !f.r.queued);
  });
}
