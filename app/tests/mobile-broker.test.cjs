const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const real = require('../mobile-access.cjs');
const filename = require.resolve('../mobile-broker.cjs'), requireFromBroker = createRequire(filename);
const source = fs.readFileSync(filename, 'utf8');
const actor = 'synthetic-human', origin = 'https://mobile.invalid';

function fixture(t, { requestLimit, holdConnect = false, desktop, onHumanInput, pushOptions } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-broker-'))), original = fs.statSync(root);
  let exclusive = true, wrongRoot = false, failRevoke = false, holdRead = false, holdSend = false, loseAck = false;
  const calls = [], clients = [], receipts = new Map(), sent = [], answered = [];
  const record = { id: 'session-a', nativeId: 'native-a', state: 'idle', provider: 'codex', name: 'Original member', owner: 'desktop-owner', liveDraft: 'PRIVATE_DESKTOP_DRAFT',
    proof: { nativeId: 'native-a', controlRevision: 0, connectionRevision: 0 }, question: null };
  let releaseRead, releaseSend, releaseConnect;
  const io = Object.create(fs);
  io.renameSync = (...args) => { if (failRevoke) throw Object.assign(Error('Synthetic save failure'), { code: 'ENOSPC' }); return fs.renameSync(...args); };
  io.openSync = (file, ...args) => { if (failRevoke && path.basename(file) === real.OFF) throw Object.assign(Error('Synthetic marker failure'), { code: 'ENOSPC' }); return fs.openSync(file, ...args); };
  io.unlinkSync = file => { if (failRevoke && path.basename(file) === real.FILE) throw Object.assign(Error('Synthetic unlink failure'), { code: 'EPERM' }); return fs.unlinkSync(file); };
  class Access extends real.MobileAccess { constructor(directory, options) { super(directory, { ...options, io }); } }
  class Client extends EventEmitter {
    constructor() { super(); this.scope = wrongRoot ? root + '/missing' : root; this.closing = false; this.socket = { destroyed: false };
      this.entry = { key: '.', state: { capabilities: ['humanMobileV1', 'humanMobilePreparedV1'], sessions: [record] } }; }
    route(id) { if (id !== record.id) throw Error('Unknown synthetic session'); return this.entry; }
    close() { this.closing = true; this.socket.destroyed = true; this.emit('closed'); }
    async call(method, ticket, spec) {
      calls.push({ method, ticket: structuredClone(ticket), spec: spec && structuredClone(spec) });
      const action = method === 'mobileRead' ? 'read' : method.includes('Answer') ? 'answer' : 'send';
      real.verifyTicket(root, ticket, { serviceKey: '.', sessionId: record.id, nativeId: record.nativeId }, action);
      if (method === 'mobileRead') {
        if (holdRead) await new Promise(resolve => { releaseRead = resolve; });
        return { ...record, messages: [{ id: 'message-a', kind: 'assistant', status: 'complete', text: 'Original reply', textOmitted: false,
          unsupportedAttachments: 0, nativeId: 'native-a', privateExtra: 'PRIVATE_EXTRA' }], questionOmitted: false, canSend: record.canSend ?? true, earlierMessagesOmitted: 0 };
      }
      if (method.endsWith('Receipt')) {
        const existing = receipts.get(spec.requestId);
        if (!existing) return null;
        assert.deepEqual(structuredClone(spec), existing.spec); return existing.receipt;
      }
      assert.ok(['mobileSend', 'mobileAnswer'].includes(method));
      if (holdSend) await new Promise(resolve => { releaseSend = resolve; });
      const value = { requestId: spec.requestId, sessionId: record.id, nativeId: record.nativeId, action,
        status: action === 'send' ? 'submitted' : 'reply-written', error: null, storageWarning: null };
      receipts.set(spec.requestId, { spec: structuredClone(spec), receipt: value });
      if (action === 'send') sent.push(structuredClone(spec)); else answered.push(structuredClone(spec));
      record.proof.controlRevision++;
      if (loseAck) throw Error('Synthetic lost commit acknowledgement');
      return value;
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(source, { module, process, Buffer, structuredClone,
    require(name) {
      if (name === './mobile-access.cjs') return { MobileAccess: Access };
      if (name === './workspace-client.cjs') return { WorkspaceClient: Client };
      if (name === './service-client.cjs') return { connect: async directory => {
        assert.equal(directory, root); const client = new Client(); clients.push(client);
        if (holdConnect) await new Promise(resolve => { releaseConnect = resolve; });
        return client;
      } };
      if (name === './mobile-session.cjs' && requestLimit !== undefined) return { MAX_REQUESTS: requestLimit };
      return requireFromBroker(name);
    } }, { filename });
  const changes = [], broker = new module.exports.MobileBroker(root, { exclusive: () => exclusive, changed: () => changes.push('changed'), desktop, onHumanInput, pushOptions });
  const selection = [{ sessionId: record.id, actions: ['read', 'send', 'answer'] }];
  async function pair(actions = selection[0].actions, replace = false, workspace) {
    const challenge = await broker.beginPairing({ actor, origin, selection: [{ sessionId: record.id, actions }], replace, ...(workspace ? { workspace } : {}) });
    const device = broker.pair({ secret: challenge.secret, actor, origin });
    const auth = { token: device.cookieValue, actor, origin };
    auth.csrf = broker.session(auth).csrf; return { challenge, device, auth };
  }
  t.after(() => { failRevoke = false; broker.revoke(); assert.equal(fs.statSync(root).ino, original.ino); fs.rmSync(root, { recursive: true }); });
  return { root, broker, record, selection, pair, calls, changes, clients, sent, answered, receipts,
    exclusive(value) { exclusive = value; }, wrongRoot(value) { wrongRoot = value; }, failRevoke(value) { failRevoke = value; },
    holdRead(value) { holdRead = value; }, holdSend(value) { holdSend = value; }, loseAck(value) { loseAck = value; }, releaseRead: () => releaseRead(), releaseSend: () => releaseSend(), releaseConnect: () => releaseConnect() };
}

test('construction is disabled and makes no connection, grant or native call', t => {
  const f = fixture(t); assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(f.clients.length, 0); assert.deepEqual(f.calls, []);
  assert.throws(() => f.broker.session({ token: 'x', actor }), { code: 'MOBILE_BROKER_DENIED' });
});
test('push uses the same desktop count and dies on logout, revoke or re-pair; a lost service is said once and the push ends', async t => {
  for (const end of ['logout', 'revoke', 'repair', 'disconnect']) {
    const messages = [], key = require('node:crypto').createECDH('prime256v1'); key.generateKeys(); let health = { alerts: [] };
    const desktop = { grant: (_c, g) => g, records: { status: () => ({ count: 19, private: 'PRIVATE_SOURCE' }) } };
    const f = fixture(t, { desktop, pushOptions: { transport: async d => { messages.push(d); return 201; }, alerts: () => health } });
    const { auth } = await f.pair(undefined, false, { roomIds: [], records: true });
    assert.equal(f.broker.pushInfo(auth).publicKey.length, 87);
    const value = { action: 'subscribe', subscription: { endpoint: 'https://web.push.apple.com/synthetic', expirationTime: null,
      keys: { p256dh: key.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } } };
    assert.throws(() => f.broker.pushAction({ ...auth, csrf: 'x'.repeat(43) }, value)); assert.equal(messages.length, 0);
    f.broker.pushAction(auth, value); await f.broker.refreshPush(); assert.equal(messages.length, 1);
    const plain = require('http_ece').decrypt(messages[0].body, { version: 'aes128gcm', privateKey: key, authSecret: value.subscription.keys.auth });
    assert.deepEqual(JSON.parse(plain), { count: desktop.records.status().count });
    if (end === 'logout') f.broker.logout(auth);
    else if (end === 'revoke') f.broker.revoke();
    else if (end === 'repair') await f.pair(undefined, true, { roomIds: [], records: true });
    else f.clients.at(-1).emit('closed');
    await new Promise(resolve => setImmediate(resolve));
    desktop.records.status = () => ({ count: 999 }); await f.broker.refreshPush();
    assert.throws(() => f.broker.pushAction(auth, value));
    if (end !== 'disconnect') { assert.equal(messages.length, 1); continue; }
    assert.equal(messages.length, 2);
    const alert = require('http_ece').decrypt(messages[1].body, { version: 'aes128gcm', privateKey: key, authSecret: value.subscription.keys.auth });
    assert.deepEqual(JSON.parse(alert), { alerts: ['service-disconnected'] });
    // Said and accepted, so it is over: not even a new alert leaves, with or without a revoke.
    health = { alerts: [{ code: 'token-anomaly' }] }; desktop.records.status = () => ({ count: 1000 }); await f.broker.refreshPush(); await new Promise(resolve => setImmediate(resolve)); assert.equal(messages.length, 2);
    f.broker.revoke(); await f.broker.refreshPush(); assert.equal(messages.length, 2);
  }
});
test('the app\'s alert codes join the same push; an unreadable source keeps what was said; a lost service is the last word', async t => {
  const messages = [], key = require('node:crypto').createECDH('prime256v1'); key.generateKeys(); let health = { alerts: [{ code: 'steward-wake-stalled' }] }, code = 201; const seen = [];
  const desktop = { grant: (_c, g) => g, records: { status: () => ({ count: 19 }) } };
  const f = fixture(t, { desktop, pushOptions: { transport: async d => { messages.push(d); return code; },
    alerts: status => { seen.push(status); if (!health) throw Error('PRIVATE_FAILURE'); return health; } } });
  const { auth } = await f.pair(undefined, false, { roomIds: [], records: true });
  const subscription = { endpoint: 'https://web.push.apple.com/synthetic', expirationTime: null,
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } };
  const last = () => JSON.parse(require('http_ece').decrypt(messages.at(-1).body, { version: 'aes128gcm', privateKey: key, authSecret: subscription.keys.auth }));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  f.broker.pushAction(auth, { action: 'subscribe', subscription }); await f.broker.refreshPush();
  assert.deepEqual(last(), { count: 19, alerts: ['steward-wake-stalled'] }); assert.deepEqual(seen.at(-1), { count: 19 });
  // The app cannot answer, then answers that the wake source is unreadable: the stall is not reported cleared.
  health = null; await f.broker.refreshPush(); assert.equal(messages.length, 1);
  health = { alerts: [], unknown: ['steward-wake-stalled'] }; await f.broker.refreshPush(); assert.equal(messages.length, 1);
  // An unreadable reminder status holds back the count, not the alerts; the app is then asked without a status.
  desktop.records.status = () => { throw Error('PRIVATE_FAILURE'); };
  health = { alerts: [{ code: 'steward-wake-stalled' }, { code: 'decision-waiting', at: 5 }], unknown: [] }; await f.broker.refreshPush();
  assert.deepEqual(last(), { alerts: ['steward-wake-stalled', 'decision-waiting'] }); assert.equal(seen.at(-1), null);
  desktop.records.status = () => ({ count: 19 }); health = { alerts: [] }; await f.broker.refreshPush();
  assert.deepEqual(last(), { count: 19, alerts: [] });
  // The service is lost while the push service refuses: the last word is tried, and waits to be tried again.
  health = { alerts: [{ code: 'decision-waiting', at: 9 }], unknown: ['steward-wake-stalled'] }; code = 500;
  f.clients.at(-1).emit('closed'); await settle();
  assert.deepEqual(last(), { alerts: ['service-disconnected', 'decision-waiting'] }); assert.equal(seen.at(-1), null);
  const attempts = messages.length; assert.equal(attempts, 4);
  // Another owner of the scope ends it before that second try.
  f.exclusive(false); code = 201; await f.broker.refreshPush(); await settle(); assert.equal(messages.length, attempts);
  f.exclusive(true); await f.broker.refreshPush(); await settle(); assert.equal(messages.length, attempts);
});
test('native read/send authority never implies reminder push permission', async t => {
  const f = fixture(t, { desktop: { grant: (_c, g) => g, records: { status: () => ({ count: 3 }) } } });
  const { auth } = await f.pair(undefined, false, { roomIds: [], records: false });
  assert.throws(() => f.broker.pushInfo(auth));
  assert.throws(() => f.broker.pushAction(auth, { action: 'subscribe', subscription: {} }));
});
test('revocation while original broker connect is held closes its late client without creating a pending grant', async t => {
  const f = fixture(t, { holdConnect: true });
  const preparing = f.broker.beginPairing({ actor, origin, selection: f.selection });
  assert.equal(f.clients.length, 1); assert.equal(f.broker.revoke().authorizationRevoked, true);
  f.releaseConnect(); await assert.rejects(preparing);
  assert.equal(f.clients[0].closing, true); assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(f.calls.length, 0);
});
test('exclusive ownership and the original canonical app scope are required before any grant', async t => {
  const f = fixture(t); f.exclusive(false); await assert.rejects(f.pair()); assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(f.clients.length, 0);
  f.exclusive(true); f.wrongRoot(true); await assert.rejects(f.pair()); assert.deepEqual(fs.readdirSync(f.root), []);
  assert.ok(f.clients.every(client => client.closing));
});
test('pairing returns a non-JSON cookie; authenticated session returns only the current CSRF and chosen scope', async t => {
  const f = fixture(t), { auth, device } = await f.pair(), session = f.broker.session(auth);
  assert.equal(device.cookieValue.length, 43); assert.ok(!JSON.stringify(device).includes(device.cookieValue));
  assert.equal(session.csrf, auth.csrf); assert.equal(session.sessions.length, 1); assert.equal(session.sessions[0].id, f.record.id);
  assert.ok(!JSON.stringify(session).includes('tokenHash')); assert.ok(!JSON.stringify(session).includes('native-a'));
  const stored = fs.readFileSync(path.join(f.root, real.FILE), 'utf8'); assert.ok(!stored.includes(auth.token) && !stored.includes(auth.csrf));
});
test('scoped list metadata is usable without reading originals, and a changed native identity hides cached metadata', async t => {
  const f = fixture(t), { auth } = await f.pair();
  const member = f.broker.session(auth).sessions[0];
  assert.equal(member.name, 'Original member'); assert.equal(member.provider, 'codex'); assert.equal(member.state, 'idle');
  assert.equal(f.calls.length, 0); f.record.nativeId = 'replacement'; f.record.name = 'PRIVATE_NEW_NAME';
  const stale = f.broker.session(auth).sessions[0]; assert.equal(stale.available, false);
  assert.ok(!JSON.stringify(stale).includes('PRIVATE_NEW_NAME'));
});
test('receipt lookup verifies full CSRF before exposing even an unknown-request result', async t => {
  const f = fixture(t), { auth } = await f.pair();
  await assert.rejects(f.broker.receipt({ ...auth, csrf: 'x'.repeat(43) }, randomUUID()), { code: 'MOBILE_BROKER_DENIED' });
  await assert.rejects(f.broker.receipt(auth, randomUUID()), { code: 'MOBILE_RECEIPT_UNKNOWN' }); assert.equal(f.calls.length, 0);
});
test('the bounded pair request cap is explicit while original receipts and duplicates remain available', async t => {
  const f = fixture(t, { requestLimit: 2 }), { auth } = await f.pair(); const originals = [];
  for (let i = 0; i < 2; i++) {
    const row = await f.broker.read(auth, f.record.id), value = { contextId: row.contextId, requestId: randomUUID(), text: 'Bounded explicit ' + i };
    originals.push(value); await f.broker.send(auth, value);
  }
  const row = await f.broker.read(auth, f.record.id);
  await assert.rejects(f.broker.send(auth, { contextId: row.contextId, requestId: randomUUID(), text: 'Over cap' }), { code: 'MOBILE_PAIR_LIMIT' });
  assert.equal((await f.broker.receipt(auth, originals[0].requestId)).status, 'submitted');
  assert.equal((await f.broker.send(auth, originals[0])).status, 'submitted'); assert.equal(f.sent.length, 2);
});
test('malformed Unicode in human text is rejected before native delegation', async t => {
  const f = fixture(t), { auth } = await f.pair(), row = await f.broker.read(auth, f.record.id);
  await assert.rejects(f.broker.send(auth, { contextId: row.contextId, requestId: randomUUID(), text: 'broken\ud800' }));
  assert.equal(f.sent.length, 0);
});
test('text with a native terminal prefix is refused before any request record or client call', async t => {
  const f = fixture(t), { auth } = await f.pair(), row = await f.broker.read(auth, f.record.id);
  // 11-09: also after invisible characters trim() keeps, and in full-width form.
  for (const text of ['!x', ' !x', '\n\t!x', '\u3000!x', '#x', ' #x', '/x', ' /x', '\u200B!x', '\u2060!x', '\u00AD!x', '\uFEFF#x', '！x', '＃x', '／x', '\u200B\u3000！x', '\u0085!x', '\u009F#x']) {
    const requestId = randomUUID();
    await assert.rejects(f.broker.send(auth, { contextId: row.contextId, requestId, text }), { code: 'MOBILE_BROKER_DENIED' }, JSON.stringify(text));
    await assert.rejects(f.broker.receipt(auth, requestId), { code: 'MOBILE_RECEIPT_UNKNOWN' }, 'no request record for ' + JSON.stringify(text));
  }
  assert.deepEqual(f.calls.map(value => value.method), ['mobileRead']); assert.equal(f.sent.length, 0);
  // The same request ID is still free, and the prefixes are only refused at the start.
  const requestId = randomUUID();
  await assert.rejects(f.broker.send(auth, { contextId: row.contextId, requestId, text: '!x' }));
  assert.equal((await f.broker.send(auth, { contextId: row.contextId, requestId, text: 'run it! #1 a/b' })).status, 'submitted');
  assert.deepEqual(f.sent.map(value => value.text), ['run it! #1 a/b']);
});
test('read whitelists originals and opaque context without exposing owner, draft, native identity or backend proof', async t => {
  const f = fixture(t), { auth } = await f.pair(), row = await f.broker.read(auth, f.record.id), raw = JSON.stringify(row);
  assert.equal(row.messages[0].text, 'Original reply'); assert.equal(row.contextId.length, 43);
  for (const privateField of ['native-a', 'PRIVATE_', 'desktop-owner', 'controlRevision', 'serviceKey']) assert.ok(!raw.includes(privateField));
  assert.deepEqual(f.calls.map(value => value.method), ['mobileRead']);
});
test('missing or foreign credentials, origin and write CSRF cannot delegate any phone input', async t => {
  const f = fixture(t), { auth } = await f.pair(), row = await f.broker.read(auth, f.record.id);
  assert.throws(() => f.broker.session({ ...auth, origin: 'https://outside.invalid' }));
  const value = { contextId: row.contextId, requestId: randomUUID(), text: 'Explicit original text' };
  for (const bad of [{ ...auth, token: 'x'.repeat(43) }, { ...auth, csrf: 'x'.repeat(43) }, { ...auth, origin: undefined }]) await assert.rejects(f.broker.send(bad, value));
  assert.equal(f.sent.length, 0);
});
test('one explicit send uses the private original proof and preserves desktop identity and draft', async t => {
  const f = fixture(t), { auth } = await f.pair(), row = await f.broker.read(auth, f.record.id);
  const value = { contextId: row.contextId, requestId: randomUUID(), text: 'Explicit original text' }, sent = await f.broker.send(auth, value);
  assert.equal(sent.status, 'submitted'); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].proof.nativeId, 'native-a');
  assert.equal(f.record.owner, 'desktop-owner'); assert.equal(f.record.liveDraft, 'PRIVATE_DESKTOP_DRAFT'); assert.ok(!Object.hasOwn(sent, 'nativeId'));
  await assert.rejects(f.broker.send(auth, { ...value, ticket: {} })); assert.equal(f.sent.length, 1);
});
test('a repeated input or receipt uses the original full spec after later control revisions and never sends twice', async t => {
  const f = fixture(t), { auth } = await f.pair(), row = await f.broker.read(auth, f.record.id);
  const value = { contextId: row.contextId, requestId: randomUUID(), text: 'One original' }, first = await f.broker.send(auth, value);
  f.record.proof.controlRevision += 10;
  assert.deepEqual(await f.broker.receipt(auth, value.requestId), first); assert.deepEqual(await f.broker.send(auth, value), first);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].proof.controlRevision, 0);
  await assert.rejects(f.broker.send(auth, { ...value, text: 'Conflicting replacement' }), { code: 'MOBILE_REQUEST_CONFLICT' });
});
test('a lost acknowledgement retains the original receipt context rather than automatically resubmitting', async t => {
  const f = fixture(t), { auth } = await f.pair(), row = await f.broker.read(auth, f.record.id); f.loseAck(true);
  const value = { contextId: row.contextId, requestId: randomUUID(), text: 'Possibly committed original' };
  await assert.rejects(f.broker.send(auth, value), /lost commit/);
  assert.equal((await f.broker.receipt(auth, value.requestId)).status, 'submitted'); assert.equal(f.sent.length, 1);
  f.receipts.clear(); await assert.rejects(f.broker.send(auth, value), { code: 'MOBILE_RECEIPT_UNKNOWN' }); assert.equal(f.sent.length, 1);
});
test('simultaneous duplicate input shares its one outstanding call', async t => {
  const f = fixture(t), { auth } = await f.pair(), row = await f.broker.read(auth, f.record.id); f.holdSend(true);
  const value = { contextId: row.contextId, requestId: randomUUID(), text: 'One held original' };
  const first = f.broker.send(auth, value), duplicate = f.broker.send(auth, value); f.releaseSend();
  assert.deepEqual(await first, await duplicate); assert.equal(f.sent.length, 1);
});
test('the native question identity stays local while the selected original answer delegates once', async t => {
  const f = fixture(t), { auth } = await f.pair(); f.record.question = { requestId: randomUUID(), questions: [{ id: 'choice', header: 'Choose', question: 'Original question?', options: [{ label: 'Original answer', description: 'Original description' }] }] };
  const row = await f.broker.read(auth, f.record.id); assert.ok(!JSON.stringify(row).includes(f.record.question.requestId));
  const value = { contextId: row.contextId, requestId: randomUUID(), answers: { choice: ['Original answer'] } };
  assert.equal((await f.broker.answer(auth, value)).status, 'reply-written'); assert.equal(f.answered.length, 1); assert.equal(f.answered[0].questionId, f.record.question.requestId);
});
test('the phone gets only fixed words for how a send would go or why it cannot', async t => {
  const f = fixture(t), { auth } = await f.pair(), pick = row => [row.canSend, row.sendMode, row.sendBlocked];
  for (const [canSend, sendMode, sendBlocked, expected] of [
    [true, 'queueMidturn', null, [true, 'queueMidturn', null]],
    [true, 'queue', 'steer', [true, 'queue', null]],
    [true, 'PRIVATE_MODE', null, [true, null, null]],
    [false, 'queue', 'steerBusy', [false, null, 'steerBusy']],
    [true, 'steer', null, [true, 'steer', null]],
    [false, null, 'steer', [false, null, null]],
    [false, null, 'PRIVATE_REASON', [false, null, null]],
    ...['storage', 'notReady', 'ended'].map(reason => [false, null, reason, [false, null, reason]]),
  ]) {
    Object.assign(f.record, { canSend, sendMode, sendBlocked });
    const row = await f.broker.read(auth, f.record.id);
    assert.deepEqual(pick(row), expected); assert.ok(!JSON.stringify(row).includes('PRIVATE_'));
  }
});
test('the turn a phone steer is for stays in the broker: the phone never sees it, the send carries it', async t => {
  const f = fixture(t), { auth } = await f.pair();
  Object.assign(f.record, { state: 'working', canSend: true, sendMode: 'steer', sendBlocked: null, proof: { ...f.record.proof, turnId: 'PRIVATE_TURN_ID' } });
  const row = await f.broker.read(auth, f.record.id); assert.ok(!JSON.stringify(row).includes('PRIVATE_TURN_ID'));
  const result = await f.broker.send(auth, { contextId: row.contextId, requestId: randomUUID(), text: 'Phone instruction' });
  assert.ok(!JSON.stringify(result).includes('PRIVATE_TURN_ID'));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].proof.turnId, 'PRIVATE_TURN_ID');
});
test('a read-only device is told it is read-only, whatever the session could take', async t => {
  const f = fixture(t), { auth } = await f.pair(['read']); Object.assign(f.record, { canSend: true, sendMode: 'queue', sendBlocked: null });
  const row = await f.broker.read(auth, f.record.id);
  assert.deepEqual([row.canSend, row.sendMode, row.sendBlocked], [false, null, 'readOnly']);
});
test('a read-only device cannot send or answer but may explicitly log out with its own origin and CSRF', async t => {
  const f = fixture(t), { auth } = await f.pair(['read']), row = await f.broker.read(auth, f.record.id);
  assert.equal(row.canSend, false); assert.equal(row.question, null);
  await assert.rejects(f.broker.send(auth, { contextId: row.contextId, requestId: randomUUID(), text: 'Not authorized' }));
  assert.throws(() => f.broker.logout({ ...auth, csrf: undefined }));
  assert.equal(f.broker.logout(auth).authorizationRevoked, true); assert.ok(f.clients[0].closing); assert.equal(f.sent.length, 0);
});
test('revocation or replacement while a read is pending cannot disclose its late body', async t => {
  const f = fixture(t), { auth } = await f.pair(); f.holdRead(true);
  const reading = f.broker.read(auth, f.record.id); f.broker.revoke(); f.releaseRead(); await assert.rejects(reading);
  f.holdRead(false); const next = await f.pair(); assert.throws(() => f.broker.session(auth)); assert.ok(f.broker.session(next.auth).csrf);
});
test('an unconfirmed durable revoke still closes only the broker connection and never claims native work stopped', async t => {
  const f = fixture(t), { auth } = await f.pair(); f.failRevoke(true);
  const result = f.broker.logout(auth); assert.equal(result.authorizationRevoked, false); assert.equal(result.connectionClosed, true); assert.equal(result.committedWorkMayContinue, true);
  assert.ok(f.clients.every(client => client.closing)); assert.equal(f.record.owner, 'desktop-owner'); assert.equal(f.record.liveDraft, 'PRIVATE_DESKTOP_DRAFT');
  assert.throws(() => f.broker.session(auth));
});

