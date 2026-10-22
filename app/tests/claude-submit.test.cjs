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
  channel.authorize(third.value); channel.close(); await assert.rejects(closing, /关闭/);
  assert.equal(poll(channel).value, undefined);
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
