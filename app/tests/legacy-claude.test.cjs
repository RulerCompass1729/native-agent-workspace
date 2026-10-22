const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { LegacyClaude } = require('../legacy-claude.cjs');
const { processIdentity } = require('../platform.cjs');
function fixture(t, state = 'idle') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-claude-'));
  const record = { id: 'retained', nativeId: crypto.randomUUID(), pid: process.pid,
    processIdentity: processIdentity(process.pid), state, messages: [{ id: 'old', role: 'assistant', text: 'old visible answer' }] };
  const readers = [], create = () => { const r = new LegacyClaude(record, dir, async () => record); readers.push(r); return r; };
  t.after(() => { readers.forEach(r => r.close()); fs.rmSync(dir, { recursive: true, force: true }); });
  return { record, dir, create, r: create() };
}
async function bind(f) { return { sessionId: f.record.nativeId, ...await f.r.bindRoot({ sessionId: f.record.nativeId, nativeBlocks: true }) }; }
function block(f, b, sequence, extra) { return f.r.observeRoot({ ...b, epoch: b.observationEpoch, sequence, block: true, id: 'display:visible', kind: 'response', turnId: 'turn-1', promptId: 'prompt-1', index: 0, delta: 'visible prefix', status: 'streaming', ...extra }); }

test('attach-only reader waits for old work to finish and never starts or controls a CLI', async t => {
  const f = fixture(t, 'working');
  assert.equal(fs.readdirSync(f.dir).length, 0);
  await assert.rejects(bind(f), /idle/); assert.equal(f.r.initialized, false);
  f.record.messages.push({ id: 'last-old-final', role: 'assistant', text: 'finished old work' }); f.record.state = 'idle';
  await bind(f); assert.ok(f.r.record.messages.some(m => m.id === 'last-old-final'));
  assert.equal(f.r.record.pid, process.pid);
  for (const method of ['send', 'queue', 'stop', 'interrupt', 'clearRoot']) assert.throws(() => f.r[method]());
});
test('native inputs, transformed display and tool output use stable blocks without old final duplicates', async t => {
  const f = fixture(t), b = await bind(f);
  block(f, b, 1, { id: 'prompt:accepted', kind: 'input', turnId: undefined, index: undefined, delta: undefined, text: 'native user input', status: 'complete' });
  block(f, b, 2); block(f, b, 3, { index: 1, delta: ' and final', status: 'complete' });
  f.record.messages.push({ id: 'random-old-cache', role: 'assistant', text: 'untransformed final' });
  assert.equal(f.r.record.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(f.r.record.messages.filter(m => m.id.includes('display:visible')).length, 1);
  assert.ok(!JSON.stringify(f.r.record.messages).includes('untransformed final'));
  block(f, b, 4, { id: 'tool:orphan', kind: 'tool', text: 'unknown tool', delta: undefined, index: undefined, status: 'complete' });
  assert.ok(!f.r.record.messages.some(m => m.id.includes('tool:orphan')));
  block(f, b, 5, { id: 'tool:known', kind: 'tool', input: '{"test":true}', delta: undefined, index: undefined, status: 'running' });
  block(f, b, 6, { id: 'tool:known', kind: 'tool', text: 'public output', delta: undefined, index: undefined, status: 'complete' });
  assert.equal(f.r.record.messages.find(m => m.id.includes('tool:known')).text, 'public output');
});
test('persisted private reader survives reopen; raw legacy final cannot replace it; old epochs and roots fail', async t => {
  const f = fixture(t), b = await bind(f); block(f, b, 1); f.r.close();
  assert.equal(fs.statSync(f.r.filename).mode & 0o777, 0o600);
  f.record.messages.push({ id: 'late-raw', role: 'assistant', text: 'raw unmatched body' });
  f.r = f.create(); const next = await bind(f);
  assert.equal(f.r.record.messages.find(m => m.id.includes('display:visible')).text, 'visible prefix');
  assert.ok(!f.r.record.messages.some(m => m.id === 'late-raw'));
  assert.throws(() => block(f, b, 2, { index: 1, delta: 'old epoch' }));
  f.r.endRoot({ ...next, reason: 'clear' });
  assert.throws(() => block(f, next, 1)); await assert.rejects(bind(f));
  assert.equal(f.r.record.nativeId, f.record.nativeId);
});
test('unsafe or corrupt projection does not fall back to raw private content', t => {
  const f = fixture(t); fs.writeFileSync(f.r.filename, '{}', { mode: 0o600 });
  assert.throws(f.create, /identity/);
  fs.chmodSync(f.r.filename, 0o644); assert.throws(f.create, /Unsafe/);
});
