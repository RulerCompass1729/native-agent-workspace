const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { spawn } = require('node:child_process'), { once, EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { names } = require('../operator-control.cjs');
const { Workspace } = require('../workspace.cjs');
const { createSubmissionServer, SubmissionChannel } = require('../claude-submit.cjs');

async function helper(t, codex = false) {
  const child = spawn(process.execPath, [path.join(__dirname, '../claude-message-tool.cjs'), ...(codex ? ['--codex'] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
  let data = '', serial = 0; const pending = new Map();
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    data += chunk; let end;
    while ((end = data.indexOf('\n')) >= 0) { const line = data.slice(0, end); data = data.slice(end + 1); const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id); }
  });
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) await once(child, 'exit'); });
  return (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; const timeout = setTimeout(() => reject(Error('Helper response timeout')), 3000); pending.set(id, value => { clearTimeout(timeout); resolve(value); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
}
test('actual helper exposes only the three approved Claude tools; Codex gets no unqualified operator tools', async t => {
  for (const codex of [false, true]) {
    const call = await helper(t, codex); assert.ok((await call('initialize')).result.capabilities.tools);
    const catalog = (await call('tools/list')).result.tools.map(t => t.name);
    assert.deepEqual(catalog, ['workspace_message', ...(codex ? [] : names)]);
    if (codex) { assert.ok((await call('tools/call', { name: 'workspace_sessions', arguments: {} })).error); continue; }
    const approved = await call('tools/call', { name: 'workspace_report', arguments: { request_id: 'r', dispatch_id: 'd', state: 'blocked', body: 'Exact evidence', question: null } });
    const value = JSON.parse(approved.result.content[0].text); assert.equal(value.approved, true); assert.equal(value.operator, 'workspace_report');
    assert.equal(value.status, undefined, 'Helper approval alone must never claim a durable save');
    assert.ok((await call('tools/call', { name: 'workspace_report', arguments: { request_id: 'r', dispatch_id: 'd', state: 'ready', body: 'body', question: null } })).error);
  }
});

async function bridge() {
  const raw = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8');
  const source = raw + `
export function prepareForTest(options = {}) {
 stopped = false; observationGap = false;
 rootBinding = { sessionId: 'fixture-root', socketPath: '/fixture/socket', token: 'fixture-token', lease: 'fixture-lease', observationEpoch: 'fixture-epoch' };
 activeTurn = 'fixture-turn'; rootPrompt = { id: 'fixture-prompt' };
 promptTurns.set(rootPrompt.id, { binding: rootBinding, turnId: activeTurn, ambiguous: options.ambiguous === true });
 operatorTools = Object.keys(operatorSchemas);
 if (options.wrongPrompt) promptTurns.get(rootPrompt.id).turnId = 'other-turn';
 if (options.gap) observationGap = true;
}
export function changeForTest() { activeTurn = 'new-turn'; }
//${randomUUID()}`;
  const mod = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const hooks = new Map();
  mod.register((event, match, handler) => { if (typeof match === 'function') handler = match; else if (match?.tool) hooks.set(event + ':' + match.tool, handler); return { catch() {} }; });
  return { mod, hooks };
}
test('actual named root hook rejects child/ambiguous/wrong prompt/non-engine/gap and keeps native approval on the path', async () => {
  const { mod, hooks } = await bridge(), hook = hooks.get('tool.call:mcp__native_workspace__workspace_report');
  let nativeCalls = 0, saves = 0;
  const args = { request_id: 'request', dispatch_id: 'dispatch', state: 'progress', body: 'Exact report' };
  const event = { ...args, tool_use_id: 'call' };
  const next = async () => { nativeCalls++; return { text: JSON.stringify({ approved: true, operator: 'workspace_report', arguments: args }) }; }; next.origin = { plugin: 'engine' };
  const $ = { http: { fetch: async (_url, spec) => { saves++; const body = JSON.parse(spec.body); assert.equal(body.sessionId, 'fixture-root'); assert.equal(body.turnId, 'fixture-turn'); assert.equal(body.promptId, 'fixture-prompt'); assert.equal(body.callId, 'call'); return { ok: true, text: JSON.stringify({ status: 'saved', reportId: 'durable' }) }; } } };
  for (const options of [{ ambiguous: true }, { wrongPrompt: true }, { gap: true }, { child: true }, { plugin: 'another-plugin' }, { missingCall: true }]) {
    mod.prepareForTest(options); next.origin.plugin = options.plugin || 'engine';
    const e = { ...event, ...(options.child ? { agentId: 'native-child' } : {}) }; if (options.missingCall) delete e.tool_use_id;
    assert.ok((await hook($, e, next)).deny);
  }
  assert.equal(nativeCalls, 0); assert.equal(saves, 0);
  mod.prepareForTest(); next.origin.plugin = 'engine';
  assert.equal(JSON.parse((await hook($, event, next)).result).reportId, 'durable'); assert.equal(nativeCalls, 1); assert.equal(saves, 1);
  const refused = async () => ({ deny: 'Native permission denied' }); refused.origin = next.origin;
  assert.equal((await hook($, event, refused)).deny, 'Native permission denied'); assert.equal(saves, 1);
  const changed = async () => { mod.changeForTest(); return next(); }; changed.origin = next.origin;
  assert.ok((await hook($, event, changed)).deny); assert.equal(saves, 1);
});

test('private synchronous endpoint validates lease/epoch and returns a report only after the real journal exists', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'operator-protocol-')));
  const w = new Workspace({ binaries: {}, close() {}, create(s) { const r = new EventEmitter(); s.nativeId ||= randomUUID(); r.record = s; r.operatorAvailable = r.nativeBlocks = true; r.submission = new SubmissionChannel(); r.liveTurn = { id: 'turn-' + s.id, promptId: 'prompt-' + s.id }; r.start = async () => r.emit('state', 'idle'); r.validRootBinding = m => m.lease === 'fixture-lease' && m.sessionId === s.nativeId; r.observationEpoch = 'epoch'; return r; } }, root);
  const id = await w.create('claude', root, null, 'Source'), s = w.get(id), r = w.runtimes.get(id); s.nativePermissionMode = 'default';
  w.operator.settings(null, true); w.operator.settings(id, true); w.operator.grant(id, { providers: ['claude'], directories: [root], permission: 'default', daily: 1, concurrent: 1, expiresAt: Date.now() + 60000 });
  const identity = { nativeId: s.nativeId, turnId: r.liveTurn.id, promptId: r.liveTurn.promptId, callId: 'open' };
  const opened = await r.operatorCall(identity, 'workspace_open', { action_id: 'one', provider: 'claude', cwd: root, permission: 'default', task: 'Never dispatched' });
  const executor = w.runtimes.get(opened.sessionId), socketPath = path.join(root, 'socket');
  executor.rootLease = 'fixture-lease';
  const server = createSubmissionServer(socketPath, new Map([['fixture-token', executor]])); await server.start();
  t.after(async () => { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); w.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = { sessionId: executor.record.nativeId, lease: 'fixture-lease', epoch: 'epoch', turnId: executor.liveTurn.id, promptId: executor.liveTurn.promptId, callId: 'report', tool: 'workspace_report', arguments: { request_id: opened.requestId, dispatch_id: opened.dispatchId, state: 'blocked', body: 'Saved before ACK', question: 'Actual question?' } };
  const request = (route, body = base, token = 'fixture-token') => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: 'POST', headers: { 'X-Workspace-Token': token } }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) })); }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  assert.equal((await request('/operator-call', base, 'invalid')).status, 403);
  assert.equal((await request('/operator-call', { ...base, lease: 'wrong' })).status, 409);
  assert.equal((await request('/operator-call', { ...base, epoch: 'wrong' })).body.status, 'refused');
  const result = await request('/operator-call'); assert.equal(result.body.status, 'saved');
  assert.equal(JSON.parse(fs.readFileSync(w.operator.file)).reports[result.body.reportId].body, 'Saved before ACK');
  assert.equal((await request('/operator-call')).body.status, 'duplicate');
  assert.equal((await request('/operator-call', { ...base, callId: 'forged', tool: 'grant', arguments: {} })).body.status, 'refused');
  executor.retainedReader = true;
  assert.equal((await request('/operator-capability', { ...base, tools: names })).body.received, true); assert.equal(executor.operatorAvailable, false);
  assert.equal((await request('/operator-call', { ...base, callId: 'after-revoke' })).body.status, 'refused');
});

