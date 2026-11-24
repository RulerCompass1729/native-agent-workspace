const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { PeerRunner } = require('../peer-handoffs.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (count = 12) => { for (let i = 0; i < count; i++) await tick(); };
async function fixture(t, sourceProvider = 'codex', preflight = true, nativeSource = false, targetProvider = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-test-'));
  const key = 'backends/aaaaaaaaaaaaaaaaaaaa', dirs = [root, path.join(root, key)];
  fs.mkdirSync(dirs[1], { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(dirs[1]), 0o700);
  fs.writeFileSync(path.join(root, 'services.json'), JSON.stringify({ format: 1, active: '.', entries: ['.', key] }), { mode: 0o600 });
  const workspaces = [], runtimes = [], writes = [];
  for (let i = 0; i < 2; i++) {
    const w = new Workspace({ binaries: {}, close() {}, create(s) {
      const r = s.provider === 'claude' && i === 0 ? new (require('../adapters.cjs').Claude)(s, this, { attachOnly: true }) : nativeSource && i === 0 ? new (require('../adapters.cjs').Codex)(s, this) : new EventEmitter(); r.record = s; s.nativeId = 'native-' + s.id;
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
      if (method === 'initial') return { ...w.snapshot(), capabilities: ['agentWakeV1', ...(preflight ? ['agentWakePreflightV1'] : [])] };
      const wake = require('../session-wake.cjs');
      if (method === 'wakeCheck' && preflight) return wake.check(w, spec);
      if (method === 'wakeTake') return wake.take(w, spec);
      if (method === 'wakeReceive') return wake.receive(w, spec);
      throw Error('Unexpected method ' + method);
    } };
  };
  workspaces.forEach((w, i) => { w.peerRunner = new PeerRunner(w, dirs[i], connect); });
  t.after(() => { workspaces.forEach(w => w.close()); fs.rmSync(root, { recursive: true, force: true }); });
  const a = await workspaces[0].create(sourceProvider, root, 'source-owner', 'Sender');
  const b = await workspaces[1].create(targetProvider, root, 'target-owner', 'Receiver');
  const [source, target] = workspaces, [ra, rb] = runtimes;
  const start = id => { if (nativeSource) return ra.event({ method: 'turn/started', params: { threadId: source.get(a).nativeId, turn: { id } } }); if (sourceProvider === 'claude') ra.liveTurn = { id, promptId: 'native-prompt-' + id }; else ra.turnId = id; ra.emit('nativeTurnStart', { nativeId: source.get(a).nativeId, turnId: id }); ra.emit('state', 'working'); };
  start('turn-one');
  const call = (text = 'Continue one bounded task.', callId = 'call-one') => ra.addressedCall({ nativeId: source.get(a).nativeId, turnId: ra.turnId, ...(sourceProvider === 'claude' ? { promptId: ra.liveTurn.promptId } : {}), callId }, { recipient_id: b, message: text });
  const finish = async (status = 'completed') => { const turnId = ra.turnId; if (sourceProvider === 'claude') ra.liveTurn = null; else ra.turnId = null; ra.emit('state', 'idle'); ra.emit('nativeTurnEnd', { nativeId: source.get(a).nativeId, turnId, status }); for (let i = 0; i < 8; i++) await tick(); };
  return { root, source, target, a, b, ra, rb, call, finish, start, writes };
}
async function runTurn(f, senderId, recipientId, turnId, text, status = 'completed') {
  const w = f.source.sessions.has(senderId) ? f.source : f.target;
  const s = w.get(senderId), r = w.runtimes.get(senderId);
  r.turnId = turnId; r.emit('nativeTurnStart', { nativeId: s.nativeId, turnId }); r.emit('state', 'working');
  const result = await r.addressedCall({ nativeId: s.nativeId, turnId, callId: 'call-' + turnId }, { recipient_id: recipientId, message: text });
  r.turnId = null; r.emit('state', 'idle'); r.emit('nativeTurnEnd', { nativeId: s.nativeId, turnId, status });
  await settle();
  return result;
}
function replyTo(f, id) {
  const r = id === f.b ? f.rb : id === f.a ? f.ra : f.source.runtimes.get(id);
  const tag = f.writes.at(-1).tag;
  r.emit('state', 'idle');
  r.emit('complete', { tag, text: 'An ordinary reply.', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false });
}
test('a blocked original recipient reports not-sent in the calling turn, with no goal write or later dispatch', async t => {
  const f = await fixture(t), nativeId = f.target.get(f.b).nativeId;
  const goal = { threadId: nativeId, status: 'blocked', objective: 'PRIVATE preserved goal', tokenBudget: 91 };
  const before = structuredClone(goal), methods = [];
  f.target.setDraft(f.b, 'UNSENT original receiver draft', 'target-owner');
  f.rb.host.rpc.call = async (method, args) => { methods.push(method); assert.equal(method, 'thread/goal/get'); assert.equal(args.threadId, nativeId); return { goal }; };
  const body = 'RAW task 中文\n  Preserve this body exactly.  ', result = await f.call(body);
  assert.equal(result.status, 'not-sent');
  assert.match(result.message, /blocked/); assert.deepEqual(methods, ['thread/goal/get']);
  const row = f.source.get(f.a).messages.find(m => m.wake);
  assert.equal(row.wake.status, 'not-sent'); assert.equal(row.wake.body, body);
  assert.equal((await f.call(body)).status, 'not-sent');
  await f.finish(); assert.deepEqual(f.writes, []); assert.deepEqual(goal, before);
  assert.deepEqual(methods, ['thread/goal/get']); assert.equal(f.target.get(f.b).wakeBudget, undefined);
  assert.equal(f.target.drafts.get(f.b), 'UNSENT original receiver draft');
  assert.equal(f.target.get(f.b).nativeId, nativeId); assert.equal(f.target.get(f.b).owner, 'target-owner');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE preserved goal|tokenBudget/);
});
test('a recipient blocked after readiness was checked is definitively not-sent, not an uncertain dispatch', async t => {
  const f = await fixture(t), goal = { threadId: f.target.get(f.b).nativeId, status: 'active' };
  f.rb.host.rpc.call = async () => ({ goal });
  const result = await f.call('Keep the exact pending body.'); assert.equal(result.status, 'staged');
  goal.status = 'blocked'; await f.finish();
  assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'not-sent');
  assert.deepEqual(f.writes, []); assert.equal(goal.status, 'blocked');
});
test('human takeover during the immediate readiness check prevents staging a send', async t => {
  const f = await fixture(t); let release;
  f.rb.host.rpc.call = () => new Promise(resolve => { release = resolve; });
  const pending = f.call();
  for (let i = 0; i < 8 && !release; i++) await tick();
  assert.equal(typeof release, 'function');
  f.target.claim(f.b, 'new-human-owner'); release({ goal: null });
  const result = await pending; assert.equal(result.status, 'not-sent');
  assert.equal(f.target.get(f.b).owner, 'new-human-owner');
  await f.finish(); assert.deepEqual(f.writes, []);
});
test('a native dispatch whose acknowledgement is lost stays unconfirmed and is never retried', async t => {
  const f = await fixture(t); let sends = 0;
  f.rb.send = async () => { sends++; throw Error('Native acknowledgement was lost after input'); };
  await f.call(); await f.finish();
  assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'unconfirmed');
  assert.equal(sends, 1); await f.finish(); assert.equal(sends, 1);
});
test('an older recipient without readiness capability retains its guarded deferred delivery', async t => {
  const f = await fixture(t, 'codex', false), result = await f.call();
  assert.equal(result.status, 'staged'); assert.equal(result.readiness, 'deferred');
  await f.finish(); assert.equal(f.writes.length, 1);
});
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

test('legacy wake display changes language through registration, acceptance and cold restore while the one native payload stays exact', async t => {
  const locale = require('../ui-locale.js'), f = await fixture(t, 'codex', false), body = 'RAW native message 中文\n  ';
  await f.call(body); const row = f.source.get(f.a).messages.find(m => m.wake), intent = row.wake;
  assert.equal(locale.displayText('en', row.text, row.uiMessage), 'Message to Receiver registered; not yet delivered.\n' + body);
  assert.equal(locale.displayText('en', row.name, row.uiNameMessage), 'Automatic message');
  const expected = `[Workspace message from ${intent.senderName} · ${intent.senderId} at ${new Date(intent.time).toISOString()}]\n${body}`;
  await f.finish(); assert.equal(f.writes.length, 1); assert.equal(f.writes[0].text, expected);
  assert.equal(locale.displayText('en', row.text, row.uiMessage), 'Automatic message to the original session: accepted by the native process.\n' + body);
  f.start('later'); await f.call('RAW staged body 中文', 'later-call'); f.source.persist();
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  const restored = reopened.get(f.a).messages.findLast(m => m.wake);
  assert.equal(locale.displayText('en', restored.text, restored.uiMessage), 'Delivery of the earlier automatic message is unconfirmed; it will not be resent.\nRAW staged body 中文');
  assert.equal(restored.wake.status, 'unconfirmed'); assert.equal(f.writes.length, 1);
});

