const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { saveImages } = require('../local-images.cjs');
const decoder = { createFromBuffer: bytes => ({ getSize: () => ({ width: 2, height: 2 }), isEmpty: () => !bytes.length, toPNG: () => bytes }) };
function profile(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-images-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('local native image staging bounds input and decoded output before writing', t => {
  const dir = profile(t), image = Uint8Array.of(1);
  for (const files of [[], Array(5).fill(image), ['path.png'], [new Uint8Array(20 * 1024 * 1024 + 1)]]) assert.throws(() => saveImages(dir, 'session', files, decoder));
  const oversized = { createFromBuffer: () => ({ getSize: () => ({ width: 10001, height: 2 }), isEmpty: () => false }) };
  assert.throws(() => saveImages(dir, 'session', [image], oversized), /10000/);
  assert.deepEqual(fs.readdirSync(dir), []);
  const files = saveImages(dir, 'session', [image, image], decoder);
  assert.equal(new Set(files).size, 2); for (const file of files) { assert.deepEqual(fs.readFileSync(file), Buffer.from(image)); assert.equal(fs.statSync(file).mode & 0o077, 0); }
});
test('failed staging removes only its own partial files and retains previous images', t => {
  const dir = profile(t), image = Uint8Array.of(1), [existing] = saveImages(dir, 'session', [image], decoder);
  const write = fs.writeFileSync; let writes = 0;
  const mock = t.mock.method(fs, 'writeFileSync', (...args) => { if (++writes === 2) { write(args[0], Buffer.from('partial')); throw Error('disk full'); } return write(...args); });
  assert.throws(() => saveImages(dir, 'session', [image, image], decoder), /disk full/); mock.mock.restore();
  assert.deepEqual(fs.readdirSync(path.dirname(existing)), [path.basename(existing)]);
});
