// Synthetic RPC using the actual 166 item/clientId/localImage envelope.
// No native engine, provider, GUI, model or clipboard is started here.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { NativeHost } = require('../adapters.cjs');
const { stageSpaceImages, readSpaceImage, SpaceImageSubmission } = require('../space-images.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const decoder = { createFromBuffer: bytes => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => bytes }) };
function fixture(t, count = 1) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'space-image-input-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const refs = stageSpaceImages(root, 'shared', Array.from({ length: count }, (_, i) => ({ bytes: png, name: `Screenshot${i}.png` })), decoder);
  const host = new NativeHost(root), runtime = host.create({ provider: 'codex', nativeId: 'owned-thread', view: 'chat', cwd: root });
  const calls = [], receipts = [], submitted = []; let ack, reject;
  host.rpc = { nativeVersion: '0.166.0', ws: { readyState: 1 }, call(method, params) { calls.push({ method, params }); return new Promise((yes, no) => { ack = yes; reject = no; }); } };
  runtime.on('spaceImagesAccepted', r => receipts.push(r)); runtime.on('submitted', tag => submitted.push(tag));
  const submission = new SpaceImageSubmission(root, 'shared', randomUUID(), refs, 'owned-thread', 'owned-tag');
  const echo = (change = {}) => runtime.event({ method: 'item/completed', params: { threadId: 'owned-thread', turnId: 'owned-turn',
    item: { type: 'userMessage', id: 'owned-item', clientId: 'owned-tag', content: [{ type: 'text', text: 'caption', text_elements: [] }, ...submission.paths.map(file => ({ type: 'localImage', path: file, detail: null }))] }, ...change } });
  return { root, refs, runtime, calls, receipts, submitted, submission, echo, ack: turnId => ack({ turn: { id: turnId || 'owned-turn' } }), reject: e => reject(e) };
}
for (const text of ['caption', '']) test(`image ${text ? 'with text' : 'only'} is a typed input, never a path in text`, async t => {
  const f = fixture(t, 2), sending = f.runtime.send(text, 'owned-tag', () => true, f.submission);
  const input = f.calls[0].params.input;
  assert.deepEqual(input, [...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...f.submission.paths.map(file => ({ type: 'localImage', path: file }))]);
  assert.equal(f.calls[0].params.clientUserMessageId, 'owned-tag'); assert.equal(f.calls[0].params.threadId, 'owned-thread');
  f.ack(); await sending; assert.equal(f.submitted.length, 1); assert.equal(f.receipts.length, 0, 'RPC acceptance cannot clear image drafts');
});
for (const beforeAck of [true, false]) test(`image echo ${beforeAck ? 'before' : 'after'} ACK binds exact turn, tag and local file`, async t => {
  const f = fixture(t), sending = f.runtime.send('caption', 'owned-tag', () => true, f.submission);
  if (beforeAck) { f.echo(); assert.equal(f.receipts.length, 0); }
  f.ack(); await sending;
  if (!beforeAck) f.echo();
  assert.equal(f.receipts.length, 1); assert.deepEqual(f.receipts[0].images, f.refs);
  assert.equal(f.receipts[0].basis, 'native-local-image-echo'); assert.equal(f.receipts[0].turnId, 'owned-turn');
  assert.equal(f.receipts[0].nativeItemId, 'owned-item'); assert.equal(f.receipts[0].nativeId, 'owned-thread');
  f.echo(); assert.equal(f.receipts.length, 1, 'duplicate native notification is not a second receipt');
});
test('wrong native context, tag, image, media count and turn cannot qualify a receipt', async t => {
  const f = fixture(t), sending = f.runtime.send('caption', 'owned-tag', () => true, f.submission); f.ack(); await sending;
  const item = content => ({ type: 'userMessage', id: 'wrong-item', clientId: 'owned-tag', content });
  for (const change of [
    { threadId: 'another-thread' }, { turnId: 'another-turn' },
    { item: { ...item([{ type: 'localImage', path: f.submission.paths[0] }]), clientId: 'another-tag' } },
    { item: item([{ type: 'text', text: f.submission.paths[0] }]) },
    { item: item([{ type: 'localImage', path: '/outside.png' }]) },
    { item: item([{ type: 'localImage', path: f.submission.paths[0] }, { type: 'image', url: 'data:image/png;base64,' }]) },
    { item: item([null]) }
  ]) f.echo(change);
  assert.equal(f.receipts.length, 0);
  f.echo(); assert.equal(f.receipts.length, 1);
});
test('an uncertain native ACK never upgrades an echoed image or retries', async t => {
  const f = fixture(t), sending = f.runtime.send('caption', 'owned-tag', () => true, f.submission);
  f.echo(); f.reject(Error('lost ACK')); await assert.rejects(sending, /lost ACK/);
  f.echo(); assert.equal(f.receipts.length, 0); assert.equal(f.calls.length, 1);
});
test('changed pixels, RPC connection or native lifecycle invalidate the image receipt', async t => {
  for (const change of ['pixels', 'rpc', 'lifecycle', 'thread']) {
    const f = fixture(t), sending = f.runtime.send('caption', 'owned-tag', () => true, f.submission); f.ack(); await sending;
    if (change === 'pixels') { const file = readSpaceImage(f.root, 'shared', f.refs[0]).path, bytes = Buffer.from(png); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes); }
    if (change === 'rpc') f.runtime.host.rpc = { ...f.runtime.host.rpc };
    if (change === 'lifecycle') f.runtime.lifecycleRevision++;
    if (change === 'thread') f.runtime.record.nativeId = 'replacement-thread';
    f.echo(); assert.equal(f.receipts.length, 0, change);
  }
});
test('unqualified native versions, disconnected transport and forged media refuse before dispatch', async t => {
  for (const change of ['0.165.0', '0.168.0', '0.167.0-beta', null, 'disconnected', 'forged']) {
    const f = fixture(t); if (change === 'disconnected') f.runtime.host.rpc.ws.readyState = 3;
    else if (change !== 'forged') f.runtime.host.rpc.nativeVersion = change;
    await assert.rejects(f.runtime.send('caption', 'owned-tag', () => true, change === 'forged' ? {} : f.submission));
    assert.equal(f.calls.length, 0, String(change)); assert.equal(f.runtime.pending, null);
  }
});