test('failed wake display retains unknown and oversized upstream reasons without changing one-shot failure state', async t => {
  const locale = require('../ui-locale.js');
  for (const reason of ['RAW upstream 中文 <failure>', 'LONG'.repeat(4100)]) {
    const f = await fixture(t), body = 'RAW body 中文\n  '; await f.call(body);
    f.source.peerRunner.transferWake = async () => { throw Error(reason); }; await f.finish();
    const row = f.source.get(f.a).messages.find(m => m.wake);
    assert.equal(row.text, '自动消息未确认投递；不会重发。\n' + reason + '\n' + body);
    assert.equal(row.wake.status, 'unconfirmed'); assert.equal(f.writes.length, 0);
    assert.equal(locale.displayText('en', row.text, row.uiMessage), reason.length <= 16000 ? 'Automatic message delivery is unconfirmed; it will not be retried.\n' + reason + '\n' + body : row.text);
    if (reason.length > 16000) assert.equal(row.uiMessage, undefined);
  }
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
test('a person acting on the receiver still cancels that wake; the person\'s input into the sender does not', async t => {
  for (const act of ['sender-input', 'receiver-send', 'receiver-native-input']) {
    const f = await fixture(t); await f.call();
    if (act === 'sender-input') f.ra.emit('nativeInput', 'The person types into the sender', { id: 'sender-native-input' });
    else if (act === 'receiver-send') await f.target.send(f.b, 'The person talks to the receiver.', 'target-owner');
    else f.rb.emit('nativeInput', 'The person types into the receiver', { id: 'receiver-native-input' });
    await f.finish();
    const delivered = act === 'sender-input';
    assert.equal(f.writes.filter(w => w.text.includes('Continue one bounded task.')).length, delivered ? 1 : 0, act);
    assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status === 'submitted', delivered, act);
  }
});
test('a sender boundary that cancels a staged wake names its reason in the record', async t => {
  // T-100: the 11-02 secretary wake was cancelled with no trace of which boundary did it.
  const f = await fixture(t, 'claude'); assert.equal((await f.call()).status, 'staged');
  f.ra.emit('state', 'approval');
  const row = f.source.get(f.a).messages.find(m => m.wake);
  assert.equal(row.wake.status, 'cancelled');
  assert.match(row.text, /^原生观察或控制边界已变化（等待原生权限确认）；自动消息未投递。/);
  assert.equal(require('../ui-locale.js').displayText('en', row.text, row.uiMessage), `The native observation or control boundary changed (Waiting for native permission approval); the automatic message was not delivered.\n${row.wake.body}`);
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
test('a refused wake says why: working, waiting, turned off, or just sent one (wake proposal, item 4)', async t => {
  // 2026-11-12 16:25: a message to a session mid-turn was refused under one sentence that also covered a changed
  // identity, the switch and the limit; nobody could tell it was only busy.
  const locale = require('../ui-locale.js');
  const cases = [
    // Working, with no native way into its turn (this Codex fixture cannot steer): item 1 opens the others.
    ['working', f => { f.target.get(f.b).state = 'working'; }, 'Receiver 正在干活。', 'Receiver is working.'],
    ['waiting', f => { f.rb.nativeInputRequired = true; }, '收件方在等批准或等原生输入。', 'The recipient is waiting for an approval or native input.'],
    ['off', f => { f.target.get(f.b).wakeDisabled = true; }, '收件方或全部会话关了自动消息。', 'Automatic messages are turned off for the recipient or for all sessions.'],
    ['queued', f => { f.rb.pendingQueue = 'tag'; }, '收件方已有一条输入在投递或排队。', 'The recipient already has input being delivered or queued.'],
    ['cooldown', f => { const s = f.target.get(f.b); s.wakeBudget = { version: 2, lastAt: Date.now(), humanRevision: s.wakeHumanRevision || 0, senders: { [f.source.get(f.a).nativeId]: { id: 'earlier', streak: 1 } } }; }, '收件方刚收过自动消息：两条至少隔 60 秒，连续最多 3 条。', 'The recipient just received an automatic message: at least 60 seconds apart, at most 3 in a row.'],
  ];
  for (const [label, set, zh, en] of cases) {
    for (const when of ['registering', 'delivering']) {
      const f = await fixture(t);
      if (when === 'registering') set(f);
      const result = await f.call('Exact body.');
      if (when === 'delivering') { assert.equal(result.status, 'staged', label); set(f); await f.finish(); }
      const row = f.source.get(f.a).messages.find(m => m.wake);
      assert.equal(row.wake.status, 'not-sent', `${label} ${when}`);
      assert.equal(row.text, `自动消息没有发出；不会自动重发。\n${zh}\nExact body.`, `${label} ${when}`);
      assert.equal(locale.displayText('en', row.text, row.uiMessage), `Automatic message was not sent; it will not be retried automatically.\n${en}\nExact body.`, `${label} ${when}`);
      assert.equal(f.writes.length, 0);
    }
  }
});
// 2026-11-12 16:25, and the person: 「别忘了 agent 在干活的时候是可以发送消息的,所以你没法发其实有问题」. A session
// mid-turn takes an automatic message the way it takes the person's own input there.
function midturnTarget(f, provider) {
  const s = f.target.get(f.b), calls = [];
  s.state = 'working';
  let settle;
  const answer = () => new Promise((resolve, reject) => { settle = { resolve, reject }; });
  if (provider === 'claude') {
    Object.assign(f.rb, { queueAvailable: true, midturnAvailable: true });
    f.rb.queue = (text, tag, guard) => { calls.push({ text, tag, guard, slot: f.rb.pendingQueue }); return answer(); };
  } else {
    Object.assign(f.rb, { steerAvailable: true, turnId: 'recipient-turn', finished: [] });
    f.rb.finishTurn = id => f.rb.finished.push(id);
    f.rb.steer = (text, tag, turnId, guard) => { calls.push({ text, tag, turnId, guard, slot: f.rb.pendingSteer }); return answer(); };
  }
  return { s, calls, settle: () => settle };
}
test('an automatic message to a Claude session mid-turn goes into its native queue and is read in that turn (wake proposal, item 1)', async t => {
  const f = await fixture(t, 'codex', true, false, 'claude'), m = midturnTarget(f, 'claude');
  f.target.setDraft(f.b, 'The person is typing here', 'target-owner');
  const before = { owner: m.s.owner, control: m.s.controlRevision, peer: m.s.peerRevision || 0, human: m.s.wakeHumanRevision || 0 };
  const staged = await f.call('Merged; please rebase.');
  assert.equal(staged.status, 'staged'); assert.equal(staged.readiness, 'checked');
  await f.finish();
  assert.equal(m.calls.length, 1, 'one queued input, no send');
  assert.match(m.calls[0].text, /^\[Workspace message from Sender · .+\]\nMerged; please rebase\.$/);
  assert.equal(m.calls[0].slot, m.calls[0].tag, 'it holds the native queue slot');
  assert.equal(m.calls[0].guard(), true);
  const sender = f.source.get(f.a).messages.find(x => x.wake);
  assert.equal(sender.wake.status, 'consumed', 'waiting for the turn to take it is neither sent nor failed');
  const row = m.s.messages.find(x => x.id === m.calls[0].tag);
  assert.equal(row.origin, 'agent-wake'); assert.equal(row.name, '来自 Sender'); assert.equal(row.inputMode, 'queue'); assert.equal(row.midturn, true); assert.equal(row.status, 'awaiting-native');
  m.settle().resolve({ mode: 'append', uuid: '00000000-0000-4000-8000-000000000001', turnId: 'recipient-turn' });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(sender.wake.status, 'submitted'); assert.equal(sender.text, '发给原会话的自动消息：原生已接收。\nMerged; please rebase.');
  assert.equal(row.status, 'submitted'); assert.equal(row.deliveredInto, 'recipient-turn');
  assert.equal(f.rb.pendingQueue, null);
  // Not the person: the receiver keeps its owner, draft and control, and its loop guard counts this one.
  assert.deepEqual({ owner: m.s.owner, control: m.s.controlRevision, peer: m.s.peerRevision || 0, human: m.s.wakeHumanRevision || 0 }, before);
  assert.equal(f.target.drafts.get(f.b), 'The person is typing here');
  assert.equal(m.s.wakeBudget.senders[f.source.get(f.a).nativeId].streak, 1); assert.equal(f.writes.length, 0);
});
test('a queued automatic message the person overtakes before native holds it is not sent, and says so (wake proposal, item 1)', async t => {
  const f = await fixture(t, 'codex', true, false, 'claude'), m = midturnTarget(f, 'claude');
  await f.call('Please look at the failing test.'); await f.finish();
  assert.equal(m.calls.length, 1);
  f.target.claim(f.b, 'new-human-owner');
  assert.equal(m.calls[0].guard(), false, 'the takeover withdraws it at the next native step');
  m.settle().reject(Object.assign(Error('held message withdrawn'), { notSent: true }));
  for (let i = 0; i < 8; i++) await tick();
  const sender = f.source.get(f.a).messages.find(x => x.wake);
  assert.equal(sender.wake.status, 'not-sent'); assert.match(sender.text, /^自动消息没有发出；不会自动重发。\nheld message withdrawn\n/);
  assert.equal(m.s.messages.find(x => x.id === m.calls[0].tag).status, 'not-sent');
  assert.equal(f.rb.pendingQueue, null);
});
test('an automatic message to a Codex session mid-turn steers its running turn (wake proposal, item 1)', async t => {
  const f = await fixture(t), m = midturnTarget(f, 'codex');
  await f.call('Your branch is merged.'); await f.finish();
  assert.equal(m.calls.length, 1); assert.equal(m.calls[0].turnId, 'recipient-turn'); assert.equal(m.calls[0].slot, m.calls[0].tag);
  assert.equal(m.calls[0].guard(), true);
  f.rb.turnId = 'a-later-turn';
  assert.equal(m.calls[0].guard(), false, 'a steer is for the turn it named');
  f.rb.turnId = 'recipient-turn';
  m.settle().resolve('recipient-turn');
  for (let i = 0; i < 8; i++) await tick();
  const sender = f.source.get(f.a).messages.find(x => x.wake), row = m.s.messages.find(x => x.id === m.calls[0].tag);
  assert.equal(sender.wake.status, 'submitted');
  assert.equal(row.inputMode, 'steer'); assert.equal(row.turnId, 'recipient-turn'); assert.equal(row.status, 'submitted'); assert.equal(row.origin, 'agent-wake');
  assert.equal(f.rb.pendingSteer, null); assert.deepEqual(f.rb.finished, ['recipient-turn'], 'a completion held behind the steer drains');
  assert.equal(f.writes.length, 0);
});
// Review of item 1, B1: a turn answering a space keeps showing there until private input arrives. The automatic
// message is for the recipient only, so what follows it stays in the recipient's own conversation.
test('an automatic message entering a turn that answers a space ends that sharing, as private input does (wake proposal, item 1)', async t => {
  for (const provider of ['claude', 'codex']) {
    const f = await fixture(t, 'codex', true, false, provider), m = midturnTarget(f, provider), replies = f.target.sharedReplies;
    const c = await f.target.create('codex', f.root, 'target-owner', 'Bystander'), other = f.target.get(c);
    f.target.join(f.b, true); f.target.join(c, true);
    replies.authorize(m.s, f.rb, 'space-reply', { id: 'space-row', inputMode: 'send' }, null, 'shared');
    replies.authorize(other, f.target.runtimes.get(c), 'elsewhere', { id: 'other-row', inputMode: 'send' }, null, 'shared');
    assert.equal(replies.valid(replies.grants.get('space-reply')), true, `${provider}: the turn answers the space`);
    assert.equal(replies.valid(replies.grants.get('elsewhere')), true);
    const control = m.s.controlRevision;
    await f.call('Private note.'); await f.finish();
    assert.equal(m.calls.length, 1, provider);
    assert.equal(replies.grants.get('space-reply').closed, true, `${provider}: the rest of the turn stays in the session`);
    assert.equal(replies.grants.get('elsewhere').closed, false, `${provider}: another session's sharing is untouched`);
    assert.equal(m.s.controlRevision, control, `${provider}: not the person's control`);
    assert.equal(m.calls[0].guard(), true, `${provider}: its own authority still holds`);
  }
});
test('an automatic message refused before it reaches native leaves the space sharing open (wake proposal, item 1)', async t => {
  const f = await fixture(t, 'codex', true, false, 'claude'), m = midturnTarget(f, 'claude'), replies = f.target.sharedReplies;
  f.target.join(f.b, true);
  replies.authorize(m.s, f.rb, 'space-reply', { id: 'space-row', inputMode: 'send' }, null, 'shared');
  await f.call('Exact body.');
  f.rb.pendingQueue = 'the person queued one'; await f.finish();
  assert.equal(m.calls.length, 0);
  assert.equal(replies.valid(replies.grants.get('space-reply')), true);
});
test('mid-turn, a recipient waiting for approval or already holding a queued input still refuses, with its reason (wake proposal, item 1)', async t => {
  const cases = [
    ['claude', f => { f.rb.pendingQueue = 'the person queued one'; }, '收件方已有一条输入在投递或排队。'],
    ['claude', f => { f.rb.nativeInputRequired = true; }, '收件方在等批准或等原生输入。'],
    ['claude', f => { f.rb.queueAvailable = false; }, 'Receiver 正在干活。'],
    ['codex', f => { f.rb.pendingSteer = 'the person steered'; }, '收件方已有一条输入在投递或排队。'],
  ];
  for (const [provider, set, zh] of cases) for (const when of ['registering', 'delivering']) {
    const f = await fixture(t, 'codex', true, false, provider), m = midturnTarget(f, provider);
    if (when === 'registering') set(f);
    const result = await f.call('Exact body.');
    if (when === 'delivering') { assert.equal(result.status, 'staged'); set(f); await f.finish(); }
    const row = f.source.get(f.a).messages.find(x => x.wake);
    assert.equal(row.text, `自动消息没有发出；不会自动重发。\n${zh}\nExact body.`, `${provider} ${when} ${zh}`);
    assert.equal(m.calls.length, 0); assert.equal(f.writes.length, 0);
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
test('the same receiver budget is per sender, so unrelated senders do not exhaust it', async t => {
  const oldNow = Date.now; let now = oldNow(); Date.now = () => now; t.after(() => { Date.now = oldNow; });
  const f = await fixture(t), senders = [f.a];
  for (const name of ['Sender two', 'Sender three', 'Sender four']) senders.push(await f.source.create('codex', f.root, 'source-owner', name));
  for (const [i, senderId] of senders.entries()) {
    if (i) now += 60001;
    assert.equal((await runTurn(f, senderId, f.b, `unrelated-${i}`, `From sender ${i + 1}.`)).status, 'staged');
    await settle();
    assert.equal(f.writes.length, i + 1);
    replyTo(f, f.b);
  }
  const budget = f.target.get(f.b).wakeBudget;
  assert.equal(budget.version, 2);
  assert.deepEqual(senders.map(id => budget.senders[f.source.get(id).nativeId].streak), [1, 1, 1, 1]);
});
test('a three-agent ring still stops each directed edge after three rounds', async t => {
  const oldNow = Date.now; let now = oldNow(); Date.now = () => now; t.after(() => { Date.now = oldNow; });
  const f = await fixture(t), c = await f.source.create('codex', f.root, 'source-owner', 'Sender three'), cycle = [[f.a, f.b], [f.b, c], [c, f.a]];
  let sent = 0;
  for (let round = 0; round < 3; round++) for (const [from, to] of cycle) {
    if (sent++) now += 60001;
    assert.equal((await runTurn(f, from, to, `ring-${round}-${sent}`, `Round ${round + 1}.`)).status, 'staged');
    await settle();
    assert.equal(f.writes.length, sent);
    replyTo(f, to);
  }
  now += 60001;
  const refused = await runTurn(f, f.a, f.b, 'ring-fourth', 'Too many.');
  assert.equal(refused.status, 'not-sent');
  assert.equal(f.writes.length, 9);
  assert.equal(f.target.get(f.b).wakeBudget.senders[f.source.get(f.a).nativeId].streak, 3);
});
test('legacy flat wake budget ignores its streak but keeps the receiver cooldown', async t => {
  const oldNow = Date.now; let now = oldNow(); Date.now = () => now; t.after(() => { Date.now = oldNow; });
  const wake = require('../session-wake.cjs'), f = await fixture(t), s = f.target.get(f.b);
  s.wakeBudget = { id: 'legacy', lastAt: now, streak: 3, humanRevision: s.wakeHumanRevision || 0 };
  const oldPreflight = await wake.check(f.target, { id: 'legacy-check', recipientId: f.b, boundary: wake.boundary(f.target), targetProof: require('../peer-handoffs.cjs').identity(s) });
  assert.equal(oldPreflight.status, 'not-sent');
  assert.notEqual(oldPreflight.reasonUiMessage?.key, 'error.wake.sourceInvalid');
  f.start('legacy-one');
  assert.equal((await f.call('Cooldown still applies.', 'legacy-one')).status, 'not-sent');
  await f.finish();
  now += 60001; f.start('legacy-two');
  assert.equal((await f.call('Legacy streak is ignored.', 'legacy-two')).status, 'staged');
  await f.finish();
  assert.equal(f.writes.length, 1);
  assert.equal(s.wakeBudget.version, 2);
  assert.equal(s.wakeBudget.senders[f.source.get(f.a).nativeId].streak, 1);
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
  const f = await fixture(t), s = f.target.get(f.b); s.wakeHumanRevision = 4;
  s.wakeBudget = { version: 2, lastAt: 1, humanRevision: 4, senders: { [f.source.get(f.a).nativeId]: { id: 'earlier', streak: 3 } } }; s.owner = null;
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
test('a takeover of the sender mid-turn withdraws that turn\'s later wake; one unsent key does not', async t => {
  // Review F1: the sender's owner/control/connection at turn start bound its wake authority.
  for (const act of ['claim', 'terminal-input']) {
    const f = await fixture(t);
    if (act === 'claim') f.source.claim(f.a, 'another-window');
    else { f.source.get(f.a).view = 'terminal'; f.ra.terminal = { alive: true, input() {} }; f.source.input(f.a, 'x', 'source-owner'); }
    if (act === 'claim') await assert.rejects(async () => f.call(), /真人|授权|回合/, act);
    else assert.equal((await f.call()).status, 'staged', act);
    await f.finish(); assert.equal(f.writes.length, act === 'claim' ? 0 : 1, act);
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

for (const side of ['source', 'target']) test(`terminal-generated mode reports preserve a staged wake at the ${side}`, async t => {
  const f = await fixture(t), w = f[side], id = side === 'source' ? f.a : f.b;
  const r = side === 'source' ? f.ra : f.rb, owner = w.get(id).owner, inputs = [];
  w.get(id).view = 'terminal'; r.terminal = { alive: true, input: data => inputs.push(data) };
  const draft = 'Unsent human draft'; w.setDraft(id, draft, owner);
  await f.call();
  const { Terminal } = require('@xterm/headless'), screen = new Terminal({ allowProposedApi: true });
  t.after(() => screen.dispose());
  // Actual replies generated by the same parser as the observing terminal.
  screen.onData(data => w.input(id, data, owner));
  await new Promise(resolve => screen.write('\x1b[?2026$p\x1b[?2004$p', resolve));
  assert.deepEqual(inputs, ['\x1b[?2026;2$y', '\x1b[?2004;2$y']);
  await f.finish();
  assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'submitted');
  assert.equal(f.writes.length, 1); assert.equal(w.drafts.get(id), draft);
  assert.equal(w.get(id).terminalInputPending, false);
});

for (const data of ['x', '\x1b[?2026;2$yx', '\x1b[?2026;9$y', '\x1b[<0;10;5M']) test(`human input into the sender's terminal keeps the staged wake: ${JSON.stringify(data)}`, async t => {
  const f = await fixture(t); f.source.get(f.a).view = 'terminal';
  f.ra.terminal = { alive: true, input() {} }; await f.call();
  const control = f.source.get(f.a).controlRevision;
  f.source.input(f.a, data, 'source-owner'); await f.finish();
  assert.equal(f.source.get(f.a).controlRevision, control + 1, 'still a human operation for every other scope');
  const row = f.source.get(f.a).messages.find(m => m.wake);
  assert.equal(row.wake.status, 'submitted'); assert.equal(f.writes.length, 1);
});
for (const [name, data] of [['Esc', '\x1b'], ['Ctrl-C', '\x03'], ['Ctrl-C inside typed text', 'x\x03']]) test(`${name} in the sender's terminal still withdraws the staged wake`, async t => {
  const f = await fixture(t); f.source.get(f.a).view = 'terminal';
  f.ra.terminal = { alive: true, input() {} }; await f.call();
  f.source.input(f.a, data, 'source-owner'); await f.finish();
  const row = f.source.get(f.a).messages.find(m => m.wake);
  assert.equal(row.wake.status, 'cancelled'); assert.equal(f.writes.length, 0);
  assert.deepEqual(row.wake.cancellation.fields, ['controlRevision']);
  assert.equal(row.wake.cancellation.nativeStatus, 'completed');
  assert.equal(row.wake.cancellation.code, 'source-identity-changed');
  assert.match(row.text, /已正常结束/);
});

test('the real Codex adapter completes the staged turn before a queued next turn starts', async t => {
  const f = await fixture(t, 'codex', true, true), nativeId = f.source.get(f.a).nativeId;
  await f.call(); const row = f.source.get(f.a).messages.find(m => m.wake), ends = [];
  f.ra.on('nativeTurnEnd', info => ends.push(info));
  f.ra.event({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'turn-one', status: 'completed' } } });
  assert.equal(row.wake.status, 'sending');
  f.start('queued-turn');
  assert.deepEqual(ends.map(info => [info.turnId, info.status]), [['turn-one', 'completed']]);
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(row.wake.status, 'submitted'); assert.equal(f.writes.length, 1);
  assert.equal(f.ra.turnId, 'queued-turn');
  assert.equal(f.source.get(f.a).state, 'working');
});

test('next-turn native input does not revoke a transfer waiting to consume its credential', async t => {
  const f = await fixture(t, 'codex', true, true), nativeId = f.source.get(f.a).nativeId;
  await f.call(); const row = f.source.get(f.a).messages.find(m => m.wake);
  f.ra.event({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'turn-one', status: 'completed' } } });
  f.start('queued-turn');
  f.ra.event({ method: 'item/completed', params: { threadId: nativeId, turnId: 'queued-turn', item: { id: 'new-input', type: 'userMessage', content: [{ type: 'text', text: 'A new instruction' }] } } });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(f.writes.length, 1); assert.equal(row.wake.status, 'submitted');
  assert.equal(f.ra.turnId, 'queued-turn');
});

// T-137: a resident wake is also recorded in the spaces its sender and recipient share, written once by
// the sender's backend; status and reason are read from the sender's own wake record when shown.
const wakeRows = w => w.snapshot().rooms.flatMap(room => room.messages.filter(m => m.wake).map(m => ({ room: room.id, ...m })));
async function joined(t, sender, receiver, provider) {
  const f = await fixture(t, provider);
  // roomId must agree with roomIds: it is 'shared' exactly when the session is in the default space.
  const join = (s, ids) => { s.roomIds = ids; s.roomId = ids.includes('shared') ? 'shared' : null; };
  if (sender) join(f.source.get(f.a), sender); if (receiver) join(f.target.get(f.b), receiver);
  return f;
}
test('a known unsent wake remains a complete space record with its exact body and reason', async t => {
  const f = await joined(t, ['shared'], ['shared']), body = 'Original handoff 中文\n  exact text  ';
  f.rb.host.rpc.call = async () => ({ goal: { threadId: f.target.get(f.b).nativeId, status: 'blocked' } });
  assert.equal((await f.call(body)).status, 'not-sent');
  const [row] = wakeRows(f.source);
  assert.equal(row.wakeStatus, 'not-sent'); assert.match(row.text, /blocked/); assert.ok(row.text.endsWith(body));
  assert.equal(require('../collaboration-spaces.cjs').completedSharedRecord(row), true);
  await f.finish(); assert.deepEqual(f.writes, []);
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  const [restored] = wakeRows(reopened);
  assert.equal(restored.wakeStatus, 'not-sent'); assert.equal(restored.text, row.text);
});
test('a wake appears in the shared space with its live status, written only by the sender\'s backend (T-137)', async t => {
  const f = await joined(t, ['shared'], ['shared']);
  assert.equal((await f.call()).status, 'staged');
  let rows = wakeRows(f.source);
  assert.equal(rows.length, 1); assert.equal(rows[0].room, 'shared'); assert.equal(rows[0].name, 'Sender → Receiver');
  assert.equal(rows[0].role, 'system'); assert.equal(rows[0].wakeStatus, 'staged'); assert.match(rows[0].text, /已登记，尚未投递。\nContinue one bounded task\.$/);
  for (const key of ['finalReply', 'sourceTag', 'sessionId', 'sharedStream', 'deliveryTracked']) assert.equal(rows[0][key], undefined, key);
  assert.deepEqual(wakeRows(f.target), [], 'the receiver\'s backend writes no second copy');
  await f.finish();
  rows = wakeRows(f.source);
  assert.equal(rows[0].wakeStatus, 'submitted'); assert.match(rows[0].text, /原生已接收/);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json')));
  assert.equal(saved.room.messages.filter(m => m.wake).length, 1, 'kept with the space\'s record');
  f.source.clearSharedHistory('shared');
  assert.deepEqual(wakeRows(f.source), [], 'clearing the space\'s shared history removes it');
});
test('a cancelled wake shows its reason in the space (T-137)', async t => {
  const f = await joined(t, ['shared'], ['shared'], 'claude');
  assert.equal((await f.call()).status, 'staged');
  f.ra.emit('state', 'approval');
  const [row] = wakeRows(f.source);
  assert.equal(row.wakeStatus, 'cancelled'); assert.match(row.text, /等待原生权限确认/);
});
test('with no shared space the wake goes to the sender\'s own spaces, and nowhere if it has none (T-137)', async t => {
  const own = await joined(t, ['shared'], []);
  await own.call(); assert.deepEqual(wakeRows(own.source).map(r => r.room), ['shared']);
  const none = await joined(t, [], ['shared']);
  await none.call(); assert.deepEqual(wakeRows(none.source), []);
  assert.equal(none.source.get(none.a).messages.filter(m => m.wake).length, 1, 'the sender\'s own record stays');
});
const spaceX = '11111111-2222-4333-8444-555555555555', spaceY = '66666666-7777-4888-9999-aaaaaaaaaaaa';
test('a wake goes only to the spaces both agents share, one row per space (T-137)', async t => {
  const f = await joined(t, ['shared', spaceX, spaceY], [spaceX, spaceY]);
  f.source.roomFor(spaceX, true); f.source.roomFor(spaceY, true);
  assert.equal((await f.call()).status, 'staged');
  const rows = wakeRows(f.source);
  assert.deepEqual(rows.map(r => r.room).sort(), [spaceX, spaceY].sort(), 'not the sender\'s other space');
  assert.notEqual(rows[0].id, rows[1].id);
  assert.deepEqual(rows.map(r => [r.wake.senderId, r.wake.recipientId]), [[f.a, f.b], [f.a, f.b]], 'participant IDs for filters and current labels');
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'room-records.json')));
  assert.equal(saved.rooms.flatMap(r => r.messages).filter(m => m.wake).length, 2, 'other spaces keep theirs in room-records.json');
});
test('a removed sender record and a reopened backend never show a stale state (T-137)', async t => {
  const f = await joined(t, ['shared'], ['shared']);
  assert.equal((await f.call()).status, 'staged');
  const { Workspace } = require('../workspace.cjs');
  f.source.close();
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root); t.after(() => reopened.close());
  const [again] = wakeRows(reopened);
  assert.equal(again.wakeStatus, 'unconfirmed', 'a wake staged before the reopen is unconfirmed, as the sender\'s own row is');
  assert.match(again.text, /未确认/);
  reopened.sessions.delete(f.a);
  const [gone] = wakeRows(reopened);
  assert.equal(gone.wakeStatus, 'unknown'); assert.match(gone.text, /^无法核对发送方的原消息，投递结果未确认。\nContinue one bounded task\.$/);
  assert.equal(require('../ui-locale.js').displayText('en', gone.text, gone.uiMessage), "The sender's original message could not be verified; delivery is unconfirmed.\nContinue one bounded task.");
});
test('only a wake row with a final state counts as complete for a space merge (T-137)', async t => {
  const { completedSharedRecord } = require('../collaboration-spaces.cjs');
  const f = await joined(t, ['shared'], ['shared']);
  await f.call(); assert.equal(completedSharedRecord(wakeRows(f.source)[0]), false, 'staged');
  await f.finish(); assert.equal(completedSharedRecord(wakeRows(f.source)[0]), true, 'submitted');
  assert.equal(completedSharedRecord({ ...wakeRows(f.source)[0], wakeStatus: undefined }), false, 'a raw stored row has no derived state');
});
test('the combined view of both backends shows the wake once (T-137)', async t => {
  const { WorkspaceClient } = require('../workspace-client.cjs');
  const f = await joined(t, ['shared'], ['shared']);
  await f.call(); await f.finish();
  const entry = (key, w) => { const client = new EventEmitter(); client.call = async method => { if (method === 'initial') return { ...w.snapshot(), capabilities: ['agentWakeV1', 'collaborationSpacesV1'] }; throw Error('Unexpected ' + method); }; client.close = () => client.emit('closed'); return { key, client, state: { ...w.snapshot(), capabilities: ['agentWakeV1', 'collaborationSpacesV1'] } }; };
  const c = new WorkspaceClient([entry('.', f.source), entry('backends/aaaaaaaaaaaaaaaaaaaa', f.target)], '.', Symbol()); t.after(() => c.close());
  const state = await c.call('initial');
  const rows = [state.room, ...(state.rooms || [])].filter(Boolean).flatMap(r => r.messages || []).filter(m => m.wake);
  assert.equal(new Set(rows.map(m => m.id)).size, 1, 'one wake, one row');
  assert.equal(rows[0].wakeStatus, 'submitted');
});
test('a cross-session message is not the person, and its input boundary does not void a staged wake (T-137)', async t => {
  const f = await fixture(t, 'claude'); assert.equal((await f.call()).status, 'staged');
  const before = [f.source.get(f.a).controlRevision, f.source.get(f.a).wakeHumanRevision || 0];
  f.ra.emit('nativeInput', '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="X">\nhi\n</cross-session-message>', { id: 'peer-input', source: 'naw-peer' });
  assert.deepEqual([f.source.get(f.a).controlRevision, f.source.get(f.a).wakeHumanRevision || 0], before, 'not a person acting on the sender');
  assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'staged');
  // The mod sends control:input for every foreign submission, a peer one included.
  const peer = f.source.get(f.a).peerRevision || 0;
  f.ra.emit('nativeControlBoundary', 'control:input');
  assert.equal(f.source.get(f.a).peerRevision, peer + 1, 'still a boundary for every other scope');
  await f.finish();
  assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'submitted');
  assert.equal(f.writes.length, 1);
});
test('a turn end reported as a boundary withdraws its staged wake and says why (T-141)', async t => {
  const f = await fixture(t, 'claude'); assert.equal((await f.call()).status, 'staged');
  await f.finish('boundary');
  const row = f.source.get(f.a).messages.find(m => m.wake);
  assert.equal(row.wake.status, 'cancelled');
  assert.match(row.text, /^发送方这一轮中途有新的输入或权限确认；自动消息未投递。/);
  assert.ok(require('../ui-locale.js').displayText('en', row.text, row.uiMessage).startsWith("New input or a permission request arrived during the sender's turn; the automatic message was not delivered.\n"));
  assert.equal(f.writes.length, 0);
});
test('an identical repeated Claude prompt neither withdraws nor reauthorizes a wake; a fresh turn can (T-141)', async t => {
    const f = await fixture(t, 'claude');
    const typed = () => f.ra.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.source.get(f.a).nativeId, prompt_id: f.ra.liveTurn.promptId, prompt: 'Continue one bounded task.' });
    typed(); // The first hook may arrive after native turn-start.
    typed(); // Native316/317 may reuse that same id/text for a mid-turn queued prompt.
    assert.equal((await f.call()).status, 'staged', 'a mid-turn prompt is ordinary input');
    f.source.claim(f.a, 'another-window');
    typed();
    await assert.rejects(async () => f.call('After the takeover.', 'second-call'), error => error.uiMessage?.key === 'error.wake.revokedByTakeover');
    await f.finish('boundary');
    assert.equal(f.writes.length, 0);
    f.start('fresh-turn');
    typed();
    assert.equal((await f.call('Continue the new authorized turn.', 'fresh-call')).status, 'staged');
    await f.finish();
    assert.equal(f.writes.length, 1, 'A genuinely new native turn still transfers once');
});
test('a first Claude prompt hook arriving after native turn-start still authorizes its wake (T-141)', async t => {
    const f = await fixture(t, 'claude');
    f.ra.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.source.get(f.a).nativeId, prompt_id: f.ra.liveTurn.promptId, prompt: 'The first human prompt.' });
    assert.equal((await f.call()).status, 'staged');
    await f.finish();
    assert.equal(f.writes.length, 1);
});

