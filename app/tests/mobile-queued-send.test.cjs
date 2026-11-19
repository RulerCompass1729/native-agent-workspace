const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { Workspace } = require('../workspace.cjs');
const { MobileAccess } = require('../mobile-access.cjs');

// The phone reaches a working Claude session through Workspace.queue, the Mac composer's own queue.
async function fixture(t, providers = ['claude']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-queue-')));
  const calls = [], made = [];
  const host = { binaries: {}, close() {}, rpc: { reply() {} }, create(s) {
    const r = new EventEmitter(); r.chatAvailable = true; r.finishTurn = () => {};
    r.start = async () => r.emit('state', 'idle');
    r.send = async (text, tag, guard) => { calls.push({ method: 'send', session: s.id, text, tag }); assert.equal(guard(), true); r.emit('submitted', tag); };
    r.steer = async (text, tag) => { calls.push({ method: 'steer', session: s.id, text, tag }); };
    // Held until the test says native read it (r.read) or refused it (r.refuse), as a running turn holds a queued message.
    r.queue = async (text, tag, guard) => {
      calls.push({ method: 'queue', session: s.id, text, tag });
      if (r.refuseNow || !guard()) throw Object.assign(Error('Synthetic native refusal'), { notSent: true });
      return new Promise((resolve, reject) => {
        r.read = () => { r.emit('submitted', tag); resolve({ mode: 'append', turnId: 'synthetic-turn' }); };
        r.refuse = error => reject(error);
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
const working = (x, midturn = true) => { x.s.state = 'working'; x.r.turnId = 'synthetic-turn'; x.r.queueAvailable = true; x.r.midturnAvailable = midturn; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const pick = row => ({ canSend: row.canSend, sendMode: row.sendMode, sendBlocked: row.sendBlocked });

test('the phone read says how a send would go, as the Mac composer decides it', async t => {
  const f = await fixture(t, ['claude', 'codex']), [a, b] = f.sessions;
  assert.deepEqual(pick(f.read(a)), { canSend: true, sendMode: 'send', sendBlocked: null });
  working(a);
  assert.deepEqual(pick(f.read(a)), { canSend: true, sendMode: 'queueMidturn', sendBlocked: null });
  a.r.midturnAvailable = false;
  assert.deepEqual(pick(f.read(a)), { canSend: true, sendMode: 'queue', sendBlocked: null });
  for (const [change, undo, reason] of [
    [() => { a.r.pendingQueue = 'desktop-queued'; }, () => { a.r.pendingQueue = null; }, 'queueBusy'],
    [() => { a.r.queueAvailable = false; }, () => { a.r.queueAvailable = true; }, 'noQueue'],
    [() => { a.s.approval = { id: 'synthetic-approval' }; }, () => { a.s.approval = null; }, 'approval'],
    [() => { a.s.approval = { id: 'synthetic-approval', pending: true }; }, () => { a.s.approval = null; }, 'answerPending'],
    [() => { a.r.nativeAbortRequest = { id: 'synthetic-abort' }; }, () => { a.r.nativeAbortRequest = null; }, 'interrupt'],
    [() => { a.r.nativeInputRequired = true; }, () => { a.r.nativeInputRequired = false; }, 'interrupt'],
    [() => { a.r.transportDisconnected = true; }, () => { a.r.transportDisconnected = false; }, 'disconnected'],
    [() => { a.r.chatAvailable = false; }, () => { a.r.chatAvailable = true; }, 'disconnected'],
  ]) {
    change(); assert.deepEqual(pick(f.read(a)), { canSend: false, sendMode: null, sendBlocked: reason }, reason); undo();
  }
  assert.deepEqual(pick(f.read(a)), { canSend: true, sendMode: 'queue', sendBlocked: null });
  b.s.state = 'working'; b.r.steerAvailable = true; b.r.turnId = 'synthetic-turn';
  assert.deepEqual(pick(f.read(b)), { canSend: false, sendMode: null, sendBlocked: 'steer' });
});

test('a phone message to a working Claude session waits in its native queue and the phone hears back once it stands there', async t => {
  const f = await fixture(t), [a] = f.sessions; working(a);
  f.w.setDraft(a.id, 'Private desktop draft', 'desktop-owner');
  const spec = f.spec(a, '  Phone words for the running turn  ');
  const result = await f.w.mobileSend(f.ticket('send', a), spec);
  assert.equal(result.status, 'awaiting-native');
  assert.deepEqual(f.calls.map(c => [c.method, c.session, c.text]), [['queue', a.id, spec.text]]);
  const message = a.s.messages.find(m => m.id === result.tag);
  assert.deepEqual({ origin: message.origin, inputMode: message.inputMode, midturn: message.midturn, status: message.status },
    { origin: 'human-mobile', inputMode: 'queue', midturn: true, status: 'awaiting-native' });
  assert.equal(a.r.pendingQueue, result.tag); assert.equal(a.s.owner, 'desktop-owner'); assert.equal(f.w.drafts.get(a.id), 'Private desktop draft');
  a.r.read(); await settle();
  assert.equal((await f.w.mobileReceipt(f.ticket('send', a), spec, 'send')).status, 'submitted');
  assert.equal(a.r.pendingQueue, null);
  const disk = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8'));
  assert.equal(disk.mobileRequests.length, 1); assert.equal(disk.mobileRequests[0].status, 'submitted');
  assert.equal(f.calls.length, 1);
});

test('the same phone request is never queued twice and a second message waits until the first is delivered', async t => {
  const f = await fixture(t), [a] = f.sessions; working(a);
  const spec = f.spec(a, 'First phone message');
  const first = await f.w.mobileSend(f.ticket('send', a), spec);
  const again = await f.w.mobileSend(f.ticket('send', a), spec);
  assert.equal(again.tag, first.tag); assert.equal(again.status, 'awaiting-native'); assert.equal(f.calls.length, 1);
  assert.deepEqual(pick(f.read(a)), { canSend: false, sendMode: null, sendBlocked: 'queueBusy' });
  await assert.rejects(f.w.mobileSend(f.ticket('send', a), f.spec(a, 'Second phone message')));
  assert.equal(f.calls.length, 1); assert.equal(f.w.mobileRequests.length, 1);
  assert.equal(a.s.messages.filter(m => m.origin === 'human-mobile').length, 1);
  a.r.read(); await settle();
  assert.equal((await f.w.mobileSend(f.ticket('send', a), spec)).status, 'submitted'); assert.equal(f.calls.length, 1);
});

test('an uncertain native outcome stays unconfirmed and is not sent again', async t => {
  const f = await fixture(t), [a] = f.sessions; working(a);
  const spec = f.spec(a, 'Phone message with a lost answer');
  assert.equal((await f.w.mobileSend(f.ticket('send', a), spec)).status, 'awaiting-native');
  a.r.refuse(Error('Synthetic lost acknowledgement')); await settle();
  const after = await f.w.mobileSend(f.ticket('send', a), spec);
  assert.equal(after.status, 'unconfirmed'); assert.equal(f.calls.length, 1);
  assert.equal(a.s.messages.find(m => m.id === after.tag).status, 'unconfirmed'); assert.equal(f.w.mobileRequests[0].status, 'unconfirmed');
});

test('the early receipt is this request\'s own queued row, never a Mac message with the same words', async t => {
  const f = await fixture(t), [a] = f.sessions; working(a);
  const mac = f.w.queue(a.id, 'Same words', 'desktop-owner'); a.r.read(); const macTag = await mac;
  const spec = f.spec(a, 'Same words'), result = await f.w.mobileSend(f.ticket('send', a), spec);
  assert.equal(result.requestId, spec.requestId); assert.notEqual(result.tag, macTag); assert.equal(result.status, 'awaiting-native');
  assert.equal(a.r.pendingQueue, result.tag); assert.equal(f.w.mobileRequests[0].tag, result.tag);
  assert.equal(a.s.messages.find(m => m.id === result.tag).origin, 'human-mobile'); assert.equal(a.s.messages.find(m => m.id === macTag).origin, 'human');
  a.r.read(); await settle();
  assert.equal((await f.w.mobileReceipt(f.ticket('send', a), spec, 'send')).tag, result.tag);
});
test('a refusal that arrives after the early receipt is kept on the same request', async t => {
  const f = await fixture(t), [a] = f.sessions; working(a);
  const spec = f.spec(a, 'Phone message native later refuses');
  assert.equal((await f.w.mobileSend(f.ticket('send', a), spec)).status, 'awaiting-native');
  a.r.refuse(Object.assign(Error('Synthetic later refusal'), { notSent: true })); await settle();
  const after = await f.w.mobileReceipt(f.ticket('send', a), spec, 'send');
  assert.equal(after.status, 'not-sent'); assert.equal(a.s.messages.find(m => m.id === after.tag).status, 'not-sent'); assert.equal(a.r.pendingQueue, null); assert.equal(f.calls.length, 1);
});
test('a queue native refuses at once is reported as not sent', async t => {
  const f = await fixture(t), [a] = f.sessions; working(a); a.r.refuseNow = true;
  const result = await f.w.mobileSend(f.ticket('send', a), f.spec(a, 'Refused phone message'));
  assert.equal(result.status, 'not-sent'); assert.equal(a.s.messages.find(m => m.id === result.tag).status, 'not-sent'); assert.equal(a.r.pendingQueue, null);
});

test('a phone message reaches only the session its grant names', async t => {
  const f = await fixture(t, ['claude', 'claude']), [a, b] = f.sessions; working(a); working(b);
  const before = b.s.messages.length, spec = f.spec(a, 'Only for session A');
  await assert.rejects(f.w.mobileSend(f.ticket('send', b), spec));
  assert.equal(f.calls.length, 0);
  const result = await f.w.mobileSend(f.ticket('send', a), spec);
  assert.equal(result.sessionId, a.id); assert.deepEqual(f.calls.map(c => c.session), [a.id]);
  assert.equal(b.s.messages.length, before); assert.equal(b.r.pendingQueue ?? null, null);
});

test('a working Codex session takes nothing from the phone: no steer, queue or send', async t => {
  const f = await fixture(t, ['codex']), [b] = f.sessions;
  b.s.state = 'working'; b.r.steerAvailable = true; b.r.turnId = 'synthetic-turn'; b.r.queueAvailable = true;
  const control = b.s.controlRevision;
  await assert.rejects(f.w.mobileSend(f.ticket('send', b), f.spec(b, 'Phone words for Codex')));
  assert.equal(f.calls.length, 0); assert.equal(b.s.controlRevision, control); assert.equal(f.w.mobileRequests.length, 0);
});

test('Workspace.queue takes a phone delegate only from mobile-session', async t => {
  const f = await fixture(t), [a] = f.sessions; working(a);
  await assert.rejects(f.w.queue(a.id, 'Forged delegate', null, null, { valid: () => true, human() {}, reserve() {} }));
  assert.equal(f.calls.length, 0); assert.equal(a.r.pendingQueue ?? null, null);
});
