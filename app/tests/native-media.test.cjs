const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { applyImagePayload, readImage, imageSource } = require('../native-images.cjs');
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const payload = (extra = {}) => ({ index: 0, mime: 'image/png', data: image.toString('base64'), ...extra });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-native-media-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const row = { id: 'native:N:tool:R', nativeId: 'N', role: 'tool', kind: 'tool', text: 'ORIGINAL_NATIVE_RESULT', status: 'complete' };
  const decoder = { createFromBuffer: buffer => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => buffer, resize() { return this; } }) };
  return { dir, row, decoder };
}
test('accepted native pixels survive a source rewrite without rereading private replacement pixels', async t => {
  const f = fixture(t), source = path.join(f.dir, 'original.png'); fs.writeFileSync(source, 'PRIVATE_REPLACEMENT');
  applyImagePayload(f.row, payload({ sourcePath: source }), f.dir, 'session');
  assert.equal(f.row.text, 'ORIGINAL_NATIVE_RESULT'); assert.equal(f.row.images[0].path, source);
  assert.notEqual(f.row.images[0].cachedPath, source);
  assert.deepEqual((await readImage(f.row.images[0], f.decoder)).png, image);
  const serialized = JSON.stringify(f.row); assert.ok(!serialized.includes(payload().data)); assert.ok(!serialized.includes('PRIVATE_REPLACEMENT'));
  assert.deepEqual(fs.readFileSync(f.row.images[0].cachedPath), image);
});
test('image-only native input needs no invented local source path and reuses its exact cache identity', async t => {
  const f = fixture(t); f.row.role = 'user'; f.row.kind = 'input';
  applyImagePayload(f.row, payload(), f.dir, 'session'); const first = structuredClone(f.row.images[0]);
  assert.equal(first.path, undefined); assert.equal(first.kind, 'native-pixels');
  applyImagePayload(f.row, payload(), f.dir, 'session'); assert.deepEqual(f.row.images[0], first);
  const snapshot = { sessions: [{ id: 'session', messages: [f.row] }] };
  assert.deepEqual(imageSource(snapshot, { kind: 'session', sessionId: 'session', nativeId: 'N', messageId: f.row.id, index: 0 }), first);
  assert.deepEqual((await readImage(first, f.decoder)).png, image);
});
test('changed native content cannot replace an existing image slot and native blobs never enter serialized history', t => {
  const f = fixture(t); applyImagePayload(f.row, payload(), f.dir, 'session'); const first = f.row.images[0];
  const changed = Buffer.from(image); changed[40] ^= 1;
  applyImagePayload(f.row, payload({ data: changed.toString('base64') }), f.dir, 'session');
  assert.equal(f.row.images[0].pixelSha256, first.pixelSha256); assert.ok(f.row.images[0].unavailable);
  assert.equal(f.row.status, 'complete'); assert.equal(f.row.text, 'ORIGINAL_NATIVE_RESULT');
  assert.ok(!JSON.stringify(f.row).includes(changed.toString('base64')));
});
test('a missing or modified private cache is unavailable; it never falls back to the original path', async t => {
  const f = fixture(t), original = path.join(f.dir, 'original.png'); fs.writeFileSync(original, image);
  applyImagePayload(f.row, payload({ sourcePath: original }), f.dir, 'session'); const ref = f.row.images[0];
  fs.writeFileSync(ref.cachedPath, Buffer.from(image).fill(0, 35, 40)); await assert.rejects(readImage(ref, f.decoder), /缓存|变化/);
  fs.unlinkSync(ref.cachedPath); await assert.rejects(readImage(ref, f.decoder), /不存在/);
});
test('malformed, oversized, foreign-field and unsafe-path payloads cannot create a readable image', t => {
  for (const value of [payload({ data: 'not base64!' }), payload({ data: Buffer.alloc(1024 * 1024 + 1).toString('base64') }),
    payload({ cachedPath: '/foreign/file' }), payload({ sourcePath: 'https://example.invalid/private' }), payload({ index: -1 }),
    payload({ mime: 'image/jpeg' })]) {
    const f = fixture(t); applyImagePayload(f.row, value, f.dir, 'session');
    assert.ok(!f.row.images?.some(ref => ref && !ref.unavailable));
  }
});
test('a symlinked cache root is refused and cannot write bytes outside private storage', t => {
  const f = fixture(t), outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.dir, 'native-image-cache'));
  applyImagePayload(f.row, payload(), f.dir, 'session'); assert.ok(f.row.images[0].unavailable);
  assert.deepEqual(fs.readdirSync(outside), []);
});
test('per-session stored-byte quota fails the image honestly without changing native text/status', t => {
  const f = fixture(t); applyImagePayload(f.row, payload(), f.dir, 'session');
  const folder = path.dirname(f.row.images[0].cachedPath), file = path.join(folder, '0'.repeat(64) + '.png'), fd = fs.openSync(file, 'wx');
  fs.ftruncateSync(fd, 64 * 1024 * 1024); fs.closeSync(fd);
  const second = Buffer.from(image); second[45] ^= 1;
  applyImagePayload(f.row, payload({ index: 1, data: second.toString('base64') }), f.dir, 'session');
  assert.match(f.row.images[1].unavailable, /64|上限/); assert.equal(f.row.text, 'ORIGINAL_NATIVE_RESULT'); assert.equal(f.row.status, 'complete');
});
test('a failed partial cache write removes only its own file and exact payload replay can recover', t => {
  const f = fixture(t), write = fs.writeFileSync;
  const mock = t.mock.method(fs, 'writeFileSync', (...args) => {
    if (typeof args[0] !== 'number') return write(...args);
    write(args[0], Buffer.from('PARTIAL')); const error = Error('synthetic disk full'); error.code = 'ENOSPC'; throw error;
  });
  applyImagePayload(f.row, payload(), f.dir, 'session'); assert.ok(f.row.images[0].unavailable);
  const folders = fs.readdirSync(path.join(f.dir, 'native-image-cache')); assert.equal(folders.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.dir, 'native-image-cache', folders[0])), []);
  mock.mock.restore(); applyImagePayload(f.row, payload(), f.dir, 'session');
  assert.equal(f.row.images[0].unavailable, undefined); assert.deepEqual(fs.readFileSync(f.row.images[0].cachedPath), image);
});
test('out-of-order media slots preserve known originals while filling only their exact index', t => {
  const f = fixture(t); applyImagePayload(f.row, payload({ index: 2 }), f.dir, 'session');
  const third = structuredClone(f.row.images[2]); assert.ok(f.row.images[0].pending);
  applyImagePayload(f.row, payload({ index: 0 }), f.dir, 'session');
  assert.equal(f.row.images[0].unavailable, undefined); assert.deepEqual(f.row.images[2], third); assert.equal(f.row.images.length, 3);
});