async function unixFixture(t, { alias = false, paired = true } = {}) {
  const { fork } = require('node:child_process'), { once } = require('node:events');
  const { connect } = require('../service-client.cjs'), { MobileBroker } = require('../mobile-broker.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'naw-mobile-broker-unix-'))), own = fs.statSync(root);
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd, { mode: 0o700 });
  const child = fork(require.resolve('../daemon.cjs'), [root], { execArgv: ['--require', require.resolve('./fixtures/mobile-broker-host.cjs')],
    env: { ...process.env, NAW_WORKSPACE: cwd, NAW_MOBILE_FIXTURE_ROOT: root, NAW_APP_VERSION: 'synthetic-mobile-broker' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', desktop, broker, parentAlias;
  child.stderr.on('data', chunk => { if (stderr.length < 16000) stderr += chunk; });
  t.after(async () => {
    broker?.revoke(); desktop?.close();
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    if (parentAlias) { assert.ok(fs.lstatSync(parentAlias).isSymbolicLink()); fs.unlinkSync(parentAlias); }
    assert.equal(fs.statSync(root).ino, own.ino); fs.rmSync(root, { recursive: true });
  });
  for (let i = 0; i < 200 && !fs.existsSync(path.join(root, 'connection.json')); i++) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail('Owned fixture exited: ' + stderr);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(fs.existsSync(path.join(root, 'connection.json')), stderr);
  let appScope = root;
  if (alias) { parentAlias = root + '-parent-alias'; fs.symlinkSync(path.dirname(root), parentAlias, 'dir'); appScope = path.join(parentAlias, path.basename(root)); }
  desktop = await connect(appScope, 'desktop-owner');
  const first = await desktop.call('create', { provider: 'codex', cwd, name: 'Synthetic sender', view: 'chat' });
  const second = await desktop.call('create', { provider: 'claude', cwd, name: 'Synthetic question', view: 'chat' });
  await desktop.call('draft', first, 'PRIVATE_DESKTOP_FIRST'); await desktop.call('draft', second, 'PRIVATE_DESKTOP_SECOND');
  broker = new MobileBroker(appScope, { exclusive: () => true });
  const challenge = await broker.beginPairing({ actor, origin, selection: [first, second].map(sessionId => ({ sessionId, actions: ['read', 'send', 'answer'] })) });
  let auth;
  if (paired) {
    const device = broker.pair({ secret: challenge.secret, actor, origin }); auth = { token: device.cookieValue, actor, origin };
    auth.csrf = broker.session(auth).csrf;
  }
  const fixtureCall = (method, sessionId) => new Promise((resolve, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { child.off('message', listener); reject(Error('Owned broker fixture timeout')); }, 2000);
    const listener = value => { if (value.brokerFixtureResult === id) { clearTimeout(timer); child.off('message', listener); resolve(value); } };
    child.on('message', listener); child.send({ brokerFixture: method, id, sessionId });
  });
  const stats = () => new Promise((resolve, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { child.off('message', listener); reject(Error('Owned native counter timeout')); }, 2000);
    const listener = value => { if (value.mobileFixtureStats === id) { clearTimeout(timer); child.off('message', listener); resolve(value.calls); } };
    child.on('message', listener); child.send({ mobileFixture: 'stats', id });
  });
  return { root, desktop, broker, auth, challenge, first, second, child, fixtureCall, stats };
}

test('phone state -> fixed HTTP adaptation -> actual Unix send/question/reload receipt preserves original desktop identity', async t => {
  const { Readable } = require('node:stream'), { createMobileHandler } = require('../mobile-http.cjs');
  const { createMobileClient, KEY } = require('../mobile-web/client.js');
  const f = await unixFixture(t, { paired: false }), before = await f.desktop.call('initial');
  const identity = value => value.sessions.map(s => [s.id, s.nativeId, s.owner, s.liveDraft]);
  const expected = identity(before), handler = createMobileHandler({ broker: f.broker, origin, actor });
  const disk = new Map(), storage = { getItem: key => disk.get(key) || null, setItem: (key, value) => disk.set(key, value) }, routes = [];
  let cookie, loseSendAck = true;
  async function request(route, value, csrf) {
    routes.push(route);
    const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]);
    req.method = value === undefined ? 'GET' : 'POST'; req.url = route; req.socket = { remoteAddress: '127.0.0.1' };
    req.rawHeaders = ['Host', 'mobile.invalid', 'Tailscale-User-Login', actor, 'X-NAW-Mobile', '1', 'Origin', origin,
      ...(cookie ? ['Cookie', cookie] : []), ...(csrf ? ['X-NAW-CSRF', csrf] : []), ...(value === undefined ? [] : ['Content-Type', 'application/json'])];
    const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(value) { this.body = value; this.writableEnded = true; } };
    await handler(req, res);
    if (res.headers['set-cookie']) cookie = res.headers['set-cookie'].split(';')[0];
    const result = JSON.parse(res.body);
    if (route === '/mobile/send' && loseSendAck) { loseSendAck = false; throw Error('Synthetic lost HTTP ACK after actual Unix commit'); }
    if (res.statusCode >= 400) throw Object.assign(Error('Synthetic HTTP refusal'), { code: result.error });
    return result;
  }
  const phone = createMobileClient({ request, storage, newId: randomUUID });
  await phone.start(f.challenge.secret); assert.equal(phone.state.session.sessions.length, 2);
  await phone.select(f.first); phone.setDraft('Original phone-to-Unix input'); await phone.send();
  assert.equal(phone.state.pending[0].status, 'unconfirmed'); assert.equal(phone.state.draft, 'Original phone-to-Unix input');
  assert.equal((await f.stats()).length, 1); assert.deepEqual(identity(await f.desktop.call('initial')), expected);
  const id = phone.state.pending[0].requestId, reloaded = createMobileClient({ request, storage, newId: randomUUID }), at = routes.length;
  await reloaded.start(); await reloaded.select(f.first);
  assert.ok(!routes.slice(at).some(route => ['/mobile/send', '/mobile/answer', '/mobile/receipt'].includes(route)));
  await reloaded.receipt(id); assert.equal(reloaded.state.pending[0].status, 'submitted'); assert.equal(reloaded.state.draft, '');
  assert.equal((await f.stats()).length, 1); assert.ok(!disk.get(KEY).includes(cookie.split('=')[1]));
  await f.fixtureCall('question', f.second); await reloaded.select(f.second);
  assert.equal(reloaded.state.row.question.questions[0].question, 'Original fixture question?');
  await reloaded.answer({ 'Original fixture question?': ['Original fixture answer'] });
  assert.equal(reloaded.state.pending[1].status, 'reply-written');
  assert.equal((await f.fixtureCall('stats', f.second)).replies.length, 1);
  assert.deepEqual(identity(await f.desktop.call('initial')), expected);
  await reloaded.logout(); assert.equal(reloaded.state.session, null);
  assert.deepEqual(identity(await f.desktop.call('initial')), expected); assert.equal((await f.stats()).length, 1);
});

