const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomUUID } = require('node:crypto'), { EventEmitter } = require('node:events');
const { Claude } = require('../adapters.cjs');
const { Workspace } = require('../workspace.cjs');
const { SubmissionChannel, createSubmissionServer } = require('../claude-submit.cjs');
const { ProgressJournal } = require('../observation.cjs');

function adapter() {
  const r = Object.create(Claude.prototype); EventEmitter.call(r);
  r.record = { nativeId: randomUUID() }; r.terminal = { alive: true }; r.submission = new SubmissionChannel();
  r.bindRoot({ sessionId: r.record.nativeId }); return r;
}
async function mod({ version = '2.1.306', fetchObservation, runtime } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  const { register } = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + randomUUID()).toString('base64'));
  const r = runtime || adapter(), clock = [], hooks = new Map(), requests = [];
  let native = r.record.nativeId;
  const $ = { session: { id: async () => native, version: async () => ({ version }) },
    env: { get: async key => key === 'NAW_SUBMIT_SOCKET' ? '/fixture/socket' : 'fixture-token' },
    clock: { after: (delay, fn) => { fn.delay = delay; clock.push(fn); return { cancel() { const i = clock.indexOf(fn); if (i >= 0) clock.splice(i, 1); } }; } },
    prompt: { submit: async () => { throw Error('Observation must never submit'); } },
    http: { fetch: async (url, options) => {
      const body = JSON.parse(options.body); let result;
      if (url.endsWith('/root-bind')) result = r.bindRoot(body);
      else if (url.endsWith('/next')) { if (body.observationGap) r.observeRootGap(body); result = { idle: true }; }
      else if (url.endsWith('/root-end')) result = r.endRoot(body);
      else if (url.endsWith('/root-clear')) {
        r.record.nativeId = body.nextSessionId; r.rootEnding = null; r.rootLease = randomUUID(); r.observationEpoch = randomUUID(); r.rootObservation = null; result = { lease: r.rootLease, observationEpoch: r.observationEpoch };
      }
      else if (url.endsWith('/observation')) { requests.push(body); result = fetchObservation ? await fetchObservation(body, r) : r.observeRoot(body); }
      else throw Error('Unexpected request: ' + url);
      return { ok: true, text: JSON.stringify(result) };
    } } };
  register((name, fn) => { hooks.set(name, fn); return { catch() {} }; });
  const invoke = (name, e, next = async e => ({ uuid: e.uuid, message: e.message })) => hooks.get(name)($, e, next);
  await invoke('session.start', {}); await clock.shift()(); const poll = clock.shift(); clock.length = 0;
  return { r, clock, requests, invoke, poll, setNativeId(id) { native = id; }, append: (e, next) => invoke('session.append', e, next) };
}
const response = (text = 'Intermediate native text', extra = {}) => ({ uuid: randomUUID(), door: 'response', origin: { kind: 'model', model: 'synthetic' }, message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, ...extra });