test('a cancelled wake translates only its own boundary wrapper and preserves the original reason and body', async t => {
  const f = await fixture(t); await f.call();
  const row = f.source.get(f.a).messages.find(m => m.wake), body = row.wake.body, reason = 'RAW reason 中文 {body}';
  require('../session-wake.cjs').cancelParticipant(f.source, f.a, reason);
  assert.equal(row.wake.status, 'cancelled'); const original = row.text, locale = require('../ui-locale.js');
  assert.equal(locale.displayText('en', row.text, row.uiMessage), `The native observation or control boundary changed（${reason}）; the automatic message was not delivered.\n${body}`);
  assert.equal(locale.displayText('zh', row.text, row.uiMessage), original); assert.equal(row.wake.body, body); assert.equal(f.writes.length, 0);
});

test('a retained sender with an unavailable original wake message is unknown without claiming its session was removed', async t => {
  const f = await joined(t, ['shared'], ['shared']);
  const body = 'Preserve the original body exactly.\nSynthetic second line.';
  assert.equal((await f.call(body)).status, 'staged');
  const [before] = wakeRows(f.source), sender = f.source.get(f.a), nativeId = sender.nativeId;
  sender.messages = sender.messages.filter(message => message.id !== before.wake.id);
  const [row] = wakeRows(f.source);
  assert.equal(f.source.get(f.a), sender); assert.equal(sender.nativeId, nativeId);
  assert.equal(row.wakeStatus, 'unknown'); assert.equal(row.wake.body, body);
  assert.equal(row.text, `无法核对发送方的原消息，投递结果未确认。\n${body}`);
  assert.equal(require('../ui-locale.js').displayText('en', row.text, row.uiMessage), `The sender's original message could not be verified; delivery is unconfirmed.\n${body}`);
  assert.deepEqual(f.writes, [], 'reading a missing source row never dispatches or retries');
});

