const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { randomUUID } = require('node:crypto');
const { stageSpaceImages: stage, readSpaceImage: read, removeUnusedSpaceImages: prune } = require('../space-images.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
const decoder = { createFromBuffer: bytes => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }), toPNG: () => bytes, resize: () => ({ toDataURL: () => 'data:image/png;base64,' + bytes.toString('base64') }), toDataURL: () => 'data:image/png;base64,' + bytes.toString('base64') }) };
function fixture(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'space-images-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, stage: (room = 'shared', files = [{ bytes: png, name: 'Screenshot.png' }]) => stage(root, room, files, decoder) }; }
test('an uploaded image has an immutable space reference and private pixels, never a native-read claim', t => {
  const f = fixture(t), [ref] = f.stage();
  assert.equal(ref.kind, 'space-upload'); assert.equal(ref.roomId, 'shared'); assert.equal(ref.name, 'Screenshot.png'); assert.equal(ref.path, undefined);
  assert.deepEqual(read(f.root, 'shared', ref).png, png); assert.equal(fs.statSync(read(f.root, 'shared', ref).path).mode & 0o077, 0);
});
test('a reference cannot cross spaces, inject a path, or silently follow edited pixels', t => {
  const f = fixture(t), [ref] = f.stage(), another = randomUUID();
  assert.throws(() => read(f.root, another, ref));
  for (const change of [{ id: '../original.png' }, { path: '/outside.png' }, { sha256: '0'.repeat(64) }, { size: ref.size + 1 }, { width: 2 }]) assert.throws(() => read(f.root, 'shared', { ...ref, ...change }));
  const file = read(f.root, 'shared', ref).path, changed = Buffer.from(png); changed[changed.length - 1] ^= 1; fs.writeFileSync(file, changed);
  assert.throws(() => read(f.root, 'shared', ref), /bytes/);
});
test('file and ancestor symlinks do not turn a draft image into another local file', t => {
  const f = fixture(t), [ref] = f.stage(), file = read(f.root, 'shared', ref).path, outside = path.join(f.root, 'original.png'); fs.writeFileSync(outside, png);
  fs.unlinkSync(file); fs.symlinkSync(outside, file); assert.throws(() => read(f.root, 'shared', ref)); assert.deepEqual(fs.readFileSync(outside), png);
  fs.unlinkSync(file); fs.rmdirSync(path.dirname(file)); fs.symlinkSync(f.root, path.dirname(file)); assert.throws(() => f.stage());
});
test('image limits and header preflight run before decoder allocation or cache creation', t => {
  const f = fixture(t); let decodes = 0; const bomb = { createFromBuffer() { decodes++; throw Error('must not decode'); } };
  for (const files of [[], Array(5).fill({ bytes: png }), [{ bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }], [{ bytes: Buffer.from('not pixels') }]]) assert.throws(() => stage(f.root, 'shared', files, bomb));
  const huge = Buffer.from(png); huge.writeUInt32BE(9000, 16); huge.writeUInt32BE(9000, 20); assert.throws(() => stage(f.root, 'shared', [{ bytes: huge }], bomb));
  assert.equal(decodes, 0); assert.deepEqual(fs.readdirSync(f.root), []);
});
test('explicit pruning keeps referenced drafts and shared images and never reaches another space or original', t => {
  const f = fixture(t), [keep, discard] = f.stage('shared', [{ bytes: png }, { bytes: png }]), otherRoom = randomUUID(), [other] = f.stage(otherRoom);
  const original = path.join(f.root, 'Original.png'); fs.writeFileSync(original, png);
  assert.deepEqual(prune(f.root, 'shared', [keep.id]), { removed: 1, kept: 1, failed: false });
  assert.deepEqual(read(f.root, 'shared', keep).png, png); assert.throws(() => read(f.root, 'shared', discard)); assert.deepEqual(read(f.root, otherRoom, other).png, png); assert.deepEqual(fs.readFileSync(original), png);
  assert.throws(() => prune(f.root, 'shared')); assert.throws(() => prune(f.root, 'shared', ['../Original.png']));
});
test('unsafe cache entries and partial removal are reported without deleting their targets', t => {
  const f = fixture(t), [ref] = f.stage(), file = read(f.root, 'shared', ref).path, outside = path.join(f.root, 'Original.png'); fs.writeFileSync(outside, png);
  fs.unlinkSync(file); fs.symlinkSync(outside, file); assert.deepEqual(prune(f.root, 'shared', []), { removed: 0, kept: 1, failed: true }); assert.deepEqual(fs.readFileSync(outside), png);
});
