'use strict';
// A local-only proof. Installs no dependency and never accepts a live endpoint.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), net = require('node:net');
const assert = require('node:assert/strict'), readline = require('node:readline'), { randomUUID } = require('node:crypto');
const testScratch = require('./fixtures/test-scratch.cjs');
const { spawn, execFileSync } = testScratch.childProcess;
const { ButlerLedger } = require('../app/butler-ledger.cjs');
const { ButlerRole } = require('../app/butler-role.cjs');
const { ButlerController } = require('../app/butler-controller.cjs');
const policy = require('../app/butler-policy.cjs');
const root = path.resolve(__dirname, '..'), deps = path.join(root, '.local/dsh-deps');
const evidence = path.join(root, '.local/evidence/b4-dsh-proof-20261110', 'run-' + randomUUID());
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const save = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const requests = [], fixtureUsage = [], children = [], summary = { parentPid: process.pid, paidRequests: 0, endpoint: 'loopback-only', status: 'starting', hosts: [], sessions: [] };
let server, other, unixServer;
const cleanup = testScratch.cleanup(async () => {
  for (const s of [server, other, unixServer]) if (s?.listening) { s.closeAllConnections?.(); await new Promise(r => s.close(r)); }
});
const sample = () => ({ eventId: 'event-' + (summary.sessions.length + 1), sourceRef: 'synthetic-source-' + (summary.sessions.length + 1), kind: 'request', payload: { text: 'Synthetic payload for event-' + (summary.sessions.length + 1) } });
const connectionPolicy = port => `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${port}"))(deny mach-lookup (global-name "com.apple.mDNSResponder"))(deny mach-lookup (global-name "com.apple.securityd"))`;
function fixedSse(body) {
  const usage = { inputTokens: 10 + requests.length, outputTokens: requests.length };
  fixtureUsage.push(usage);
  const toolResult = body.messages.some(m => m.content?.some(c => c.type === 'tool_result'));
  const texts = body.messages.flatMap(m => m.content || []).filter(c => c.type === 'text');
  const input = texts.map(c => { try { return JSON.parse(c.text); } catch { return null; } }).find(v => v?.version === 1 && v.events);
  assert.ok(input); assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].name, 'mcp__native_workspace__workspace_status');
  assert.equal(body.thinking.type, 'disabled');
  assert.equal(body.max_tokens, 1024); assert.equal(body.model, 'deepseek-v4-pro');
  const block = toolResult ? { type: 'text', text: '' } : { type: 'tool_use', id: 'fixture-call', name: body.tools[0].name, input: {} };
  const delta = toolResult ? { type: 'text_delta', text: JSON.stringify({ actions: [{ kind: 'report', sourceRef: input.events[0].sourceRef, text: 'Fixed synthetic report' }] }) }
    : { type: 'input_json_delta', partial_json: '{}' };
  return [
    { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.inputTokens, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: toolResult ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: usage.outputTokens } },
    { type: 'message_stop' },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