for (const status of ['blocked','paused','usageLimited','budgetLimited']) test('native goal refusal retains its exact observed state without resuming it: '+status, async t=>{
 const f=await fixture(t),nativeId=f.target.get(f.b).nativeId;
 const goal={threadId:nativeId,status,objective:'PRIVATE_ORIGINAL_GOAL_BODY',tokenBudget:123};const original=structuredClone(goal),reads=[];
 f.target.setDraft(f.b,'POSITIVE UNSENT RECEIVER DRAFT','target-owner');
 f.rb.host.rpc.call=async(method,params)=>{reads.push([method,params]);assert.equal(method,'thread/goal/get');assert.equal(params.threadId,nativeId);return {goal};};
 await f.call('Exact shared task body.');await f.finish();
 assert.equal(f.writes.length,0);assert.equal(reads.length,1);assert.deepEqual(goal,original);assert.equal(f.target.get(f.b).nativeId,nativeId);assert.equal(f.target.get(f.b).owner,'target-owner');assert.equal(f.target.drafts.get(f.b),'POSITIVE UNSENT RECEIVER DRAFT');
 const row=f.source.get(f.a).messages.find(m=>m.wake);assert.equal(row.wake.status,'not-sent');
 const locale=require('../ui-locale.js');for(const language of ['zh','en']){const text=locale.displayText(language,row.text,row.uiMessage);assert.ok(text.includes(status));assert.ok(text.endsWith('Exact shared task body.'));assert.doesNotMatch(text,/PRIVATE_ORIGINAL_GOAL_BODY|123/);}
});
for(const kind of ['other-thread-active','missing-thread-active','undefined-goal','unknown-status'])test('unverified native goal never permits an automatic handoff: '+kind,async t=>{
 const f=await fixture(t),nativeId=f.target.get(f.b).nativeId;
 const result=kind==='undefined-goal'?{goal:undefined}:{goal:{threadId:kind==='other-thread-active'?'another-native':kind==='missing-thread-active'?undefined:nativeId,status:kind==='unknown-status'?'new-unknown':'active'}};
 f.rb.host.rpc.call=async(method,params)=>{assert.equal(method,'thread/goal/get');assert.equal(params.threadId,nativeId);return result;};
 await f.call();await f.finish();assert.equal(f.writes.length,0);assert.equal(f.source.get(f.a).messages.find(m=>m.wake).wake.status,'not-sent');
});
for(const status of ['active','complete'])test('same-thread confirmed native goal still allows one handoff without any goal write: '+status,async t=>{
 const f=await fixture(t),goal={threadId:f.target.get(f.b).nativeId,status,objective:'PRIVATE_ACTIVE_GOAL'},before=structuredClone(goal),methods=[];
 f.rb.host.rpc.call=async(method,params)=>{methods.push(method);assert.equal(method,'thread/goal/get');assert.equal(params.threadId,goal.threadId);return {goal};};
 await f.call();await f.finish();assert.equal(f.writes.length,1);assert.deepEqual(methods,['thread/goal/get','thread/goal/get']);assert.deepEqual(goal,before);
});
test('Codex: a wake staged in a turn whose end never came is withdrawn when the next turn starts; a late end changes nothing', async t => {
  const f = await fixture(t); assert.equal((await f.call()).status, 'staged');
  f.start('turn-two'); await tick();
  const row = f.source.get(f.a).messages.find(m => m.wake);
  assert.equal(row.wake.status, 'cancelled'); assert.equal(row.wake.cancellation.nativeStatus, 'unreported');
  f.ra.emit('nativeTurnEnd', { nativeId: f.source.get(f.a).nativeId, turnId: 'turn-one', status: 'completed' }); for (let i = 0; i < 8; i++) await tick();
  assert.equal(row.wake.status, 'cancelled'); assert.equal(f.writes.length, 0);
});

