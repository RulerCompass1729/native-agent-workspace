'use strict';
// Real dedicated process negative cases, no model service or workspace data.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const { ButlerBackend } = require('../app/butler-backend.cjs');
const { ButlerDshDriver } = require('../app/butler-dsh-driver.cjs');
const { ButlerLedger } = require('../app/butler-ledger.cjs');
const { ButlerRole } = require('../app/butler-role.cjs');
const { ButlerController } = require('../app/butler-controller.cjs');
if (Object.hasOwn(process.env, 'DEEPSEEK_API_KEY') || Object.hasOwn(process.env, 'DEEPSEEK_BASE_URL')) throw Error('Remove inherited DeepSeek variables');
const evidence = path.join(root, '.local/evidence/b4-dsh-runner-20261111', 'failures-' + randomUUID());
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const outcomes = [];
function stream(tool) {
  const events = [
    { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content: [], usage: { input_tokens: 9, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: randomUUID(), name: 'mcp__native_workspace__workspace_status', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: '{"actions":[]}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
(async () => {
  for (const mode of ['partial-error', 'request-cap', 'forced-close', 'missing-tool', 'production-endpoint', 'unknown-price']) {
    const folder = path.join(evidence, mode); fs.mkdirSync(folder, { mode: 0o700 });
    let count = 0, fixtureError, controller, prices = 0;
    const server = http.createServer((req, res) => {
      req.resume(); req.on('end', () => {
        try {
          count++; assert.ok(count <= 8); assert.equal(req.url, '/v1/messages');
          assert.equal(req.headers['x-deepseek-harness-user-id'], undefined);
          assert.equal(req.headers['x-deepseek-harness-session-id'], undefined);
          if (mode === 'partial-error' && count === 2) { res.writeHead(401); res.end('{"error":{"message":"FIXTURE_ERROR_PRIVATE_CANARY"}}'); }
          else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(stream(mode !== 'unknown-price')); }
        } catch (error) { fixtureError = error.message; res.writeHead(400); res.end('Fixture failure'); }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpointProbe = path.join(folder, 'fetch-probe.cjs');
    fs.writeFileSync(endpointProbe, `const fs=require('fs');globalThis.fetch=async url=>{fs.appendFileSync(${JSON.stringify(path.join(folder, 'urls.jsonl'))},JSON.stringify({url:String(url)})+'\\n');throw Error('synthetic fetch stop')};`);
    const port = server.address().port, wrapper = path.join(folder, 'sandboxed-node');
    const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/sandbox-exec -p ' + quote(`(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${port}"))`) + ' ' + quote(process.execPath) + (mode === 'production-endpoint' ? ' --require ' + quote(endpointProbe) : '') + ' "$@"\n', { mode: 0o700 });
    process.env.DEEPSEEK_API_KEY = 'fixture-key'; process.env.DEEPSEEK_BASE_URL = 'https://inherited-endpoint.invalid';
    const directory = path.join(folder, 'backend');
    const backend = new ButlerBackend(directory, { runtimeVersion: 'fixture-dsh', configuration: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' } });
    backend.prepare(); const proof = JSON.parse(fs.readFileSync(backend.file)).binding;
    const driver = new ButlerDshDriver(directory, { executablePath: wrapper, fixtureEndpoint: mode === 'production-endpoint' ? null : `http://127.0.0.1:${port}`,
      ...(mode !== 'unknown-price' ? { priceUsage: () => { prices++; return 0; } } : {}),
      mcp: { command: process.execPath, args: [path.join(root, 'scripts/fixtures/butler-dsh-mcp.cjs'), path.join(folder, 'mcp.jsonl'), ...(mode === 'missing-tool' ? ['--empty'] : [])], tools: ['mcp__native_workspace__workspace_status'] } });
    try {
      if (mode === 'missing-tool') {
        await assert.rejects(driver.start(proof), e => e.code === 'mcp-unavailable');
        assert.equal(count, 0);
      } else {
        await driver.start(proof); const pid = driver.child.pid;
        const expected = { selectionRevision: 1, identity: { sessionId: 'synthetic', nativeId: driver.nativeId }, runnerRef: proof.runnerRef };
        const input = { version: 1, mode: 'record-only', batchId: 'synthetic-batch', attempt: 1, events: [{ eventId: 'event', sourceRef: 'source', kind: 'request', payload: { text: 'Synthetic input' } }], spaces: [], pendingQuestions: [] };
        if (mode === 'forced-close') {
          process.kill(pid, 'SIGSTOP'); // The real host cannot process its close pipe.
          const start = Date.now(), closed = await driver.close();
          assert.ok(Date.now() - start >= 2900); assert.equal(closed.stopped, true); assert.equal(count, 0);
        } else if (mode === 'unknown-price') {
          const roleDir = path.join(folder, 'role'), ledgerDir = path.join(folder, 'ledger');
          fs.mkdirSync(roleDir, { mode: 0o700 }); fs.mkdirSync(ledgerDir, { mode: 0o700 });
          const person = Symbol('synthetic person'), role = new ButlerRole(roleDir, { authorizePerson: a => a === person });
          const binding = Object.fromEntries(['runnerRef', 'backendRef', 'purpose', 'profile', 'provider', 'model'].map(k => [k, proof[k]]));
          role.set(person, { identity: expected.identity, runner: binding, budget: { limitMicros: 2000000 } }, 0);
          const ledger = new ButlerLedger(ledgerDir), notices = [];
          const record = { id: 'synthetic', nativeId: driver.nativeId, provider: 'dsh', state: 'idle', roomIds: [], runner: binding };
          controller = new ButlerController({ role, ledger, backend: { ensure: async () => ({ ready: true, binding }) }, view: () => ({ records: [record], spaces: [] }), run: (i, s) => driver.run(i, s), estimateBatchCost: () => 0, onBlocked: n => notices.push(n) });
          const first = await controller.receive(input.events[0]); assert.equal(first.status, 'recorded');
          const next = await controller.receive({ ...input.events[0], eventId: 'second', sourceRef: 'second' });
          assert.equal(next.status, 'blocked'); assert.equal(next.reason, 'usage-cost-unknown'); assert.equal(count, 1);
          assert.equal(ledger.snapshot().attempts[0].usage.costMicros, null); assert.equal(ledger.snapshot().attempts[0].usage.inputTokens, 9);
          assert.ok(notices.some(n => n.reason === 'usage-cost-unknown'));
        } else {
          const result = await driver.run(input, expected);
          assert.equal(result.reply, null); assert.equal(result.usage, null); assert.equal(prices, 0);
          assert.ok(!JSON.stringify(result).includes('FIXTURE_ERROR_PRIVATE_CANARY'));
          assert.equal(count, mode === 'partial-error' ? 2 : mode === 'production-endpoint' ? 0 : 8);
          if (mode === 'production-endpoint') assert.deepEqual(fs.readFileSync(path.join(folder, 'urls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse), [{ url: 'https://api.deepseek.com/anthropic/v1/messages' }]);
        }
        await controller?.close(); await driver.close();
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      }
      // Includes the actual MCP child after SIGKILL of the stopped host group.
      for (const row of fs.readFileSync(path.join(folder, 'mcp.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.kind === 'started')) {
        assert.equal(row.providerCredentialPresent, false);
        assert.throws(() => process.kill(row.pid, 0), { code: 'ESRCH' });
      }
      assert.equal(fixtureError, undefined); outcomes.push({ mode, requests: count, priceCalls: prices, status: 'passed' });
    } finally {
      await controller?.close(); await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      delete process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_BASE_URL;
    }
  }
})().catch(error => { outcomes.push({ status: 'failed', error: error.stack }); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(outcomes, null, 2));
  console.log(JSON.stringify({ evidence, outcomes }));
});
