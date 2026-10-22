const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { LegacyClaude } = require('../legacy-claude.cjs'), { LegacyShared } = require('../legacy-shared.cjs');
const { processIdentity } = require('../platform.cjs');
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-shared-'));
  const s = { id: 'a', provider: 'claude', name: 'Claude A', nativeId: crypto.randomUUID(), pid: process.pid,
    processIdentity: processIdentity(process.pid), state: 'idle', roomId: 'shared', memberRevision: 2, controlRevision: 3,
    messages: [{ id: 'private', role: 'assistant', text: 'PRIVATE HISTORY' }] };
  const runtime = new LegacyClaude(s, dir, async () => s), shared = new LegacyShared(dir, () => {});
  const binding = { sessionId: s.nativeId, ...await runtime.bindRoot({ sessionId: s.nativeId, nativeBlocks: true, nativeQueue: true, nativeSharedDisplay: true }) };
  runtime.submission.connected = true;
  runtime.on('readerBlock', m => shared.observed(runtime, m));
  runtime.on('sharingBoundary', () => shared.revoke(s.id));
  runtime.on('contextEnd', () => shared.revoke(s.id));
  t.after(() => { shared.dispose(); runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let allowed = true, sequence = 0;
  const tag = crypto.randomUUID(), promptId = crypto.randomUUID();
  assert.equal(shared.authorize(s, runtime, tag, { id: tag }, () => allowed), true);
  function event(values) { runtime.observeRoot({ ...binding, epoch: binding.observationEpoch, sequence: ++sequence, block: true,
    id: 'display:answer', kind: 'response', turnId: 'turn-1', promptId, index: 0, delta: 'visible', status: 'streaming', ...values }); }
  const input = (inputTag = tag) => event({ id: `prompt:${crypto.randomUUID()}`, kind: 'input', text: 'explicit task', inputTag, status: 'complete' });
  const receipt = () => shared.receipt(tag, { turnId: 'turn-1', promptId });
  return { dir, s, runtime, shared, tag, event, input, receipt, setAllowed: v => { allowed = v; } };
}
test('retained shared blocks require both exact native input and ACK; no history promotion or extra dispatch accounting', async t => {
  const f = await fixture(t); f.event({}); f.receipt();
  assert.equal(f.shared.snapshot().length, 0);
  f.input(); const row = f.shared.snapshot().find(m => m.role === 'assistant');
  assert.equal(row.text, 'visible'); assert.equal(row.replyTo, f.tag); assert.equal(row.sessionId, f.s.id);
  f.event({ index: 1, delta: ' final', status: 'complete' });
  f.event({ id: 'turn:turn-1', kind: 'turn', status: 'complete', text: 'native ended', finalDisplayId: 'display:answer' });
  assert.equal(row.text, 'visible final'); assert.equal(row.finalReply, true);
  assert.equal(f.shared.snapshot().filter(m => m.role === 'assistant').length, 1);
  assert.ok(!JSON.stringify(f.shared.snapshot()).includes('PRIVATE'));
  f.shared.save(); assert.equal(fs.statSync(f.shared.filename).mode & 0o777, 0o600);
  const reopened = new LegacyShared(f.dir, () => {}); t.after(() => reopened.dispose());
  assert.equal(reopened.grants.size, 0); assert.equal(reopened.snapshot().find(m => m.id === row.id).text, 'visible final');
});
for (const boundary of ['permission', 'foreign-input', 'takeover', 'gap', 'context', 'clear', 'observer-reload']) test(`retained shared ${boundary} freezes output and cannot be reversed by a later receipt`, async t => {
  const f = await fixture(t); f.input(); f.receipt(); f.event({});
  const before = f.shared.snapshot().find(m => m.role === 'assistant');
  if (boundary === 'permission') f.event({ id: 'control:permission', kind: 'control', status: 'complete' });
  if (boundary === 'foreign-input') f.event({ id: 'control:input', kind: 'control', status: 'complete' });
  if (boundary === 'takeover') { f.setAllowed(false); f.shared.snapshot(); f.setAllowed(true); }
  if (boundary === 'gap') f.runtime.gap('missing observation');
  if (boundary === 'context') f.runtime.contextEnding('clear');
  if (boundary === 'clear') f.shared.clear([f.tag]);
  if (boundary === 'observer-reload') await f.runtime.bindRoot({ sessionId: f.s.nativeId, nativeBlocks: true, nativeQueue: true, nativeSharedDisplay: true });
  f.shared.receipt(f.tag, { turnId: 'turn-1', promptId: 'unrelated' });
  // A late private block can still be displayed in its own conversation.
  f.runtime.emit('nativeBlock', { id: 'display:answer', kind: 'response', nativeId: f.s.nativeId, turnId: 'turn-1', index: 1, delta: ' PRIVATE LATER', status: 'complete' });
  assert.ok(f.runtime.record.messages.some(m => m.text.includes('PRIVATE LATER')));
  assert.ok(!JSON.stringify(f.shared.snapshot()).includes('PRIVATE LATER'));
  if (boundary === 'clear') {
    assert.equal(f.shared.snapshot().length, 0);
    assert.equal(fs.readFileSync(f.shared.filename, 'utf8'), '[]');
  } else { assert.equal(before.text, 'visible'); assert.ok(before.sharingStopped); }
});
test('permission before native ACK prevents retroactive publication; wrong input tag never binds', async t => {
  const f = await fixture(t); f.event({}); f.input(crypto.randomUUID()); f.receipt();
  assert.equal(f.shared.snapshot().length, 0);
  const tag = crypto.randomUUID(); f.shared.authorize(f.s, f.runtime, tag, { id: tag }, () => true);
  f.event({ id: 'control:permission', kind: 'control', status: 'complete' });
  f.shared.receipt(tag, { turnId: 'turn-1', promptId: crypto.randomUUID() });
  assert.equal(f.shared.snapshot().length, 0);
});
test('shared cache failure blocks further publication and volatile tool text stays memory-only', async t => {
  const f = await fixture(t); f.input(); f.receipt();
  f.event({ id: 'tool:one', kind: 'tool', input: '{"x":1}', title: 'Read', text: 'VOLATILE BODY', status: 'complete' });
  f.shared.save(); assert.ok(!fs.readFileSync(f.shared.filename, 'utf8').includes('VOLATILE BODY'));
  f.event({}); f.shared.storageError = true;
  f.event({ index: 1, delta: ' NOT SAVED', status: 'complete' });
  assert.ok(!JSON.stringify(f.shared.snapshot()).includes('NOT SAVED'));
});
