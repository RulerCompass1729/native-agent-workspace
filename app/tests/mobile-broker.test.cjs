const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const real = require('../mobile-access.cjs');
const filename = require.resolve('../mobile-broker.cjs'), requireFromBroker = createRequire(filename);
const source = fs.readFileSync(filename, 'utf8');
const actor = 'synthetic-human', origin = 'https://mobile.invalid';

function fixture(t, { requestLimit, holdConnect = false } = {}) {
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
          unsupportedAttachments: 0, nativeId: 'native-a', privateExtra: 'PRIVATE_EXTRA' }], questionOmitted: false, canSend: true, earlierMessagesOmitted: 0 };
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
  const broker = new module.exports.MobileBroker(root, { exclusive: () => exclusive });
  const selection = [{ sessionId: record.id, actions: ['read', 'send', 'answer'] }];
  async function pair(actions = selection[0].actions, replace = false) {
    const challenge = await broker.beginPairing({ actor, origin, selection: [{ sessionId: record.id, actions }], replace });
    const device = broker.pair({ secret: challenge.secret, actor, origin });
    const auth = { token: device.cookieValue, actor, origin };
    auth.csrf = broker.session(auth).csrf; return { challenge, device, auth };
  }
  t.after(() => { failRevoke = false; broker.revoke(); assert.equal(fs.statSync(root).ino, original.ino); fs.rmSync(root, { recursive: true }); });
  return { root, broker, record, selection, pair, calls, clients, sent, answered, receipts,
    exclusive(value) { exclusive = value; }, wrongRoot(value) { wrongRoot = value; }, failRevoke(value) { failRevoke = value; },
    holdRead(value) { holdRead = value; }, holdSend(value) { holdSend = value; }, loseAck(value) { loseAck = value; }, releaseRead: () => releaseRead(), releaseSend: () => releaseSend(), releaseConnect: () => releaseConnect() };
}

test('construction is disabled and makes no connection, grant or native call', t => {
  const f = fixture(t); assert.deepEqual(fs.readdirSync(f.root), []); assert.equal(f.clients.length, 0); assert.deepEqual(f.calls, []);
  assert.throws(() => f.broker.session({ token: 'x', actor }), { code: 'MOBILE_BROKER_DENIED' });
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
