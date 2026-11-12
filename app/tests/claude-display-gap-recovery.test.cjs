// Steward step 2, batch 0 (measured 2026-11-11 22:10 → 11-12 06:4x on the steward's own session): after one
// observation gap, `displayGap` stayed set until a rebind or context switch. Every later root-control call failed
// "Native root control call is unavailable", and every later turn ended unreported, so a wake staged in it stayed
// 已登记 for good. A clean root turn start after the gap is where NAW sees whole again; a turn that ends without
// being seen whole still reports its end, so its wake is withdrawn with the reason instead of hanging.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs');
const { SubmissionChannel } = require('../claude-submit.cjs');
const { Workspace } = require('../workspace.cjs');
const { PeerRunner } = require('../peer-handoffs.cjs');
const native = require('../background-control-native.cjs');
const controlArgs = (id, method, args = []) => ({ action: 'invoke', operation_id: id, method, arguments: args });
const tick = () => new Promise(resolve => setImmediate(resolve));

function adapter() {
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  r.record = { nativeId: randomUUID() }; r.terminal = { alive: true }; r.submission = new SubmissionChannel();
  r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true }); return r;
}
// The real bridge mod (register.js) over a fixture transport: an observation can be made to fail, as a lost
// delivery does, and the mod then declares the gap on the next row it delivers.
async function mod() {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  const { register } = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + randomUUID()).toString('base64'));
  const r = adapter(), clock = [], hooks = new Map(), ends = [];
  let lose = 0;
  r.on('nativeTurnEnd', info => ends.push([info.turnId, info.status]));
  const $ = { session: { id: async () => r.record.nativeId, version: async () => ({ version: '2.1.322' }) },
    env: { get: async key => key === 'NAW_SUBMIT_SOCKET' ? '/fixture/socket' : key === 'NAW_HOOK_SOCKET' ? '/fixture/hooks.sock' : 'fixture-token' },
    fs: { read: async () => JSON.stringify({ sessionId: r.record.nativeId, socketPath: '/fixture/gui-submit.sock', token: 'a'.repeat(64), compat: true, nativeBlocks: true }) },
    clock: { after: (delay, fn) => { fn.delay = delay; clock.push(fn); return { cancel() { const i = clock.indexOf(fn); if (i >= 0) clock.splice(i, 1); } }; } },
    tool: { list: async () => [] }, turn: { abort: async () => { throw Error('No native control requested'); } },
    prompt: { read: async () => ({ text: '' }), submit: async () => { throw Error('Observation must never submit'); } },
    http: { fetch: async (url, options) => {
      const body = JSON.parse(options.body); let result;
      if (url.endsWith('/root-bind')) result = r.bindRoot(body);
      else if (url.endsWith('/next')) { if (body.observationGap) r.observeRootGap(body); result = { idle: true }; }
      else if (url.endsWith('/observation')) { if (lose > 0) { lose--; throw Error('Offline'); } result = r.observeRoot(body); }
      else throw Error('Unexpected request: ' + url);
      return { ok: true, text: JSON.stringify(result) };
    } } };
  register((name, matcher, handler) => { const values = hooks.get(name) || []; values.push({ matcher: handler ? matcher : null, fn: handler || matcher }); hooks.set(name, values); return { catch() {} }; });
  const matches = (filter, value) => !filter || Object.entries(filter).every(([key, want]) => want && typeof want === 'object' ? matches(want, value?.[key]) : value?.[key] === want);
  const invoke = (name, e, next = async e => ({ uuid: e.uuid, message: e.message })) => {
    const selected = (hooks.get(name) || []).filter(hook => matches(hook.matcher, e));
    const dispatch = (index, value) => { if (index === selected.length) return next(value); const rest = v => dispatch(index + 1, v); rest.origin = next.origin; return selected[index].fn($, value, rest); };
    return dispatch(0, e);
  };
  await invoke('session.start', {}); await clock.shift()(); const listen = clock.find(fn => fn.delay === 0); clock.length = 0;
  // Pending observation deliveries only; a bounded loop fails instead of spinning.
  const flush = async () => { for (let n = 0; clock.length; n++) { assert.ok(n < 100, 'observation timers never settled'); await clock.shift()(); } };
  // One control poll; the next poll it schedules for itself is dropped.
  const poll = async () => { const before = new Set(clock); await listen(); for (const fn of [...clock]) if (!before.has(fn)) clock.splice(clock.indexOf(fn), 1); };
  const prompts = new Map();
  const f = {
    r, ends, poll, flush, lose(count = 1) { lose = count; },
    // `wait: true` leaves the row queued in the bridge, as under a backlog.
    async start(turnId, { wait = false } = {}) { const promptId = randomUUID(); prompts.set(turnId, promptId);
      await invoke('classic.UserPromptSubmit', { session_id: r.record.nativeId, prompt_id: promptId }); await invoke('turn.start', { turnId }); if (!wait) await flush(); },
    async display(turnId, text, { index = 0, message = randomUUID(), wait = false } = {}) {
      await invoke('classic.MessageDisplay', { session_id: r.record.nativeId, prompt_id: prompts.get(turnId), turn_id: turnId, message_id: message, index, final: true, delta: text }, async () => ({})); if (!wait) await flush(); return message; },
    async end(turnId, reason = 'answer', answer = '', { wait = false } = {}) { await invoke('turn.complete', { turnId, reason, answer }); if (!wait) await flush(); },
    control(turnId, callId = randomUUID()) {
      return native.rootCall(r, { arguments: controlArgs('steward-read', 'rename', ['target', 'name']), turnId, promptId: r.liveTurn?.promptId, callId, epoch: r.observationEpoch,
        sessionId: r.record.nativeId, lease: r.rootLease }, new AbortController().signal, () => true);
    },
  };
  return f;
}

