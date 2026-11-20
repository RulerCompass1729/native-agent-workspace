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
    // Not busy reasons: the phone names them instead of asking the person to wait for idle (2026-11-19).
    [() => { f.w.storageWarning = 'Synthetic save failure'; }, () => { f.w.storageWarning = null; }, 'storage'],
    [() => { a.s.state = 'starting'; }, () => { a.s.state = 'working'; }, 'notReady'],
    [() => { a.s.state = 'error'; }, () => { a.s.state = 'working'; }, 'notReady'],
    [() => { a.s.state = 'recoverable'; }, () => { a.s.state = 'working'; }, 'notReady'],
    [() => { a.s.state = 'ended'; }, () => { a.s.state = 'working'; }, 'ended'],
  ]) {
    change(); assert.deepEqual(pick(f.read(a)), { canSend: false, sendMode: null, sendBlocked: reason }, reason); undo();
  }
  assert.deepEqual(pick(f.read(a)), { canSend: true, sendMode: 'queue', sendBlocked: null });
  b.s.state = 'working'; b.r.steerAvailable = true; b.r.turnId = 'synthetic-turn';
  assert.deepEqual(pick(f.read(b)), { canSend: true, sendMode: 'steer', sendBlocked: null });
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

test('a working Codex session that cannot steer takes nothing from the phone: no steer, queue or send', async t => {
  const f = await fixture(t, ['codex']), [b] = f.sessions;
  b.s.state = 'working'; b.r.steerAvailable = false; b.r.turnId = 'synthetic-turn'; b.r.queueAvailable = true;
  const control = b.s.controlRevision;
  await assert.rejects(f.w.mobileSend(f.ticket('send', b), f.spec(b, 'Phone words for Codex')));
  assert.equal(f.calls.length, 0); assert.equal(b.s.controlRevision, control); assert.equal(f.w.mobileRequests.length, 0);
});

test('Workspace.queue takes a phone delegate only from mobile-session', async t => {
  const f = await fixture(t), [a] = f.sessions; working(a);
  await assert.rejects(f.w.queue(a.id, 'Forged delegate', null, null, { valid: () => true, human() {}, reserve() {} }));
  assert.equal(f.calls.length, 0); assert.equal(a.r.pendingQueue ?? null, null);
});

// Claude 7's review, F1: the phone presses what it was shown. NAW's own dispatch starts a turn without a control change.
const mobile = require('../mobile-session.cjs');
test('a press made on an idle read is not queued into a turn that started since (F1)', async t => {
  const f = await fixture(t), [a] = f.sessions, spec = f.spec(a, 'Typed while it looked idle');
  assert.deepEqual(Object.keys(spec.proof).sort(), ['connectionRevision', 'controlRevision', 'nativeId']);
  working(a);
  const receipt = await f.w.mobileSend(f.ticket('send', a), spec);
  assert.equal(receipt.status, 'not-sent'); assert.equal(f.calls.length, 0);
  assert.equal(a.s.messages.some(m => m.origin === 'human-mobile'), false);
  assert.deepEqual(await f.w.mobileSend(f.ticket('send', a), spec), receipt); assert.equal(f.calls.length, 0);
});
test('a send prepared while idle is not committed into a turn that started before commit (F1)', async t => {
  const f = await fixture(t), [a] = f.sessions, connection = {};
  const ready = mobile.prepare(f.w, f.ticket('send', a), f.spec(a, 'Prepared while idle'), 'send', connection);
  assert.equal(ready.prepared, true);
  working(a);
  const receipt = await mobile.commit(f.w, f.ticket('send', a), ready.lease, connection, 'send');
  assert.equal(receipt.status, 'not-sent'); assert.equal(f.calls.length, 0);
});
test('a queued phone message goes only into the turn and the way it was read (F1, comparison C-a2)', async t => {
  const f = await fixture(t), [a] = f.sessions;
  working(a);
  const spec = f.spec(a, 'Read in the first turn');
  assert.equal(spec.proof.sendMode, 'queueMidturn'); assert.equal(spec.proof.turnId, 'synthetic-turn');
  a.r.turnId = 'synthetic-turn-dispatched';
  assert.equal((await f.w.mobileSend(f.ticket('send', a), spec)).status, 'not-sent');
  const queueRead = (a.r.midturnAvailable = false, f.spec(a, 'Read as an after-turn queue'));
  a.r.midturnAvailable = true;
  assert.equal((await f.w.mobileSend(f.ticket('send', a), queueRead)).status, 'not-sent');
  const connection = {}, ready = mobile.prepare(f.w, f.ticket('send', a), f.spec(a, 'Prepared in this turn'), 'send', connection);
  a.r.turnId = 'synthetic-turn-next';
  assert.equal((await mobile.commit(f.w, f.ticket('send', a), ready.lease, connection, 'send')).status, 'not-sent');
  assert.equal(f.calls.length, 0);
  const same = await f.w.mobileSend(f.ticket('send', a), f.spec(a, 'Read in this turn'));
  assert.equal(same.status, 'awaiting-native'); assert.deepEqual(f.calls.map(c => c.method), ['queue']);
});