async function listen(s, ...args) { await new Promise((r, j) => { s.once('error', j); s.listen(...args, r); }); }
function envFor(home, port) { return { PATH: '/usr/bin:/bin:/opt/homebrew/bin', LANG: 'en_US.UTF-8', HOME: home, DSH_HOME: path.join(evidence, 'dsh-home'), TMPDIR: home,
  DEEPSEEK_API_KEY: 'local-fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}`, NO_PROXY: '*' }; }
async function host(port, ordinal) {
  const home = path.join(evidence, 'host-' + ordinal); fs.mkdirSync(home, { mode: 0o700 });
  const start = performance.now();
  const child = spawn('/usr/bin/sandbox-exec', ['-p', connectionPolicy(port), process.execPath, path.join(__dirname, 'fixtures/dsh-proof/host.mjs'), deps, home],
    { cwd: home, env: envFor(home, port), stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  const messages = [], pending = [];
  const lines = readline.createInterface({ input: child.stdout });
  const stderr = fs.openSync(path.join(home, 'stderr.log'), 'a', 0o600); child.stderr.on('data', b => fs.writeSync(stderr, b)); child.once('close', () => fs.closeSync(stderr));
  lines.on('line', l => { try { const m = JSON.parse(l); if (pending.length) pending.shift()(m); else messages.push(m); } catch { throw Error('Non-JSON host output'); } });
  const receive = () => Promise.race([new Promise(resolve => messages.length ? resolve(messages.shift()) : pending.push(resolve)),
    new Promise((_, reject) => { const t = setTimeout(() => reject(Error('host-response-timeout')), 15000); t.unref(); })]);
  const ready = await receive(); if (ready.type !== 'ready') throw Error(JSON.stringify(ready));
  ready.wallStartupMs = performance.now() - start; assert.notEqual(ready.pid, process.pid); summary.hosts.push(ready);
  return { child, home, receive, async status() { child.stdin.write(JSON.stringify({ type: 'status' }) + '\n'); return receive(); }, async run(input, expected) {
    const sessionId = 'dsh-proof-' + randomUUID();
    child.stdin.write(JSON.stringify({ type: 'run', sessionId, input }) + '\n');
    const result = await receive(); save(sessionId + '-result.json', result);
    assert.equal(result.type, 'result'); assert.equal(result.end.kind, 'completed');
    summary.sessions.push({ sessionId, ...result });
    assert.equal(result.requestUsage.length, 2);
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0, source: 'dsh-loopback-fixture', estimated: false };
    for (const request of result.requestUsage) for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) usage[key] += request[key];
    return { batchId: input.batchId, attempt: input.attempt, selection: expected, reply: JSON.parse(result.final), usage };
  } };
}
async function stopChild(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => { const t = setTimeout(() => child.kill('SIGKILL'), 2000); child.once('exit', () => { clearTimeout(t); resolve(); }); child.kill(signal); });
}
(async () => {
  try {
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', b => { raw += b; if (raw.length > 65536) req.destroy(); });
      req.on('end', () => { try {
        assert.equal(req.headers['x-api-key'], 'local-fixture'); assert.equal(req.headers.authorization, undefined);
        assert.equal(req.url, '/v1/messages');
        const body = JSON.parse(raw);
        requests.push({ method: req.method, path: req.url, headerNames: Object.keys(req.headers).sort(), body }); save('requests.json', requests);
        assert.ok(requests.length <= 8, 'No unexpected requests');
        const sse = fixedSse(body); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse);
      } catch (error) { summary.fixtureError = error.message; res.writeHead(400); res.end('fixture rejected request'); } });
    });
    await listen(server, 0, '127.0.0.1'); const port = server.address().port;
    other = net.createServer(s => s.end()); await listen(other, 0, '127.0.0.1');
    const socketPath = '/tmp/naw-dsh-proof-' + process.pid + '.sock'; unixServer = net.createServer(s => s.end()); await listen(unixServer, socketPath);
    const probe = `const n=require('net');const cases=JSON.parse(process.argv[1]);Promise.all(Object.entries(cases).map(([k,v])=>new Promise(r=>{const s=n.connect(v),t=setTimeout(()=>{s.destroy();r([k,'timeout'])},1500);s.once('connect',()=>{clearTimeout(t);s.destroy();r([k,'connected'])});s.once('error',e=>{clearTimeout(t);r([k,e.code])})}))).then(x=>console.log(JSON.stringify(Object.fromEntries(x))))`;
    const cases = { allowed: { host: '127.0.0.1', port }, other: { host: '127.0.0.1', port: other.address().port }, outside: { host: '192.0.2.1', port: 443 }, unix: socketPath };
    summary.network = JSON.parse(execFileSync('/usr/bin/sandbox-exec', ['-p', connectionPolicy(port), process.execPath, '-e', probe, JSON.stringify(cases)], { env: envFor(evidence, port), encoding: 'utf8', timeout: 7000 }));
    assert.deepEqual(summary.network, { allowed: 'connected', other: 'EPERM', outside: 'EPERM', unix: 'EPERM' });
    let active = await host(port, 1);
    const ledgerDir = path.join(evidence, 'ledger'); fs.mkdirSync(ledgerDir, { mode: 0o700 });
    let ledger = new ButlerLedger(ledgerDir);
    const expected = { selectionRevision: 1, identity: { sessionId: 'dsh-butler', nativeId: 'dsh-role-identity' }, runnerRef: 'butler-runner:dsh' };
    const consume = async () => {
      const event = sample(); ledger.ingest(event); const batch = ledger.beginBatch(expected); ledger.beginAttempt(batch.batchId, expected);
      const input = { ...policy.buildInput({ batchId: batch.batchId, events: ledger.snapshot().pendingEvents, catalog: [], questions: [] }), attempt: batch.attempt };
      assert.deepEqual(input.events.map(e => e.eventId), [event.eventId]);
      const response = await active.run(input, expected);
      ledger.recordAttemptUsage(batch.batchId, expected, response.usage, batch.attempt);
      ledger.completeBatch(batch.batchId, expected, policy.interpretResult(response.reply, { events: input.events, catalog: [] }));
      assert.equal(ledger.snapshot().pendingEvents.length, 0);
    };
    await consume(); await consume();
    await new Promise(resolve => setTimeout(resolve, 500));
    summary.residentAfterTwoSessions = await active.status();
    await stopChild(active.child, 'SIGKILL'); active = await host(port, 2); ledger = new ButlerLedger(ledgerDir); await consume();
    summary.residentAfterRestart = await active.status();
    summary.processed = ledger.snapshot();
    const usageRows = summary.processed.attempts.map(attempt => attempt.usage);
    summary.metered = { requestCount: summary.sessions.reduce((n, s) => n + s.requestUsage.length, 0),
      inputTokens: usageRows.reduce((n, u) => n + u.inputTokens, 0), outputTokens: usageRows.reduce((n, u) => n + u.outputTokens, 0),
      totalTokens: usageRows.reduce((n, u) => n + u.totalTokens, 0), costMicros: 0, source: 'fixed-loopback-counters-through-DSH-to-NAW-ledger' };
    assert.equal(summary.metered.requestCount, fixtureUsage.length);
    assert.equal(summary.metered.inputTokens, fixtureUsage.reduce((n, u) => n + u.inputTokens, 0));
    assert.equal(summary.metered.outputTokens, fixtureUsage.reduce((n, u) => n + u.outputTokens, 0));
    assert.equal(summary.metered.totalTokens, summary.metered.inputTokens + summary.metered.outputTokens);
    save('fixture-usage.json', fixtureUsage);
    assert.equal(summary.processed.cursors.processed, 3);
    for (let i = 0; i < requests.length; i++) {
      const wire = JSON.stringify(requests[i].body);
      const current = Math.floor(i / 2) + 1;
      for (let prior = 1; prior < current; prior++) {
        assert.ok(!wire.includes('event-' + prior), 'A fresh session cannot replay processed event text');
        assert.ok(!wire.includes('synthetic-source-' + prior), 'A fresh session cannot replay processed source references');
      }
    }
    summary.sameDshHomeAcrossRestart = true;
    summary.compactionObserved = summary.sessions.some(s => s.eventTypes.some(t => /compact/i.test(t)));
    assert.equal(summary.compactionObserved, false);
    assert.equal(requests.length, 6); assert.equal(summary.sessions.length, 3);
    const roleDir = path.join(evidence, 'role'); fs.mkdirSync(roleDir, { mode: 0o700 });
    const person = Symbol('test person'), role = new ButlerRole(roleDir, { authorizePerson: x => x === person });
    const runner = { runnerRef: 'butler-runner:dsh', backendRef: 'butler-backend:dsh', purpose: 'butler', profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' };
    const dshIdentity = { sessionId: 'dsh-butler', nativeId: summary.sessions.at(-1).sessionId };
    role.set(person, { identity: dshIdentity, runner, budget: { limitMicros: 2000000 } }, 0);
    const record = { id: dshIdentity.sessionId, nativeId: dshIdentity.nativeId, provider: 'dsh', state: 'idle', roomIds: [], runner };
    // Positive control isolates the provider predicate; never passed to the DSH runner.
    const codexControl = { ...record, provider: 'codex' };
    assert.equal(role.authorize(codexControl, { selectionRevision: 1, runnerRef: runner.runnerRef }, [codexControl]).identity.nativeId, dshIdentity.nativeId);
    summary.roleProviderPositiveControl = 'authorized-with-only-provider-changed';
    assert.throws(() => role.authorize(record, { selectionRevision: 1, runnerRef: runner.runnerRef }, [record]), { code: 'ERR_BUTLER_UNAUTHORIZED' });
    let calls = 0;
    const controller = new ButlerController({ role, ledger, backend: { ensure: async () => ({ ready: true, binding: runner }) }, view: () => ({ records: [record], spaces: [] }), run: async (...a) => { calls++; return active.run(...a); }, estimateBatchCost: () => 0 });
    summary.controllerOutcome = await controller.receive({ eventId: 'blocked-dsh-event', kind: 'request', sourceRef: 'synthetic-role-check', payload: { text: 'No identity masquerade' } });
    assert.deepEqual(summary.controllerOutcome, { status: 'blocked', reason: 'context-unavailable', batchId: null });
    assert.equal(calls, 0); await controller.close();
    summary.roleGate = 'ERR_BUTLER_UNAUTHORIZED';
    const requestsBeforeClose = requests.length;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Error('DSH close command did not finish')), 3000);
      active.child.once('exit', (code, signal) => { clearTimeout(t); summary.closeCommand = { exitCode: code, signal }; resolve(); });
      active.child.stdin.write(JSON.stringify({ type: 'close' }) + '\n');
    });
    assert.equal(summary.closeCommand.exitCode, 0);
    await new Promise(r => setTimeout(r, 100)); assert.equal(requests.length, requestsBeforeClose);
    summary.closeCommand.requestsAfterClose = requests.length - requestsBeforeClose;
    summary.status = 'partial-proof-core-role-blocked';
  } catch (error) { summary.status = 'failed'; summary.error = error.stack; process.exitCode = 1; }
  finally {
    for (const child of children) await stopChild(child);
    await cleanup();
    try {
      const pids = summary.hosts.map(h => h.pid);
      for (const h of ['host-1', 'host-2']) {
        const file = path.join(evidence, h, 'mcp.jsonl');
        if (fs.existsSync(file)) pids.push(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).pid);
      }
      summary.ownedProcesses = pids.map(pid => {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
        return { pid, afterCleanup: 'ESRCH' };
      });
    } catch (error) { summary.status = 'failed'; summary.cleanupError = error.message; process.exitCode = 1; }
    save('summary.json', summary); console.log(JSON.stringify({ evidence, status: summary.status, requests: requests.length, error: summary.error, fixtureError: summary.fixtureError }));
  }
})();
