const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs');
const { MobileAccess } = require('../mobile-access.cjs');

// The phone adds instructions to a working Codex turn through Workspace.steer, the Mac composer's own steer.
async function fixture(t, providers = ['codex']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-steer-')));
  const calls = [], made = [];
  const host = { binaries: {}, close() {}, rpc: { reply() {} }, create(s) {
    const r = new EventEmitter(); r.chatAvailable = true; r.finishTurn = () => {};
    r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag) => { calls.push({ method: 'send', session: s.id, text, tag }); r.emit('submitted', tag); };
    r.queue = async (text, tag) => { calls.push({ method: 'queue', session: s.id, text, tag }); };
    // As the Codex adapter: the expected turn and the guard are checked before turn/steer; the receipt is held until
    // the test says native answered (r.ack) or the answer was lost (r.lose).
    r.steer = async (text, tag, expectedTurnId, guard) => {
      if (!r.steerAvailable || r.turnId !== expectedTurnId || !guard()) throw Error('Synthetic turn changed before steer');
      calls.push({ method: 'steer', session: s.id, text, tag, expectedTurnId });
      return new Promise((resolve, reject) => {
        r.ack = () => { r.emit('submitted', tag); resolve(expectedTurnId); };
        r.lose = error => reject(error);
      });
    };
    made.push(r); return r;
  } };
  const w = new Workspace(host, root), access = new MobileAccess(root, { exclusive: () => true }); access.initialize();
  const sessions = [];
  for (const [i, provider] of providers.entries()) {
    const id = await w.create(provider, root, 'desktop-owner', 'Synthetic member ' + i), s = w.get(id);
    s.nativeId = 'synthetic-native-' + i;
    sessions.push({ id, s, r: made.at(-1), target: { serviceKey: '.', sessionId: id, nativeId: s.nativeId } });
  }
  const actor = 'synthetic-human', site = 'https://mobile.invalid';
  const qr = access.beginPairing({ actor, origin: site, scopes: sessions.map(x => ({ ...x.target, actions: ['read', 'send', 'answer'] })) });
  const device = access.pair({ secret: qr.secret, actor, origin: site });
  const ticket = (action, x) => access.authorize({ token: device.cookieValue, actor, origin: site, csrf: device.csrf, action, target: x.target });
  const read = x => w.mobileRead(ticket('read', x));
  const spec = (x, text) => ({ requestId: randomUUID(), proof: read(x).proof, text });
  t.after(() => { w.close(); fs.rmSync(root, { recursive: true }); });
  return { w, root, calls, sessions, ticket, read, spec };
}
const working = (x, turn = 'synthetic-turn-1') => { x.s.state = 'working'; x.r.turnId = turn; x.r.steerAvailable = true; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const pick = row => ({ canSend: row.canSend, sendMode: row.sendMode, sendBlocked: row.sendBlocked });
const phone = x => x.s.messages.filter(m => m.origin === 'human-mobile');

test('a working Codex session reads as steer on the phone, as the Mac composer decides it', async t => {
  const f = await fixture(t), [b] = f.sessions;
  assert.deepEqual(pick(f.read(b)), { canSend: true, sendMode: 'send', sendBlocked: null });
  working(b);
  assert.deepEqual(pick(f.read(b)), { canSend: true, sendMode: 'steer', sendBlocked: null });
  for (const [change, undo, reason] of [
    [() => { b.r.pendingSteer = 'desktop-steer'; }, () => { b.r.pendingSteer = null; }, 'steerBusy'],
    [() => { b.r.steerAvailable = false; }, () => { b.r.steerAvailable = true; }, 'noQueue'],
    [() => { b.r.turnId = null; }, () => { b.r.turnId = 'synthetic-turn-1'; }, 'noQueue'],
    [() => { b.s.approval = { id: 'synthetic-approval' }; }, () => { b.s.approval = null; }, 'approval'],
    [() => { b.r.nativeAbortRequest = { id: 'synthetic-abort' }; }, () => { b.r.nativeAbortRequest = null; }, 'interrupt'],
  ]) {
    change(); assert.deepEqual(pick(f.read(b)), { canSend: false, sendMode: null, sendBlocked: reason }, reason); undo();
  }
  assert.deepEqual(pick(f.read(b)), { canSend: true, sendMode: 'steer', sendBlocked: null });
  // The turn the phone read travels in the proof the broker keeps; an idle read carries none.
  assert.equal(f.read(b).proof.turnId, 'synthetic-turn-1');
  b.s.state = 'idle'; b.r.turnId = null; assert.deepEqual(Object.keys(f.read(b).proof).sort(), ['connectionRevision', 'controlRevision', 'nativeId']);
});

test('a phone message to a working Codex session goes once into the turn the phone read and ends at its steer receipt', async t => {
  const f = await fixture(t), [b] = f.sessions; working(b);
  f.w.setDraft(b.id, 'Private desktop draft', 'desktop-owner');
  const peer = b.s.peerRevision || 0, spec = f.spec(b, '  Phone words for the running turn  ');
  const sending = f.w.mobileSend(f.ticket('send', b), spec); await settle();
  assert.deepEqual(f.calls.map(c => [c.method, c.session, c.text, c.expectedTurnId]), [['steer', b.id, spec.text, 'synthetic-turn-1']]);
  const [message] = phone(b);
  assert.deepEqual({ inputMode: message.inputMode, turnId: message.turnId, status: message.status }, { inputMode: 'steer', turnId: 'synthetic-turn-1', status: 'awaiting-native' });
  assert.equal(b.r.pendingSteer, message.id);
  b.r.ack(); const result = await sending;
  assert.equal(result.status, 'submitted'); assert.equal(result.tag, message.id); assert.equal(message.status, 'submitted');
  assert.equal(b.r.pendingSteer, null); assert.equal(b.s.owner, 'desktop-owner'); assert.equal(f.w.drafts.get(b.id), 'Private desktop draft');
  assert.ok((b.s.peerRevision || 0) >= peer);
  const disk = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8'));
  assert.equal(disk.mobileRequests.length, 1); assert.equal(disk.mobileRequests[0].status, 'submitted');
  assert.equal((await f.w.mobileSend(f.ticket('send', b), spec)).status, 'submitted');
  assert.equal(f.calls.length, 1); assert.equal(phone(b).length, 1);
});

test('when the turn changed after the phone read it, nothing is sent: not into another turn, not as a new turn', async t => {
  for (const change of [
    b => { b.r.turnId = 'synthetic-turn-2'; },
    b => { b.s.state = 'idle'; b.r.turnId = null; },
  ]) {
    const f = await fixture(t), [b] = f.sessions; working(b);
    const spec = f.spec(b, 'Words for turn one'); change(b);
    const result = await f.w.mobileSend(f.ticket('send', b), spec);
    assert.equal(result.status, 'not-sent'); assert.equal(f.calls.length, 0); assert.equal(phone(b).length, 0);
    assert.equal((await f.w.mobileSend(f.ticket('send', b), spec)).status, 'not-sent'); assert.equal(f.calls.length, 0);
  }
});

test('a turn that changes between prepare and commit is not sent', async t => {
  const f = await fixture(t), [b] = f.sessions; working(b);
  const connection = {}, spec = f.spec(b, 'Prepared for turn one');
  const ready = f.w.mobilePrepare(f.ticket('send', b), spec, 'send', connection); assert.equal(ready.prepared, true);
  b.r.turnId = 'synthetic-turn-2';
  const result = await f.w.mobileCommit(f.ticket('send', b), ready.lease, 'send', connection);
  assert.equal(result.status, 'not-sent'); assert.equal(f.calls.length, 0); assert.equal(phone(b).every(m => m.status === 'not-sent'), true);
  assert.equal(b.r.pendingSteer ?? null, null);
});

test('while one instruction is being added, another from the phone is refused and not sent', async t => {
  const f = await fixture(t), [b] = f.sessions; working(b);
  const first = f.spec(b, 'First instruction'), sending = f.w.mobileSend(f.ticket('send', b), first); await settle();
  assert.deepEqual(pick(f.read(b)), { canSend: false, sendMode: null, sendBlocked: 'steerBusy' });
  const second = await f.w.mobileSend(f.ticket('send', b), f.spec(b, 'Second instruction')).catch(error => ({ status: 'refused', error }));
  assert.ok(['not-sent', 'refused'].includes(second.status)); assert.equal(f.calls.length, 1);
  b.r.ack(); assert.equal((await sending).status, 'submitted'); assert.equal(f.calls.length, 1);
});

test('an uncertain steer outcome stays unconfirmed and is not sent again', async t => {
  const f = await fixture(t), [b] = f.sessions; working(b);
  const spec = f.spec(b, 'Phone instruction with a lost answer'), sending = f.w.mobileSend(f.ticket('send', b), spec); await settle();
  b.r.lose(Error('Synthetic lost acknowledgement'));
  assert.equal((await sending).status, 'unconfirmed');
  assert.equal((await f.w.mobileSend(f.ticket('send', b), spec)).status, 'unconfirmed'); assert.equal(f.calls.length, 1);
  assert.equal(phone(b)[0].status, 'unconfirmed'); assert.equal(f.w.mobileRequests[0].status, 'unconfirmed');
});

test('a phone instruction reaches only the session its grant names', async t => {
  const f = await fixture(t, ['codex', 'codex']), [a, b] = f.sessions; working(a); working(b);
  const spec = f.spec(a, 'Only for session A');
  await assert.rejects(f.w.mobileSend(f.ticket('send', b), spec));
  assert.equal(f.calls.length, 0); assert.equal(phone(b).length, 0);
  const sending = f.w.mobileSend(f.ticket('send', a), spec); await settle(); a.r.ack();
  assert.equal((await sending).sessionId, a.id); assert.deepEqual(f.calls.map(c => c.session), [a.id]); assert.equal(b.r.pendingSteer ?? null, null);
});

test('an idle read does not become a steer when Codex starts working before the send', async t => {
  const f = await fixture(t), [b] = f.sessions;
  const spec = f.spec(b, 'Written while idle'); working(b);
  const result = await f.w.mobileSend(f.ticket('send', b), spec).catch(() => ({ status: 'refused' }));
  assert.ok(['not-sent', 'refused'].includes(result.status)); assert.equal(f.calls.length, 0); assert.equal(phone(b).length, 0);
});

test('Workspace.steer takes a phone delegate only from mobile-session', async t => {
  const f = await fixture(t), [b] = f.sessions; working(b);
  await assert.rejects(f.w.steer(b.id, 'Forged delegate', null, 'synthetic-turn-1', null, { valid: () => true, human() {}, reserve() {} }));
  assert.equal(f.calls.length, 0); assert.equal(b.r.pendingSteer ?? null, null);
});

test('the Mac composer\'s own steer is unchanged', async t => {
  const f = await fixture(t), [b] = f.sessions; working(b);
  f.w.setDraft(b.id, 'Mac instruction', 'desktop-owner');
  const control = b.s.controlRevision, peer = b.s.peerRevision || 0;
  const sending = f.w.steer(b.id, 'Mac instruction', 'desktop-owner', 'synthetic-turn-1'); await settle();
  const message = b.s.messages.at(-1);
  assert.deepEqual({ origin: message.origin, inputMode: message.inputMode, turnId: message.turnId }, { origin: 'human', inputMode: 'steer', turnId: 'synthetic-turn-1' });
  assert.equal(b.s.controlRevision, control + 1); assert.equal(b.s.peerRevision || 0, peer);
  b.r.ack(); assert.equal(await sending, message.id); assert.equal(f.w.drafts.get(b.id), '');
  await assert.rejects(f.w.steer(b.id, 'Wrong owner', 'observer', 'synthetic-turn-1'));
  await assert.rejects(f.w.steer(b.id, 'Stale turn', 'desktop-owner', 'synthetic-turn-0'));
  assert.equal(f.calls.length, 1); assert.equal(f.w.mobileRequests?.length || 0, 0);
});

// Rebased onto a5517e88 (Claude 7, F1 and C-a2): a steer proof uses the same comparison as a queued send.
test('a steer read names its mode and turn in the proof the broker keeps', async t => {
  const f = await fixture(t), [b] = f.sessions; working(b);
  const value = f.read(b).proof;
  assert.deepEqual(Object.keys(value).sort(), ['connectionRevision', 'controlRevision', 'nativeId', 'sendMode', 'turnId']);
  assert.deepEqual({ sendMode: value.sendMode, turnId: value.turnId }, { sendMode: 'steer', turnId: 'synthetic-turn-1' });
});

test('an idle read pressed after Codex started working keeps a stored not-sent receipt, not a refusal', async t => {
  const f = await fixture(t), [b] = f.sessions;
  const spec = f.spec(b, 'Written while idle'); working(b);
  const result = await f.w.mobileSend(f.ticket('send', b), spec);
  assert.equal(result.status, 'not-sent'); assert.equal(f.calls.length, 0); assert.equal(phone(b).length, 0);
  assert.equal((await f.w.mobileSend(f.ticket('send', b), spec)).status, 'not-sent'); assert.equal(f.calls.length, 0);
});

// C-a1: native's refusal before turn/steer carries notSent (adapters.cjs steer), and Workspace.steer keeps it.
test('a steer native refused before turn/steer is not-sent on the Mac and the phone; a lost answer stays unconfirmed', async t => {
  const f = await fixture(t), [b] = f.sessions; working(b);
  const refuse = (callGuard) => { b.r.steer = async (text, tag, turn, guard) => { if (callGuard) guard(); throw Object.assign(Error('Synthetic refusal before turn/steer'), { notSent: true }); }; };
  refuse(false);
  f.w.setDraft(b.id, 'Mac instruction', 'desktop-owner');
  await assert.rejects(f.w.steer(b.id, 'Mac instruction', 'desktop-owner', 'synthetic-turn-1'));
  assert.equal(b.s.messages.at(-1).status, 'not-sent'); assert.equal(f.w.drafts.get(b.id), 'Mac instruction');
  assert.equal(b.r.pendingSteer, null);
  refuse(true);
  const result = await f.w.mobileSend(f.ticket('send', b), f.spec(b, 'Phone instruction'));
  assert.equal(result.status, 'not-sent'); assert.equal(phone(b).at(-1).status, 'not-sent');
  b.r.steer = async () => { throw Error('Synthetic lost answer after turn/steer'); };
  await assert.rejects(f.w.steer(b.id, 'Mac instruction', 'desktop-owner', 'synthetic-turn-1'));
  assert.equal(b.s.messages.at(-1).status, 'unconfirmed');
});

// Claude 7's R11 (forged turn on a Claude proof) under a5517e88, where a queued Claude proof carries its own turn.
test('a Claude queue proof forged to steer, to another turn or to no turn sends nothing', async t => {
  const f = await fixture(t, ['claude']), [a] = f.sessions;
  a.s.state = 'working'; a.r.queueAvailable = true; a.r.turnId = 'synthetic-turn-1';
  const genuine = f.read(a).proof; assert.deepEqual({ sendMode: genuine.sendMode, turnId: genuine.turnId }, { sendMode: 'queue', turnId: 'synthetic-turn-1' });
  const { turnId, ...noTurn } = genuine;
  for (const proof of [{ ...genuine, sendMode: 'steer' }, { ...genuine, turnId: 'synthetic-turn-0' }, noTurn]) {
    const out = await f.w.mobileSend(f.ticket('send', a), { requestId: randomUUID(), proof, text: 'Forged' }).then(x => x.status, () => 'refused');
    assert.ok(['refused', 'not-sent'].includes(out), out);
  }
  assert.equal(f.calls.length, 0); assert.equal(turnId, 'synthetic-turn-1');
  await f.w.mobileSend(f.ticket('send', a), { requestId: randomUUID(), proof: genuine, text: 'Genuine' });
  assert.deepEqual(f.calls.map(c => c.method), ['queue']);
});