// The wake proposal, item 2 (board 11-12 16:44): 「②只给指定大管家（每收件方 1 条、最多 4 个），其他 agent 不变」.
async function butler(t, recipients, { designate = true, spaces = [] } = {}) {
  const f = await fixture(t), s = f.source.get(f.a);
  s.roomIds = spaces; s.roomId = spaces.includes('shared') ? 'shared' : null;
  const ids = [f.b];
  for (let i = 2; i <= recipients; i++) ids.push(await f.target.create('codex', f.root, 'target-owner', 'Receiver ' + i));
  const designation = selected => fs.writeFileSync(path.join(f.root, 'steward.json'), JSON.stringify({ version: 1, selected }), { mode: 0o600 });
  if (designate) designation({ sessionId: f.a, nativeId: s.nativeId });
  // Called inside a promise, as native calls arrive: a refusal before anything is staged is a rejection here.
  const send = (to, text, callId) => Promise.resolve().then(() => f.ra.addressedCall({ nativeId: s.nativeId, turnId: f.ra.turnId, callId }, { recipient_id: to, message: text }));
  const received = id => f.target.get(id).messages.filter(m => m.origin === 'agent-wake');
  const sent = () => s.messages.filter(m => m.wake);
  return { ...f, s, ids, send, received, sent, designation };
}
test('the butler sends one message each to three recipients in one turn, each once after the turn ends (wake proposal, item 2)', async t => {
  const f = await butler(t, 3);
  for (const [i, id] of f.ids.entries()) assert.equal((await f.send(id, `Task ${i + 1}.`, `call-${i}`)).status, 'staged');
  assert.equal(f.writes.length, 0, 'nothing goes before the turn ends');
  await f.finish();
  assert.equal(f.writes.length, 3);
  for (const [i, id] of f.ids.entries()) {
    assert.deepEqual(f.received(id).map(m => [m.status, m.text.split('\n')[1]]), [['submitted', `Task ${i + 1}.`]]);
    assert.equal(f.target.get(id).wakeBudget.senders[f.source.get(f.a).nativeId].streak, 1, 'each recipient keeps its own limit');
  }
  assert.deepEqual(f.sent().map(m => m.wake.status), ['submitted', 'submitted', 'submitted']);
});
test('the butler cannot send a second message to one recipient, nor reach a fifth, in one turn (wake proposal, item 2)', async t => {
  const f = await butler(t, 5);
  assert.equal((await f.send(f.ids[0], 'First.', 'one')).status, 'staged');
  await assert.rejects(f.send(f.ids[0], 'Second to the same.', 'two'), /这一轮已经给这个收件方登记过一条；要说的合成一条。/);
  for (const [i, id] of f.ids.slice(1, 4).entries()) assert.equal((await f.send(id, `Next ${i}.`, `next-${i}`)).status, 'staged');
  await assert.rejects(f.send(f.ids[4], 'Fifth.', 'five'), /这一轮最多给 4 个不同的收件方各发一条。/);
  assert.equal(f.sent().length, 4);
  await f.finish();
  assert.equal(f.writes.length, 4); assert.equal(f.received(f.ids[0]).length, 1); assert.equal(f.received(f.ids[4]).length, 0);
});
test('concurrent butler calls to one recipient stage one; a call that registered nothing does not count (wake proposal, item 2)', async t => {
  const f = await butler(t, 2);
  const both = await Promise.allSettled([f.send(f.ids[0], 'A.', 'c1'), f.send(f.ids[0], 'B.', 'c2')]);
  assert.equal(both.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(f.send('no-such-session', 'Lost.', 'c3'));
  assert.equal(f.sent().length, 1);
  assert.equal((await f.send(f.ids[1], 'C.', 'c4')).status, 'staged');
  await f.finish();
  assert.equal(f.writes.length, 2); assert.equal(f.received(f.ids[0]).length, 1); assert.equal(f.received(f.ids[1]).length, 1);
});
test('every other sender still sends one message a turn: not designated, in a space, another native session, native context pending, or an unreadable designation (wake proposal, item 2)', async t => {
  const cases = {
    'not designated': { designate: false },
    'in a space': { spaces: ['shared'] },
    'another native session': { after: f => f.designation({ sessionId: f.a, nativeId: 'native-other' }) },
    // As main.cjs stewardCaller: a session whose native context is still to come is not the butler's yet.
    'native context pending': { after: f => { f.s.nativeContextPending = true; } },
    'unreadable designation': { after: f => fs.chmodSync(path.join(f.root, 'steward.json'), 0o644) },
  };
  for (const [name, options] of Object.entries(cases)) {
    const f = await butler(t, 2, options); options.after?.(f);
    assert.equal((await f.send(f.ids[0], 'Only one.', 'one')).status, 'staged', name);
    await assert.rejects(f.send(f.ids[1], 'A second.', 'two'), /这个原生回合已经请求过自动消息；未追加。/, name);
    await f.finish();
    assert.equal(f.writes.length, 1, name); assert.equal(f.sent().length, 1, name);
  }
});
test('a turn the butler started after a refused first message still counts that one (wake proposal, item 2)', async t => {
  const f = await butler(t, 2);
  f.target.get(f.ids[0]).wakeDisabled = true;
  assert.equal((await f.send(f.ids[0], 'Refused.', 'one')).status, 'not-sent');
  await assert.rejects(f.send(f.ids[0], 'Again.', 'two'), /合成一条/, 'each message is tried once, also by the butler');
  assert.equal((await f.send(f.ids[1], 'Other.', 'three')).status, 'staged');
  await f.finish();
  assert.equal(f.writes.length, 1); assert.equal(f.received(f.ids[1]).length, 1);
});
test('when the person ends the butler role before the turn ends, only the turn\'s first message goes (wake proposal, item 2)', async t => {
  const f = await butler(t, 2);
  assert.equal((await f.send(f.ids[0], 'First.', 'one')).status, 'staged');
  assert.equal((await f.send(f.ids[1], 'Second.', 'two')).status, 'staged');
  f.designation(null);
  await f.finish();
  assert.equal(f.writes.length, 1); assert.equal(f.received(f.ids[0]).length, 1); assert.equal(f.received(f.ids[1]).length, 0);
  const [first, second] = f.sent();
  assert.equal(first.wake.status, 'submitted');
  assert.equal(second.wake.status, 'cancelled'); assert.equal(second.wake.cancellation.code, 'steward-role-ended');
  assert.equal(second.text, '这一轮结束时没能确认发送方还是大管家，只发第一条；自动消息未投递。\nSecond.');
});

// The person's words queued into a sender's running turn. The wake proposal's item 3 (2026-11-12) withdrew the turn's
// authority at those words and gave it back once the turn read them. Since 2026-11-23 every session has the butler's
// input policy: the words neither withdraw nor renew what the turn may send. A Claude sender in a turn; the person
// queues words into it through NAW, the real adapter takes native's append receipt, and native's read of them comes as
// the submission channel's read event.
async function personSpeaks(t, { steward = false } = {}) {
  const f = await fixture(t, 'claude'), s = f.source.get(f.a), requests = [];
  s.state = 'working';
  if (steward) fs.writeFileSync(path.join(f.root, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: f.a, nativeId: s.nativeId } }), { mode: 0o600 });
  Object.defineProperty(f.ra, 'queueAvailable', { value: true, configurable: true });
  f.ra.nativeMidturnAppend = true;
  let mode = 'append', release;
  f.ra.submission.request = async (text, tag, guard, queued, midturn) => {
    requests.push({ text, tag, queued, midturn });
    const uuid = `00000000-0000-4000-8000-${String(requests.length).padStart(12, '0')}`;
    if (mode === 'not-sent') throw Object.assign(new Error('native refused the words'), { notSent: true });
    if (mode === 'unconfirmed') throw new Error('no answer from native');
    // Native answers words queued as their own turn only when that turn starts, after the running one ends.
    if (mode === 'held') return new Promise(resolve => { release = () => resolve({ turnId: null, promptId: null }); });
    return mode === 'append' ? { mode: 'append', uuid, turnId: f.ra.turnId } : { turnId: null, promptId: null };
  };
  const say = async text => { const tag = await f.source.queue(f.a, text, 'source-owner'); return { tag, uuid: `00000000-0000-4000-8000-${String(requests.length).padStart(12, '0')}` }; };
  const read = ({ tag, uuid }, turnId = f.ra.turnId) => f.ra.submission.emit('read', { tag, uuid, turnId });
  const send = (to, text, callId) => Promise.resolve().then(() => f.ra.addressedCall({ nativeId: s.nativeId, turnId: f.ra.turnId, promptId: f.ra.liveTurn.promptId, callId }, { recipient_id: to, message: text }));
  const sent = () => s.messages.filter(m => m.wake);
  return { ...f, s, requests, say, read, send, sent, ownTurn: () => { mode = 'own-turn'; }, fail: kind => { mode = kind; }, release: () => release?.() };
}
const refusedAs = key => error => error.uiMessage?.key === key;
test('the person speaking into a sender\'s turn withdraws nothing it registered, and reading the words adds no second message', async t => {
  const f = await personSpeaks(t);
  assert.equal((await f.send(f.b, 'Before the person spoke.', 'before')).status, 'staged');
  const words = await f.say('Tell Receiver about the new plan too.');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].midturn, true);
  const row = f.s.messages.find(m => m.id === words.tag);
  assert.equal(row.deliveredInto, f.ra.turnId, 'native stored the words in the running turn');
  await assert.rejects(f.send(f.b, 'Before the read.', 'unread'), /这一轮已经登记过|已经请求过/);
  f.read(words);
  assert.equal(row.nativeRead, true);
  await assert.rejects(f.send(f.b, 'After the read.', 'after'), /这一轮已经登记过|已经请求过/, 'still one message a turn for a session that is not the butler');
  await f.finish();
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].text, /\nBefore the person spoke\.$/);
  assert.deepEqual(f.sent().map(m => m.wake.status), ['submitted']);
});
test('the person\'s words, read or not yet, do not hold back the turn\'s message', async t => {
  const f = await personSpeaks(t);
  const first = await f.say('One thing.'); await f.say('And another.');
  f.read(first);
  assert.equal((await f.send(f.b, 'Between the two reads.', 'early')).status, 'staged', 'no waiting for a native read');
  await f.finish();
  assert.equal(f.writes.length, 1);
});
test('words this turn will not read leave its message as it was: not sent, unconfirmed, or run as their own later turn', async t => {
  for (const [name, kind, status] of [['not sent', 'not-sent', 'not-sent'], ['unconfirmed', 'unconfirmed', 'unconfirmed']]) {
    const f = await personSpeaks(t);
    f.fail(kind);
    await assert.rejects(f.source.queue(f.a, 'Use the other plan.', 'source-owner'));
    assert.equal(f.s.messages.find(m => m.origin === 'human' && m.text === 'Use the other plan.').status, status, name);
    assert.equal((await f.send(f.b, 'After the words.', 'failed')).status, 'staged', name);
    await f.finish();
    assert.equal(f.writes.length, 1, name);
  }
  // A Claude version without mid-turn delivery: the words wait for the turn to end and run as their own turn.
  const f = await personSpeaks(t); f.ra.nativeMidturnAppend = false; f.fail('held');
  const queued = f.source.queue(f.a, 'Next, please.', 'source-owner');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].midturn, false, 'not offered into the running turn');
  assert.equal((await f.send(f.b, 'Still this turn.', 'same')).status, 'staged');
  f.release(); await queued;
  await f.finish();
  assert.equal(f.writes.length, 1);
  // Native answers that the words run as their own turn.
  const g = await personSpeaks(t); g.ownTurn();
  const words = await g.say('Next, please.');
  assert.equal(g.s.messages.find(m => m.id === words.tag).deliveredInto, undefined);
  assert.equal((await g.send(g.b, 'Before the turn ends.', 'before-end')).status, 'staged');
  await g.finish();
  assert.equal(g.writes.length, 1);
});
test('after the person speaks into a turn, a takeover, pausing everything or another agent\'s background queue still ends its messages; typing does not', async t => {
  const cases = {
    'a takeover': [async f => { f.source.claim(f.a, 'another-window'); }, 'error.wake.revokedByTakeover'],
    'pausing all handoffs': [async f => { f.source.pauseAll('stop'); }, 'error.wake.revokedByPause'],
    // An agent using the person's own queue command through NAW's background control is not message input.
    'another agent queueing through background control': [async f => {
      const actor = { id: 'other-session', name: 'Other agent', nativeId: 'other-native', provider: 'claude', callId: 'call-1', turnId: 'turn-1', operationId: 'operation-1' };
      await require('../background-operation.cjs').run(actor, () => f.say('From another agent.'));
    }, 'error.wake.revokedByBackground'],
    'the person typing in the terminal': [async f => { f.s.view = 'terminal'; f.ra.terminal = { alive: true, input() {} }; f.source.input(f.a, 'x', 'source-owner'); }, null],
  };
  for (const [name, [act, refused]] of Object.entries(cases)) {
    const f = await personSpeaks(t), words = await f.say('Hold on.'), keeps = !refused;
    f.read(words);
    await act(f);
    if (keeps) assert.equal((await f.send(f.b, 'Goes.', 'after')).status, 'staged', name);
    else await assert.rejects(f.send(f.b, 'Must not go.', 'after'), refusedAs(refused), name);
    await f.finish();
    assert.equal(f.writes.length, keeps ? 1 : 0, name);
  }
});
test('the butler keeps staged messages and its per-recipient limit when the person speaks and is read', async t => {
  const f = await personSpeaks(t, { steward: true });
  const second = await f.target.create('codex', f.root, 'target-owner', 'Second receiver');
  assert.equal((await f.send(f.b, 'First task.', 'one')).status, 'staged');
  const words = await f.say('Also tell the second member.');
  assert.equal((await f.send(second, 'Second task.', 'two')).status, 'staged', 'no waiting for a native read');
  f.read(words);
  await assert.rejects(f.send(f.b, 'Duplicate task.', 'three'), /这一轮已经给这个收件方登记过一条/);
  await f.finish();
  assert.equal(f.writes.length, 2);
  assert.deepEqual(f.sent().map(m => m.wake.status), ['submitted', 'submitted']);
});
for (const steward of [true, false]) test(`late first prompt hook after turn-start keeps the turn's authority (${steward ? 'butler' : 'ordinary sender'})`, async t => {
  const f = await personSpeaks(t, { steward });
  const promptId = f.ra.liveTurn.promptId, turn = f.ra.wakeTurn, control = f.s.controlRevision;
  // The native display already linked the prompt; its settings hook follows on another socket.
  f.s.messages.push({ id: `claude-prompt-${promptId}`, role: 'user', origin: 'native', nativeId: f.s.nativeId, text: 'Agreed.' });
  f.ra.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.s.nativeId, prompt_id: promptId, prompt: 'Agreed.', source: 'user' });
  assert.equal(f.s.controlRevision, control + 1);
  assert.equal(f.ra.wakeTurn, turn, 'the late hook has no turnId and does not call nativeStart again');
  assert.equal((await f.send(f.b, 'First call of the new turn.', 'first')).status, 'staged');
  await f.finish(); assert.equal(f.writes.length, 1);
});
for (const [name, [act, key]] of Object.entries({
  stop: [async f => { f.ra.interrupt = async () => ({ interrupted: true }); await f.source.interrupt(f.a, 'source-owner'); }, 'error.wake.revokedByInterrupt'],
  takeover: [f => f.source.claim(f.a, 'another-owner'), 'error.wake.revokedByTakeover'],
  'pause all': [f => f.source.pauseAll('Explicit stop.'), 'error.wake.revokedByPause'],
  'automatic messages off': [f => require('../session-wake.cjs').setPolicy(f.source, null, false), 'error.wake.revokedBySwitch'],
})) for (const steward of [true, false]) test(`${steward ? 'butler' : 'ordinary'} input cannot restore authority after ${name}`, async t => {
  const f = await personSpeaks(t, { steward });
  await f.send(f.b, 'Pending task.', 'before');
  await act(f);
  f.ra.emit('nativeInput', 'Later words.', { id: 'later-words', source: 'user' });
  await assert.rejects(f.send(f.b, 'Must not go.', 'after'), refusedAs(key));
  await f.finish(); assert.equal(f.writes.length, 0);
});
// The person, 11-23 「又是 communication 的 bug」: a withdrawn turn says what withdrew it, not always 「真人操作」.
test('a withdrawn turn names what changed, in its text, its code and its withdrawn rows; none of these says a person did it', async t => {
  const wake = require('../session-wake.cjs'), locale = require('../ui-locale.js');
  const actor = { id: 'other-session', name: 'Other agent', nativeId: 'other-native', provider: 'claude', callId: 'call-1', turnId: 'turn-1', operationId: 'operation-1' };
  const cases = {
    'a window opening a session none held': ['opened', f => f.source.claim(f.a, 'new-window'), f => { f.s.owner = null; f.start('unheld'); }],
    'pausing all on the other backend': ['pause', f => f.target.pauseAll('stop')],
    'an upgrade pausing the old backend': ['upgrade', f => f.source.pauseAll('stop', undefined, 'upgrade')],
    'the automatic-message switch': ['switch', f => wake.setPolicy(f.source, f.a, true)],
    'an older backend rotating the boundary': ['boundary', f => fs.writeFileSync(path.join(f.root, 'agent-wake-boundary'), require('node:crypto').randomUUID(), { mode: 0o600 })],
    'another agent\'s terminal keys through background control': ['background', async f => { f.s.view = 'terminal'; f.ra.terminal = { alive: true, input() {} }; await require('../background-operation.cjs').run(actor, () => f.source.input(f.a, 'x', 'source-owner')); }],
    'a control change NAW has no name for': ['control', f => { f.s.controlRevision++; }],
  };
  for (const [name, [code, act, before]] of Object.entries(cases)) {
    const f = await personSpeaks(t);
    if (before) before(f);
    const staged = await f.send(f.b, 'Pending task.', 'before'); assert.equal(staged.status, 'staged', name);
    await act(f);
    const error = await f.send(f.b, 'Must not go.', 'after').then(() => null, e => e);
    assert.ok(error, name);
    assert.equal(error.sourceIssue, code, name);
    assert.equal(error.uiMessage?.key, `error.wake.revokedBy${{ opened: 'Open' }[code] || code[0].toUpperCase() + code.slice(1)}`, name);
    assert.doesNotMatch(error.message, /真人/, name);
    assert.doesNotMatch(locale.errorText('en', error), /human|person/i, name);
    assert.equal(f.ra.wakeUndelivered.at(-1).sourceIssue, code, `${name}: the butler's event carries it`);
    // Withdrawn at once by its own backend's change; the other backend's change reaches it at the turn's end.
    if (['upgrade', 'switch'].includes(code)) {
      const row = f.sent()[0];
      assert.equal(row.wake.status, 'cancelled', name); assert.equal(row.wake.cancellation?.code, code, name);
      assert.doesNotMatch(row.text, /真人/, name);
      assert.doesNotMatch(locale.displayText('en', row.text, row.uiMessage), /human|person/i, name);
    }
    await f.finish();
    assert.equal(f.writes.length, 0, name);
  }
});