test('the actual app-local broker connects over Unix, sends and answers once, then closes without taking desktop ownership', async t => {
  const f = await unixFixture(t), initial = await f.desktop.call('initial');
  const identities = initial.sessions.map(value => [value.id, value.nativeId, value.owner, value.liveDraft]);
  const read = await f.broker.read(f.auth, f.first), value = { contextId: read.contextId, requestId: randomUUID(), text: 'Explicit Unix broker original' };
  assert.ok(!JSON.stringify(read).includes('PRIVATE_DESKTOP'));
  assert.equal((await f.broker.send(f.auth, value)).status, 'submitted');
  const revision = f.desktop.control.revision;
  assert.equal((await f.broker.send(f.auth, value)).status, 'submitted'); assert.equal(f.desktop.control.revision, revision);
  assert.equal((await f.stats()).length, 1);
  await f.fixtureCall('question', f.second);
  const question = await f.broker.read(f.auth, f.second); assert.equal(question.question.questions[0].question, 'Original fixture question?');
  const answer = { contextId: question.contextId, requestId: randomUUID(), answers: { 'Original fixture question?': ['Original fixture answer'] } };
  assert.equal((await f.broker.answer(f.auth, answer)).status, 'reply-written');
  assert.equal((await f.broker.answer(f.auth, answer)).status, 'reply-written');
  const response = await f.fixtureCall('stats'); assert.equal(response.replies.length, 1);
  assert.deepEqual(response.replies[0], { answers: { 'Original fixture question?': 'Original fixture answer' } });
  assert.equal(f.broker.revoke().authorizationRevoked, true);
  const after = await f.desktop.call('initial'); assert.equal(f.desktop.socket.destroyed, false);
  assert.deepEqual(after.sessions.map(row => [row.id, row.nativeId, row.owner, row.liveDraft]), identities);
});

