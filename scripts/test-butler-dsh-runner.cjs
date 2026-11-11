'use strict';
// Real production host/driver, fixed local model and MCP only. Never a live run.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const appRoot = path.resolve(process.argv.find(a => a.startsWith('--app-root='))?.slice(11) || root);
if (appRoot.startsWith('/Applications/')) throw Error('Daily app is forbidden');
if (Object.hasOwn(process.env, 'DEEPSEEK_API_KEY') || Object.hasOwn(process.env, 'DEEPSEEK_BASE_URL')) throw Error('Run with inherited DeepSeek variables removed');
const { ButlerDshDriver } = require(path.join(appRoot, 'app/butler-dsh-driver.cjs'));
const { ButlerBackend } = require(path.join(appRoot, 'app/butler-backend.cjs'));
const { createDedicatedBackend } = require(path.join(appRoot, 'app/butler-backend-host.cjs'));
const { ButlerLedger } = require(path.join(appRoot, 'app/butler-ledger.cjs'));
const { ButlerRole } = require(path.join(appRoot, 'app/butler-role.cjs'));
const { ButlerController } = require(path.join(appRoot, 'app/butler-controller.cjs'));
const policy = require(path.join(appRoot, 'app/butler-policy.cjs'));
const evidence = path.join(root, '.local/evidence/b4-dsh-runner-20261111', 'run-' + randomUUID());
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const executable = path.resolve(process.argv.find(a => a.startsWith('--executable='))?.slice(13) || process.execPath);
if (executable.startsWith('/Applications/')) throw Error('Daily app is forbidden');
const requests = [], drivers = [], summary = { realModelRequests: 0, status: 'running' };
const save = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2), { mode: 0o600 });
let server, controller;
function sse(body, ordinal) {
  const usage = { input_tokens: 10 + ordinal, output_tokens: 0,
    ...(ordinal === 3 ? { cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } : {}) };
  const done = body.messages.some(m => m.content?.some(c => c.type === 'tool_result'));
  const input = body.messages.flatMap(m => m.content || []).filter(c => c.type === 'text').map(c => { try { return JSON.parse(c.text); } catch {} }).find(v => v?.version === 1);
  assert.ok(input); assert.equal(body.max_tokens, 4096); assert.equal(body.model, 'deepseek-v4-pro');
  assert.deepEqual(body.tools.map(t => t.name), ['mcp__native_workspace__workspace_status']);
  const block = done ? { type: 'text', text: '' } : { type: 'tool_use', id: 'synthetic-call', name: body.tools[0].name, input: {} };
  const text = JSON.stringify({ actions: [{ kind: 'report', sourceRef: input.events[0].sourceRef, text: 'Synthetic DSH result' }] });
  return [
    { type: 'message_start', message: { id: 'fixture-message', type: 'message', role: 'assistant', model: body.model, content: [], usage } },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta: done ? { type: 'text_delta', text } : { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: done ? 'end_turn' : 'tool_use' }, usage: { ...usage, output_tokens: ordinal } },
    { type: 'message_stop' },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
(async () => {
  try {
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', b => { raw += b; if (raw.length > 262144) req.destroy(); });
      req.on('end', () => { try {
        assert.equal(req.url, '/v1/messages'); assert.equal(req.headers['x-api-key'], 'fixture-key');
        assert.equal(req.headers['x-deepseek-harness-user-id'], undefined);
        assert.equal(req.headers['x-deepseek-harness-session-id'], undefined);
        const body = JSON.parse(raw); requests.push({ headerNames: Object.keys(req.headers), body });
        assert.ok(requests.length <= 6); const output = sse(body, requests.length);
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(output);
      } catch (e) { summary.fixtureFailure = e.message; res.writeHead(400); res.end('Fixture failure'); } });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
    const wrapper = path.join(evidence, 'sandboxed-node');
    const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/sandbox-exec -p ' + shellQuote(`(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${port}"))`) + ' ' + shellQuote(executable) + ' "$@"\n', { mode: 0o700 });
    const directory = path.join(evidence, 'backend'), backend = new ButlerBackend(directory, { runtimeVersion: 'fixture-dsh',
      configuration: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' } });
    backend.prepare(); const proof = JSON.parse(fs.readFileSync(backend.file)).binding;
    const mcp = { command: process.execPath, args: [path.join(__dirname, 'fixtures/butler-dsh-mcp.cjs'), path.join(evidence, 'mcp.jsonl')],
      tools: ['mcp__native_workspace__workspace_status'] };
    const make = () => { const d = new ButlerDshDriver(directory, { executablePath: wrapper, mcp, priceUsage: () => 0,
      fixtureEndpoint: `http://127.0.0.1:${port}` }); drivers.push(d); return d; };
    let driver = make();
    for (const key of ['profile', 'provider', 'model']) await assert.rejects(driver.start({ ...proof, [key]: 'wrong' }), /binding-mismatch/);
    await assert.rejects(driver.start(proof), e => e.code === 'credential-missing' && /DEEPSEEK_API_KEY/.test(e.message));
    assert.equal(fs.existsSync(driver.file), false); assert.equal(requests.length, 0);
    process.env.DEEPSEEK_API_KEY = 'fixture-key'; process.env.DEEPSEEK_BASE_URL = 'https://inherited-endpoint.invalid';
    const production = createDedicatedBackend(path.join(evidence, 'still-off'), { runtimeVersion: 'fixture-dsh' });
    const off = await production.ensure(); assert.equal(off.ready, false);
    assert.deepEqual(off.blocked, ['tools-unqualified', 'context-unqualified', 'provider-unqualified', 's2-unqualified']);
    assert.equal(production.driver.child, null);
    await driver.start(proof); summary.firstHost = driver.readyReceipt;
    assert.notEqual(driver.child.pid, process.pid);
    const roleDir = path.join(evidence, 'role'), ledgerDir = path.join(evidence, 'ledger');
    fs.mkdirSync(roleDir, { mode: 0o700 }); fs.mkdirSync(ledgerDir, { mode: 0o700 });
    const person = Symbol('synthetic user'), role = new ButlerRole(roleDir, { authorizePerson: x => x === person });
    let ledger = new ButlerLedger(ledgerDir), revision = 0, record;
    const runnerBinding = Object.fromEntries(['runnerRef', 'backendRef', 'purpose', 'profile', 'provider', 'model'].map(k => [k, proof[k]]));
    function designate() {
      const identity = { sessionId: 'synthetic-butler', nativeId: driver.nativeId };
      role.set(person, { identity, runner: runnerBinding, budget: { limitMicros: 2000000 } }, revision++);
      record = { id: identity.sessionId, nativeId: identity.nativeId, provider: 'dsh', state: 'idle', roomIds: [], runner: runnerBinding };
    }
    const event = n => ({ eventId: 'event-' + n, sourceRef: 'source-' + n, kind: 'request', payload: { text: 'Unique synthetic event ' + n } });
    async function consume(n) {
      const expected = { selectionRevision: revision, identity: { sessionId: record.id, nativeId: record.nativeId }, runnerRef: proof.runnerRef };
      if (process.argv.includes('--driver-only')) {
        ledger.ingest(event(n)); const batch = ledger.beginBatch(expected); ledger.beginAttempt(batch.batchId, expected);
        const input = { ...policy.buildInput({ batchId: batch.batchId, events: ledger.pendingEvents(), catalog: [] }), attempt: batch.attempt };
        const result = await driver.run(input, expected);
        ledger.recordAttemptUsage(batch.batchId, expected, result.usage, batch.attempt);
        ledger.completeBatch(batch.batchId, expected, policy.interpretResult(result.reply, { events: input.events, catalog: [] }));
      } else {
        // Test-only readiness dependency; real production qualification stays
        // false above and is never opened by this script or its fixture pricing.
        controller = new ButlerController({ role, ledger, backend: { ensure: async () => ({ ready: true, binding: runnerBinding }) },
          view: () => ({ records: [record], spaces: [] }), run: (input, expected) => driver.run(input, expected),
          estimateBatchCost: () => 0, publish: async receipt => ({ deliveryId: receipt.deliveryId, status: 'sent' }) });
        const result = await controller.receive(event(n)); assert.equal(result.status, 'recorded', JSON.stringify(result));
        await controller.close(); controller = null;
      }
      assert.equal(ledger.pendingEvents().length, 0);
    }
    designate(); await consume(1);
    await assert.rejects(driver.run({ batchId: 'invalid', attempt: 1 }, { selectionRevision: revision, identity: { sessionId: record.id, nativeId: 'wrong' }, runnerRef: proof.runnerRef }), /selection-mismatch/);
    await driver.rotate(); summary.rotatedNativeId = driver.nativeId; designate(); await consume(2);
    assert.equal(fs.existsSync(path.join(driver.home, '.anonymous-user-id')), false);
    const firstPid = driver.child.pid; await driver.close(); assert.throws(() => process.kill(firstPid, 0), { code: 'ESRCH' });
    // Existing-ID witness: a FIFO blocks on ANY read. Normal completion shows
    // the pinned patched provider did not read it; it is never a real ID/key.
    require('node:child_process').execFileSync('/usr/bin/mkfifo', [path.join(driver.home, '.anonymous-user-id')]);
    driver = make(); await driver.start(proof); ledger = new ButlerLedger(ledgerDir); designate(); await consume(3);
    summary.secondHost = driver.readyReceipt; summary.ledger = ledger.snapshot();
    const mcpEvents = fs.readFileSync(path.join(evidence, 'mcp.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(mcpEvents.filter(e => e.kind === 'started').every(e => e.providerCredentialPresent === false));
    if (!process.argv.includes('--driver-only')) {
      assert.equal(summary.ledger.deliveries.length, 3);
      assert.ok(summary.ledger.deliveries.every(d => d.status === 'sent'));
    }
    assert.equal(summary.ledger.cursors.processed, 3); assert.equal(summary.ledger.attempts.length, 3);
    assert.deepEqual(summary.ledger.attempts.map(a => [a.usage.inputTokens, a.usage.outputTokens]), [[23,3],[30,7],[31,11]]);
    assert.equal(summary.ledger.attempts[1].usage.cachedInputTokens, 2);
    assert.deepEqual(summary.ledger.attempts.map(a => a.usage.totalTokens), [26,37,42]);
    const finalPid = driver.child.pid; await driver.close(); assert.throws(() => process.kill(finalPid, 0), { code: 'ESRCH' });
    for (const event of mcpEvents.filter(e => e.kind === 'started')) assert.throws(() => process.kill(event.pid, 0), { code: 'ESRCH' });
    assert.equal(requests.length, 6);
    for (const nativeId of [summary.firstHost.nativeId, summary.rotatedNativeId, summary.secondHost.nativeId]) {
      assert.ok(!requests.some(r => JSON.stringify(r.body).includes(nativeId)), 'Native identity must not enter model context');
    }
    for (let i = 0; i < requests.length; i++) for (let prior = 1; prior < Math.floor(i / 2) + 1; prior++) {
      assert.ok(!JSON.stringify(requests[i]).includes('source-' + prior));
      assert.ok(!JSON.stringify(requests[i]).includes('Unique synthetic event ' + prior));
    }
    summary.status = process.argv.includes('--driver-only') ? 'driver-only-core-pending' : 'passed';
    summary.productionQualification = off; summary.requests = requests.length;
  } catch (error) { summary.status = 'failed'; summary.error = error.stack; process.exitCode = 1; }
  finally {
    await controller?.close(); for (const driver of drivers) await driver.close();
    delete process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_BASE_URL;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    save('requests.json', requests); save('summary.json', summary);
    console.log(JSON.stringify({ evidence, status: summary.status, error: summary.error, fixtureFailure: summary.fixtureFailure }));
  }
})();