// Review N1: a change the turn's start proof does not carry (a space's queue changes only the peer revision) does not
// name a later refusal; the takeover that withdrew it does.
test('a peer-only change before a takeover does not name the takeover\'s refusal', async t => {
  const wake = require('../session-wake.cjs'), f = await personSpeaks(t);
  assert.equal((await f.send(f.b, 'Pending task.', 'before')).status, 'staged');
  wake.cause(f.s, 'input', true);
  f.source.claim(f.a, 'another-window');
  const error = await f.send(f.b, 'Must not go.', 'after').then(() => null, e => e);
  assert.deepEqual([error?.sourceIssue, error?.uiMessage?.key], ['takeover', 'error.wake.revokedByTakeover']);
  await f.finish(); assert.equal(f.writes.length, 0);
});
// Review N2: a saved row the catalog cannot render still ends, and the pause still happens.
test('withdrawing a saved row whose body the catalog refuses still ends it and still pauses', async t => {
  const f = await fixture(t), s = f.source.get(f.a), body = 'x'.repeat(17000);
  s.messages.push({ id: 'bad', role: 'system', kind: 'notice', text: '', status: 'complete', time: Date.now(), wake: { status: 'staged', body } });
  const paused = []; const pause = f.source.pause.bind(f.source); f.source.pause = (...args) => { paused.push(args[0]); return pause(...args); };
  f.source.pauseAll('stop');
  const row = s.messages.find(m => m.id === 'bad');
  assert.deepEqual([row.wake.status, row.wake.cancellation?.code, row.text.startsWith('自动消息的授权边界变了；自动消息未投递。\n'), row.uiMessage], ['cancelled', 'pause', true, undefined]);
  assert.deepEqual(paused, ['stop']);
});
for (const [steward, end, permission] of [[true, 'complete', false], [false, 'complete', false], [true, 'failed', false], [false, 'failed', false], [true, 'complete', true], [false, 'complete', true]]) test(`observed native input and turn end preserve a completed input-only turn only (${steward}/${end}/${permission})`, async t => {
  const f = await personSpeaks(t, { steward });
  f.ra.terminal = { alive: true };
  const bound = f.ra.bindRoot({ sessionId: f.s.nativeId, nativeBlocks: true, nativeInlineInput: true, nativePromptInput: true, addressedTool: true });
  let sequence = 0;
  const observe = value => f.ra.observeBlock({ sessionId: f.s.nativeId, lease: bound.lease, epoch: bound.observationEpoch, block: true, sequence: ++sequence, ...value });
  observe({ id: 'control:turn-start', kind: 'control', turnId: 'observed-turn', promptId: 'observed-prompt', status: 'running' });
  await f.send(f.b, 'Keep the pending task.', 'pending');
  observe({ id: 'control:input', kind: 'control', status: 'complete' });
  if (permission) observe({ id: 'control:permission', kind: 'control', status: 'complete', turnId: 'observed-turn', permissionId: 'permission:one' });
  observe({ id: 'turn:observed-turn', kind: 'turn', turnId: 'observed-turn', status: end });
  for (let n = 0; n < 8; n++) await tick();
  const expected = end === 'complete' && !permission;
  assert.equal(f.writes.length, expected ? 1 : 0);
  assert.equal(f.sent()[0].wake.status, expected ? 'submitted' : 'cancelled');
});

for (const [name, data, keeps] of [['text', 'hello\r', true], ['paste', '\x1b[200~pasted text\x1b[201~', true], ['Esc', '\x1b', false], ['Ctrl-C', '\x03', false]]) test(`butler terminal ${name} keeps only message input authorized`, async t => {
  const f = await butler(t, 2), keys = [];
  f.s.view = 'terminal'; f.ra.terminal = { alive: true, input: data => keys.push(data) };
  await f.send(f.ids[0], 'Already staged.', 'first');
  f.source.input(f.a, data, 'source-owner');
  assert.deepEqual(keys, [data]);
  if (keeps) assert.equal((await f.send(f.ids[1], 'After input.', 'second')).status, 'staged');
  else await assert.rejects(f.send(f.ids[1], 'After stop.', 'second'), refusedAs('error.wake.revokedByInterrupt'));
  await f.finish(); assert.equal(f.writes.length, keeps ? 2 : 0);
});
// R163 (11-24): fullscreen Claude turns on mouse tracking, so a scroll or click in its terminal arrives as input.
for (const [name, data, keeps] of [['one unsent key', 'x', true], ['text', 'hello\r', true], ['paste', '\x1b[200~pasted text\x1b[201~', true], ['mouse wheel', '\x1b[<64;10;5M', true], ['click and release', '\x1b[<0;10;5M\x1b[<0;10;5m', true], ['focus in', '\x1b[I', true], ['Esc', '\x1b', false], ['Ctrl-C', '\x03', false]]) test(`an ordinary session's terminal ${name} ${keeps ? 'keeps' : 'withdraws'} its turn's message, registered before or after`, async t => {
  for (const order of ['registered first', 'input first']) {
    const f = await personSpeaks(t), keys = [];
    f.s.view = 'terminal'; f.ra.terminal = { alive: true, input: data => keys.push(data) };
    if (order === 'registered first') await f.send(f.b, 'Already staged.', 'first');
    f.source.input(f.a, data, 'source-owner');
    assert.deepEqual(keys, [data]);
    if (order === 'input first') {
      if (keeps) assert.equal((await f.send(f.b, 'After input.', 'first')).status, 'staged');
      else await assert.rejects(f.send(f.b, 'After stop.', 'first'), refusedAs('error.wake.revokedByInterrupt'));
    }
    await f.finish(); assert.equal(f.writes.length, keeps ? 1 : 0, order);
  }
});
test('the butler keeps its authority when a Codex human steer enters its running turn', async t => {
  const f = await butler(t, 2); f.ra.steerAvailable = true; f.ra.finishTurn = () => {};
  f.ra.steer = async (_text, _tag, turnId, valid) => { assert.equal(turnId, f.ra.turnId); assert.equal(valid(), true); };
  await f.send(f.ids[0], 'Before steering.', 'first');
  await f.source.steer(f.a, 'Also tell the other member.', 'source-owner', f.ra.turnId);
  assert.equal((await f.send(f.ids[1], 'After steering.', 'second')).status, 'staged');
  await f.finish(); assert.equal(f.writes.length, 2);
});
test('an ordinary session keeps its authority when a Codex human steer enters its running turn', async t => {
  const f = await fixture(t); f.ra.steerAvailable = true; f.ra.finishTurn = () => {};
  f.ra.steer = async (_text, _tag, turnId, valid) => { assert.equal(turnId, f.ra.turnId); assert.equal(valid(), true); };
  await f.source.steer(f.a, 'Also tell the receiver.', 'source-owner', f.ra.turnId);
  assert.equal((await f.call('After steering.', 'after-steer')).status, 'staged');
  await f.finish(); assert.equal(f.writes.length, 1);
});
for (const steward of [true, false]) test(`${steward ? 'butler' : 'ordinary'} input during recipient lookup preserves the pending call, while a stop still wins`, async t => {
  for (const stop of [false, true]) {
    const f = await personSpeaks(t, { steward }), lookup = f.source.peerRunner.lookupWake.bind(f.source.peerRunner);
    f.source.peerRunner.lookupWake = async (...args) => {
      const result = await lookup(...args);
      if (stop) { f.ra.interrupt = async () => ({ interrupted: true }); await f.source.interrupt(f.a, 'source-owner'); }
      await f.say('A clarification while looking up the receiver.');
      return result;
    };
    if (stop) await assert.rejects(f.send(f.b, 'Must not go.', 'one'), refusedAs('error.wake.revokedByInterrupt'));
    else assert.equal((await f.send(f.b, 'Still authorized.', 'one')).status, 'staged');
    await f.finish(); assert.equal(f.writes.length, stop ? 0 : 1);
  }
});

