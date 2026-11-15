const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { loadVendorIcons } = require('../vendor-icons.cjs');
// A synthetic one-pixel image, never a vendor trademark.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVh0AAAAASUVORK5CYII=', 'base64');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naw-icons-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
test('local vendor images are an optional fixed catalog, with no file paths exposed', t => {
  const dir = fixture(t); assert.deepEqual(loadVendorIcons(dir), {});
  fs.writeFileSync(path.join(dir, 'openai.png'), png); fs.writeFileSync(path.join(dir, 'unrelated.png'), png);
  assert.deepEqual(loadVendorIcons(dir), { openai: 'data:image/png;base64,' + png.toString('base64') });
});
test('symlinks, oversize files and invalid PNG data fall back without reading unrelated files', t => {
  const dir = fixture(t); fs.writeFileSync(path.join(dir, 'target.png'), png);
  fs.symlinkSync(path.join(dir, 'target.png'), path.join(dir, 'openai.png'));
  fs.writeFileSync(path.join(dir, 'anthropic.png'), Buffer.alloc(256 * 1024 + 1));
  fs.writeFileSync(path.join(dir, 'deepseek.png'), '<svg><script/></svg>');
  assert.deepEqual(loadVendorIcons(dir), {});
});