// F2: the phone hears back early from a queued send; the person's refresh asks once for this session's open receipts.
const { createMobileClient } = require('../mobile-web/client.js');
test('a refresh brings a queued phone message to submitted once native read it; opening the session alone does not ask (F2)', async t => {
  const f = await fixture(t, ['claude', 'claude']), [a, b] = f.sessions;
  working(a); working(b);
  const disk = new Map(), storage = { getItem: k => disk.get(k) ?? null, setItem: (k, v) => { disk.set(k, v); } };
  const deviceId = randomUUID(), csrf = 'c'.repeat(43), contextId = 'x'.repeat(43), specs = new Map(), routes = [], proofs = new Map();
  const target = id => f.sessions.find(x => x.id === id);
  const request = async (route, value) => {
    routes.push(route.replace(a.id, 'A').replace(b.id, 'B'));
    if (route === '/mobile/session') return { deviceId, csrf, sessions: [{ id: a.id, available: true }, { id: b.id, available: true }] };
    if (route.startsWith('/mobile/read/')) { const x = target(decodeURIComponent(route.split('/').pop())), row = f.read(x); proofs.set(x.id, row.proof); return { ...row, contextId }; }
    const x = route === '/mobile/send' ? target(client.state.selected) : target(specs.get(value.requestId).sessionId);
    if (route === '/mobile/send') {
      const spec = { requestId: value.requestId, proof: proofs.get(x.id), text: value.text }; specs.set(value.requestId, { spec, sessionId: x.id });
      return f.w.mobileSend(f.ticket('send', x), spec);
    }
    if (route === '/mobile/receipt') return f.w.mobileReceipt(f.ticket('send', x), specs.get(value.requestId).spec, 'send');
    throw Error('unexpected ' + route);
  };
  const client = createMobileClient({ request, storage, newId: randomUUID });
  await client.start(); await client.select(b.id); client.setDraft('Words for B'); await client.send();
  await client.select(a.id); client.setDraft('Words for A'); await client.send();
  assert.deepEqual(client.state.pending.map(p => p.status), ['awaiting-native', 'awaiting-native']);
  a.r.read(); await settle();
  routes.length = 0;
  await client.select(a.id);
  assert.deepEqual(routes, ['/mobile/read/A']); assert.equal(client.state.pending[1].status, 'awaiting-native');
  await client.refresh();
  assert.deepEqual(routes, ['/mobile/read/A', '/mobile/read/A', '/mobile/receipt']);
  assert.deepEqual(client.state.pending.map(p => p.status), ['awaiting-native', 'submitted']);
  assert.equal(client.state.draft, '');
  routes.length = 0; await client.refresh();
  assert.deepEqual(routes, ['/mobile/read/A']);
  assert.deepEqual(f.calls.map(c => c.method), ['queue', 'queue']);
});


test('queued receipt requires the same live slot, native identity and message; unknown remains unknown', async t => {
  const f = await fixture(t), [a] = f.sessions; working(a);
  const spec = f.spec(a, 'Synthetic queue witness');
  const result = await f.w.mobileSend(f.ticket('send', a), spec);
  assert.equal(result.queued, true);
  a.r.transportDisconnected = true;
  assert.notEqual(f.w.mobileReceipt(f.ticket('send', a), spec, 'send').queued, true);
  a.r.transportDisconnected = false;
  a.r.pendingQueue = 'different-slot';
  assert.notEqual(f.w.mobileReceipt(f.ticket('send', a), spec, 'send').queued, true);
  a.r.pendingQueue = result.tag;
  a.r.refuse(Error('Synthetic lost acknowledgement')); await settle();
  const uncertain = f.w.mobileReceipt(f.ticket('send', a), spec, 'send');
  assert.equal(uncertain.status, 'unconfirmed'); assert.notEqual(uncertain.queued, true);
  assert.equal(f.calls.length, 1);
});