test('verified display contract carries indexed batches, empty final and interruption without waiting for HTTP', async () => {
  const f = await mod({ version: '2.1.307' }), rows = [], turn = randomUUID(), id = randomUUID();
  f.r.on('nativeBlock', row => rows.push(row));
  const promptId = randomUUID(); await f.invoke('classic.UserPromptSubmit', { session_id: f.r.record.nativeId, prompt_id: promptId });
  await f.invoke('turn.start', { turnId: turn });
  const e = { session_id: f.r.record.nativeId, turn_id: randomUUID(), prompt_id: promptId, message_id: id, index: 0, final: false, delta: 'stream\n' };
  await f.invoke('classic.MessageDisplay', e, async () => ({}));
  await f.invoke('classic.MessageDisplay', { ...e, index: 1, final: true, delta: '' }, async () => ({}));
  await f.invoke('turn.complete', { turnId: turn, reason: 'aborted', durationMs: 1200 });
  assert.equal(rows.length, 0); await f.clock.shift()();
  assert.deepEqual(rows.map(x => x.status), ['streaming', 'complete', 'interrupted']);
  assert.deepEqual(rows.slice(0, 2).map(x => x.index), [0, 1]); assert.equal(rows[1].delta, '');
  assert.ok(rows.every(row => row.turnId === turn));
});
test('display mapping excludes child text, respects downstream redaction, and never duplicates response append', async () => {
  const f = await mod({ version: '2.1.307' }), rows = []; f.r.on('nativeBlock', row => rows.push(row));
  const e = { session_id: f.r.record.nativeId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, final: true, delta: 'PRIVATE ORIGINAL' };
  await f.invoke('classic.MessageDisplay', { ...e, agent_id: 'child' }, async () => ({}));
  await f.invoke('classic.MessageDisplay', e, async () => ({ displayContent: 'REDACTED' }));
  await f.append(response('PRIVATE ORIGINAL'));
  await f.clock.shift()(); assert.equal(rows.length, 1); assert.equal(rows[0].delta, 'REDACTED');
});
test('tool identity retains its original turn when append or background result crosses a later turn', async () => {
  const f = await mod({ version: '2.1.307' }), rows = [], a = randomUUID(), b = randomUUID();
  f.r.on('nativeBlock', row => rows.push(row));
  await f.invoke('turn.start', { turnId: a });
  const e = response(); e.message.content = [{ type: 'tool_use', id: 'toolu_background', name: 'Bash', input: { command: 'printf test' } }];
  let release; const appending = f.append(e, () => new Promise(resolve => { release = resolve; }));
  await f.invoke('turn.start', { turnId: b }); release({ uuid: e.uuid, message: e.message }); await appending;
  const result = response(); result.door = 'tool-result'; result.origin = { kind: 'tool', tool: 'Bash' };
  result.message = { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_background', content: 'background result' }] };
  await f.append(result); await f.clock.shift()();
  assert.equal(rows[0].turnId, a); assert.equal(rows[1].turnId, undefined); assert.equal(rows[0].id, rows[1].id);
  const session = { nativeId: f.r.record.nativeId, messages: [] };
  for (const row of rows) require('../native-blocks.cjs').applyNativeBlock(session, row);
  assert.equal(session.messages[0].turnId, a); assert.equal(session.messages[0].text, 'background result');
});

test('observe only the stored native response, after append, without delaying or rewriting it', async () => {
  const f = await mod(), e = response(), saved = { uuid: e.uuid, message: { ...e.message, content: [{ type: 'text', text: 'Stored downstream text' }] } };
  const value = await f.append(e, async () => saved);
  assert.equal(value, saved); assert.equal(f.requests.length, 0);
  await f.clock.shift()(); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].text, 'Stored downstream text');
  assert.equal(f.requests[0].sessionId, f.r.record.nativeId); assert.equal(f.requests[0].lease, f.r.rootLease);
});
test('private hidden attachments, prompts, children, denied/changed rows and thinking are excluded', async () => {
  const f = await mod();
  for (const extra of [{ agentId: 'child' }, { door: 'attachment' }, { door: 'hook-context' }, { door: 'prompt' }, { origin: { kind: 'plugin' } }, { message: { type: 'assistant', isMeta: true, content: [{ type: 'text', text: 'private' }] } }]) await f.append(response('private', extra));
  await f.append(response(), async () => ({ deny: 'Denied' }));
  await f.append(response(), async e => ({ uuid: randomUUID(), message: e.message }));
  const e = response(); e.message.content = [{ type: 'thinking', thinking: 'never copy' }, { type: 'image', source: { data: 'never copy' } }]; await f.append(e);
  assert.equal(f.clock.length, 0); assert.equal(f.requests.length, 0);
});
test('tool result text keeps block order, excludes media bytes and marks nontext output', async () => {
  const f = await mod(), e = response();
  e.door = 'tool-result'; e.origin = { kind: 'tool', tool: 'Read' }; e.message = { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'text', text: 'first' }, { type: 'image', source: { data: 'secret-media' } }, { type: 'text', text: 'second' }] }] };
  await f.append(e); await f.clock.shift()(); const row = f.requests[0];
  assert.equal(row.text, 'first\nsecond'); assert.equal(row.nonText, true); assert.equal(row.kind, 'tool-output'); assert.equal(row.id, e.uuid + ':0'); assert.ok(!JSON.stringify(row).includes('secret-media'));
});
test('observation queue and text are bounded with explicit gaps and truncation', async () => {
  const f = await mod();
  for (let i = 0; i < 80; i++) await f.append(response('X'.repeat(15000) + i));
  assert.equal(f.requests.length, 0); assert.equal(f.clock.length, 1); await f.clock.shift()();
  assert.ok(f.requests.length <= 64); assert.ok(f.requests.reduce((n, r) => n + r.text.length, 0) <= 256000);
  assert.equal(f.requests[0].gap, true); assert.ok(f.requests.every(r => r.truncated && r.text.length === 12000));
});
test('failed observation does not retry a task and the next received row declares a gap', async () => {
  let calls = 0; const f = await mod({ fetchObservation: body => { if (++calls === 1) throw Error('Offline'); return { observed: true }; } });
  await f.append(response('first')); await f.append(response('second')); await f.clock.shift()();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].gap, true);
});
test('a failed final observation reports its gap through the next normal poll without another append', async () => {
  const f = await mod({ fetchObservation: () => { throw Error('Offline'); } }), gaps = [];
  f.r.on('progress', item => gaps.push(item)); await f.append(response()); await f.clock.shift()();
  assert.equal(gaps.length, 0); await f.poll(); assert.equal(gaps.length, 1); assert.equal(gaps[0].kind, 'gap'); assert.equal(f.requests.length, 1);
});
test('a held old-root observation times out and new-root text proceeds without old completion changing it', async () => {
  let release; const f = await mod({ fetchObservation: (body, r) => body.text === 'old' ? new Promise(resolve => { release = resolve; }) : r.observeRoot(body) });
  const seen = []; f.r.on('progress', item => seen.push(item));
  await f.append(response('old')); const flush = f.clock.shift()(); await new Promise(r => setImmediate(r));
  const previous = f.r.record.nativeId, next = randomUUID(); await f.invoke('session.end', { sessionId: previous, reason: 'clear' });
  // $.session.id already points at the new native root when classic start fires.
  f.setNativeId(next); await f.invoke('classic.SessionStart', { session_id: next, source: 'clear' });
  for (let i = 0; i < 5 && f.clock.some(fn => fn.delay === 0); i++) { const j = f.clock.findIndex(fn => fn.delay === 0); await f.clock.splice(j, 1)[0](); }
  await f.append(response('new')); const timeout = f.clock.find(fn => fn.delay === 1500); assert.ok(timeout); timeout(); await flush;
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].sessionId, next); assert.equal(seen.at(-1).text, 'new');
  release({ observed: true }); await new Promise(r => setImmediate(r)); assert.equal(seen.length, 1);
});
test('blocked local delivery never blocks the next native append', async () => {
  let release; const f = await mod({ fetchObservation: () => new Promise(resolve => { release = resolve; }) });
  await f.append(response()); const pending = f.clock.shift()(); await new Promise(r => setImmediate(r));
  const e = response('another native message'), result = await f.append(e); assert.equal(result.uuid, e.uuid);
  // End the root before releasing the first observation: queued stale rows cannot
  // be attributed to a new native conversation or become shared work.
  await f.invoke('session.end', { sessionId: f.r.record.nativeId, reason: 'clear' });
  release({ observed: true }); await pending; assert.equal(f.requests.length, 1);
});
test('a timed-out same-root observation cannot arrive after a newer row as the latest output', async () => {
  let deliverOld; const f = await mod({ fetchObservation: (body, r) => body.text === 'old'
    ? new Promise((resolve, reject) => { deliverOld = () => { try { resolve(r.observeRoot(body)); } catch (e) { reject(e); } }; }) : r.observeRoot(body) });
  const seen = []; f.r.on('progress', item => seen.push(item));
  await f.append(response('old')); await f.append(response('new'));
  const flush = f.clock.shift()(); await new Promise(r => setImmediate(r));
  f.clock.find(fn => fn.delay === 1500)(); await flush;
  assert.deepEqual(seen.map(x => x.kind), ['gap', 'response']); assert.equal(seen.at(-1).text, 'new');
  deliverOld(); await new Promise(r => setImmediate(r));
  assert.equal(seen.length, 2); assert.equal(seen.at(-1).text, 'new');
  assert.deepEqual(f.requests.map(x => x.sequence), [1, 2]);
  assert.equal(f.r.rootObservation.sequence, 2);
});
test('reloading an observer rejects old in-flight higher sequences without changing the control lease', async () => {
  const deliveries = [], f = await mod({ fetchObservation: (body, r) => new Promise((resolve, reject) => {
    deliveries.push(() => { try { resolve(r.observeRoot(body)); } catch (e) { reject(e); } });
  }) }), seen = [];
  f.r.on('progress', item => seen.push(item));
  for (let i = 0; i < 2; i++) {
    await f.append(response('old-' + i)); const flush = f.clock.shift()(); await new Promise(r => setImmediate(r));
    f.clock.find(fn => fn.delay === 1500)(); await flush;
  }
  const lease = f.r.rootLease, previousEpoch = f.r.observationEpoch;
  const next = await mod({ runtime: f.r }); assert.equal(f.r.rootLease, lease); assert.notEqual(f.r.observationEpoch, previousEpoch);
  await next.append(response('new')); await next.clock.shift()();
  assert.equal(seen.at(-1).text, 'new'); assert.equal(next.requests[0].sequence, 1);
  for (const deliver of deliveries) deliver(); await new Promise(r => setImmediate(r));
  assert.deepEqual(seen.map(x => x.kind), ['gap', 'response']); assert.equal(seen[1].text, 'new');
  assert.throws(() => f.r.observeRootGap({ sessionId: f.r.record.nativeId, lease, epoch: previousEpoch }), /Invalid/);
});
test('unresolved native HTTP calls remain capped while a normal poll can disclose dropped tail output', async () => {
  const releases = [], f = await mod({ fetchObservation: () => new Promise(resolve => releases.push(resolve)) }), gaps = [];
  f.r.on('progress', item => gaps.push(item));
  for (let i = 0; i < 3; i++) {
    await f.append(response('held-' + i)); const flush = f.clock.shift()(); await new Promise(r => setImmediate(r));
    const timeout = f.clock.find(fn => fn.delay === 1500); if (timeout) timeout(); await flush;
  }
  assert.equal(f.requests.length, 2); assert.equal(releases.length, 2);
  await f.poll(); assert.equal(gaps.length, 1); assert.equal(gaps[0].kind, 'gap');
  for (const release of releases) release({ observed: true }); await new Promise(r => setImmediate(r));
});
test('unverified runtime versions do not enable native message observation', async () => {
  const f = await mod({ version: '2.1.307' }); await f.append(response()); assert.equal(f.clock.length, 0); assert.equal(f.requests.length, 0);
});
test('legacy observation appears inline but remains volatile and cannot alter readiness, sharing or dispatch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-observation-')); let r;
  const w = new Workspace({ binaries: {}, close() {}, create(record) { r = adapter(); r.record = record; r.chatAvailable = true; r.start = async () => r.emit('state', 'working'); return r; } }, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await w.create('claude', dir, 'owner'); w.join(id, true); const before = JSON.stringify(w.snapshot());
  const body = { sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: 1, id: randomUUID(), kind: 'response', text: 'PRIVATE_NATIVE_OUTPUT', gap: true, truncated: true };
  r.observeRoot(body); assert.throws(() => r.observeRoot({ ...body, gap: false }), /Stale/);
  const after = w.snapshot(); assert.equal(after.sessions[0].messages.at(-1).text, body.text);
  after.sessions[0].messages = []; assert.equal(JSON.stringify(after), before); const observed = await w.observe(id);
  assert.equal(observed.progress.items.length, 2); assert.equal(observed.progress.items.at(-1).truncated, true);
  w.persist(); assert.ok(!fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8').includes(body.text));
});
test('private observation transport rejects stale root leases, invalid IDs and oversized text', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-observe-')), socketPath = path.join(dir, 's'), r = adapter(), journal = new ProgressJournal();
  r.on('progress', item => journal.update(item)); const transport = createSubmissionServer(socketPath, new Map([['token', r]])); await transport.start();
  t.after(async () => { r.submission.close(); transport.server.closeAllConnections(); await new Promise(resolve => transport.server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const request = body => new Promise((resolve, reject) => { const req = http.request({ socketPath, path: '/observation', method: 'POST', headers: { 'X-Workspace-Token': 'token' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end(JSON.stringify(body)); });
  const row = { sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch, sequence: 1, id: randomUUID(), kind: 'response', text: 'Observed' };
  for (const patch of [{ lease: 'stale' }, { sessionId: randomUUID() }, { id: '<script>' }, { kind: 'prompt' }, { text: 'x'.repeat(12001) }, { sequence: 0 }, { sequence: 1.5 }, { sequence: null }]) assert.equal(await request({ ...row, ...patch }), 409);
  assert.equal(journal.items.size, 0); assert.equal(await request(row), 200); assert.equal(journal.items.size, 1);
  r.rootEnding = { sessionId: r.record.nativeId }; assert.equal(await request(row), 409);
});
test('held native turn completion cannot enter a newly cleared root', async () => {
  const f = await mod({ version: '2.1.307' }), rows = [], turnId = randomUUID();
  f.r.on('nativeBlock', row => rows.push(row));
  let release; const finishing = f.invoke('turn.complete', { turnId, reason: 'aborted' }, () => new Promise(resolve => { release = resolve; }));
  const previous = f.r.record.nativeId, next = randomUUID();
  await f.invoke('session.end', { sessionId: previous, reason: 'clear' }); f.setNativeId(next);
  await f.invoke('classic.SessionStart', { session_id: next, source: 'clear' });
  for (let i = 0; i < 5 && f.clock.some(fn => fn.delay === 0); i++) { const j = f.clock.findIndex(fn => fn.delay === 0); await f.clock.splice(j, 1)[0](); }
  release({}); await finishing;
  for (let i = 0; i < 5 && f.clock.some(fn => fn.delay === 0); i++) { const j = f.clock.findIndex(fn => fn.delay === 0); await f.clock.splice(j, 1)[0](); }
  assert.equal(rows.length, 0); assert.equal(f.r.record.nativeId, next);
});
test('display redaction survives Stop, shared room retention and the next automatic handoff', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-display-proof-')); let r;
  const w = new Workspace({ binaries: {}, close() {}, create(record) { r = adapter(); r.record = record; r.chatAvailable = true; return r; } }, dir);
  t.after(() => { w.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const id = await w.create('claude', dir, 'owner'); w.join(id, true);
  const f = await mod({ runtime: r, version: '2.1.307' });
  const turnId = randomUUID(), promptId = randomUUID(), tag = randomUUID();
  r.pending = { nativeId: r.record.nativeId, accepted: true, promptId, turnId, tag, guard: () => true };
  w.get(id).pendingTag = tag; w.forwards.set(tag, { member: w.get(id).memberRevision, control: w.get(id).controlRevision });
  const advanced = []; w.advance = async (_, info) => advanced.push(info);
  await f.invoke('classic.UserPromptSubmit', { session_id: r.record.nativeId, prompt_id: promptId });
  await f.invoke('turn.start', { turnId });
  const e = { session_id: r.record.nativeId, prompt_id: promptId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, final: true, delta: 'PRIVATE ORIGINAL' };
  await f.invoke('classic.MessageDisplay', e, async () => ({ displayContent: 'REDACTED' }));
  // Stop arrives before the asynchronous display observation: it cannot leak.
  r.finishReply(r.pending, { prompt_id: promptId, last_assistant_message: 'PRIVATE ORIGINAL', background_tasks: [], session_crons: [], stop_hook_active: false });
  assert.equal(w.room.messages.length, 0); assert.equal(advanced.length, 0);
  await f.invoke('turn.complete', { turnId, reason: 'answer', answer: 'PRIVATE ORIGINAL' }); await f.clock.shift()();
  assert.equal(w.room.messages[0].text, 'REDACTED'); assert.equal(advanced[0].text, 'REDACTED'); assert.equal(advanced[0].tag, tag);
  assert.ok(!JSON.stringify(w.snapshot()).includes('PRIVATE ORIGINAL')); w.persist();
  assert.ok(!fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8').includes('PRIVATE ORIGINAL'));
});
test('missing display identity or a display gap never falls back to raw Stop text', async () => {
  for (const gap of [false, true]) {
    const f = await mod({ version: '2.1.307' }), r = f.r, turnId = randomUUID(), promptId = randomUUID(), tag = randomUUID(), complete = [];
    r.pending = { nativeId: r.record.nativeId, accepted: true, promptId, turnId, tag, guard: () => true };
    r.on('complete', info => complete.push(info));
    await f.invoke('classic.UserPromptSubmit', { session_id: r.record.nativeId, prompt_id: promptId });
  await f.invoke('turn.start', { turnId });
  const e = { session_id: r.record.nativeId, prompt_id: promptId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, final: true, delta: 'PRIVATE' };
    await f.invoke('classic.MessageDisplay', e, async () => ({ displayContent: 'MASKED' }));
    await f.invoke('turn.complete', { turnId, reason: 'answer', answer: gap ? 'PRIVATE' : 'OTHER' });
    if (gap) r.observeRootGap({ sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch });
    await f.clock.shift()();
    r.finishReply(r.pending, { prompt_id: promptId, last_assistant_message: 'PRIVATE' });
    assert.equal(complete[0].tag, undefined); assert.equal(complete[0].text, '');
  }
});
test('a gap or late batch after a valid final display revokes sharing before a delayed Stop', async () => {
  for (const damage of ['gap', 'late']) {
    const f = await mod({ version: '2.1.307' }), r = f.r, turnId = randomUUID(), promptId = randomUUID(), tag = randomUUID(), completed = [];
    await f.invoke('classic.UserPromptSubmit', { session_id: r.record.nativeId, prompt_id: promptId }); await f.invoke('turn.start', { turnId });
    r.pending = { nativeId: r.record.nativeId, accepted: true, promptId, turnId, tag, guard: () => true }; r.on('complete', info => completed.push(info));
    const e = { session_id: r.record.nativeId, prompt_id: promptId, turn_id: randomUUID(), message_id: randomUUID(), index: 0, final: true, delta: 'Safe display\n' };
    await f.invoke('classic.MessageDisplay', e, async () => ({}));
    await f.invoke('turn.complete', { turnId, reason: 'answer', answer: 'Safe display' }); await f.clock.shift()();
    assert.equal(r.displayProofs.get(turnId).safeText, 'Safe display\n');
    if (damage === 'gap') r.observeRootGap({ sessionId: r.record.nativeId, lease: r.rootLease, epoch: r.observationEpoch });
    else { await f.invoke('classic.MessageDisplay', { ...e, index: 1, delta: 'late' }, async () => ({})); await f.clock.shift()(); }
    r.finishReply(r.pending, { prompt_id: promptId, last_assistant_message: 'Safe display' });
    assert.equal(completed[0].tag, undefined); assert.equal(completed[0].text, '');
  }
});
