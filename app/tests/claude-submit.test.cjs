const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { EventEmitter } = require('node:events');
const { SubmissionChannel, createSubmissionServer } = require('../claude-submit.cjs');
const { submissionState, assertSubmission, assertAutomaticRun, assertNativeCreation } = require('../submission-policy.cjs');

function poll(channel) {
  const response = new EventEmitter();
  response.end = text => { response.value = JSON.parse(text); response.emit('close'); };
  channel.receive(response); return response;
}
test('native acceptance needs fresh authorization; canceled and timed-out sends never replay', async t => {
  const channel = new SubmissionChannel(30); t.after(() => channel.close());
  let allowed = true;
  const first = poll(channel), pending = channel.request('exact text', 'one', () => allowed);
  assert.deepEqual(first.value, { id: 'one', text: 'exact text' });
  assert.equal(channel.authorize({ id: 'one', text: 'different text' }), false);
  allowed = false;
  assert.equal(channel.authorize(first.value), false);
  channel.result({ id: 'one', status: 'accepted' });
  await assert.rejects(pending, /未接受/);
  const second = poll(channel), expired = channel.request('later', 'two', () => true);
  await assert.rejects(expired, /未确认/);
  assert.equal(channel.authorize(second.value), false);
  assert.equal(channel.result({ id: 'two', status: 'accepted' }), false);
  const reconnected = poll(channel);
  assert.equal(reconnected.value, undefined); // Reconnect cannot replay either text.
  const accepted = channel.request('new explicit send', 'three', () => true);
  assert.equal(channel.authorize(reconnected.value), true);
  assert.equal(channel.authorize(reconnected.value), false);
  channel.result({ id: 'three', status: 'accepted' }); await accepted;
});

test('private transport rejects invalid tokens, sessions, and bodies without losing its listener', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'submit-test-'));
  const socketPath = path.join(folder, 's');
  const channel = new SubmissionChannel();
  const transport = createSubmissionServer(socketPath, new Map([['fixture-token', { record: { nativeId: 'fixture-session' }, submission: channel }]]));
  await transport.start();
  t.after(async () => { channel.close(); transport.server.closeAllConnections(); await new Promise(r => transport.server.close(r)); fs.rmSync(folder, { recursive: true, force: true }); });
  const request = (token, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'POST', path: '/authorize', headers: { 'X-Workspace-Token': token } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  assert.equal(await request('wrong', { sessionId: 'fixture-session' }), 403);
  assert.equal(await request('fixture-token', { sessionId: 'another-session' }), 409);
  assert.equal(await request('fixture-token', null), 400);
  assert.equal(await request('fixture-token', { sessionId: 'fixture-session' }), 200);
});

async function modFixture({ draft = '', changeBeforeSubmit = false, authorized = true, failAuthorization = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  const { register } = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + Math.random()).toString('base64'));
  const hooks = new Map(), clock = [], results = [], entered = [];
  let text = draft, submits = 0;
  const invoke = async (name, event, next = async e => e) => {
    const hook = hooks.get(name);
    try { return await hook.fn($, event, next); } catch (e) { if (hook.fallback) return hook.fallback($, event, next); throw e; }
  };
  const $ = {
    env: { get: async key => key === 'NAW_SUBMIT_SOCKET' ? '/fixture/socket' : 'fixture-token' }, session: { id: async () => 'fixture-session', version: async () => ({ version: '2.1.302' }) },
    clock: { after: (_ms, fn) => clock.push(fn) },
    http: { fetch: async (url, options) => {
      assert.equal(options.socketPath, '/fixture/socket');
      const body = JSON.parse(options.body); assert.equal(body.sessionId, 'fixture-session');
      if (url.endsWith('/authorize') && failAuthorization) throw Error('Offline');
      if (url.endsWith('/authorize') && changeBeforeSubmit) text = 'later human draft';
      const value = url.endsWith('/next') ? { id: 'request', text: 'only this text' } : url.endsWith('/authorize') ? { allowed: authorized } : (results.push(body), { received: true });
      return { ok: true, text: JSON.stringify(value) };
    } },
    prompt: { read: async () => ({ text }), submit: async args => {
      submits++; assert.equal(args.asUser, true);
      entered.push(args.text); return { text: args.text };
    } },
  };
  register((event, fn) => { const hook = { fn }; hooks.set(event, hook); return { catch(fallback) { hook.fallback = fallback; } }; });
  await invoke('session.start', {}); await clock.shift()();
  return { text, submits, results, entered, invoke };
}
test('native mod preserves existing and racing drafts; only the authorized explicit payload enters', async () => {
  const existing = await modFixture({ draft: 'private native draft' });
  assert.equal(existing.text, 'private native draft'); assert.equal(existing.submits, 0); assert.deepEqual(existing.entered, []); assert.equal(existing.results[0].status, 'draft');
  const racing = await modFixture({ changeBeforeSubmit: true });
  assert.equal(racing.text, 'later human draft'); assert.deepEqual(racing.entered, []); assert.equal(racing.results[0].status, 'draft');
  for (const options of [{ authorized: false }]) {
    const canceled = await modFixture(options); assert.deepEqual(canceled.entered, []); assert.equal(canceled.results[0].status, 'blocked');
  }
  const accepted = await modFixture(); assert.deepEqual(accepted.entered, ['only this text']); assert.equal(accepted.results[0].status, 'accepted');
  const offline = await modFixture({ failAuthorization: true }); assert.equal(offline.submits, 0); assert.deepEqual(offline.entered, []);
});

test('an updated UI cannot use an older Claude submission path, while native sessions remain intact', () => {
  const old = { sessions: [{ id: 'c', provider: 'claude', nativeId: 'same' }, { id: 'x', provider: 'codex' }], capabilities: [] };
  const view = submissionState(old, false);
  assert.equal(view.sessions[0].nativeId, 'same'); assert.equal(view.sessions[0].chatAvailable, false);
  assert.equal(old.sessions[0].chatAvailable, undefined);
  assert.throws(() => assertSubmission(old, ['c']), /旧版会话/);
  assert.throws(() => assertSubmission(old, ['x', 'c']), /旧版会话/);
  assert.throws(() => assertSubmission(old, ['x']), /旧版会话/);
  assert.equal(view.sessions[1].chatAvailable, false);
  const updated = { ...old, capabilities: ['structuredClaudeSubmit'] };
  assert.notEqual(submissionState(updated).sessions[0].chatAvailable, false); assert.doesNotThrow(() => assertSubmission(updated, ['c']));
});
test('a retained backend cannot start automatic routing without verified handoff checks', () => {
  for (const capabilities of [undefined, [], ['structuredClaudeSubmit']]) assert.throws(() => assertAutomaticRun({ capabilities }), /旧版后台/);
  assert.doesNotThrow(() => assertAutomaticRun({ capabilities: ['verifiedHandoffs'] }));
});
test('an older retained service cannot create or recover sessions with forced permission overrides', () => {
  for (const capabilities of [undefined, [], ['verifiedHandoffs', 'structuredClaudeSubmit']]) assert.throws(() => assertNativeCreation({ capabilities }), /旧版会话/);
  assert.doesNotThrow(() => assertNativeCreation({ capabilities: ['nativePermissionDefaults'] }));
});
