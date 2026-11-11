'use strict';
// Real DSH process + MCP + loopback transport. Never a provider/model request.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { ButlerBackend } = require('../app/butler-backend.cjs');
const runtimeRoot = path.resolve(process.argv.find(a => a.startsWith('--runtime-root='))?.slice(15) || path.join(__dirname, '..'));
if (runtimeRoot.startsWith('/Applications/')) throw Error('Daily app is forbidden');
const { ButlerDshDriver } = require(path.join(runtimeRoot, 'app/butler-dsh-driver.cjs'));
const { ButlerRole } = require('../app/butler-role.cjs');
const { ButlerLedger } = require('../app/butler-ledger.cjs');
const { ButlerController } = require('../app/butler-controller.cjs');
const root = path.resolve(__dirname, '..');
if (Object.hasOwn(process.env, 'DEEPSEEK_API_KEY') || Object.hasOwn(process.env, 'DEEPSEEK_BASE_URL')) throw Error('Remove inherited DeepSeek variables');
const evidence = path.join(root, '.local/evidence/b4-input', randomUUID());
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
function stream(tool) {
  return [
    { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content: [], usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: randomUUID(), name: 'mcp__native_workspace__workspace_status', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: '{"actions":[]}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
const outcomes = [];
(async () => {
  for (const mode of ['large-tool', 'error-tool', 'small-error', 'accumulated-input', 'escaped-input', 'large-schema', 'ledger-failure', 'normal-rotate', 'max-event', 'business-pages']) {
    const folder = path.join(evidence, mode); fs.mkdirSync(folder, { mode: 0o700 });
    const businessPages = mode === 'business-pages' ? require('./fixtures/butler-business-pages.cjs')(folder) : null;
    if (businessPages) fs.writeFileSync(path.join(folder, 'pages.json'), JSON.stringify(businessPages));
    const receivedBudgets = [];
    const receivedBytes = []; let fixtureError, prices = 0, resultCode, controller, ledgerEvidence;
    const server = http.createServer((req, res) => {
      const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
        try {
          const body = Buffer.concat(chunks); receivedBytes.push(body.length);
          assert.equal(req.url, '/v1/messages');
          assert.equal(req.headers['x-deepseek-harness-user-id'], undefined);
          assert.equal(req.headers['x-deepseek-harness-session-id'], undefined);
          const parsed = JSON.parse(body); assert.equal(parsed.max_tokens, 4096);
          const budget = parsed.messages?.at(-1)?.content?.at(-1);
          assert.equal(budget?.type, 'text'); assert.ok(budget.text.startsWith('NAW_CAPACITY '));
          assert.ok(typeof parsed.system === 'string' && !parsed.system.includes('NAW_CAPACITY '), 'Fixed system is unchanged');
          const remaining = budget ? Number(/remaining_bytes=(\d+)/.exec(budget.text)[1]) : null;
          receivedBudgets.push(remaining);
          if (remaining !== null) assert.equal(remaining, 262144 - body.length);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(stream(mode === 'business-pages' ? (remaining === null ? receivedBytes.length <= 4 : remaining > Math.max(...businessPages.map(p => Buffer.byteLength(JSON.stringify(JSON.stringify(p))))) + 512 + 65536) : ['large-tool', 'error-tool', 'small-error', 'ledger-failure'].includes(mode) ? receivedBytes.length === 1 : mode === 'accumulated-input' ? receivedBytes.length < 7 : false));
        } catch (error) { fixtureError = error.message; res.writeHead(400); res.end('Fixture failure'); }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port, wrapper = path.join(folder, 'sandboxed-node');
    const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/sandbox-exec -p ' + quote(`(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${port}"))`) + ' ' + quote(process.execPath) + ' "$@"\n', { mode: 0o700 });
    const directory = path.join(folder, 'backend');
    const backend = new ButlerBackend(directory, { runtimeVersion: 'fixture-dsh', configuration: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' } });
    backend.prepare(); const proof = JSON.parse(fs.readFileSync(backend.file)).binding;
    process.env.DEEPSEEK_API_KEY = 'fixture-key';
    const driver = new ButlerDshDriver(directory, { executablePath: wrapper, fixtureEndpoint: `http://127.0.0.1:${port}`, priceUsage: () => { prices++; return 0; },
      mcp: { command: process.execPath, args: [path.join(root, 'scripts/fixtures/butler-dsh-mcp.cjs'), path.join(folder, 'mcp.jsonl'), '--input-fixture', mode === 'ledger-failure' ? 'large-tool' : mode, ...(businessPages ? ['--business-pages', path.join(folder, 'pages.json')] : [])], tools: ['mcp__native_workspace__workspace_status'] } });
    try {
      if (mode === 'large-schema') {
        await assert.rejects(driver.start(proof), e => e.code === 'input-boundary');
        assert.equal(receivedBytes.length, 0); outcomes.push({ mode, receivedBytes, resultCode: 'input-boundary', stage: 'initialize', status: 'passed' }); continue;
      }
      await driver.start(proof); const pid = driver.child.pid;
      const expected = () => ({ selectionRevision: 1, identity: { sessionId: 'synthetic', nativeId: driver.nativeId }, runnerRef: proof.runnerRef });
      let input = { batchId: 'synthetic-batch', attempt: 1, events: [{ text: mode === 'business-pages' ? 'Synthetic batch '.repeat(3800) : mode === 'escaped-input' ? '\\'.repeat(90000) : 'Synthetic input' }] };
      if (mode === 'max-event') {
        const limits = { text: 12000, title: 400, spaceId: 200, spaceName: 200, memberName: 200, memberId: 200, itemId: 200, outcome: 200, reason: 2000, decisionKind: 200, questionKey: 600, supersedes: 200 };
        input = { ...require('../app/butler-policy.cjs').buildInput({ batchId: 'b'.repeat(200), catalog: [], events: [{ eventId: '\ud800'.repeat(200), sourceRef: '\ud800'.repeat(600), kind: 'request', payload: Object.fromEntries(Object.entries(limits).map(([k,n]) => [k, '\ud800'.repeat(n)])) }] }), attempt: 1 };
        const result = await driver.run(input, expected());
        assert.deepEqual(result.reply, { actions: [] }); assert.equal(result.failureCode, null);
        assert.equal(receivedBytes.length, 1); assert.ok(receivedBytes[0] < 262144);
        assert.equal(result.usage.tokensComplete, true);
      } else if (mode === 'escaped-input') {
        await assert.rejects(driver.run(input, expected()), e => e.code === 'input-too-large');
        assert.equal(receivedBytes.length, 0); assert.equal(prices, 0);
      } else if (mode === 'business-pages') {
        const result = await driver.run(input, expected());
        assert.equal(result.failureCode, null); assert.deepEqual(result.reply, { actions: [] });
        assert.ok(receivedBudgets.every(v => Number.isInteger(v) && v >= 0));
        assert.ok(receivedBytes.length >= 2 && receivedBytes.length <= 3);
        assert.ok(businessPages.every(p => Buffer.byteLength(JSON.stringify(p)) <= 65536));
        assert.ok(businessPages.some(p => Buffer.byteLength(JSON.stringify(p)) > 55000));
        assert.equal(result.usage.tokensComplete, true);
      } else if (mode === 'ledger-failure') {
        const person = Symbol('synthetic person'), role = new ButlerRole(folder, { authorizePerson: a => a === person });
        const binding = Object.fromEntries(['runnerRef', 'backendRef', 'purpose', 'profile', 'provider', 'model'].map(k => [k, proof[k]]));
        role.set(person, { identity: expected().identity, runner: binding, budget: { limitMicros: 2000000 } }, 0);
        const ledger = new ButlerLedger(folder), notices = [];
        const record = { id: 'synthetic', nativeId: driver.nativeId, provider: 'dsh', state: 'idle', roomIds: [], runner: binding };
        controller = new ButlerController({ role, ledger, backend: { ensure: async () => ({ ready: true, binding }) }, view: () => ({ records: [record], spaces: [] }),
          run: (i, s) => driver.run(i, s), estimateBatchCost: () => 0, onBlocked: n => notices.push(n) });
        const event = { eventId: 'synthetic', sourceRef: 'synthetic', kind: 'request', payload: { text: 'Synthetic input' } };
        const failed = await controller.receive(event); assert.equal(failed.reason, 'batch-failed');
        const snapshot = ledger.snapshot(); assert.equal(snapshot.activeBatch.status, 'failed');
        assert.equal(snapshot.attempts.length, 1); assert.equal(snapshot.attempts[0].usage.inputTokens, 9);
        assert.equal(snapshot.attempts[0].usage.outputTokens, 2); assert.equal(snapshot.attempts[0].usage.costMicros, null);
        assert.equal(snapshot.attempts[0].usage.tokensComplete, true);
        assert.ok(notices.some(n => n.reason === 'usage-cost-unknown'));
        assert.ok(notices.some(n => n.reason === 'batch-failed'));
        const beforeNext = receivedBytes.length;
        await controller.receive({ ...event, eventId: 'second', sourceRef: 'second' });
        assert.equal(receivedBytes.length, 1); assert.equal(prices, 0);
        ledgerEvidence = { batchStatus: snapshot.activeBatch.status, usage: snapshot.attempts[0].usage, notices: notices.map(n => n.reason), subsequentRequests: receivedBytes.length - beforeNext };
      } else if (mode === 'small-error') {
        assert.deepEqual((await driver.run(input, expected())).reply, { actions: [] });
        assert.equal(receivedBytes.length, 2); assert.equal(prices, 1);
      } else if (mode === 'normal-rotate') {
        assert.deepEqual((await driver.run(input, expected())).reply, { actions: [] });
        const old = driver.nativeId; await driver.rotate(); assert.notEqual(driver.nativeId, old);
        assert.deepEqual((await driver.run(input, expected())).reply, { actions: [] });
        assert.equal(receivedBytes.length, 2); assert.equal(prices, 2);
      } else {
        const failed = await driver.run(input, expected()); resultCode = failed.failureCode; assert.equal(resultCode, 'input-boundary');
        assert.equal(failed.usage.costMicros, null); assert.equal(failed.usage.inputTokens, 9 * receivedBytes.length);
        assert.equal(prices, 0);
        assert.ok(receivedBytes.every(n => n <= 262144));
        if (['large-tool', 'error-tool'].includes(mode)) assert.equal(receivedBytes.length, 1);
        if (mode === 'accumulated-input') assert.ok(receivedBytes.length >= 2 && receivedBytes.length < 7);
        if (mode === 'escaped-input' || mode === 'large-schema') assert.equal(receivedBytes.length, 0);
      }
      assert.equal(fixtureError, undefined);
      await controller?.close(); await driver.close(); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      for (const row of fs.readFileSync(path.join(folder, 'mcp.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.kind === 'started')) {
        assert.equal(row.providerCredentialPresent, false); assert.throws(() => process.kill(row.pid, 0), { code: 'ESRCH' });
      }
      outcomes.push({ mode, receivedBytes, ...(businessPages ? { receivedBudgets, pageBytes: businessPages.map(p => Buffer.byteLength(JSON.stringify(p))) } : {}), resultCode, prices, ...(ledgerEvidence ? { ledgerEvidence } : {}), status: 'passed' });
    } catch (error) { outcomes.push({ mode, receivedBytes, resultCode, prices, status: 'failed', error: error.message }); process.exitCode = 1; }
    finally { await controller?.close(); await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete process.env.DEEPSEEK_API_KEY; }
  }
})().catch(error => { outcomes.push({ status: 'failed', error: error.stack }); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(outcomes, null, 2));
  console.log(JSON.stringify({ evidence, outcomes }));
});