test('native creation parameters constrain only an operator-created default session and leave ordinary defaults intact', async () => {
  const vm = require('node:vm'), source = fs.readFileSync(path.join(__dirname, '../adapters.cjs'), 'utf8');
  const from = source.indexOf('    const posture ='), to = source.indexOf('\n    // A picker', from);
  const posture = record => vm.runInNewContext(source.slice(from, to) + '\nposture', { record, EFFORT_LEVELS: ['low', 'medium', 'high'] });
  assert.deepEqual(Array.from(posture({})), []);
  assert.deepEqual(Array.from(posture({ operatorCreation: { permission: 'default' } })), ['--permission-mode', 'default']);
  assert.deepEqual(Array.from(posture({ skipPermissions: true, operatorCreation: { permission: 'bypass' } })), ['--permission-mode', 'bypassPermissions']);
  assert.deepEqual(Array.from(posture({ recovering: true, nativePermissionMode: 'plan', operatorCreation: { permission: 'default' } })), []);
  const { Codex } = require('../adapters.cjs');
  for (const operator of [false, true]) {
    const calls = [], child = { pid: 12345 }, host = { codexTargets: new Map(), codexProcess: child, startCodex: async () => {}, createCodex: fn => fn(), rpc: { call: async (method, args) => { calls.push({ method, args }); return { thread: { id: 'synthetic-thread', sessionId: 'synthetic-session' }, model: 'synthetic-model' }; } } };
    const record = { id: 'synthetic', cwd: '/tmp', provider: 'codex', view: 'chat', messages: [], ...(operator ? { operatorCreation: { permission: 'default' } } : {}) };
    await new Codex(record, host).start();
    assert.equal(calls.length, 1); assert.equal(calls[0].method, 'thread/start');
    assert.equal(calls[0].args.approvalPolicy, operator ? 'on-request' : undefined); assert.equal(calls[0].args.sandbox, operator ? 'read-only' : undefined);
    assert.equal(calls[0].args.dynamicTools.length, 1); assert.equal(calls[0].args.dynamicTools[0].name, 'workspace');
    assert.deepEqual(calls[0].args.dynamicTools[0].tools.map(t => t.name), ['workspace_message']);
  }
});

test('an exact old cwd compatibility copy passes managed calls through and refuses retained external operator use', async () => {
  const raw = fs.readFileSync(path.join(__dirname, '../claude-bridge/hooks/register.js'), 'utf8').replace('const legacyOnly = false;', 'const legacyOnly = true;');
  const mod = await import('data:text/javascript;base64,' + Buffer.from(raw + '\n//' + randomUUID()).toString('base64'));
  let hook, calls = 0;
  mod.register((event, match, handler) => { if (event === 'tool.call' && match?.tool === 'mcp__native_workspace__workspace_report') hook = handler; return { catch() {} }; });
  const next = async () => { calls++; return { result: 'from-the-managed-mod' }; };
  assert.equal((await hook({ env: { get: async () => '/managed/socket' } }, {}, next)).result, 'from-the-managed-mod');
  assert.ok((await hook({ env: { get: async () => null } }, {}, next)).deny); assert.equal(calls, 1);
});
