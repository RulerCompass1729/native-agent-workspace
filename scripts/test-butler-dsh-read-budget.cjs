'use strict';
// Actual Business -> MCP -> DSH -> loopback requests; no provider credentials.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { ButlerBackend } = require('../app/butler-backend.cjs');
const { ButlerDshDriver } = require('../app/butler-dsh-driver.cjs');
const root = path.resolve(__dirname, '..');
if (Object.hasOwn(process.env, 'DEEPSEEK_API_KEY') || Object.hasOwn(process.env, 'DEEPSEEK_BASE_URL')) throw Error('Remove inherited provider variables');
const evidence = path.join(root, '.local/evidence/b4-read-budget', randomUUID());
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function stream(calls) {
  const events = [{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content: [], usage: { input_tokens: 9, output_tokens: 0 } } }];
  const blocks = calls.length ? calls : [null];
  for (const [index, args] of blocks.entries()) {
    events.push({ type: 'content_block_start', index, content_block: args ? { type: 'tool_use', id: randomUUID(), name: 'mcp__native_workspace__readBusiness', input: {} } : { type: 'text', text: '' } });
    events.push({ type: 'content_block_delta', index, delta: args ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: '{"actions":[]}' } });
    events.push({ type: 'content_block_stop', index });
  }
  events.push({ type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' });
  return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
const outcomes = [];
(async () => {
  for (const mode of ['obedient', 'ignores-budget', 'parallel-reads', 'escaped-batch']) {
    const folder = path.join(evidence, mode); fs.mkdirSync(folder, { mode: 0o700 });
    const businessDir = path.join(folder, 'business'); fs.mkdirSync(businessDir, { mode: 0o700 });
    let phase = 0, step = 0, fixtureError, controller, ledgerReceipt; const wires = [], delivered = new Map();
    const server = http.createServer((req, res) => {
      const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
        try {
          const body = Buffer.concat(chunks), value = JSON.parse(body); step++;
          assert.ok(body.length <= 196608, 'These bounded fixture replies preserve the reserved headroom'); assert.equal(value.max_tokens, 4096);
          const remaining = Number(/remaining_bytes=(\d+)/.exec(value.messages.at(-1).content.at(-1).text)[1]);
          assert.equal(remaining, 262144 - body.length);
          assert.equal(req.headers['x-deepseek-harness-user-id'], undefined);
          assert.equal(req.headers['x-deepseek-harness-session-id'], undefined);
          let cursor; let denied = 0;
          for (const m of value.messages) for (const b of m.content) if (b.type === 'tool_result') {
            const text = b.content.map(c => c.text).join('');
            if (b.is_error) { assert.match(text, /NAW_READ_BUDGET_EXHAUSTED/); denied++; }
            else { const page = JSON.parse(text); delivered.set(b.tool_use_id, page); cursor = page.nextCursor; }
          }
          wires.push({ phase, bytes: body.length, remaining, denied });
          const query = { kind: 'queue', spaceId: 'shared', ...(cursor ? { cursor } : {}) };
          const calls = phase === 1 ? (step === 1 ? [query] : []) : mode === 'obedient' ? (remaining > 140000 ? [query] : []) : mode === 'parallel-reads' ? (step === 1 ? Array.from({ length: 6 }, () => query) : []) : step < 7 ? [query] : [];
          res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(stream(calls));
        } catch (error) { fixtureError = error.stack; res.writeHead(400); res.end('Fixture failed'); }
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port, wrapper = path.join(folder, 'sandboxed-node');
    fs.writeFileSync(wrapper, '#!/bin/sh\nexec /usr/bin/sandbox-exec -p ' + quote(`(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:${port}"))`) + ' ' + quote(process.execPath) + ' "$@"\n', { mode: 0o700 });
    const directory = path.join(folder, 'backend');
    const backend = new ButlerBackend(directory, { runtimeVersion: 'fixture-dsh', configuration: { profile: 'deepseek-pro', provider: 'deepseek', model: 'deepseek-v4-pro' } });
    backend.prepare(); const proof = JSON.parse(fs.readFileSync(backend.file)).binding;
    process.env.DEEPSEEK_API_KEY = 'fixture-key';
    const driver = new ButlerDshDriver(directory, { executablePath: wrapper, fixtureEndpoint: `http://127.0.0.1:${port}`, priceUsage: () => 0,
      mcp: { command: process.execPath, args: [path.join(root, 'scripts/fixtures/butler-business-mcp.cjs'), businessDir], tools: ['mcp__native_workspace__readBusiness'] } });
    try {
      await driver.start(proof);
      const selection = () => ({ selectionRevision: 1, identity: { sessionId: 'synthetic', nativeId: driver.nativeId }, runnerRef: proof.runnerRef });
      const input = { batchId: 'synthetic-batch', attempt: 1, events: [{ text: mode === 'escaped-batch' ? '\\'.repeat(30000) : 'Read complete pages; finish with confirmed context only.' }] };
      let first;
      if (mode === 'ignores-budget') {
        const { ButlerRole } = require('../app/butler-role.cjs');
        const { ButlerLedger } = require('../app/butler-ledger.cjs');
        const { ButlerController } = require('../app/butler-controller.cjs');
        const person = Symbol('synthetic person'), role = new ButlerRole(folder, { authorizePerson: a => a === person });
        const binding = Object.fromEntries(['runnerRef', 'backendRef', 'purpose', 'profile', 'provider', 'model'].map(k => [k, proof[k]]));
        role.set(person, { identity: selection().identity, runner: binding, budget: { limitMicros: 2000000 } }, 0);
        const ledger = new ButlerLedger(folder), notices = [];
        const actor = { id: 'synthetic', nativeId: driver.nativeId, provider: 'dsh', state: 'idle', roomIds: [], runner: binding };
        controller = new ButlerController({ role, ledger, backend: { ensure: async () => ({ ready: true, binding }) }, view: () => ({ records: [actor], spaces: [] }),
          run: async (i, s) => first = await driver.run(i, s), estimateBatchCost: () => 0, onBlocked: n => notices.push(n) });
        const outcome = await controller.receive({ eventId: 'synthetic', sourceRef: 'synthetic', kind: 'request', payload: { text: 'Synthetic request' } });
        const saved = ledger.snapshot();
        assert.equal(outcome.status, 'recorded'); assert.equal(saved.batches.at(-1).status, 'completed');
        assert.equal(saved.attempts[0].usage.tokensComplete, true); assert.equal(saved.attempts[0].usage.costMicros, 0);
        assert.equal(notices.length, 0);
        ledgerReceipt = { status: saved.batches.at(-1).status, usage: saved.attempts[0].usage, notices: notices.length };
        await controller.close();
      } else first = await driver.run(input, selection());
      assert.equal(fixtureError, undefined); assert.equal(first.failureCode, null, 'Read pages must not poison the batch');
      assert.deepEqual(first.reply, { actions: [] }); assert.equal(first.usage.tokensComplete, true); assert.equal(first.usage.costMicros, 0);
      assert.equal(first.usage.inputTokens, wires.length * 9);
      const readsBefore = fs.readFileSync(path.join(businessDir, 'reads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(readsBefore.length, first.readBudget.acceptedResults + first.readBudget.withheldResults, 'No MCP read after exhaustion');
      if (mode !== 'obedient') {
        assert.equal(first.readBudget.exhausted, true); assert.equal(first.readBudget.withheldResults, 1);
        assert.ok(first.readBudget.skippedReads > 0); assert.ok(readsBefore.length < 6);
        assert.ok(wires.at(-1).denied > 0);
      } else assert.equal(first.readBudget.exhausted, false);
      for (const page of delivered.values()) assert.ok(readsBefore.some(r => JSON.stringify(r.page) === JSON.stringify(page)), 'Only complete unchanged pages reach the model');
      assert.ok(readsBefore.every(r => Buffer.byteLength(JSON.stringify(r.page)) > 55000));
      // New DSH session admits pages again; shared audit root and quota survive.
      const old = driver.nativeId; await driver.rotate(); assert.notEqual(driver.nativeId, old); phase = 1; step = 0;
      const second = await driver.run({ ...input, batchId: 'next-batch', events: [{ text: 'Next batch' }] }, selection());
      assert.equal(second.failureCode, null); assert.equal(second.readBudget.exhausted, false); assert.equal(second.readBudget.acceptedResults, 1);
      const readsAfter = fs.readFileSync(path.join(businessDir, 'reads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(readsAfter.length, readsBefore.length + 1);
      const { ButlerReadAudit } = require('../app/butler-read-audit.cjs');
      const person = Symbol('synthetic reader');
      const audit = new ButlerReadAudit(businessDir, { authorizePerson: a => a === person }).read(person);
      assert.equal(audit.throughSequence, readsAfter.length);
      outcomes.push({ mode, status: 'passed', wires, reads: readsAfter.length, readBudget: first.readBudget, usage: first.usage, ledgerReceipt, auditPages: audit.throughSequence });
    } catch (error) { outcomes.push({ mode, status: 'failed', error: error.stack, wires, fixtureError }); process.exitCode = 1; }
    finally { await controller?.close(); await driver.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); delete process.env.DEEPSEEK_API_KEY; }
  }
})().catch(error => { outcomes.push({ status: 'failed', error: error.stack }); process.exitCode = 1; }).finally(() => {
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(outcomes, null, 2));
  console.log(JSON.stringify({ evidence, outcomes }));
});