test('after a gap, the next clean root turn is seen whole again: control returns and its end is reported once (steward step 2, batch 0)', async () => {
  const f = await mod();
  await f.start('before-gap'); await f.display('before-gap', 'Text before the loss.');
  f.lose(); await f.display('before-gap', 'Lost text.');
  await f.end('before-gap', 'answer', 'Lost text.');
  assert.equal(f.r.displayGap, true, 'the next delivered row declared the loss');
  assert.equal(f.r.liveTurn, null);
  assert.throws(() => f.control('before-gap'), /unavailable/);
  assert.deepEqual(f.ends, [], 'the turn whose end row carried the gap reports no end');

  await f.start('after-gap');
  assert.equal(f.r.displayGap, false, 'a clean start after the gap is where NAW sees whole again');
  const proof = f.control('after-gap'); assert.equal(native.consumeCredential(proof.credential).valid(), true, 'control returns for the clean turn');
  await f.display('after-gap', 'Seen whole.\n');
  await f.end('after-gap', 'answer', 'Seen whole.');
  assert.deepEqual(f.ends, [['after-gap', 'completed']]);
  assert.equal(f.r.displayProofs.get('after-gap').safeText, 'Seen whole.\n');
  assert.equal(f.r.displayProofs.get('before-gap').incomplete, true, 'the turn before the gap stays not seen whole');
});

test('a start that itself carries the gap does not restore anything; the clean start after it does', async () => {
  const f = await mod();
  await f.start('first'); await f.display('first', 'Fine.\n');
  f.lose(); await f.end('first', 'answer', 'Fine.'); // the end row itself is lost
  await f.start('carries-gap');
  assert.equal(f.r.displayGap, true, 'the loss was declared on this start row');
  assert.equal(f.r.liveTurn, null); assert.equal(f.r.rootTurn, null);
  await f.display('carries-gap', 'Not proven.\n'); await f.end('carries-gap', 'answer', 'Not proven.');
  assert.deepEqual(f.ends, [], 'neither turn grants or reports a normal end');
  await f.start('clean');
  assert.equal(f.r.displayGap, false);
  await f.display('clean', 'Whole.\n'); await f.end('clean', 'answer', 'Whole.');
  assert.deepEqual(f.ends, [['clean', 'completed']]);
});

