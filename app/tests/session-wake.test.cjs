const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { Workspace } = require('../workspace.cjs');
const { PeerRunner } = require('../peer-handoffs.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
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
    ['cooldown', f => { const s = f.target.get(f.b); s.wakeBudget = { id: 'earlier', lastAt: Date.now(), streak: 1, humanRevision: s.wakeHumanRevision || 0 }; }, '收件方刚收过自动消息：两条至少隔 60 秒，连续最多 3 条。', 'The recipient just received an automatic message: at least 60 seconds apart, at most 3 in a row.'],
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
  assert.equal(m.s.wakeBudget.streak, 1); assert.equal(f.writes.length, 0);
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

for (const data of ['x', '\x1b[?2026;2$yx', '\x1b[?2026;9$y', '\x1b[<0;10;5M']) test(`human input still withdraws the staged wake: ${JSON.stringify(data)}`, async t => {
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

test('next-turn native input still revokes a transfer waiting to consume its credential', async t => {
  const f = await fixture(t, 'codex', true, true), nativeId = f.source.get(f.a).nativeId;
  await f.call(); const row = f.source.get(f.a).messages.find(m => m.wake);
  f.ra.event({ method: 'turn/completed', params: { threadId: nativeId, turn: { id: 'turn-one', status: 'completed' } } });
  f.start('queued-turn');
  f.ra.event({ method: 'item/completed', params: { threadId: nativeId, turnId: 'queued-turn', item: { id: 'new-input', type: 'userMessage', content: [{ type: 'text', text: 'A new instruction' }] } } });
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(f.writes.length, 0); assert.equal(row.wake.status, 'unconfirmed');
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
test('a cross-session message is not the person, yet its input boundary still voids a staged wake (T-137)', async t => {
  const f = await fixture(t, 'claude'); assert.equal((await f.call()).status, 'staged');
  const before = [f.source.get(f.a).controlRevision, f.source.get(f.a).wakeHumanRevision || 0];
  f.ra.emit('nativeInput', '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="X">\nhi\n</cross-session-message>', { id: 'peer-input', source: 'naw-peer' });
  assert.deepEqual([f.source.get(f.a).controlRevision, f.source.get(f.a).wakeHumanRevision || 0], before, 'not a person acting on the sender');
  assert.equal(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'staged');
  // The mod sends control:input for every foreign submission, a peer one included.
  f.ra.emit('nativeControlBoundary', 'control:input');
  await f.finish();
  assert.notEqual(f.source.get(f.a).messages.find(m => m.wake).wake.status, 'submitted', 'the boundary voids it');
  assert.equal(f.writes.length, 0);
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
test('an identical repeated Claude prompt cannot reauthorize a wake; a fresh turn can (T-141)', async t => {
    const f = await fixture(t, 'claude');
    const typed = () => f.ra.hook({ hook_event_name: 'UserPromptSubmit', session_id: f.source.get(f.a).nativeId, prompt_id: f.ra.liveTurn.promptId, prompt: 'Continue one bounded task.' });
    typed(); // The first hook may arrive after native turn-start.
    typed(); // Native316/317 may reuse that same id/text for a mid-turn queued prompt.
    await assert.rejects(async () => f.call(), error => error.uiMessage?.key === 'error.wake.turnRevokedByHuman');
    assert.equal(f.source.get(f.a).messages.some(message => message.wake), false, 'No misleading registered wake after the boundary');
    assert.equal(f.writes.length, 0);
    await f.finish('boundary');
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
    assert.equal(f.target.get(id).wakeBudget.streak, 1, 'each recipient keeps its own limit');
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

// The wake proposal, item 3 (board 11-12 16:44: 「③只做读到真人的话后重新授权、不在真人的话后附行」; 23:44:19: 「真人插话之后、
// 他的话还没读到之前，这一回合仍然发不出」). A Claude sender in a turn; the person queues words into it through NAW, the real
// adapter takes native's append receipt, and native's read of them comes as the submission channel's read event.
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
test('the person speaking into a sender\'s turn: before the turn reads it, it cannot send; once read, it sends again, once (wake proposal, item 3)', async t => {
  const f = await personSpeaks(t);
  assert.equal((await f.send(f.b, 'Before the person spoke.', 'before')).status, 'staged');
  const words = await f.say('Send Receiver the new plan instead.');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].midturn, true);
  const row = f.s.messages.find(m => m.id === words.tag);
  assert.equal(row.deliveredInto, f.ra.turnId, 'native stored the words in the running turn');
  let refusal; await assert.rejects(f.send(f.b, 'Decided before reading the person.', 'unread'), error => { refusal = error; return refusedAs('error.wake.turnAwaitingHumanRead')(error); });
  assert.equal(refusal.message, '真人刚在这一回合插了话，这一回合还没读到；读到之后可以再发。');
  assert.equal(require('../ui-locale.js').displayText('en', refusal.message, refusal.uiMessage), 'The person just spoke into this turn, and the turn has not read it yet; once it has, it can send again.');
  assert.equal(f.sent().length, 1, 'a refusal before the read registers nothing');
  f.read(words);
  assert.equal(row.nativeRead, true);
  assert.equal((await f.send(f.b, 'The new plan.', 'after')).status, 'staged');
  await assert.rejects(f.send(f.b, 'And one more.', 'more'), /这一轮已经登记过|已经请求过/, 'still one message a turn for a session that is not the butler');
  await f.finish();
  assert.equal(f.writes.length, 1);
  assert.match(f.writes[0].text, /\nThe new plan\.$/);
  const [before, after] = f.sent();
  assert.equal(before.wake.status, 'cancelled', 'what the turn registered before the person spoke stays withdrawn');
  assert.equal(before.wake.cancellation.code, 'source-identity-changed');
  assert.equal(after.wake.status, 'submitted'); assert.equal(after.wake.epoch, 1);
});
test('words this turn will not read leave it revoked, not told to wait: not sent, unconfirmed, or no mid-turn delivery (wake proposal, item 3)', async t => {
  for (const [name, kind, status] of [['not sent', 'not-sent', 'not-sent'], ['unconfirmed', 'unconfirmed', 'unconfirmed']]) {
    const f = await personSpeaks(t);
    f.fail(kind);
    await assert.rejects(f.source.queue(f.a, 'Use the other plan.', 'source-owner'));
    assert.equal(f.s.messages.find(m => m.origin === 'human' && m.text === 'Use the other plan.').status, status, name);
    await assert.rejects(f.send(f.b, 'After the words.', 'failed'), refusedAs('error.wake.turnRevokedByHuman'), name);
    assert.equal(f.sent().length, 0, name);
  }
  // A Claude version without mid-turn delivery: the words wait for the turn to end and run as their own turn.
  const f = await personSpeaks(t); f.ra.nativeMidturnAppend = false; f.fail('held');
  const queued = f.source.queue(f.a, 'Next, please.', 'source-owner');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].midturn, false, 'not offered into the running turn');
  await assert.rejects(f.send(f.b, 'Still this turn.', 'same'), refusedAs('error.wake.turnRevokedByHuman'));
  f.read({ tag: f.requests[0].tag, uuid: '00000000-0000-4000-8000-000000000001' });
  await assert.rejects(f.send(f.b, 'Still this turn, again.', 'again'), refusedAs('error.wake.turnRevokedByHuman'));
  f.release(); await queued;
  await f.finish();
  assert.equal(f.writes.length, 0);
});
test('the read authorizes nothing when the person acted again, everything was paused, or it is not the turn\'s read of those words (wake proposal, item 3)', async t => {
  const cases = {
    'a takeover before the read': async f => { f.source.claim(f.a, 'another-window'); },
    'the person typing in the terminal before the read': async f => { f.s.view = 'terminal'; f.ra.terminal = { alive: true, input() {} }; f.source.input(f.a, 'x', 'source-owner'); },
    'pausing all handoffs before the read': async f => { f.source.pauseAll('stop'); },
    // Only the person's words reopen the turn: here another agent's, queued through NAW's background control.
    'another agent\'s words': async (f, words) => {
      f.read(words); await f.send(f.b, 'After the person.', 'first');
      const actor = { id: 'other-session', name: 'Other agent', nativeId: 'other-native', provider: 'claude', callId: 'call-1', turnId: 'turn-1', operationId: 'operation-1' };
      return require('../background-operation.cjs').run(actor, () => f.say('From another agent.'));
    },
    'a read reported for another turn': async (f, words) => { f.read(words, 'another-turn'); },
    'a read of other words': async f => { f.read({ tag: '11111111-1111-4111-8111-111111111111', uuid: '00000000-0000-4000-8000-000000000009' }); },
  };
  for (const [name, act] of Object.entries(cases)) {
    const f = await personSpeaks(t), words = await f.say('Hold on.');
    const other = await act(f, words);
    if (other) f.read(other); else if (!name.startsWith('a read')) f.read(words);
    // The other words are still unread, so that turn is told to wait; every other case is over for the turn.
    const expected = name === 'a read of other words' ? 'error.wake.turnAwaitingHumanRead' : 'error.wake.turnRevokedByHuman';
    await assert.rejects(f.send(f.b, 'Must not go.', 'after'), refusedAs(expected), name);
    await f.finish();
    assert.equal(f.writes.length, 0, name);
  }
});
test('the person\'s second words before the first are read: only reading the latest lets the turn send (wake proposal, item 3)', async t => {
  const f = await personSpeaks(t);
  const first = await f.say('One thing.'), second = await f.say('And another.');
  f.read(first);
  await assert.rejects(f.send(f.b, 'Too early.', 'early'), refusedAs('error.wake.turnAwaitingHumanRead'));
  f.read(second);
  assert.equal((await f.send(f.b, 'After both.', 'late')).status, 'staged');
  await f.finish();
  assert.equal(f.writes.length, 1);
});
test('words that run as their own later turn do not reopen the turn they waited behind (wake proposal, item 3)', async t => {
  const f = await personSpeaks(t); f.ownTurn();
  const words = await f.say('Next, please.');
  assert.equal(f.s.messages.find(m => m.id === words.tag).deliveredInto, undefined);
  await assert.rejects(f.send(f.b, 'Before the turn ends.', 'before-end'), refusedAs('error.wake.turnRevokedByHuman'), 'native will not read them in this turn');
  f.read(words);
  await assert.rejects(f.send(f.b, 'Still this turn.', 'same'), refusedAs('error.wake.turnRevokedByHuman'));
  await f.finish();
  assert.equal(f.writes.length, 0);
});
test('the butler, after reading the person, may message a recipient it already registered one for in that turn (wake proposal, items 2 and 3)', async t => {
  const f = await personSpeaks(t, { steward: true });
  assert.equal((await f.send(f.b, 'First version.', 'one')).status, 'staged');
  f.read(await f.say('Change it.'));
  assert.equal((await f.send(f.b, 'Changed version.', 'two')).status, 'staged');
  await assert.rejects(f.send(f.b, 'Third.', 'three'), /这一轮已经给这个收件方登记过一条/);
  await f.finish();
  assert.equal(f.writes.length, 1); assert.match(f.writes[0].text, /\nChanged version\.$/);
  assert.deepEqual(f.sent().map(m => m.wake.status), ['cancelled', 'submitted']);
});
