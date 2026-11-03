const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { PeerRunner } = require('../peer-handoffs.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, sourceProvider = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-test-'));
  const key = 'backends/aaaaaaaaaaaaaaaaaaaa', dirs = [root, path.join(root, key)];
  fs.mkdirSync(dirs[1], { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dirs[1]), 0o700);
  fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', key] }), { mode: 0o600 });
  const workspaces = [], runtimes = [], writes = [];
  for (let i = 0; i < 2; i++) {
    const w = new Workspace({ binaries: {}, close() {}, create(s) {
      const r = s.provider === 'claude' ? new (require('../adapters.cjs').Claude)(s, this, { attachOnly: true }) : new EventEmitter(); r.record = s; s.nativeId = 'native-' + s.id;
      r.host = { rpc: { call: async method => { assert.equal(method, 'thread/goal/get'); return { goal: null }; } } };
      r.chatAvailable = r.addressedSendAvailable = true;
      r.start = async () => r.emit('state', 'idle');
      r.send = async (text, tag, guard) => { assert.equal(guard(), true); writes.push({ i, text, tag }); r.emit('submitted', tag); };
      runtimes.push(r); return r;
    } }, dirs[i]); workspaces.push(w);
  }
  const connect = async dir => {
    const i = dirs.indexOf(dir); assert.notEqual(i, -1); const w = workspaces[i];
    return { close() {}, async call(method, spec) {
      if (method === 'initial') return { ...w.snapshot(), capabilities: ['agentWakeV1'] };
      const wake = require('../session-wake.cjs');
      if (method === 'wakeTake') return wake.take(w, spec);
      if (method === 'wakeReceive') return wake.receive(w, spec);
      throw Error('Unexpected method ' + method);
    } };
  };
  workspaces.forEach((w, i) => { w.peerRunner = new PeerRunner(w, dirs[i], connect); });
  t.after(() => { workspaces.forEach(w => w.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const a = await workspaces[0].create(sourceProvider, root, 'source-owner', 'Sender');
  const b = await workspaces[1].create('codex', root, 'target-owner', 'Receiver');
  const [source, target] = workspaces, [ra, rb] = runtimes;
  const start = id => { if (sourceProvider === 'claude') ra.liveTurn = { id, promptId: 'native-prompt-' + id }; else ra.turnId = id; ra.emit('nativeTurnStart', { nativeId: source.get(a).nativeId, turnId: id }); ra.emit('state', 'working'); };
  start('turn-one');
  const call = (text = 'Continue one bounded task.', callId = 'call-one') => ra.addressedCall({ nativeId: source.get(a).nativeId, turnId: ra.turnId, ...(sourceProvider === 'claude' ? { promptId: ra.liveTurn.promptId } : {}), callId }, { recipient_id: b, message: text });
  const finish = async (status = 'completed') => { const turnId = ra.turnId; if (sourceProvider === 'claude') ra.liveTurn = null; else ra.turnId = null; ra.emit('state', 'idle'); ra.emit('nativeTurnEnd', { nativeId: source.get(a).nativeId, turnId, status }); for (let i = 0; i < 8; i++) await tick(); };
  return { root, source, target, a, b, ra, rb, call, finish, start, writes };
}
test('native explicit wake is staged durably, transfers once across backends, and preserves owner plus identical draft', async t => {
  const { root, source, target, a, b, call, finish, writes } = await fixture(t);
  const text = 'Continue one bounded task.'; target.setDraft(b, text, 'target-owner');
  assert.equal((await call(text)).status, 'staged');
  const intent = source.get(a).messages.find(m => m.wake).wake;
  const exactPayload = `[Workspace message from ${intent.senderName} · ${intent.senderId} at ${new Date(intent.time).toISOString()}]\n${text}`;
  target.setDraft(b, exactPayload, 'target-owner');
  assert.equal(writes.length, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'workspace.json')));
  assert.equal(saved.sessions.find(s => s.id === a).messages.filter(m => m.wake?.status === 'staged').length, 1);
  assert.equal((await call(text)).status, 'staged');
  await finish(); assert.equal(writes.length, 1);
  assert.match(writes[0].text, /Sender/); assert.ok(writes[0].text.endsWith(text));
  assert.equal(target.get(b).owner, 'target-owner'); assert.equal(target.drafts.get(b), exactPayload);
  assert.equal(source.get(a).messages.find(m => m.wake)?.wake.status, 'submitted');
  assert.equal(target.get(b).messages.find(m => m.origin === 'agent-wake').status, 'submitted');
});
test('the person pausing all follow-up handoffs on another backend invalidates both staged and late intent from the old source turn', async t => {
  const { source, target, a, b, call, finish, writes } = await fixture(t);
  await call(); target.pauseAll('你暂停了后续交接'); await finish(); assert.equal(writes.length, 0);
  assert.notEqual(source.get(a).messages.find(m => m.wake)?.wake.status, 'submitted');
  assert.match(source.get(a).messages.find(m => m.wake).text, /Continue one bounded task\./);
  await assert.rejects(async () => call('A late new call.', 'call-two'), /真人|回合|授权/);
  assert.equal(target.get(b).owner, 'target-owner');
});
test('a person typing to an unrelated session neither cancels a staged wake nor blocks a later one', async t => {
  // T-100: one person talks to several agents; input to C must not void A's wake to B.
  const f = await fixture(t), other = await f.target.create('codex', f.root, 'other-owner', 'Unrelated');
  await f.call();
  await f.target.send(other, 'The person talks to an unrelated agent.', 'other-owner');
  f.target.runtimes.get(other).emit('nativeInput', 'Native input in another session', { id: 'native-input-elsewhere' });
  assert.equal(f.writes.length, 1, 'Only the human message to the unrelated session was written');
  await f.finish();
  const delivered = f.writes.filter(w => w.text.includes('Continue one bounded task.'));
  assert.equal(delivered.length, 1, 'The staged wake is delivered once');
  assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'submitted');
});
test('a person acting on the sender or the receiver still cancels that wake', async t => {
  for (const act of ['sender-input', 'receiver-send', 'receiver-native-input']) {
    const f = await fixture(t); await f.call();
    if (act === 'sender-input') f.ra.emit('nativeInput', 'The person types into the sender', { id: 'sender-native-input' });
    else if (act === 'receiver-send') await f.target.send(f.b, 'The person talks to the receiver.', 'target-owner');
    else f.rb.emit('nativeInput', 'The person types into the receiver', { id: 'receiver-native-input' });
    await f.finish();
    assert.equal(f.writes.filter(w => w.text.includes('Continue one bounded task.')).length, 0, act);
    assert.notEqual(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'submitted', act);
  }
});
test('a sender boundary that cancels a staged wake names its reason in the record', async t => {
  // T-100: the 11-02 secretary wake was cancelled with no trace of which boundary did it.
  const f = await fixture(t, 'claude'); assert.equal((await f.call()).status, 'staged');
  f.ra.emit('state', 'approval');
  const row = f.source.get(f.a).messages.find(m => m.wake);
  assert.equal(row.wake.status, 'cancelled');
  assert.match(row.text, /^原生观察或控制边界已变化（等待原生权限确认）；自动消息未投递。/);
  await f.finish(); assert.equal(f.writes.length, 0);
});
test('target busy, permission wait, or immediate global/session off prevents any native write', async t => {
  for (const boundary of ['busy', 'permission', 'global', 'session']) {
    const f = await fixture(t); await f.call();
    if (boundary === 'busy') f.target.get(f.b).state = 'working';
    if (boundary === 'permission') f.rb.nativeInputRequired = true;
    if (boundary === 'global') require('../session-wake.cjs').setPolicy(f.target, null, false);
    if (boundary === 'session') require('../session-wake.cjs').setPolicy(f.target, f.b, false);
    await f.finish(); assert.equal(f.writes.length, 0, boundary);
  }
});
test('failed original turn never dispatches or replays a staged intent', async t => {
  const { source, a, call, finish, writes } = await fixture(t);
  await call(); await finish('failed'); assert.equal(writes.length, 0);
  assert.equal(source.get(a).messages.find(m => m.wake)?.wake.status, 'cancelled');
});
test('concurrent calls from the same native turn cannot stage two messages', async t => {
  const { call, source, a, finish, writes } = await fixture(t);
  const results = await Promise.allSettled([Promise.resolve().then(() => call('First.', 'one')), Promise.resolve().then(() => call('Second.', 'two'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(source.get(a).messages.filter(m => m.wake).length, 1);
  await finish(); assert.equal(writes.length, 1);
});
test('receiver cooldown and three-wake budget survive ordinary replies, and only human control resets the streak', async t => {
  const oldNow = Date.now; let now = oldNow(); Date.now = () => now; t.after(() => { Date.now = oldNow; });
  const f = await fixture(t);
  const reply = () => { const tag = f.writes.at(-1).tag; f.rb.emit('state', 'idle'); f.rb.emit('complete', { tag, text: 'An ordinary reply.', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); };
  await f.call(); await f.finish(); assert.equal(f.writes.length, 1); reply();
  f.start('turn-two'); await f.call('Too soon.', 'two'); await f.finish(); assert.equal(f.writes.length, 1);
  for (const n of [3, 4]) { now += 60001; f.start('turn-' + n); await f.call('Next task.', 'call-' + n); await f.finish(); assert.equal(f.writes.length, n - 1); reply(); }
  now += 60001; f.start('turn-five'); await f.call('Budget exhausted.', 'five'); await f.finish(); assert.equal(f.writes.length, 3);
  assert.match(f.source.get(f.a).messages.findLast(m => m.wake).text, /连续 3 次/);
  f.target.claim(f.b, 'human-new-owner'); now += 60001; f.start('turn-six'); await f.call('After human control.', 'six'); await f.finish(); assert.equal(f.writes.length, 4);
  assert.equal(f.target.get(f.b).owner, 'human-new-owner');
});
test('human control during native goal lookup prevents the write', async t => {
  const f = await fixture(t); await f.call();
  let release; f.rb.host.rpc.call = () => new Promise(resolve => { release = resolve; });
  await f.finish(); assert.equal(typeof release, 'function');
  f.target.claim(f.b, 'later-owner'); release({ goal: null });
  for (let i = 0; i < 8; i++) await tick(); assert.equal(f.writes.length, 0); assert.equal(f.target.get(f.b).owner, 'later-owner');
});
test('reopening retained source intents marks them unconfirmed and never transfers them', async t => {
  const f = await fixture(t); await f.call(); f.source.persist();
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root);
  t.after(() => reopened.close());
  const row = reopened.get(f.a).messages.find(m => m.wake);
  assert.equal(row.wake.status, 'unconfirmed'); assert.match(row.text, /不会重发/); assert.equal(f.writes.length, 0);
});
test('a per-session receive-off switch does not prohibit that human-operated session from addressing another peer', async t => {
  const f = await fixture(t); require('../session-wake.cjs').setPolicy(f.source, f.a, false);
  f.start('new-human-turn'); await f.call(); await f.finish(); assert.equal(f.writes.length, 1);
});

test('a newly human-started native turn can address a peer after the native input boundary is recorded', async t => {
  const f = await fixture(t);
  f.ra.emit('nativeInput', 'The new human task.', { id: 'native-human-input', turnId: f.ra.turnId });
  await f.call(); await f.finish(); assert.equal(f.writes.length, 1);
});

test('failed durable source storage never acknowledges staging or writes native input', async t => {
  const f = await fixture(t); f.source.persist = () => { f.source.storageWarning = 'Synthetic failed durable write'; };
  await assert.rejects(async () => f.call(), /保存/); assert.equal(f.writes.length, 0);
  assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'unconfirmed');
});

test('wake payload preserves the complete native argument including trailing whitespace', async t => {
  const f = await fixture(t), body = 'Original message.\n  ';
  await f.call(body); await f.finish(); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].text.endsWith(body), true);
});
test('same-backend human revocation keeps the cancelled original message readable', async t => {
  const f = await fixture(t); await f.call('Keep this exact cancelled message.');
  f.source.pauseAll('你暂停了后续交接');
  const row = f.source.get(f.a).messages.find(m => m.wake); assert.equal(row.wake.status, 'cancelled'); assert.ok(row.text.endsWith(row.wake.body));
});

test('native goals explicitly disabled permits ordinary wake without setting any goal state', async t => {
  const f = await fixture(t); f.rb.host.rpc.call = async method => { assert.equal(method, 'thread/goal/get'); throw Object.assign(Error('Goals disabled'), { nativeGoalsDisabled: true }); };
  await f.call(); await f.finish(); assert.equal(f.writes.length, 1);
});

test('Claude original-root getter and prompt provenance can stage the same cross-provider wake', async t => {
  const f = await fixture(t, 'claude'); await f.call(); await f.finish(); assert.equal(f.writes.length, 1);
});
test('a mismatched Claude root prompt cannot stage even with the current native turn ID', async t => {
  const f = await fixture(t, 'claude');
  await assert.rejects(async () => f.ra.addressedCall({ nativeId: f.source.get(f.a).nativeId, turnId: f.ra.turnId, promptId: 'another-prompt', callId: 'spoofed-prompt' }, { recipient_id: f.b, message: 'Must not send.' }), /回合|来源|prompt/);
  assert.equal(f.writes.length, 0);
});
test('a retained native call ID is never replayed under a later turn ID', async t => {
  const f = await fixture(t); await f.call('Retained original intent.', 'retained-native-call'); await f.finish('failed');
  f.start('later-native-turn');
  await assert.rejects(async () => f.call('Retained original intent.', 'retained-native-call'), /调用|登记|重发/);
  assert.equal(f.writes.length, 0);
});

test('observation failure cancels a staged intent before any later completion', async t => {
  const f = await fixture(t); await f.call(); f.ra.emit('failed', 'Synthetic observation loss');
  assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'cancelled');
  assert.notEqual((await f.call()).status, 'staged'); await f.finish(); assert.equal(f.writes.length, 0);
});
test('automatic owner restoration does not reset the receiving wake budget', async t => {
  const f = await fixture(t), s = f.target.get(f.b); s.wakeHumanRevision = 4; s.wakeBudget = { streak: 3, humanRevision: 4 }; s.owner = null;
  f.target.claim(f.b, 'restored-view-owner'); assert.equal(s.wakeHumanRevision, 4);
});
test('failed revocation storage disables automatic messages without blocking the human send', async t => {
  const f = await fixture(t); await f.call();
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(Error('Synthetic disk full'), { code: 'ENOSPC' }); });
  assert.doesNotThrow(() => f.target.pauseAll('你暂停了后续交接'));
  await assert.doesNotReject(f.target.send(f.b, 'Human input still works.', 'target-owner'));
  assert.equal(f.writes.length, 1); assert.equal(f.writes[0].text, 'Human input still works.');
  assert.equal(require('../session-wake.cjs').snapshot(f.target).enabled, false);
  await f.finish(); assert.equal(f.writes.length, 1); assert.equal(f.target.get(f.b).owner, 'target-owner');
});
test('a non-file guard marker cannot block human controls or permit an automatic write', async t => {
  const f = await fixture(t); await f.call(); const marker = path.join(f.root, 'agent-wake-boundary');
  if (fs.existsSync(marker)) fs.unlinkSync(marker); fs.mkdirSync(marker);
  await assert.doesNotReject(f.target.send(f.b, 'Human control with an invalid marker.', 'target-owner'));
  assert.equal(f.writes.length, 1); assert.equal(require('../session-wake.cjs').snapshot(f.target).enabled, false);
  await f.finish(); assert.equal(f.writes.length, 1);
});
test('a person acting on the sender mid-turn withdraws that turn\'s later wake', async t => {
  // Review F1: the sender's owner/control/connection at turn start bound its wake authority.
  for (const act of ['claim', 'terminal-input']) {
    const f = await fixture(t);
    if (act === 'claim') f.source.claim(f.a, 'another-window');
    else { f.source.get(f.a).view = 'terminal'; f.ra.terminal = { alive: true, input() {} }; f.source.input(f.a, 'x', 'source-owner'); }
    await assert.rejects(async () => f.call(), /真人|授权|回合/, act);
    await f.finish(); assert.equal(f.writes.length, 0, act);
  }
});
test('a native control boundary without a person still lets the turn stage its wake', async t => {
  const f = await fixture(t); f.ra.emit('nativeControlBoundary', 'synthetic permission boundary');
  await f.call(); await f.finish();
  assert.equal(f.writes.filter(w => w.text.includes('Continue one bounded task.')).length, 1);
});
test('pointer hover over a terminal is not human input; a press still is', async t => {
  // Fullscreen Claude turns on any-event mouse tracking, so hovering sends motion reports.
  const f = await fixture(t); f.target.get(f.b).view = 'terminal'; const sent = []; f.rb.terminal = { alive: true, input: d => sent.push(d) };
  await f.call(); const control = f.target.get(f.b).controlRevision;
  f.target.input(f.b, '\x1b[<35;10;5M\x1b[<35;11;5M', 'target-owner');
  assert.equal(f.target.get(f.b).controlRevision, control, 'Hover does not count as a human operation');
  assert.equal(sent.length, 1, 'Hover still reaches the native program');
  await f.finish(); assert.equal(f.writes.filter(w => w.text.includes('Continue one bounded task.')).length, 1, 'A staged wake survives hovering over the receiver');
  const g = await fixture(t); g.target.get(g.b).view = 'terminal'; g.rb.terminal = { alive: true, input() {} };
  await g.call(); g.target.input(g.b, '\x1b[<0;10;5M', 'target-owner');
  assert.notEqual(g.target.get(g.b).controlRevision, control, 'A press is a human operation');
  await g.finish(); assert.equal(g.writes.filter(w => w.text.includes('Continue one bounded task.')).length, 0);
});