test('revoking the actual broker while prepare ACK is held persists not-sent without closing the desktop or submitting native work', async t => {
  const f = await unixFixture(t), read = await f.broker.read(f.auth, f.first);
  await f.fixtureCall('holdPrepare');
  const value = { contextId: read.contextId, requestId: randomUUID(), text: 'Do not commit after broker revoke' };
  const submitting = f.broker.send(f.auth, value), rejected = assert.rejects(submitting);
  let held = false;
  for (let i = 0; i < 100; i++) { if ((await f.fixtureCall('stats')).held === 1) { held = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(held, true); assert.equal((await f.stats()).length, 0);
  assert.equal(f.broker.revoke().connectionClosed, true); await rejected;
  let stored;
  for (let i = 0; i < 100; i++) {
    stored = JSON.parse(fs.readFileSync(path.join(f.root, 'workspace.json'), 'utf8')).mobileRequests.find(row => row.requestId === value.requestId);
    if (stored?.status === 'not-sent') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(stored.status, 'not-sent'); await f.fixtureCall('releasePrepare');
  assert.equal((await f.stats()).length, 0);
  const after = await f.desktop.call('initial'); assert.equal(after.sessions.find(row => row.id === f.first).liveDraft, 'PRIVATE_DESKTOP_FIRST');
  assert.equal(after.sessions.find(row => row.id === f.first).owner, 'desktop-owner');
});

test('an aliased app profile retains the same desktop human boundary during a held phone prepare', async t => {
  const f = await unixFixture(t, { alias: true }), read = await f.broker.read(f.auth, f.first);
  await f.fixtureCall('holdPrepare');
  const sending = f.broker.send(f.auth, { contextId: read.contextId, requestId: randomUUID(), text: 'Old phone intent before newer desktop action' });
  let held = false;
  for (let i = 0; i < 100; i++) { if ((await f.fixtureCall('stats')).held === 1) { held = true; break; } await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(held, true);
  await f.desktop.intervene(async () => {}, f.first);
  await f.fixtureCall('releasePrepare');
  assert.equal((await sending).status, 'not-sent');
  assert.equal((await f.stats()).length, 0);
  assert.equal((await f.desktop.call('initial')).sessions.find(row => row.id === f.first).liveDraft, 'PRIVATE_DESKTOP_FIRST');
});

// 11-09: the app keeps its listener only while something is open (main.cjs watchAppMobile).
test('openUntil follows the pairing link and then the paired device; pairing and logout report a change', async t => {
  const f = fixture(t); assert.equal(f.broker.openUntil(), 0, 'Nothing open before pairing');
  const challenge = await f.broker.beginPairing({ actor, origin, selection: f.selection });
  assert.equal(f.broker.openUntil(), challenge.expiresAt); assert.deepEqual(f.changes, [], 'Preparing a link is the desktop\'s own action');
  const device = f.broker.pair({ secret: challenge.secret, actor, origin });
  assert.equal(f.broker.openUntil(), device.expiresAt); assert.deepEqual(f.changes, ['changed']);
  const auth = { token: device.cookieValue, actor, origin }; auth.csrf = f.broker.session(auth).csrf;
  assert.equal(f.broker.logout(auth).authorizationRevoked, true);
  assert.equal(f.broker.openUntil(), 0); assert.deepEqual(f.changes, ['changed', 'changed']);
});

test('a device whose revocation could not be saved no longer keeps the listener open (closed access)', async t => {
  const f = fixture(t), { auth, device } = await f.pair(); assert.equal(f.broker.openUntil(), device.expiresAt);
  f.failRevoke(true); f.broker.logout(auth); f.failRevoke(false);
  assert.equal(f.broker.openUntil(), 0, 'A failed revocation save still closes access, so nothing is open');
});

test('workspace control needs its own desktop grant; native send scope does not imply it', async t => {
  const desktop = { grant: (_c, grant) => grant, read: async () => ({ rooms: [] }), action: async () => ({ status: 'complete' }) };
  const f = fixture(t, { desktop }), { auth } = await f.pair();
  await assert.rejects(f.broker.workspaceRead(auth));
  await assert.rejects(f.broker.workspaceAction(auth, { requestId: randomUUID(), action: 'queueAdd' }));
});
test('workspace writes are authenticated, one-use, payload-bound and revoked with the device', async t => {
  let writes = 0;
  const desktop = { grant: (_c, grant) => grant, read: async () => ({ rooms: [] }), action: async (_c, _g, _v, valid) => { valid(); writes++; return { status: 'complete', itemId: 'new-task' }; } };
  const f = fixture(t, { desktop }), { auth } = await f.pair(undefined, false, { roomIds: ['shared'], records: true });
  assert.equal(f.broker.session(auth).workspace, true);
  const value = { requestId: randomUUID(), action: 'queueAdd', roomId: 'shared', text: 'Original', assignee: null };
  await assert.rejects(f.broker.workspaceAction({ ...auth, csrf: 'z'.repeat(43) }, value)); assert.equal(writes, 0);
  const first = await f.broker.workspaceAction(auth, value);
  assert.deepEqual(await f.broker.workspaceAction(auth, value), first); assert.equal(writes, 1);
  await assert.rejects(f.broker.workspaceAction(auth, { ...value, text: 'Changed' }));
  await assert.rejects(f.broker.workspaceAction(auth, { requestId: randomUUID(), action: 'backgroundDecision' }));
  f.broker.revoke(); await assert.rejects(f.broker.workspaceRead(auth)); await assert.rejects(f.broker.workspaceAction(auth, value)); assert.equal(writes, 1);
});
test('a lost workspace result stays uncertain and never executes the same ID twice', async t => {
  let writes = 0;
  const desktop = { grant: (_c, grant) => grant, read: async () => ({}), action: async (_c, _g, _v, valid) => { valid(); writes++; throw Error('Lost result after business write'); } };
  const f = fixture(t, { desktop }), { auth } = await f.pair(undefined, false, { roomIds: ['shared'], records: false });
  const value = { requestId: randomUUID(), action: 'queueAdd', roomId: 'shared', text: 'One task', assignee: null };
  assert.equal((await f.broker.workspaceAction(auth, value)).status, 'unconfirmed');
  assert.equal((await f.broker.workspaceAction(auth, value)).status, 'unconfirmed'); assert.equal(writes, 1);
  assert.equal((await f.broker.workspaceAction(auth, { requestId: value.requestId, action: 'receipt' })).status, 'unconfirmed');
});

test('only a fresh authenticated phone input enters the desktop human quiet gate', async t => {
  const human = [], f = fixture(t, { onHumanInput: id => human.push(id) }), { auth } = await f.pair();
  const read = await f.broker.read(auth, 'session-a');
  const value = { contextId: read.contextId, requestId: randomUUID(), text: 'Original phone input' };
  await assert.rejects(f.broker.send({ ...auth, csrf: 'z'.repeat(43) }, value));
  assert.deepEqual(human, []);
  await f.broker.send(auth, value); await f.broker.send(auth, value); await f.broker.receipt(auth, value.requestId);
  assert.deepEqual(human, ['session-a']);
});


test('port: reminder push does not enable approvals and approval revocation leaves push independent', async t => {
  const desktop = { grant: (_client, value) => value, records: { status: () => ({ count: 3 }) },
    read: async () => ({ capabilities: {}, confirmations: [{ state: 'confirmation-required', version: 'synthetic-version', expiresAt: Date.now() + 60000 }] }) };
  const f = fixture(t, { desktop }), { auth } = await f.pair(undefined, false, { roomIds: [], records: true });
  const before = f.broker.pushInfo(auth);
  assert.equal(f.broker.approvalStatus().enabled, false);
  assert.equal((await f.broker.workspaceRead(auth)).confirmations[0].canDecide, false);
  f.broker.approvalRevoke();
  assert.equal(f.broker.pushInfo(auth).publicKey, before.publicKey);
  assert.equal(f.broker.approvalStatus().enabled, false);
});
test('port: approval-only card visibility grants no reminder push authority', async t => {
  // Isolate the broker's grant composition; cryptographic enablement is covered by the consent suite.
  const { MobileConsent } = require('../mobile-consent.cjs');
  t.mock.method(MobileConsent.prototype, 'setEnabled', () => ({ enabled: true }));
  const f = fixture(t, { desktop: { records: { status: () => ({ count: 3 }) } } }), { auth } = await f.pair();
  f.broker.approvalEnable({ enabled: true });
  assert.equal(f.broker.session(auth).workspace, true);
  assert.throws(() => f.broker.pushInfo(auth));
  assert.throws(() => f.broker.pushAction(auth, { action: 'subscribe', subscription: {} }));
});


function inboxDesktop() {
 const main=fs.readFileSync(require.resolve('../main.cjs'),'utf8'),temp={shown:true,version:1,checkedAt:1,directories:1,bytes:1,oldestDay:null};let reads=0;
 const cards=snapshot=>Array.from({length:snapshot.unavailable?0:snapshot.cardCount||0},(_,i)=>({id:'card-'+i,key:'a:n:'+i,operationId:String(i),sessionId:'a',nativeId:'n',actionable:true,state:'confirmation-required',summary:{action:'input'},time:1,expiresAt:600001}));
 const scope=vm.createContext({recordReminders:{status:()=>({count:1,records:[]})},operationsUnavailable:null,stewardRecord:null,dataDir:'/synthetic',tempReminders:{cached:temp},tempSummary:require('../temp-reminders.cjs').tempSummary,
  roomState:{apply:s=>s},sessionLabels:{apply:s=>s,labels:new Map()},confirmationInbox:require('../confirmation-inbox.cjs'),backgroundControl:{confirmations:(_names,snapshot)=>cards(snapshot)},displayState:s=>s,queueDispatcher:null,broadcastRoom(){},
  require(name){assert.equal(name,'./mobile-workspace.cjs');return {MobileWorkspace:class{constructor(options){Object.assign(this,options);}}};}});
 vm.runInContext(main.slice(main.indexOf('function confirmationSnapshot('),main.indexOf('// The listener stays open')),scope);
 const adapter=scope.appMobileWorkspace();return {grant:(_client,grant)=>grant,records:adapter.records,read:async client=>{reads++;return {...adapter.snapshot(client),capabilities:{},confirmations:[]};},total:client=>scope.appRecordsStatus(client.snapshot()).count,reads:()=>reads};
}
for(const rebind of [false,true])test(`bound push count: ${rebind?'a new client replaces the last phone reader':'subscribe before any phone read'}`,async t=>{
 const desktop=inboxDesktop(),messages=[],curve=require('node:crypto').createECDH('prime256v1');curve.generateKeys();
 const f=fixture(t,{desktop,pushOptions:{transport:async d=>{messages.push(d);return 201;}}});
 const pairing=await f.pair(undefined,false,{roomIds:[],records:true}),old=f.clients.at(-1);old.snapshot=()=>({sessions:[],cardCount:1});
 const subscription={endpoint:'https://web.push.apple.com/synthetic',expirationTime:null,keys:{p256dh:curve.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,7).toString('base64url')}};
 const notify=async auth=>{f.broker.pushInfo(auth);f.broker.pushAction(auth,{action:'subscribe',subscription});await f.broker.refreshPush();return JSON.parse(require('http_ece').decrypt(messages.at(-1).body,{version:'aes128gcm',privateKey:curve,authSecret:subscription.keys.auth}));};
 if(!rebind){assert.equal(desktop.reads(),0);assert.deepEqual(await notify(pairing.auth),{count:desktop.total(old)});assert.equal(desktop.total(old),3);assert.equal(desktop.reads(),0);}
 else {
  await f.broker.workspaceRead(pairing.auth);assert.deepEqual(await notify(pairing.auth),{count:3});
  const next=await f.pair(undefined,true,{roomIds:[],records:true}),current=f.clients.at(-1);let n=2;current.snapshot=()=>({sessions:[],cardCount:n});
  assert.notEqual(current,old);assert.equal(old.closing,true);assert.equal(desktop.reads(),1);
  assert.deepEqual(await notify(next.auth),{count:desktop.total(current)});assert.equal(desktop.total(current),4);
  old.emit('closed');n=3;await f.broker.refreshPush();assert.deepEqual(JSON.parse(require('http_ece').decrypt(messages.at(-1).body,{version:'aes128gcm',privateKey:curve,authSecret:subscription.keys.auth})),{count:5});
  f.broker.revoke();n=4;const sent=messages.length;await f.broker.refreshPush();assert.equal(messages.length,sent);
 }
 assert.deepEqual(f.calls,[],'No original conversation read or native input is needed to count');
});

for (const change of ['native', 'route', 'archived', 'pending', 'revoke', 'repair']) test('selected workspace read rejects a late ' + change + ' before returning body', async t => {
  let release, entered; const started = new Promise(r => { entered = r; }), held = new Promise(r => { release = r; });
  const desktop = { grant: (_c, g) => g, read: async () => { entered(); await held; return { capabilities: {}, confirmations: [] }; } };
  const f = fixture(t, { desktop }), { auth } = await f.pair(['read'], false, { roomIds: [], records: false });
  const pending = f.broker.workspaceRead(auth, { kind: 'session', id: f.record.id }); await started;
  if (change === 'native') f.record.nativeId = 'successor-native';
  if (change === 'route') f.clients.at(-1).entry.key = 'successor-service';
  if (change === 'archived') f.record.archived = true;
  if (change === 'pending') f.record.nativeContextPending = true;
  if (change === 'revoke') f.broker.revoke();
  if (change === 'repair') await f.pair(['read'], true, { roomIds: [], records: false });
  release(); await assert.rejects(pending); assert.equal(f.sent.length, 0); assert.equal(f.answered.length, 0);
});
test('selected workspace body forwards the exact selector without granting native send', async t => {
  let seen; const desktop = { grant: (_c, g) => g, read: async (_c, _g, scopes, choice) => { seen = { scopes, choice }; return { capabilities: {}, confirmations: [] }; } };
  const f = fixture(t, { desktop }), { auth } = await f.pair(['read'], false, { roomIds: [], records: false });
  await f.broker.workspaceRead(auth, { kind: 'session', id: f.record.id });
  assert.deepEqual(structuredClone(seen.choice), { kind: 'session', id: f.record.id }); assert.deepEqual(seen.scopes[0].actions, ['read']);
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0);
});
test('selected room rejects archive after its body was computed', async t => {
  let release, entered; const started = new Promise(r => { entered = r; }), held = new Promise(r => { release = r; });
  const source = { rooms: [{ id: 'shared', archived: false }] };
  const desktop = { grant: (_c, g) => g, snapshot: () => source, resolveGrant: (_g, s) => ({ roomIds: s.rooms.filter(r => !r.archived).map(r => r.id) }),
    read: async () => { entered(); await held; return { capabilities: {}, confirmations: [] }; } };
  const f = fixture(t, { desktop }), { auth } = await f.pair(['read'], false, { roomIds: ['shared'], records: false });
  const pending = f.broker.workspaceRead(auth, { kind: 'room', id: 'shared' }); await started; source.rooms[0].archived = true; release();
  await assert.rejects(pending); assert.equal(f.calls.length, 0);
});

async function waitingFixture(t) {
  const desktop = {}, f = fixture(t, { desktop });
  const { RoomState } = require('../room-state.cjs'), { MobileWorkspace } = require('../mobile-workspace.cjs');
  const room = new RoomState(f.root), itemId = room.queueAdd('Synthetic waiting task', f.record.id);
  f.record.roomIds = ['shared'];
  room.queueMarkSent('shared', itemId, f.record.id, 'Original member', Date.now() - 100, false, f.record.nativeId);
  room.queueSettle('shared', itemId, 'waiting', '', 'Original member', '', 'Choose the synthetic option?');
  const adapter = new MobileWorkspace({ snapshot: () => ({ sessions: [f.record], rooms: [{ ...room.metadata('shared'), id: 'shared' }] }), roomState: room,
    records: { status: () => ({ count: 0, records: [] }), acknowledge() {} } });
  for (const name of ['grant', 'read', 'action', 'queueAnswerTarget']) if (typeof adapter[name] === 'function') desktop[name] = adapter[name].bind(adapter);
  const paired = await f.pair(['read', 'send'], false, { roomIds: ['shared'], records: false });
  for (const client of f.clients) client.refresh = async () => {};
  const questionId = room.metadata('shared').events.at(-1).id;
  const target = { roomId: 'shared', itemId, questionId };
  const read = () => f.broker.read(paired.auth, f.record.id);
  const send = async () => f.broker.send(paired.auth, { contextId: (await read()).contextId, requestId: randomUUID(), text: 'Synthetic explicit answer', queueTarget: target });
  const resolve = answerRequestId => f.broker.workspaceAction(paired.auth, { requestId: randomUUID(), action: 'queueResolve', ...target, answerRequestId });
  return { ...f, room, itemId, target, paired, read, send, resolve };
}
test('phone waiting answer is recorded only after the same bound native input is received', async t => {
  const f = await waitingFixture(t), result = await f.send();
  assert.equal(result.status, 'submitted'); assert.equal(f.room.queueFind('shared', f.itemId).status, 'waiting');
  const done = await f.resolve(result.requestId); assert.equal(done.status, 'complete');
  const item = f.room.queueFind('shared', f.itemId); assert.equal(item.status, 'done'); assert.equal(item.answer.text, 'Synthetic explicit answer');
  assert.equal(f.sent.length, 1);
});
test('an unrelated normal send receipt cannot be reused as a waiting answer', async t => {
  const f = await waitingFixture(t), contextId = (await f.read()).contextId;
  const result = await f.broker.send(f.paired.auth, { contextId, requestId: randomUUID(), text: 'Unrelated ordinary input' });
  const done = await f.resolve(result.requestId); assert.equal(done.status, 'not-sent');
  assert.equal(f.room.queueFind('shared', f.itemId).status, 'waiting'); assert.equal(f.room.queueFind('shared', f.itemId).answer, undefined);
});
test('a waiting answer cannot use the in-turn steer mode', async t => {
  const f = await waitingFixture(t); f.record.state = 'working'; f.record.sendMode = 'steer';
  await assert.rejects(f.send()); assert.equal(f.sent.length, 0); assert.equal(f.room.queueFind('shared', f.itemId).status, 'waiting');
});
test('a lost waiting-answer acknowledgement remains waiting until its original receipt is explicitly checked', async t => {
  const f = await waitingFixture(t); f.loseAck(true); const contextId = (await f.read()).contextId, requestId = randomUUID();
  await assert.rejects(f.broker.send(f.paired.auth, { contextId, requestId, text: 'Synthetic explicit answer', queueTarget: f.target }));
  let result = await f.resolve(requestId); assert.equal(result.status, 'not-sent'); assert.equal(f.room.queueFind('shared', f.itemId).status, 'waiting');
  f.loseAck(false); assert.equal((await f.broker.receipt(f.paired.auth, requestId)).status, 'submitted');
  result = await f.resolve(requestId); assert.equal(result.status, 'complete'); assert.equal(f.sent.length, 1);
});
test('independent handling before the late receipt never reopens or appends an answer', async t => {
  const f = await waitingFixture(t), result = await f.send(); f.room.queueResolve(f.itemId, 'shared');
  assert.equal((await f.resolve(result.requestId)).status, 'not-sent');
  const item = f.room.queueFind('shared', f.itemId); assert.equal(item.status, 'done'); assert.equal(item.answer, undefined); assert.equal(f.sent.length, 1);
});
test('a changed waiting question or native context cannot consume an old received answer', async t => {
  for (const change of ['question', 'native', 'revoke']) {
    const f = await waitingFixture(t), result = await f.send();
    if (change === 'question') f.target.questionId = randomUUID();
    if (change === 'native') f.record.nativeId = 'successor';
    if (change === 'revoke') f.broker.revoke();
    try { assert.equal((await f.resolve(result.requestId)).status, 'not-sent'); } catch (error) { assert.equal(error.code, 'MOBILE_BROKER_DENIED'); }
    assert.equal(f.room.queueFind('shared', f.itemId).status, 'waiting'); assert.equal(f.room.queueFind('shared', f.itemId).answer, undefined);
  }
});