// Option A (board 11-12 21:2x, the person 「按你推荐的来」): 「大管家 60 秒限制选 A：被拒的自动消息先存着、每分钟补送一条，
// 限制本身不变（不放宽）」. Before it, three agents delivering to the butler at once lost two messages to its limit.
async function toButler(t, { designate = true } = {}) {
  const oldNow = Date.now; let now = oldNow(); Date.now = () => now; t.after(() => { Date.now = oldNow; });
  const f = await fixture(t), b = f.target.get(f.b);
  b.roomIds = []; b.roomId = null;
  if (designate) fs.writeFileSync(path.join(f.root, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: f.b, nativeId: b.nativeId } }), { mode: 0o600 });
  const reply = () => { const tag = f.writes.at(-1).tag; f.rb.emit('state', 'idle'); f.rb.emit('complete', { tag, text: 'An ordinary reply.', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); };
  const rows = () => f.source.get(f.a).messages.filter(m => m.wake);
  const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
  const turn = async (id, text) => { f.start(id); const result = await f.call(text, 'call-' + id); await f.finish(); return result; };
  return { ...f, reply, rows, settle, turn, advance: ms => { now += ms; }, now: () => now };
}
test('a message the butler refuses only for its 60-second limit is held and sent once the limit allows (option A)', async t => {
  const wake = require('../session-wake.cjs'), locale = require('../ui-locale.js');
  const f = await toButler(t);
  f.ra.emit('state', 'idle'); const first = await f.turn('first', 'First.'); assert.equal(f.writes.length, 1); f.reply();
  assert.match(first.message, /当前原生回合正常结束后尝试投递；那时收件方若 60 秒内刚收过一条自动消息，NAW 先存着，限制过了再送一次；/, 'to the butler, not 「只尝试一次」');
  const firstAt = f.target.get(f.b).wakeBudget.lastAt;
  f.advance(10000);
  const second = await f.turn('second', 'Second.');
  assert.equal(second.status, 'staged'); assert.equal(second.readiness, 'held'); assert.match(second.message, /已排着，约 1 分钟后由 NAW 再送一次/);
  const row = f.rows().at(-1);
  assert.equal(row.wake.status, 'held');
  assert.equal(row.text, '收件方 60 秒内刚收过一条自动消息；这条先存着，限制过了再试一次。\nSecond.');
  assert.equal(locale.displayText('en', row.text, row.uiMessage), 'The recipient received an automatic message less than 60 seconds ago; this one is held and tried once more when the limit allows.\nSecond.');
  assert.equal(row.wake.retryAt, firstAt + 60000); assert.equal(f.source.wakeHoldAt, firstAt + 60000, 'the one timer is set for when the limit opens');
  assert.equal(f.writes.length, 1, 'nothing more before the limit');
  wake.retryHeld(f.source); await f.settle();
  assert.equal(row.wake.status, 'held', 'too early: still held'); assert.equal(f.writes.length, 1);
  // The service's own timer sends it; nothing calls it by hand.
  t.mock.timers.enable({ apis: ['setTimeout'] }); wake.retryHeld(f.source); assert.equal(row.wake.status, 'held');
  f.advance(50000); t.mock.timers.tick(50000); await f.settle(); t.mock.timers.reset();
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1].text.split('\n')[1], 'Second.');
  assert.equal(row.wake.status, 'submitted'); assert.match(row.text, /原生已接收/);
  assert.equal(f.source.wakeHoldTimer, null, 'no timer once nothing is held');
  assert.equal(f.target.get(f.b).wakeBudget.senders[f.source.get(f.a).nativeId].streak, 2);
});
test('the limit itself stays: three in a row still ends it, and other recipients are refused as before (option A)', async t => {
  const wake = require('../session-wake.cjs');
  const f = await toButler(t);
  for (const [i, id] of ['one', 'two', 'three'].entries()) { if (i) f.advance(60001); f.ra.emit('state', 'idle'); await f.turn(id, `Task ${id}.`); f.reply(); }
  assert.equal(f.writes.length, 3);
  f.advance(10000); await f.turn('four', 'Task four.');
  const row = f.rows().at(-1);
  assert.equal(row.wake.status, 'not-sent', 'three in a row: refused, not held'); assert.match(row.text, /连续 3 次/);
  assert.equal(f.source.wakeHoldTimer, null);
  // Not the butler: refused for the limit and not retried, as before.
  const g = await toButler(t, { designate: false });
  const plainFirst = await g.turn('first', 'First.'); g.reply(); g.advance(10000);
  assert.match(plainFirst.message, /当前原生回合正常结束后只尝试一次；/, 'to anyone else, tried once as before');
  const refused = await g.turn('second', 'Second.');
  assert.equal(refused.status, 'not-sent');
  // Each side checks on its own. The recipient's: only the designated butler, refusing for its limit, asks to hold.
  const ask = h => wake.check(h.target, { id: 'probe', senderId: h.a, senderNativeId: h.source.get(h.a).nativeId,
    recipientId: h.b, boundary: wake.boundary(h.target), targetProof: require('../peer-handoffs.cjs').identity(h.target.get(h.b)) });
  const plain = await ask(g);
  assert.deepEqual([plain.status, plain.hold, plain.retryAt], ['not-sent', undefined, undefined], 'not the butler: no hold');
  const limited = await ask(f);
  assert.deepEqual([limited.status, limited.hold], ['not-sent', undefined], 'three in a row: no hold');
  assert.equal(g.rows().at(-1).text, '自动消息没有发出；不会自动重发。\n收件方刚收过自动消息：两条至少隔 60 秒，连续最多 3 条。\nSecond.');
  g.advance(60000); wake.retryHeld(g.source); await g.settle();
  assert.equal(g.writes.length, 1); assert.equal(g.source.wakeHoldTimer, null);
  // The sender's: a recipient backend that asks to hold a message to anyone but the designated butler is not followed,
  // even for the limit.
  g.source.peerRunner.transferWake = async () => ({ status: 'not-sent', reason: 'Synthetic refusal.', reasonUiMessage: { version: 1, key: 'error.wake.recipientCooldown', params: {} }, hold: true, retryAt: Date.now() + 1000 });
  g.advance(60001); await g.turn('third', 'Third.');
  assert.equal(g.rows().at(-1).wake.status, 'not-sent'); assert.equal(g.source.wakeHoldTimer, null);
  // Nor one to the butler that asks to hold for any reason but its 60-second limit.
  const h = await toButler(t);
  h.source.peerRunner.transferWake = async () => ({ status: 'not-sent', reason: 'Synthetic refusal.', reasonUiMessage: null, hold: true, retryAt: Date.now() + 1000 });
  await h.turn('first', 'First.');
  assert.equal(h.rows().at(-1).wake.status, 'not-sent'); assert.equal(h.source.wakeHoldTimer, null);
});
test('the butler still holds a message its limit refuses while the one it just took is on its way in (option A)', async t => {
  const f = await toButler(t);
  await f.turn('first', 'First.'); f.reply(); f.advance(10000);
  f.target.get(f.b).pendingTag = 'an-input-in-flight';
  const wake = require('../session-wake.cjs');
  const answer = await wake.check(f.target, { id: 'probe', senderId: f.a, senderNativeId: f.source.get(f.a).nativeId,
    recipientId: f.b, boundary: wake.boundary(f.target), targetProof: require('../peer-handoffs.cjs').identity(f.target.get(f.b)) });
  assert.deepEqual([answer.status, answer.hold, answer.retryAt], ['not-sent', true, f.target.get(f.b).wakeBudget.lastAt + 60000]);
  await f.turn('second', 'Second.');
  assert.equal(f.rows().at(-1).wake.status, 'held');
  f.target.get(f.b).pendingTag = null;
});
test('a held message is not sent once the person acts on the butler or the sender, or pauses all handoffs (option A)', async t => {
  const wake = require('../session-wake.cjs');
  const outcomes = {
    'butler-input': ['not-sent', '自动消息没有发出；不会自动重发。\n收件方已不是登记时的那个会话。\nSecond.'],
    'sender-input': ['cancelled', '存着的自动消息没有补送：补送前核对发送方和授权没通过。\nSecond.'],
    'pause-all': ['cancelled', '存着的自动消息没有补送：补送前核对发送方和授权没通过。\nSecond.'],
    'pause-all-here': ['cancelled', '全部交接已暂停；自动消息未投递。\nSecond.'],
  };
  for (const act of Object.keys(outcomes)) {
    const f = await toButler(t);
    await f.turn('first', 'First.'); f.reply(); f.advance(10000); await f.turn('second', 'Second.');
    const row = f.rows().at(-1); assert.equal(row.wake.status, 'held', act);
    if (act === 'butler-input') f.rb.emit('nativeInput', 'The person types into the butler', { id: 'butler-native-input' });
    else if (act === 'sender-input') f.ra.emit('nativeInput', 'The person types into the sender', { id: 'sender-native-input' });
    else if (act === 'pause-all') f.target.pauseAll('你暂停了后续交接');
    else { f.source.pauseAll('你暂停了后续交接'); assert.equal(row.wake.status, 'cancelled', 'at once, on its own backend'); }
    f.advance(60000); wake.retryHeld(f.source); await f.settle();
    assert.equal(f.writes.length, 1, act);
    assert.deepEqual([row.wake.status, row.text], outcomes[act], act);
    assert.equal(f.source.wakeHoldTimer, null, act);
  }
});
// No turn of the sender stands behind a held message: the input allowance of a running turn does not reach it.
test('a held message is not sent once another agent\'s message enters its sender; one that entered its turn before it was held does not end it', async t => {
  const wake = require('../session-wake.cjs');
  for (const when of ['before it is held', 'after it is held']) {
    const f = await toButler(t);
    await f.turn('first', 'First.'); f.reply(); f.advance(10000);
    f.start('second'); await f.call('Second.', 'call-second');
    if (when === 'before it is held') f.ra.emit('nativeControlBoundary', 'control:input');
    await f.finish();
    const row = f.rows().at(-1); assert.equal(row.wake.status, 'held', when);
    if (when === 'after it is held') f.ra.emit('nativeControlBoundary', 'control:input');
    f.advance(60000); wake.retryHeld(f.source); await f.settle();
    assert.equal(f.writes.length, when === 'before it is held' ? 2 : 1, when);
    assert.deepEqual([row.wake.status, row.wake.cancellation?.code, row.wake.cancellation?.fields], when === 'before it is held' ? ['submitted', undefined, undefined] : ['cancelled', 'source-identity-changed', ['peerRevision']], when);
  }
});
test('held messages to the butler go one at a time, oldest first, and a reopened backend never sends one (option A)', async t => {
  const wake = require('../session-wake.cjs');
  const f = await toButler(t);
  // A second sender on the same backend, with its own turn.
  const c = await f.source.create('codex', f.root, 'source-owner', 'Sender two'), rc = f.source.runtimes.get(c);
  const turnOf = async (s, r, id, text) => {
    r.turnId = id; r.emit('nativeTurnStart', { nativeId: s.nativeId, turnId: id }); r.emit('state', 'working');
    await r.addressedCall({ nativeId: s.nativeId, turnId: id, callId: 'call-' + id }, { recipient_id: f.b, message: text });
    r.turnId = null; r.emit('state', 'idle'); r.emit('nativeTurnEnd', { nativeId: s.nativeId, turnId: id, status: 'completed' }); await f.settle();
  };
  await f.turn('first', 'First.'); f.reply(); f.advance(1000);
  await f.turn('second', 'From sender one.'); f.advance(1000);
  await turnOf(f.source.get(c), rc, 'other', 'From sender two.');
  const one = f.rows().at(-1), two = f.source.get(c).messages.find(m => m.wake);
  assert.deepEqual([one.wake.status, two.wake.status], ['held', 'held']);
  f.advance(58001);
  // An earlier attempt the butler took but has not answered yet is still one under way: nothing else goes to it.
  const taken = { id: 'taken', role: 'system', kind: 'notice', text: '', wake: { id: 'taken', status: 'consumed', recipientId: f.b, body: '' } };
  f.source.get(c).messages.push(taken); wake.retryHeld(f.source); await f.settle();
  assert.equal(f.writes.length, 1); assert.equal(f.source.wakeHoldTimer, null, 'no timer while it is under way');
  f.source.get(c).messages.splice(f.source.get(c).messages.indexOf(taken), 1);
  // The service's own timer stays still here: an early try it made would be refused and held again, hiding the wait.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  wake.retryHeld(f.source); await f.settle();
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1].text.split('\n')[1], 'From sender one.', 'oldest first');
  assert.equal(two.wake.status, 'held', 'the other waits for the next minute');
  assert.ok(two.wake.retryAt >= f.now() + 60000); assert.equal(f.source.wakeHoldAt, two.wake.retryAt, 'its timer is set a minute on');
  t.mock.timers.reset();
  f.reply(); f.source.persist();
  const reopened = new Workspace({ binaries: {}, close() {} }, f.root);
  t.after(() => reopened.close());
  const restored = reopened.get(c).messages.find(m => m.wake);
  assert.equal(restored.wake.status, 'cancelled'); assert.equal(restored.text, 'NAW 后台重开过；存着的自动消息没有补送。\nFrom sender two.');
  assert.equal(reopened.wakeHoldTimer ?? null, null);
  f.advance(60000); wake.retryHeld(f.source); await f.settle();
  assert.equal(f.writes.length, 3, 'the live backend still sends its own'); assert.equal(two.wake.status, 'submitted');
});
// The integrator's case (board 11-12 21:2x: 「先用旧代码复现三个同时交付两条被拒」). On e0f068d the statuses read
// ['submitted', 'not-sent', 'not-sent'].
test('three agents report to the butler at once: one goes now, the other two are held and go a minute apart, none lost (option A)', async t => {
  const wake = require('../session-wake.cjs');
  const f = await toButler(t);
  const sender = async name => { const id = await f.source.create('codex', f.root, 'source-owner', name); return { s: f.source.get(id), r: f.source.runtimes.get(id) }; };
  const turnOf = async ({ s, r }, id, text) => {
    r.turnId = id; r.emit('nativeTurnStart', { nativeId: s.nativeId, turnId: id }); r.emit('state', 'working');
    const result = await r.addressedCall({ nativeId: s.nativeId, turnId: id, callId: 'call-' + id }, { recipient_id: f.b, message: text });
    r.turnId = null; r.emit('state', 'idle'); r.emit('nativeTurnEnd', { nativeId: s.nativeId, turnId: id, status: 'completed' }); await f.settle();
    return result;
  };
  const two = await sender('Sender two'), three = await sender('Sender three');
  await f.turn('one', 'From one.');
  const firstAt = f.now();
  f.advance(300); const second = await turnOf(two, 'two', 'From two.');
  f.advance(300); const third = await turnOf(three, 'three', 'From three.');
  const rows = [f.rows().at(-1), two.s.messages.find(m => m.wake), three.s.messages.find(m => m.wake)];
  assert.deepEqual(rows.map(row => row.wake.status), ['submitted', 'held', 'held'], 'none refused');
  // Each sender's agent reads about when its message goes.
  assert.match(second.message, /已排着，约 1 分钟后/); assert.match(third.message, /已排着，约 2 分钟后/);
  assert.equal(f.writes.length, 1);
  // The butler's record counts what is held for it, and since when the oldest waits.
  const { view } = require('../steward-record.cjs'), record = { entries: () => [], periods: () => [], failed: false };
  const current = { sessionId: f.b, nativeId: f.target.get(f.b).nativeId };
  assert.deepEqual(view(record, f.source.snapshot(), { current }).waiting, { count: 2, since: rows[1].wake.heldAt });
  assert.equal(view(record, f.source.snapshot(), { current: null }).waiting, null, 'no butler, nothing counted');
  assert.equal(view(record, f.source.snapshot(), { current: { sessionId: f.a, nativeId: f.source.get(f.a).nativeId } }).waiting, null, 'only what is held for the butler');
  f.reply();
  f.advance(firstAt + 60000 - f.now()); wake.retryHeld(f.source); await f.settle();
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1].text.split('\n')[1], 'From two.');
  assert.equal(rows[2].wake.status, 'held', 'the third waits for the next minute');
  f.reply();
  f.advance(60000); wake.retryHeld(f.source); await f.settle();
  assert.equal(f.writes.length, 3); assert.equal(f.writes[2].text.split('\n')[1], 'From three.');
  assert.deepEqual(rows.map(row => row.wake.status), ['submitted', 'submitted', 'submitted']);
  assert.equal(view(record, f.source.snapshot(), { current }).waiting, null, 'nothing held now');
});
// The second review's notes: turns that overlap read that a message to the butler may be held, and a queue reads a
// minute more for each one ahead of it.
test('overlapping turns to the butler read that a message may be held; a queue reads about when; four senders all go (option A, review)', async t => {
  const wake = require('../session-wake.cjs');
  const f = await toButler(t);
  const sender = async name => { const id = await f.source.create('codex', f.root, 'source-owner', name); return { s: f.source.get(id), r: f.source.runtimes.get(id) }; };
  const open = ({ s, r }, id, text) => { r.turnId = id; r.emit('nativeTurnStart', { nativeId: s.nativeId, turnId: id }); r.emit('state', 'working'); return r.addressedCall({ nativeId: s.nativeId, turnId: id, callId: 'call-' + id }, { recipient_id: f.b, message: text }); };
  const close = async ({ s, r }, id) => { r.turnId = null; r.emit('state', 'idle'); r.emit('nativeTurnEnd', { nativeId: s.nativeId, turnId: id, status: 'completed' }); await f.settle(); };
  const two = await sender('Sender two'), three = await sender('Sender three'), four = await sender('Sender four');
  // Nothing has gone when both call, so neither knows yet; neither reads 「只尝试一次」.
  f.start('one'); const first = await f.call('From one.', 'call-one');
  const second = await open(two, 'two', 'From two.');
  for (const result of [first, second]) {
    assert.equal(result.readiness, 'checked');
    assert.match(result.message, /当前原生回合正常结束后尝试投递；那时收件方若 60 秒内刚收过一条自动消息，NAW 先存着，限制过了再送一次；/);
  }
  await f.finish(); await f.settle();
  const firstAt = f.target.get(f.b).wakeBudget.lastAt;
  f.advance(300); await close(two, 'two');
  const rows = [f.rows().at(-1), two.s.messages.find(m => m.wake)];
  assert.deepEqual(rows.map(row => row.wake.status), ['submitted', 'held'], 'held at its turn end');
  // Two more while it waits: each reads a minute more than the one before it.
  f.advance(300); const third = await open(three, 'three', 'From three.'); await close(three, 'three');
  f.advance(300); const fourth = await open(four, 'four', 'From four.'); await close(four, 'four');
  assert.match(third.message, /已排着，约 2 分钟后/); assert.match(fourth.message, /已排着，约 3 分钟后/);
  rows.push(three.s.messages.find(m => m.wake), four.s.messages.find(m => m.wake));
  assert.deepEqual(rows.map(row => row.wake.status), ['submitted', 'held', 'held', 'held']);
  f.reply(); f.advance(firstAt + 60000 - f.now()); wake.retryHeld(f.source); await f.settle();
  f.reply(); f.advance(60000); wake.retryHeld(f.source); await f.settle();
  assert.deepEqual(f.writes.map(write => write.text.split('\n')[1]), ['From one.', 'From two.', 'From three.']);
  // Four different senders each have their own streak, so the fourth message is not the same-sender limit.
  f.reply(); f.advance(60000); wake.retryHeld(f.source); await f.settle();
  assert.equal(f.writes.length, 4);
  assert.deepEqual(rows.map(row => row.wake.status), ['submitted', 'submitted', 'submitted', 'submitted']);
  assert.equal(f.source.wakeHoldTimer, null);
});
test('a held message is not sent once the person ends or moves the butler role, or its sender becomes unavailable (option A, review)', async t => {
  const wake = require('../session-wake.cjs');
  const designate = (f, selected) => fs.writeFileSync(path.join(f.root, 'steward.json'), JSON.stringify({ version: 1, selected }), { mode: 0o600 });
  const outcomes = {
    'role ended': [f => designate(f, null), '存着的自动消息没有补送：补送前核对发送方和授权没通过。\nSecond.', 'steward-role-ended'],
    'role moved': [f => designate(f, { sessionId: f.b, nativeId: 'native-other' }), '存着的自动消息没有补送：补送前核对发送方和授权没通过。\nSecond.', 'steward-role-ended'],
    'sender unavailable': [f => f.ra.emit('state', 'error'), '原生观察或控制边界已变化（原生会话不可用）；自动消息未投递。\nSecond.', undefined],
  };
  for (const [act, [change, text, code]] of Object.entries(outcomes)) {
    const f = await toButler(t);
    await f.turn('first', 'First.'); f.reply(); f.advance(10000); await f.turn('second', 'Second.');
    const row = f.rows().at(-1); assert.equal(row.wake.status, 'held', act);
    change(f);
    f.advance(60000); wake.retryHeld(f.source); await f.settle();
    assert.equal(f.writes.length, 1, act);
    assert.deepEqual([row.wake.status, row.text, row.wake.cancellation?.code], ['cancelled', text, code], act);
    assert.equal(f.source.wakeHoldTimer, null, act);
  }
});

