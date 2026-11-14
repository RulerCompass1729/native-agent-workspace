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
test('native queued receipt outlives the normal deadline only after authorization and closes without replay', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  const first = poll(channel), request = channel.request('next task', 'queued', () => true, true);
  assert.equal(channel.authorize(first.value), true);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(channel.pending.tag, 'queued');
  channel.result({ id: 'queued', status: 'accepted' }); await request;
  const second = poll(channel), unapproved = channel.request('not authorized', 'no', () => true, true);
  await assert.rejects(unapproved, /未确认/);
  assert.equal(channel.authorize(second.value), false);
  const third = poll(channel), closing = channel.request('waiting', 'closed', () => true, true);
  channel.authorize(third.value); channel.close(); await assert.rejects(closing, error => /关闭/.test(error.message) && error.notSent === false);
  assert.equal(poll(channel).value, undefined);
});
test('only a failure before native authorization is reported as not sent', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  await assert.rejects(channel.request('offline', 'zero', () => true, true), error => error.notSent === true);
  const first = poll(channel), draft = channel.request('blocked', 'one', () => true, true);
  channel.result({ id: 'one', status: 'draft' }); await assert.rejects(draft, error => /草稿/.test(error.message) && error.notSent === true);
  const second = poll(channel), late = channel.request('late', 'two', () => true, true);
  await assert.rejects(late, error => /未确认/.test(error.message) && error.notSent === true);
  assert.equal(channel.authorize(second.value), false);
  const third = poll(channel), unauthorized = channel.request('odd', 'three', () => true, true);
  channel.result({ id: 'three', status: 'accepted' }); await assert.rejects(unauthorized, error => error.notSent === false);
  assert.equal(third.value.id, 'three');
});
test('native listener returning after an uncertain queued submit/result retires its wait without replay', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  const first = poll(channel), pending = channel.request('queued once', 'one', () => true, true);
  channel.authorize(first.value);
  const rejected = assert.rejects(pending, /结果未确认/);
  const again = poll(channel); await rejected;
  assert.equal(again.value, undefined); assert.equal(channel.pending, null);
  assert.equal(channel.result({ id: 'one', status: 'accepted' }), false);
});
test('an unknown native result after authorization remains uncertain', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  const response = poll(channel), pending = channel.request('queued once', 'unknown', () => true, true);
  assert.equal(channel.authorize(response.value), true);
  channel.result({ id: 'unknown', status: 'unexpected-status' });
  await assert.rejects(pending, error => /结果未确认/.test(error.message) && error.notSent === false);
  assert.equal(channel.pending, null);
});
test('native acceptance needs fresh authorization; canceled and timed-out sends never replay', async t => {
  const channel = new SubmissionChannel(30); t.after(() => channel.close());
  let allowed = true;
  const first = poll(channel), pending = channel.request('exact text', 'one', () => allowed);
  assert.deepEqual(first.value, { id: 'one', text: 'exact text' });
  assert.equal(channel.authorize({ id: 'one', text: 'different text' }), false);
  allowed = false;
  assert.equal(channel.authorize(first.value), false);
  channel.result({ id: 'one', status: 'accepted' });
  await assert.rejects(pending, error => /结果未确认/.test(error.message) && error.notSent === false);
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

async function modFixture({ draft = '', changeBeforeSubmit = false, authorized = true, failAuthorization = false, endOnFinalRead = false, observe } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  const { register } = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + Math.random()).toString('base64'));
  const hooks = new Map(), clock = [], results = [], entered = [];
  let text = draft, submits = 0, reads = 0;
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
    prompt: { read: async () => { if (++reads === 2 && endOnFinalRead) await invoke('session.end', {}); return { text }; }, submit: async args => {
      submits++; assert.equal(args.asUser, true);
      entered.push(args.text); if (observe) await observe(invoke,hooks); return { text: args.text, origin:{kind:'plugin',name:'native-workspace-submit',asUser:true} };
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
  const ended = await modFixture({ endOnFinalRead: true }); assert.equal(ended.submits, 0); assert.deepEqual(ended.entered, []);
});

test('a compatibility plugin in the project remains dormant when the native submission plugin is present', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  const clocks = [];
  for (const legacy of [false, true]) {
    const code = source.replace('const legacyOnly = false;', `const legacyOnly = ${legacy};`);
    const { register } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    const hooks = new Map(), clock = [];
    register((name, fn) => {hooks.set(name, fn);return {catch(){}};});
    await hooks.get('session.start')({ session: { version: async () => ({ version: '2.1.302' }) },
      env: { get: async key => key === 'NAW_SUBMIT_SOCKET' ? '/fixture/native.sock' : 'fixture-token' },
      clock: { after: (_ms, fn) => clock.push(fn) } }, {}, async e => e);
    clocks.push(clock.length);
  }
  assert.deepEqual(clocks, [1, 0], 'Only the original native plugin starts a poll listener');
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

const promptId='00000000-0000-4000-8000-000000000001';
const classic={session_id:'fixture-session',prompt_id:promptId,prompt:'only this text'};
const append={door:'prompt',origin:{kind:'plugin',name:'native-workspace-submit',asUser:true},message:{type:'user',role:'user',content:[{type:'text',text:'only this text'}]},uuid:'00000000-0000-4000-8000-000000000002'};
test('only one native prompt with an own-origin append yields correlation', async () => {
  const f=await modFixture({observe:async invoke=>{
    await invoke('classic.UserPromptSubmit',classic);await invoke('session.append',append);
  }});
  assert.equal(f.results[0].status,'accepted');assert.equal(f.results[0].promptId,promptId);
});
for(const scenario of ['missing-classic','missing-append','foreign-same-text','queued-foreign','two-classics','two-appends','unknown-origin','child','reload','throw']) test(`accepted Claude submission stays uncorrelated: ${scenario}`,async()=>{
  const f=await modFixture({observe:async invoke=>{
    if(scenario==='foreign-same-text') await invoke('prompt.submit',{text:'only this text',origin:{kind:'composer'}});
    if(scenario!=='missing-classic') await invoke('classic.UserPromptSubmit',scenario==='child'?{...classic,agent_id:'child'}:classic);
    if(scenario==='two-classics') await invoke('classic.UserPromptSubmit',{...classic,prompt_id:'00000000-0000-4000-8000-000000000003'});
    if(scenario==='throw') try{await invoke('classic.UserPromptSubmit',classic,async()=>{throw Error('native hook failed')})}catch{}
    if(scenario==='queued-foreign') await invoke('session.append',{...append,origin:{kind:'composer'}});
    if(scenario!=='missing-append') await invoke('session.append',scenario==='unknown-origin'?{...append,origin:{kind:'unclassified'}}:append);
    if(scenario==='two-appends') await invoke('session.append',append);
    if(scenario==='reload') await invoke('session.start',{});
  }});
  assert.equal(f.results[0].status,'accepted');assert.equal(f.results[0].promptId,undefined);
  assert.equal(f.submits,1);
});

for(const name of ['classic.UserPromptSubmit','session.append','prompt.submit']) test(`native engine timeout fallback cancels attribution: ${name}`,async()=>{
 const f=await modFixture({observe:async(invoke,hooks)=>{
   await invoke('classic.UserPromptSubmit',classic);await invoke('session.append',append);
   let continuations=0;const next=async e=>{continuations++;return e};next.error={kind:'timeout'};
   await hooks.get(name).fallback({}, {}, next);assert.equal(continuations,1);
 }});assert.equal(f.results[0].status,'accepted');assert.equal(f.results[0].promptId,undefined);
});
test('a rewritten native append cannot authorize reply sharing',async()=>{
 const f=await modFixture({observe:async invoke=>{
  await invoke('classic.UserPromptSubmit',classic);await invoke('session.append',{...append,message:{...append.message,content:[{type:'text',text:'changed task'}]}});
 }});assert.equal(f.results[0].promptId,undefined);
});

// 2.1.322 mid-turn delivery: the mod holds a queued message for the running turn's next tool boundary.
const ROW = '33333333-3333-4333-8333-333333333333';
test('a held mid-turn message outlives the first-answer limit unauthorized; its append receipt names the row and the turn', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  const response = poll(channel), pending = channel.request('steer text', 'held', () => true, true, true);
  assert.deepEqual(response.value, { id: 'held', text: 'steer text', midturn: true });
  assert.equal(channel.hold({ id: 'held' }), true);
  assert.equal(channel.hold({ id: 'held' }), false, 'held once');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(channel.pending?.tag, 'held'); assert.equal(channel.pending.authorized, false);
  // Authorization stays at the dispatch moment, past the first-answer deadline.
  assert.equal(channel.authorize(response.value), true);
  channel.result({ id: 'held', status: 'accepted', mode: 'append', uuid: ROW, turnId: 'running-turn' });
  assert.deepEqual(await pending, { mode: 'append', uuid: ROW, turnId: 'running-turn', promptId: null });
});
test('an ordinary request cannot be held, and a late hold after the limit is refused', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  const first = poll(channel), ordinary = channel.request('plain', 'plain', () => true, true);
  assert.equal(first.value.midturn, undefined);
  assert.equal(channel.hold({ id: 'plain' }), false);
  await assert.rejects(ordinary, error => error.notSent === true);
  poll(channel); const late = channel.request('late', 'late', () => true, true, true);
  await assert.rejects(late, error => error.notSent === true);
  assert.equal(channel.hold({ id: 'late' }), false);
});
test('a revoked guard at hold time or at dispatch proves not sent', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  let allowed = true;
  const first = poll(channel), atHold = channel.request('x', 'one', () => allowed, true, true);
  assert.equal(first.value.id, 'one', 'delivered to the mod'); allowed = false;
  assert.equal(channel.hold({ id: 'one' }), false);
  await assert.rejects(atHold, error => error.notSent === true);
  allowed = true;
  const second = poll(channel), atDispatch = channel.request('y', 'two', () => allowed, true, true);
  assert.equal(channel.hold({ id: 'two' }), true); allowed = false;
  assert.equal(channel.authorize(second.value), false);
  channel.result({ id: 'two', status: 'blocked' });
  await assert.rejects(atDispatch, error => error.notSent === true);
});
test('a listener that comes back without settling its held message proves it was never sent; an authorized one stays uncertain', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  poll(channel); const held = channel.request('held', 'gone', () => true, true, true);
  channel.hold({ id: 'gone' });
  const rejected = assert.rejects(held, error => /没有发出|not sent/.test(error.message) && error.notSent === true);
  poll(channel); await rejected;
  const again = poll(channel); void again;
  const second = channel.request('held', 'authorized', () => true, true, true);
  channel.hold({ id: 'authorized' }); channel.authorize({ id: 'authorized', text: 'held' });
  const uncertain = assert.rejects(second, error => error.notSent === false);
  poll(channel); await uncertain;
});
test('an append receipt needs its row id and turn; a malformed one stays uncertain', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  for (const bad of [{ uuid: 'not-a-row', turnId: 'running-turn' }, { uuid: ROW }]) {
    const response = poll(channel), pending = channel.request('x', 'bad', () => true, true, true);
    channel.hold({ id: 'bad' }); channel.authorize(response.value);
    channel.result({ id: 'bad', status: 'accepted', mode: 'append', ...bad });
    await assert.rejects(pending, error => error.notSent === false);
  }
});
test('read receipts are emitted only in their exact shape', () => {
  const channel = new SubmissionChannel(20), reads = [];
  channel.on('read', read => reads.push(read));
  assert.equal(channel.read({ id: 'held', uuid: ROW, turnId: 'running-turn' }), true);
  for (const bad of [{ id: 'held', uuid: 'x', turnId: 'running-turn' }, { id: 'held', uuid: ROW }, { uuid: ROW, turnId: 't' }]) assert.equal(channel.read(bad), false);
  assert.deepEqual(reads, [{ tag: 'held', uuid: ROW, turnId: 'running-turn' }]);
  channel.close();
});
test('a mid-turn request carries its mid-turn text to the mod; an ordinary one never does', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  const first = poll(channel), framed = channel.request('plain', 'framed', () => true, true, true, '[frame]\nplain');
  assert.deepEqual(first.value, { id: 'framed', text: 'plain', midturn: true, midturnText: '[frame]\nplain' });
  await assert.rejects(framed, error => error.notSent === true);
  const second = poll(channel), ordinary = channel.request('plain', 'ordinary', () => true, true, false, '[frame]\nplain');
  assert.deepEqual(second.value, { id: 'ordinary', text: 'plain' });
  await assert.rejects(ordinary, error => error.notSent === true);
});
test('only a guard marked as the person\'s own message tells the mod so (it may go in beside a native draft)', async t => {
  const channel = new SubmissionChannel(20); t.after(() => channel.close());
  const own = Object.assign(() => true, { ownInput: true });
  const first = poll(channel), mine = channel.request('box text', 'mine', own, true, true);
  assert.deepEqual(first.value, { id: 'mine', text: 'box text', midturn: true, own: true });
  await assert.rejects(mine, error => error.notSent === true);
  for (const guard of [() => true, Object.assign(() => true, { ownInput: 'yes' })]) {
    const next = poll(channel), other = channel.request('queue item', 'other', guard);
    assert.deepEqual(next.value, { id: 'other', text: 'queue item' });
    await assert.rejects(other, error => error.notSent === true);
  }
});
