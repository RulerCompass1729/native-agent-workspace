const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { userImageReferences, imageReferences, imageSource, readImage, ImagePreviews, imageDimensions, MAX_PIXELS } = require('../native-images.cjs');
const originalPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
function pngHeader(width, height) {
  const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a', 'hex').copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); b[24] = 8; b[25] = 6; return b;
}
function jpegHeader(width, height, marker = 0xc0) {
  const b = Buffer.from([0xff, 0xd8, 0xff, marker, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]);
  b.writeUInt16BE(height, 7); b.writeUInt16BE(width, 9); return b;
}
function webpChunk(type, payload) {
  const chunk = Buffer.alloc(8 + payload.length + (payload.length & 1)); chunk.write(type); chunk.writeUInt32LE(payload.length, 4); payload.copy(chunk, 8); return chunk;
}
function webp(...chunks) {
  const b = Buffer.alloc(12); b.write('RIFF'); b.writeUInt32LE(4 + chunks.reduce((n, v) => n + v.length, 0), 4); b.write('WEBP', 8); return Buffer.concat([b, ...chunks]);
}
test('header preflight recognizes bounded static PNG, baseline/progressive JPEG, GIF and WebP variants', () => {
  assert.deepEqual(imageDimensions(originalPng), { width: 1, height: 1 });
  for (const marker of [0xc0, 0xc2]) assert.deepEqual(imageDimensions(jpegHeader(4032, 3024, marker)), { width: 4032, height: 3024 });
  const gif = Buffer.from('474946383961010001000000002c00000000010001000002014c003b', 'hex');
  assert.deepEqual(imageDimensions(gif), { width: 1, height: 1 });
  const lossless = webpChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0]));
  assert.deepEqual(imageDimensions(webp(lossless)), { width: 1, height: 1 });
  assert.deepEqual(imageDimensions(webp(webpChunk('VP8X', Buffer.alloc(10)), lossless)), { width: 1, height: 1 });
  assert.deepEqual(imageDimensions(webp(webpChunk('VP8 ', Buffer.from([0, 0, 0, 0x9d, 1, 0x2a, 1, 0, 1, 0])))), { width: 1, height: 1 });
  assert.equal(MAX_PIXELS, 16777216);
});
test('malformed, unknown, truncated, animated and conflicting containers fail before decoding', async t => {
  const f = fixture(t), animatedPng = Buffer.concat([originalPng.subarray(0, 33), Buffer.from('000000006163544c00000000', 'hex'), originalPng.subarray(33)]);
  const gif = Buffer.from('474946383961010001000000002c00000000010001000002014c003b', 'hex');
  const animation = Buffer.concat([gif.subarray(0, -1), gif.subarray(13)]), webpAnimation = Buffer.alloc(10); webpAnimation[0] = 2;
  const hugeWebp = Buffer.alloc(10); hugeWebp.writeUIntLE(9999, 4, 3); hugeWebp.writeUIntLE(9999, 7, 3);
  const bodies = [Buffer.from('unsupported image format'), originalPng.subarray(0, 30), animatedPng, animation,
    jpegHeader(10000, 10000), jpegHeader(1, 1).subarray(0, 9), webp(webpChunk('VP8X', webpAnimation)), webp(webpChunk('VP8X', hugeWebp)),
    webp(webpChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])), webpChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0])))];
  let calls = 0;
  for (const body of bodies) {
    fs.writeFileSync(f.file, body); const ref = imageReferences([{ path: f.file }], f.dir)[0];
    await assert.rejects(readImage(ref, { createFromBuffer() { calls++; throw Error('must not decode'); } }));
  }
  assert.equal(calls, 0);
});
test('a decoder result cannot escape the validated header dimensions', async t => {
  const f = fixture(t);
  await assert.rejects(readImage(f.ref, { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 10000, height: 10000 }) }) }), /尺寸/);
});
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-image-preview-')), file = path.join(dir, 'original.png');
  fs.writeFileSync(file, originalPng);
  const ref = imageReferences([{ path: 'original.png' }], dir, [], Date.now() + 1)[0];
  const source = { kind: 'session', sessionId: 'session', nativeId: 'native', messageId: 'message', index: 0 };
  const row = { id: 'message', nativeId: 'native', role: 'tool', kind: 'tool', status: 'complete', images: [ref] };
  const snapshot = { sessions: [{ id: 'session', cwd: '/different-now', messages: [row] }], room: { messages: [] } };
  const decoder = { createFromBuffer: png => ({ isEmpty: () => !png.length, getSize: () => ({ width: 1, height: 1 }), toPNG: () => Buffer.from(png), resize() { return this; } }) };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file, ref, source, row, snapshot, decoder };
}
test('only native localImage paths become references; URLs/fileIds/bytes never masquerade as local paths', () => {
  const refs = userImageReferences([{ type: 'text', text: 'caption' }, { type: 'localImage', path: '/synthetic/one.png' },
    { type: 'image', url: 'https://example.test/PRIVATE' }, { type: 'image', fileId: 'PRIVATE' }]);
  assert.equal(refs.length, 3); assert.equal(refs[0].path, '/synthetic/one.png');
  assert.ok(refs.slice(1).every(r => r.unavailable)); assert.ok(!JSON.stringify(refs).includes('PRIVATE'));
});
test('same native reference preserves its original cwd/time; changed paths fail closed', () => {
  const first = imageReferences([{ path: 'one.png' }], '/original', [], 123);
  assert.deepEqual(imageReferences([{ path: 'one.png' }], '/later', first, 999), first);
  assert.match(imageReferences([{ path: 'other.png' }], '/later', first)[0].unavailable, /变化/);
});
test('replaying a changed native path cannot revive a different file under the original image identity', () => {
  const first = imageReferences([{ path: 'original.png' }], '/original', [], 123);
  const changed = imageReferences([{ path: 'different.png' }], '/later', first, 456);
  const replay = imageReferences([{ path: 'different.png' }], '/later', changed, 789);
  assert.ok(replay[0].unavailable); assert.equal(replay[0].path, 'original.png');
  for (const removed of [[], null, [{ unavailable: 'native reference unavailable' }]]) {
    const missing = imageReferences(removed, '/later', first, 456);
    const rebound = imageReferences([{ path: 'different.png' }], '/later', missing, 789);
    assert.ok(rebound[0].unavailable); assert.equal(rebound[0].path, 'original.png');
  }
});
test('main resolves only exact recorded identities, never a renderer path, private fallback or incomplete native request', t => {
  const f = fixture(t); assert.deepEqual(imageSource(f.snapshot, f.source), f.ref);
  for (const change of [{ path: f.file }, { nativeId: 'different' }, { messageId: 'different' }, { index: 1 }, { index: -1 }]) {
    assert.throws(() => imageSource(f.snapshot, { ...f.source, ...change }));
  }
  f.row.status = 'running'; assert.throws(() => imageSource(f.snapshot, f.source)); f.row.status = 'complete';
  const shared = { ...f.row, id: 'shared', sessionId: 'session', sharedStream: true, nativeMessageId: f.row.id, images: [] };
  f.snapshot.room.messages.push(shared);
  assert.throws(() => imageSource(f.snapshot, { ...f.source, kind: 'room', messageId: 'shared' }));
  shared.images = [f.ref]; assert.deepEqual(imageSource(f.snapshot, { ...f.source, kind: 'room', messageId: 'shared' }), f.ref);
});
test('regular file snapshot uses captured source cwd and stable bytes, not current session cwd', async t => {
  const f = fixture(t), result = await readImage(f.ref, f.decoder);
  assert.deepEqual(result.png, originalPng); assert.ok(result.thumbnail.startsWith('data:image/png;base64,'));
  assert.deepEqual([result.width, result.height], [1, 1]);
  await assert.rejects(readImage({ ...f.ref, cwd: undefined }, f.decoder), /工作目录/);
});
test('missing, rewritten, linked, special and oversized files are rejected before image decoding', async t => {
  const f = fixture(t); let calls = 0; const decoder = { createFromBuffer() { calls++; throw Error('Should not decode'); } };
  await assert.rejects(readImage({ ...f.ref, path: 'missing.png' }, decoder), /不存在/);
  await assert.rejects(readImage({ ...f.ref, path: f.dir }, decoder), /普通文件/);
  const link = path.join(f.dir, 'linked.png'); fs.symlinkSync(f.file, link);
  await assert.rejects(readImage({ ...f.ref, path: link }, decoder), /符号链接/);
  const large = path.join(f.dir, 'large.png'), fd = fs.openSync(large, 'w'); fs.ftruncateSync(fd, 20 * 1024 * 1024 + 1); fs.closeSync(fd);
  await assert.rejects(readImage({ ...f.ref, path: large }, decoder), /20 MB/);
  fs.writeFileSync(f.file, 'LATER_PRIVATE_IMAGE');
  await assert.rejects(readImage({ ...f.ref, observedAt: 1 }, decoder), /变化/); assert.equal(calls, 0);
});
test('source revocation while a preview is pending discards pixels and creates no token', async t => {
  const f = fixture(t); let reads = 0;
  const store = new ImagePreviews({ snapshot: async () => { if (++reads === 2) f.row.images = []; return f.snapshot; }, nativeImage: f.decoder });
  await assert.rejects(store.preview(f.source)); assert.equal(store.entries.size, 0); assert.equal(store.bytes, 0);
});
test('tiny oversized image headers and excessive pixel counts never enter the native decoder', async t => {
  const f = fixture(t); let calls = 0;
  const decoder = { createFromBuffer(buffer) { calls++; return f.decoder.createFromBuffer(buffer); } };
  for (const [width, height] of [[60000, 60000], [10000, 10000]]) {
    fs.writeFileSync(f.file, pngHeader(width, height));
    const ref = imageReferences([{ path: f.file }], f.dir)[0];
    await assert.rejects(readImage(ref, decoder), /尺寸|像素/);
  }
  assert.equal(calls, 0);
});
test('an old reference cannot follow a substituted ancestor into older private pixels', async t => {
  const f = fixture(t), original = path.join(f.dir, 'public'), privateDir = path.join(f.dir, 'private');
  fs.mkdirSync(original); fs.mkdirSync(privateDir);
  fs.writeFileSync(path.join(privateDir, 'same.png'), 'OLDER_PRIVATE_PIXELS');
  fs.writeFileSync(path.join(original, 'same.png'), 'ORIGINAL_PUBLIC_PIXELS');
  const ref = imageReferences([{ path: path.join(original, 'same.png') }], f.dir, [], Date.now() + 1)[0];
  fs.renameSync(original, path.join(f.dir, 'moved-public')); fs.symlinkSync(privateDir, original);
  await assert.rejects(readImage(ref, f.decoder), /变化|来源/);
});
test('explicit copy uses the exact previewed pixels; later local rewrites do not replace that snapshot', async t => {
  const f = fixture(t), store = new ImagePreviews({ snapshot: async () => f.snapshot, nativeImage: f.decoder });
  const p = await store.preview(f.source); fs.writeFileSync(f.file, 'LATER_PRIVATE_IMAGE');
  const copied = []; await store.copy(p.token, { writeImage: image => copied.push(image.toPNG()) });
  assert.deepEqual(copied, [originalPng]); assert.ok((await store.expand(p.token)).endsWith(originalPng.toString('base64')));
  f.snapshot.sessions = []; await assert.rejects(store.copy(p.token, { writeImage() { throw Error('No clipboard write'); } }));
});
test('tokens are window-local, bounded, released and invalid after close', async t => {
  const f = fixture(t), options = { snapshot: async () => f.snapshot, nativeImage: f.decoder, maxEntries: 1 };
  const a = new ImagePreviews(options), b = new ImagePreviews(options), first = await a.preview(f.source);
  await assert.rejects(b.expand(first.token));
  const second = await a.preview(f.source); await assert.rejects(a.expand(first.token)); assert.equal(a.entries.size, 1);
  a.release(second.token); assert.equal(a.bytes, 0); a.close(); await assert.rejects(a.preview(f.source));
});
test('releasing a token while copy revalidates prevents the pending clipboard write', async t => {
  const f = fixture(t), store = new ImagePreviews({ snapshot: async () => f.snapshot, nativeImage: f.decoder });
  const p = await store.preview(f.source); let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  store.snapshot = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  let copied = false; const copying = store.copy(p.token, { writeImage() { copied = true; } });
  await waiting; store.release(p.token); release(f.snapshot);
  await assert.rejects(copying); assert.equal(copied, false);
});
test('closing the window during final preview validation cannot recreate a cache entry', async t => {
  const f = fixture(t); let count = 0, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const store = new ImagePreviews({ snapshot: () => ++count === 2 ? (entered(), new Promise(resolve => { release = resolve; })) : Promise.resolve(f.snapshot), nativeImage: f.decoder });
  const previewing = store.preview(f.source); await waiting; store.close(); release(f.snapshot);
  await assert.rejects(previewing); assert.equal(store.entries.size, 0); assert.equal(store.bytes, 0);
});
test('a file rewritten during its read never reaches the decoder', async t => {
  const f = fixture(t), open = fs.promises.open; let decoded = false;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle); let changed = false;
    handle.read = async (...input) => { const result = await read(...input); if (!changed) { changed = true; fs.writeFileSync(f.file, 'CHANGED_DURING_READ'); } return result; };
    return handle;
  });
  await assert.rejects(readImage(f.ref, { createFromBuffer() { decoded = true; } }), /变化/);
  assert.equal(decoded, false);
});
test('concurrent preview requests serialize their bounded file reads', async t => {
  const f = fixture(t), open = fs.promises.open; let reads = 0, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args), read = handle.read.bind(handle); reads++; entered();
    handle.read = async (...input) => { await gate; return read(...input); }; return handle;
  });
  const store = new ImagePreviews({ snapshot: async () => f.snapshot, nativeImage: f.decoder });
  const jobs = [store.preview(f.source), store.preview(f.source)]; let simultaneous;
  try { await waiting; await new Promise(setImmediate); simultaneous = reads; }
  finally { release(); await Promise.allSettled(jobs); }
  assert.equal(simultaneous, 1); assert.equal(reads, 2); assert.equal(store.pending, 0);
});
test('pending work is bounded and closing drains queued reads without opening more files', async t => {
  const f = fixture(t); let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const store = new ImagePreviews({ snapshot: () => { entered(); return new Promise(resolve => { release = resolve; }); }, nativeImage: f.decoder });
  const jobs = Array.from({ length: 64 }, () => store.preview(f.source)); await waiting;
  await assert.rejects(store.preview(f.source), /繁忙/); store.close(); release(f.snapshot);
  const results = await Promise.allSettled(jobs); assert.ok(results.every(r => r.status === 'rejected'));
  assert.equal(store.pending, 0); assert.equal(store.entries.size, 0);
});

test('post-read validation remains inside the bounded preview operation', async t => {
  const f = fixture(t); let entered, release, calls = 0;
  const validating = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const store = new ImagePreviews({ snapshot: () => {
    if (++calls === 2) { entered(); return held; }
    return f.snapshot;
  }, nativeImage: f.decoder });
  const first = store.preview(f.source); await validating;
  const queued = Array.from({ length: 63 }, () => store.preview(f.source));
  try { await assert.rejects(store.preview(f.source), /繁忙/); }
  finally { release(f.snapshot); await Promise.allSettled([first, ...queued]); store.close(); }
});