// Option A (42e60ba3) with the person's words (reviewed together 2026-11-13; the input policy of 2026-11-23): a held
// message keeps its sender's identity from when it was held. The person speaking into the sender after that ends it,
// whatever a later turn reads; what the person said while its own turn ran does not.
async function personToButler(t) {
  const oldNow = Date.now; let now = oldNow(); Date.now = () => now; t.after(() => { Date.now = oldNow; });
  const f = await fixture(t, 'claude'), s = f.source.get(f.a), b = f.target.get(f.b), requests = [];
  b.roomIds = []; b.roomId = null;
  fs.writeFileSync(path.join(f.root, 'steward.json'), JSON.stringify({ version: 1, selected: { sessionId: f.b, nativeId: b.nativeId } }), { mode: 0o600 });
  Object.defineProperty(f.ra, 'queueAvailable', { value: true, configurable: true });
  f.ra.nativeMidturnAppend = true;
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  f.ra.submission.request = async text => { requests.push(text); return { mode: 'append', uuid: uuid(requests.length), turnId: f.ra.turnId }; };
  const say = async text => { const tag = await f.source.queue(f.a, text, 'source-owner'); return { tag, uuid: uuid(requests.length) }; };
  const read = ({ tag, uuid: id }) => f.ra.submission.emit('read', { tag, uuid: id, turnId: f.ra.turnId });
  const begin = id => { f.start(id); s.state = 'working'; };
  const send = (text, callId) => Promise.resolve().then(() => f.ra.addressedCall({ nativeId: s.nativeId, turnId: f.ra.turnId, promptId: f.ra.liveTurn.promptId, callId }, { recipient_id: f.b, message: text }));
  const reply = () => { const tag = f.writes.at(-1).tag; f.rb.emit('state', 'idle'); f.rb.emit('complete', { tag, text: 'An ordinary reply.', background: 0, scheduled: 0, fleetPending: 0, stopHookActive: false }); };
  const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
  const rows = () => s.messages.filter(m => m.wake);
  // The butler has just taken one message: the next within a minute is held for its limit.
  f.ra.emit('state', 'idle'); begin('first'); await send('First.', 'call-first'); await f.finish(); reply();
  assert.equal(f.writes.length, 1);
  now += 10000;
  return { ...f, s, say, read, begin, send, settle, rows, advance: ms => { now += ms; } };
}
test('a message held from an earlier turn is not sent once the person speaks into a later turn, even after that turn reads the words (items 3 and option A)', async t => {
  const wake = require('../session-wake.cjs');
  const f = await personToButler(t);
  f.begin('second'); assert.equal((await f.send('Second.', 'call-second')).status, 'staged'); await f.finish();
  const held = f.rows().at(-1);
  assert.equal(held.wake.status, 'held');
  f.begin('third');
  f.read(await f.say('Do not send that one.'));
  f.advance(60000); wake.retryHeld(f.source); await f.settle();
  assert.equal(f.writes.length, 1, 'the held message is not sent');
  assert.deepEqual([held.wake.status, held.wake.cancellation?.code], ['cancelled', 'source-identity-changed']);
  assert.equal(held.text, '存着的自动消息没有补送：补送前核对发送方和授权没通过。\nSecond.');
  await f.finish();
  assert.equal(f.writes.length, 1);
});
test('a message the turn registered before the person spoke into it is held for the butler\'s limit and sent once it allows; the turn gets no second one (option A)', async t => {
  const wake = require('../session-wake.cjs');
  const f = await personToButler(t);
  f.begin('second');
  assert.equal((await f.send('Before the person spoke.', 'before')).status, 'staged');
  f.read(await f.say('Send the butler the new plan.'));
  await assert.rejects(f.send('The new plan.', 'after'), /这一轮已经登记过|已经请求过/);
  await f.finish();
  assert.equal(f.rows().length, 2);
  const before = f.rows().at(-1);
  assert.equal(before.wake.status, 'held');
  assert.equal(f.writes.length, 1, 'nothing more before the limit');
  f.advance(50000); wake.retryHeld(f.source); await f.settle();
  assert.equal(f.writes.length, 2);
  assert.match(f.writes[1].text, /\nBefore the person spoke\.$/);
  assert.equal(before.wake.status, 'submitted');
});

// The person, 2026-11-23 (「可以,按你推荐的来」): a member's automatic message that the designated butler actually took
// clears the butler's three-in-a-row to that member. The 3, the 60 seconds and every other edge stay as they were.
async function butlerAndMember(t, options) {
  const f = await toButler(t, options), member = f.a, butler = f.b;
  f.ra.emit('state', 'idle');
  let n = 0;
  const send = async (from, to, status) => {
    f.advance(60001); const before = f.writes.length;
    const result = await runTurn(f, from, to, `edge-${++n}`, `Message ${n}.`, status);
    const sent = f.writes.length > before;
    if (sent) replyTo(f, to);
    return { result, sent, row: (f.source.sessions.has(from) ? f.source : f.target).get(from).messages.findLast(m => m.wake) };
  };
  const streak = key => f.source.get(member).wakeBudget?.senders?.[key]?.streak;
  return { ...f, member, butler, send, streak, butlerKey: f.target.get(butler).nativeId };
}
test('the butler\'s fourth message to a member goes once the member\'s message to the butler was delivered; other senders keep their count', async t => {
  const f = await butlerAndMember(t), other = await f.source.create('codex', f.root, 'source-owner', 'Other member');
  for (let i = 0; i < 3; i++) assert.equal((await f.send(f.butler, f.member)).sent, true);
  assert.equal((await f.send(other, f.member)).sent, true);
  const otherKey = f.source.get(other).nativeId, lastAt = f.source.get(f.member).wakeBudget.lastAt;
  assert.deepEqual([f.streak(f.butlerKey), f.streak(otherKey)], [3, 1]);
  const reply = await f.send(f.member, f.butler);
  assert.deepEqual([reply.sent, reply.row.wake.status], [true, 'submitted']);
  assert.deepEqual([f.streak(f.butlerKey), f.streak(otherKey)], [0, 1], 'only the butler\'s run to this member is cleared');
  assert.equal(f.source.get(f.member).wakeBudget.lastAt, lastAt, 'the 60-second limit keeps its time');
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'))).sessions.find(s => s.id === f.member);
  assert.equal(saved.wakeBudget.senders[f.butlerKey].streak, 0, 'saved with the delivery');
  const fourth = await f.send(f.butler, f.member);
  assert.deepEqual([fourth.result.status, fourth.sent], ['staged', true]);
  assert.equal(f.streak(f.butlerKey), 1);
});
test('without a delivered message from the member, the butler\'s fourth is refused as before', async t => {
  const f = await butlerAndMember(t);
  for (let i = 0; i < 3; i++) assert.equal((await f.send(f.butler, f.member)).sent, true);
  const fourth = await f.send(f.butler, f.member);
  assert.deepEqual([fourth.result.status, fourth.sent], ['not-sent', false]);
  assert.match(fourth.result.message, /连续 3 次/);
  assert.equal(f.streak(f.butlerKey), 3);
});
test('a member\'s message to the butler that was not sent, cancelled or unconfirmed clears nothing', async t => {
  const outcomes = {
    'not-sent': [f => { f.target.get(f.butler).wakeDisabled = true; }, f => { f.target.get(f.butler).wakeDisabled = false; }],
    cancelled: [() => {}, () => {}, 'interrupted'],
    unconfirmed: [f => { f.real = f.source.peerRunner.transferWake; f.source.peerRunner.transferWake = async () => { throw Error('Synthetic lost acknowledgement'); }; }, f => { f.source.peerRunner.transferWake = f.real; }],
  };
  for (const [status, [before, after, turnEnd]] of Object.entries(outcomes)) {
    const f = await butlerAndMember(t);
    for (let i = 0; i < 3; i++) assert.equal((await f.send(f.butler, f.member)).sent, true, status);
    before(f); const reply = await f.send(f.member, f.butler, turnEnd); after(f);
    assert.deepEqual([reply.sent, reply.row.wake.status], [false, status], status);
    assert.equal(f.streak(f.butlerKey), 3, status);
    const fourth = await f.send(f.butler, f.member);
    assert.deepEqual([fourth.result.status, fourth.sent], ['not-sent', false], status);
  }
});
test('between ordinary sessions, a delivered answer still clears nothing', async t => {
  const f = await butlerAndMember(t, { designate: false });
  for (let i = 0; i < 3; i++) assert.equal((await f.send(f.butler, f.member)).sent, true);
  const reply = await f.send(f.member, f.butler);
  assert.deepEqual([reply.sent, reply.row.wake.status], [true, 'submitted']);
  assert.equal(f.streak(f.butlerKey), 3);
  const fourth = await f.send(f.butler, f.member);
  assert.deepEqual([fourth.result.status, fourth.sent], ['not-sent', false]);
});