test('a replayed or repeated start after a gap does not restore control', () => {
  const r = adapter(), emit = value => r.observeRoot({ block: true, sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: (r.rootObservation?.sequence || 0) + 1, ...value });
  emit({ id: 'control:turn-start', kind: 'control', turnId: 'seen', promptId: randomUUID(), status: 'running' });
  r.observeRootGap({ sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, gapThrough: r.rootObservation.sequence });
  emit({ id: 'control:turn-start', kind: 'control', turnId: 'history', promptId: randomUUID(), status: 'running', replayed: true });
  assert.equal(r.displayGap, true, 'history is not a fresh observation');
  emit({ id: 'control:turn-start', kind: 'control', turnId: 'seen', promptId: randomUUID(), status: 'running' });
  assert.equal(r.displayGap, true, 'a start for a turn already seen is not a new turn');
  assert.equal(r.liveTurn, null);
});

test('a gap declared without the sequence it covers (an older bridge) holds until a rebind, as before', () => {
  const r = adapter(), emit = value => r.observeRoot({ block: true, sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: (r.rootObservation?.sequence || 0) + 1, ...value });
  r.observeRootGap({ sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch });
  emit({ id: 'control:turn-start', kind: 'control', turnId: 'clean', promptId: randomUUID(), status: 'running' });
  assert.equal(r.displayGap, true);
  r.bindRoot({ sessionId: r.record.nativeId, nativeBlocks: true });
  assert.equal(r.displayGap, false);
  emit({ id: 'control:turn-start', kind: 'control', turnId: 'after-rebind', promptId: randomUUID(), status: 'running' });
  assert.equal(r.displayGap, false, 'the floor went with the old binding');
});

// Review 1 of this batch: a row of a turn dropped as it is made, while that turn's start still waits in the bridge,
// is declared on an older row or on the poll; the start then arrives with no gap flag of its own.
for (const via of ['poll', 'older-row']) test(`a start that waited while a row of its own turn was dropped restores nothing (${via})`, async () => {
  const f = await mod();
  await f.start('previous');
  if (via === 'older-row') await f.end('previous', 'answer', '', { wait: true });
  await f.start('dropped-in', { wait: true });
  await f.display('dropped-in', 'x'.repeat(600000), { wait: true }); // over the bridge's row limit: dropped, never numbered
  if (via === 'poll') await f.poll();
  await f.flush();
  assert.equal(f.r.displayGap, true, 'the start waited behind the loss');
  assert.throws(() => f.control('dropped-in'), /Native root control call is unavailable/);
  await f.display('dropped-in', 'Rest.\n'); await f.end('dropped-in', 'answer', 'Rest.');
  assert.deepEqual(f.ends.filter(([id]) => id === 'dropped-in'), [['dropped-in', 'incomplete']]);
  await f.start('next');
  assert.equal(f.r.displayGap, false, 'the next start is numbered above the loss');
});

test('a gap during the recovered turn takes it away again; its end is never reported as completed', async () => {
  for (const via of ['row', 'poll']) {
    const f = await mod();
    f.lose(); await f.start('lost-start'); // nothing delivered yet: the gap rides the next row or poll
    if (via === 'poll') { await f.poll(); assert.equal(f.r.displayGap, true); }
    await f.start('recovered');
    assert.equal(f.r.displayGap, via === 'row', via === 'row' ? 'the start carried the gap' : 'the poll declared it before this clean start');
    if (via === 'row') await f.start('recovered-2');
    const turn = via === 'row' ? 'recovered-2' : 'recovered';
    assert.equal(f.r.displayGap, false);
    f.lose(); await f.display(turn, 'Lost mid-turn.\n');
    if (via === 'poll') await f.poll();
    await f.end(turn, 'answer', 'Lost mid-turn.');
    assert.equal(f.r.displayGap, true);
    assert.ok(!f.ends.some(([id, status]) => id === turn && status === 'completed'), `${via}: ${JSON.stringify(f.ends)}`);
    assert.throws(() => f.control(turn), /unavailable|identity/);
  }
});

test('every observed end of a started root turn is reported exactly once, completed only when seen whole', async () => {
  const cases = {
    whole: { reason: 'answer', expect: 'completed' },
    // An index skipped in the middle of one display block: the end is seen, the turn is not seen whole.
    'not-whole': { reason: 'answer', skip: true, expect: 'incomplete' },
  };
  for (const [name, c] of Object.entries(cases)) {
    const f = await mod();
    await f.start(name);
    const message = await f.display(name, 'Part one. ');
    if (c.skip) await f.display(name, 'Part three.', { index: 2, message });
    await f.end(name, c.reason, c.skip ? 'Part one. Part three.' : 'Part one.');
    await f.end(name, c.reason, 'again'); // a repeated end row reports nothing more
    assert.deepEqual(f.ends, [[name, c.expect]], name);
  }
});

// The steward's measured path end to end: the wake staged in a turn after the gap, its end observed by the adapter
// itself (the session-wake fixture's finish() emits nativeTurnEnd by hand and so never met this gate).
async function wakeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-gap-wake-'));
  const key = 'backends/aaaaaaaaaaaaaaaaaaaa', dirs = [root, path.join(root, key)];
  fs.mkdirSync(dirs[1], { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dirs[1]), 0o700);
  fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', key] }), { mode: 0o600 });
  const workspaces = [], runtimes = [], writes = [];
  for (let i = 0; i < 2; i++) {
    const w = new Workspace({ binaries: {}, close() {}, create(s) {
      const r = s.provider === 'claude' ? new Claude(s, this, { attachOnly: true }) : new EventEmitter(); r.record = s; s.nativeId = i === 0 ? randomUUID() : 'native-' + s.id;
      r.host = { rpc: { call: async method => { assert.equal(method, 'thread/goal/get'); return { goal: null }; } } };
      r.chatAvailable = true; if (s.provider !== 'claude') r.addressedSendAvailable = true;
      r.start = async () => r.emit('state', 'idle');
      r.send = async (text, tag, guard) => { assert.equal(guard(), true); writes.push({ i, text, tag }); r.emit('submitted', tag); };
      runtimes.push(r); return r;
    } }, dirs[i]); workspaces.push(w);
  }
  const connect = async dir => {
    const w = workspaces[dirs.indexOf(dir)];
    return { close() {}, async call(method, spec) {
      if (method === 'initial') return { ...w.snapshot(), capabilities: ['agentWakeV1', 'agentWakePreflightV1'] };
      const wake = require('../session-wake.cjs');
      if (method === 'wakeCheck') return wake.check(w, spec);
      if (method === 'wakeTake') return wake.take(w, spec);
      if (method === 'wakeReceive') return wake.receive(w, spec);
      throw Error('Unexpected method ' + method);
    } };
  };
  workspaces.forEach((w, i) => { w.peerRunner = new PeerRunner(w, dirs[i], connect); });
  t.after(() => { workspaces.forEach(w => w.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const a = await workspaces[0].create('claude', root, 'source-owner', 'Steward');
  const b = await workspaces[1].create('codex', root, 'target-owner', 'Receiver');
  const [source] = workspaces, [r] = runtimes, s = source.get(a);
  r.terminal = { alive: true }; r.submission = new SubmissionChannel();
  r.bindRoot({ sessionId: s.nativeId, nativeBlocks: true, addressedTool: true });
  const emit = value => r.observeRoot({ block: true, sessionId: s.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: (r.rootObservation?.sequence || 0) + 1, ...value });
  const start = turnId => { emit({ id: 'control:turn-start', kind: 'control', turnId, promptId: randomUUID(), status: 'running' }); r.emit('state', 'working'); };
  const block = (turnId, index, text, id = 'display:' + turnId) => emit({ id, kind: 'response', turnId, promptId: r.liveTurn?.promptId, index, delta: text, status: 'complete' });
  const end = turnId => emit({ id: `turn:${turnId}`, kind: 'turn', turnId, status: 'complete', text: '' });
  const call = (text = 'Take the next queue item.') => r.addressedCall({ nativeId: s.nativeId, turnId: r.turnId, promptId: r.liveTurn.promptId, callId: randomUUID() }, { recipient_id: b, message: text });
  // Declared as the bridge does: covering every row numbered so far.
  const gap = () => r.observeRootGap({ sessionId: s.nativeId, lease: r.rootLease, epoch: r.observationEpoch, gapThrough: r.rootObservation?.sequence || 0 });
  const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
  const wakes = () => s.messages.filter(m => m.wake);
  return { r, s, start, block, end, call, gap, settle, wakes, writes };
}

test('a wake staged in the clean turn after a gap is delivered once when that turn ends', async t => {
  const f = await wakeFixture(t);
  f.start('turn-with-gap'); f.gap(); f.end('turn-with-gap');
  f.start('clean-turn');
  assert.equal((await f.call()).status, 'staged');
  f.block('clean-turn', 0, 'Done.'); f.end('clean-turn'); await f.settle();
  assert.equal(f.wakes()[0].wake.status, 'submitted');
  assert.equal(f.writes.length, 1);
});

test('a wake staged in a turn that ends without being seen whole is withdrawn with that reason, never left 已登记', async t => {
  const f = await wakeFixture(t);
  f.start('long-turn');
  assert.equal((await f.call()).status, 'staged');
  f.block('long-turn', 0, 'Part one. '); f.block('long-turn', 2, 'Part three.'); // index 1 never arrived
  f.end('long-turn'); await f.settle();
  const [row] = f.wakes();
  assert.equal(row.wake.status, 'cancelled');
  assert.equal(row.wake.cancellation.nativeStatus, 'incomplete');
  assert.match(row.text, /^发送方这一轮的原生内容没能确认完整；自动消息未投递。\n/);
  assert.ok(require('../ui-locale.js').displayText('en', row.text, row.uiMessage).startsWith("NAW could not confirm it saw all of the sender's turn; the automatic message was not delivered.\n"));
  assert.equal(f.writes.length, 0);
});

test('a gap after a wake was staged withdraws it at once with the gap as the reason', async t => {
  const f = await wakeFixture(t);
  f.start('turn');
  assert.equal((await f.call()).status, 'staged');
  f.gap(); f.end('turn'); await f.settle();
  const [row] = f.wakes();
  assert.equal(row.wake.status, 'cancelled');
  assert.match(row.text, /原生观察连接出现缺口/);
  assert.equal(f.writes.length, 0);
});

// A turn that failed without a capacity report emits no end; its wake is withdrawn when the next turn starts.
test('a wake staged in a turn whose end NAW never saw is withdrawn when the next turn starts, and a late end changes nothing', async t => {
  const f = await wakeFixture(t);
  f.start('failed-turn');
  assert.equal((await f.call()).status, 'staged');
  f.r.observeRoot({ block: true, sessionId: f.s.nativeId, lease: f.r.rootLease, epoch: f.r.observationEpoch, sequence: (f.r.rootObservation?.sequence || 0) + 1, id: 'turn:failed-turn', kind: 'turn', turnId: 'failed-turn', status: 'failed', text: '' });
  await f.settle();
  assert.equal(f.wakes()[0].wake.status, 'staged', 'No end was reported for that turn');
  f.start('next-turn'); await f.settle();
  const [row] = f.wakes();
  assert.equal(row.wake.status, 'cancelled'); assert.equal(row.wake.cancellation.nativeStatus, 'unreported');
  assert.match(row.text, /^发送方上一轮的结束 NAW 没有看到，下一轮已经开始；自动消息未投递。\n/);
  assert.ok(require('../ui-locale.js').displayText('en', row.text, row.uiMessage).startsWith("NAW did not see the end of the sender's earlier turn"));
  f.r.emit('nativeTurnEnd', { nativeId: f.s.nativeId, turnId: 'failed-turn', status: 'failed' }); await f.settle();
  assert.equal(f.wakes()[0].wake.status, 'cancelled'); assert.equal(f.writes.length, 0);
});
